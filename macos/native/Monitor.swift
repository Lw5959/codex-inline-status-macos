import Foundation
import Darwin

func validTarget(_ target: JObject, port: Int) -> Bool {
    guard target["type"] as? String == "page", let page = target["url"] as? String, let url = URL(string: page), url.scheme == "app", url.path == "/index.html",
          let socket = target["webSocketDebuggerUrl"] as? String, let ws = URLComponents(string: socket), ws.scheme == "ws", ws.port == port,
          ["127.0.0.1", "localhost", "::1"].contains((ws.host ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[]"))), ws.user == nil, ws.password == nil else { return false }
    return true
}
func cdpTargets(_ port: Int) throws -> [JObject] {
    guard (1024...65535).contains(port) else { throw UserError("接入端口无效。") }
    let data = try httpData(URL(string: "http://127.0.0.1:\(port)/json/list")!, timeout: 2)
    guard let targets = try JSONSerialization.jsonObject(with: data) as? [JObject] else { throw UserError("无法识别本机应用页面。") }
    return targets.filter { validTarget($0, port: port) }
}
func cdpAvailable(_ port: Int) -> Bool { !((try? cdpTargets(port)) ?? []).isEmpty }

// 接收器独立分发回复和变更事件，空闲时无需轮询页面来确认是否有新正文。
// 锁只保护 continuation/标记，不在锁内做网络或页面操作。
final class CDPReplies {
    typealias Reply = CheckedContinuation<JObject, Error>
    private let lock = NSLock()
    private var pending: [Int: (Reply, DispatchWorkItem)] = [:]
    private var serial = 0
    private var stopped = false
    private var dirty = true
    var closed: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func nextID() -> Int { lock.lock(); defer { lock.unlock() }; serial += 1; return serial }
    func changed() { lock.lock(); dirty = true; lock.unlock() }
    func takeChange() -> Bool { lock.lock(); defer { lock.unlock() }; let value = dirty; dirty = false; return value }
    func register(_ id: Int, _ reply: Reply, _ timeout: DispatchWorkItem) {
        lock.lock()
        if stopped { lock.unlock(); reply.resume(throwing: UserError("调试连接已断开。")); return }
        pending[id] = (reply, timeout); lock.unlock()
    }
    func finish(_ id: Int, _ result: Result<JObject, Error>) {
        lock.lock(); let entry = pending.removeValue(forKey: id); lock.unlock()
        entry?.1.cancel(); entry?.0.resume(with: result)
    }
    func shutdown() {
        lock.lock(); stopped = true; let entries = Array(pending.values); pending.removeAll(); lock.unlock()
        for (reply, timeout) in entries { timeout.cancel(); reply.resume(throwing: UserError("调试连接已断开。")) }
    }
}

final class CDPSession {
    let target: JObject
    let socket: URLSessionWebSocketTask
    let session: URLSession
    let replies = CDPReplies()
    var receiver: Task<Void, Never>?
    var closed: Bool { replies.closed }
    var cursors: [String: JObject] = [:]
    var streaming = false
    var lastRefresh = Date.distantPast
    var inspected: JObject = [:]
    init(target: JObject, port: Int) throws {
        guard validTarget(target, port: port), let string = target["webSocketDebuggerUrl"] as? String, let url = URL(string: string) else { throw UserError("调试连接必须保持在本机。") }
        self.target = target
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0]
        config.timeoutIntervalForRequest = 4
        session = URLSession(configuration: config)
        socket = session.webSocketTask(with: url); socket.maximumMessageSize = 4 * 1024 * 1024; socket.resume()
        receiver = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    let data: Data
                    switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
                    guard let value = try JSONSerialization.jsonObject(with: data) as? JObject else { continue }
                    if let ident = value["id"] as? Int {
                        if value["error"] != nil { replies.finish(ident, .failure(UserError("应用暂时无法响应调试请求。"))) }
                        else { replies.finish(ident, .success(value["result"] as? JObject ?? [:])) }
                    } else if value["method"] as? String == "Runtime.executionContextsCleared"
                        || (value["method"] as? String == "Runtime.bindingCalled" && (value["params"] as? JObject)?["name"] as? String == "__codexInlineNotify") {
                        replies.changed()
                    }
                }
            } catch { replies.shutdown() }
        }
    }
    func call(_ method: String, _ parameters: JObject = [:]) async throws -> JObject {
        guard !closed else { throw UserError("调试连接已断开。") }
        let ident = replies.nextID()
        return try await withCheckedThrowingContinuation { reply in
            let timeout = DispatchWorkItem { [weak self] in self?.close() }
            replies.register(ident, reply, timeout)
            DispatchQueue.global().asyncAfter(deadline: .now() + 4, execute: timeout)
            Task {
                do { try await socket.send(.string(jsonText(["id": ident, "method": method, "params": parameters]))) }
                catch { close() }
            }
        }
    }
    func evaluate(_ expression: String) async throws -> Any {
        let response = try await call("Runtime.evaluate", ["expression": expression, "returnByValue": true, "awaitPromise": true])
        guard response["exceptionDetails"] == nil else { throw UserError("状态条页面暂不可用。") }
        return (response["result"] as? JObject)?["value"] ?? null
    }
    func close() { replies.shutdown(); receiver?.cancel(); socket.cancel(with: .normalClosure, reason: nil); session.invalidateAndCancel() }
}

final class MonitorControl {
    private let lock = NSLock()
    private var requested = false
    func stop() { lock.lock(); requested = true; lock.unlock() }
    var stopping: Bool { lock.lock(); defer { lock.unlock() }; return requested }
}
final class NativeMonitor {
    let root: URL
    let port: Int
    let report: URL
    let runId: String
    let once: Bool
    let remove: Bool
    let codex: URL
    let history: ConversationMetricsStore
    let control = MonitorControl()
    var signals: [DispatchSourceSignal] = []
    var sessions: [String: CDPSession] = [:]
    var readers: [String: (ThreadStatistics, Date)] = [:]
    var statistics: [String: (JObject, Date)] = [:]
    var cleanupUnconfirmed = 0
    var health: JObject = [:]
    var healthWarning = false
    init(root: URL, port: Int, report: URL, runId: String, codex: URL, once: Bool = false, remove: Bool = false) {
        self.root = root; self.port = port; self.report = report; self.runId = runId; self.codex = codex; self.once = once; self.remove = remove
        self.history = ConversationMetricsStore(root: root)
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { [control] in control.stop() }; source.resume(); signals.append(source)
        }
    }
    func stats(_ thread: String) -> JObject {
        // 缓存占比和正文统计均按 5 秒刷新；同一线程的多窗口共享这份只读结果。
        if let cached = statistics[thread], Date().timeIntervalSince(cached.1) < 5 { return cached.0 }
        if let previous = readers[thread] {
            readers[thread] = (previous.0, Date()); let value = previous.0.poll(); statistics[thread] = (value, Date()); return value
        }
        if readers.count >= 32 {
            guard let old = readers.first(where: { Date().timeIntervalSince($0.value.1) > 30 })?.key else { return ["issue": "capacity_exceeded", "cache_hit": null] }
            readers.removeValue(forKey: old)
            statistics.removeValue(forKey: old)
        }
        let reader = ThreadStatistics(codex, thread); readers[thread] = (reader, Date()); let value = reader.poll(); statistics[thread] = (value, Date()); return value
    }
    func writeHealth(_ value: JObject) {
        health = value.merging(["runId": runId, "checkedAt": timestamp(), "backend": "swift-sqlite-javascriptcore"]) { _, new in new }
        do { try writeObject(health, report); healthWarning = false }
        catch { if !healthWarning { FileHandle.standardError.write(Data("健康报告暂不可写，监控继续。\n".utf8)); healthWarning = true } }
    }
    func destroy(_ session: CDPSession) async -> Bool {
        guard !session.closed else { return false }
        do { _ = try await session.evaluate("window.__CODEX_VISIBLE_STREAM__?.destroy(); window.__CODEX_INLINE_STATUS__?.destroy()"); return true }
        catch { return false }
    }
    func collect(_ session: CDPSession) async throws -> JObject {
        // 一次页面请求完成版本核验、绑定读取和增量快照，正文用 JSON 字符串保留半个 surrogate。
        try await session.evaluate("""
        (() => {
          const bar = window.__CODEX_INLINE_STATUS__, stream = window.__CODEX_VISIBLE_STREAM__;
          const ready = { bar: bar?.revision === "1.3.5-live.7", stream: stream?.version === "1.2.0" };
          if (!ready.bar || !ready.stream) return ready;
          const cursors = \(jsonText(session.cursors));
          return { ...ready, views: bar.bindings().map(view => {
            if (!view.threadId) return view;
            const snapshot = stream.snapshot(view.threadId, cursors[view.threadId]);
            return { ...view, snapshot: JSON.stringify(snapshot), streaming: snapshot.streaming,
              cursor: { observerId: snapshot.observerId, revision: snapshot.revision } };
          }) };
        })()
        """) as? JObject ?? [:]
    }
    func refresh(_ session: CDPSession, id: String, meter: MeterRuntime, script: String, observer: String) async throws {
        var response = try await collect(session)
        if response["stream"] as? Bool != true { _ = try await session.evaluate(observer) }
        if response["bar"] as? Bool != true { _ = try await session.evaluate(script) }
        if response["stream"] as? Bool != true || response["bar"] as? Bool != true { response = try await collect(session) }
        let views = response["views"] as? [JObject] ?? []
        var updates: [JObject] = []; var liveThreads = Set<String>(); session.streaming = false
        // 同一 renderer 的同线程多输入框只分词一次，也只推进一次快照游标。
        var streams: [String: JObject] = [:]
        for view in views {
            guard let thread = view["threadId"] as? String, UUID(uuidString: thread) != nil, let key = view["key"] as? String,
                  let snapshot = view["snapshot"] as? String else { continue }
            liveThreads.insert(thread)
            session.streaming = session.streaming || view["streaming"] as? Bool == true
            let stream: JObject
            if let previous = streams[thread] { stream = previous }
            else {
                stream = try meter.update(id, thread, snapshot); streams[thread] = stream
                if stream["issue"] as? String == "snapshot_resync_required" { session.cursors.removeValue(forKey: thread); session.replies.changed() }
                else if let cursor = view["cursor"] as? JObject { session.cursors[thread] = cursor }
            }
            let cached = stats(thread)
            let combined = history.merge(thread: thread, stream: stream, cache: cached)
            updates.append(["key": key, "metrics": combined])
        }
        session.cursors = session.cursors.filter { liveThreads.contains($0.key) }
        // 普通健康报告不读取 rect，避免每次数字刷新触发同步布局。
        session.inspected = try await session.evaluate("""
        (() => { const bar = window.__CODEX_INLINE_STATUS__;
          for (const update of \(jsonText(updates))) bar?.apply(update);
          return bar?.inspect({ refresh: false, geometry: false }) ?? {};
        })()
        """) as? JObject ?? [:]
        session.lastRefresh = Date()
    }
    func run() async -> Int32 {
        var meter: MeterRuntime
        let script: String
        let observer: String
        do {
            meter = try MeterRuntime(root: root)
            script = try String(contentsOf: root.appendingPathComponent("native_statusbar.js"), encoding: .utf8)
            observer = try String(contentsOf: root.appendingPathComponent("visible_stream_observer.js"), encoding: .utf8)
        } catch {
            writeHealth(["running": false, "status": "initialization-failed", "rendererCount": 0, "bindingCount": 0]); return 1
        }
        var lastSeen = Date(); var hadTarget = false; var exitCode: Int32 = 0
        var nextDiscovery = Date.distantPast; var nextReport = Date.distantPast; var reportedState = ""
        while !control.stopping {
            var targets = sessions.values.filter { !$0.closed }.map { $0.target }; var discoveryOK = false
            if Date() >= nextDiscovery || once || remove {
                do { targets = try cdpTargets(port); discoveryOK = true } catch {}
                nextDiscovery = Date().addingTimeInterval(5)
                let live = Set(targets.compactMap { $0["id"] as? String })
                for (id, session) in sessions where (discoveryOK && !live.contains(id)) || session.closed {
                    if !(await destroy(session)) { cleanupUnconfirmed += 1 }; session.close(); sessions.removeValue(forKey: id); meter.remove(id)
                }
            }
            if !targets.isEmpty { lastSeen = Date(); hadTarget = true }
            var removalFailures = 0
            for target in targets.prefix(32) {
                guard let id = target["id"] as? String else { continue }
                do {
                    let session: CDPSession
                    if let previous = sessions[id] { session = previous }
                    else {
                        session = try CDPSession(target: target, port: port); sessions[id] = session
                        _ = try await session.call("Runtime.enable")
                        _ = try await session.call("Runtime.addBinding", ["name": "__codexInlineNotify"])
                    }
                    if remove { _ = try await session.evaluate("window.__CODEX_VISIBLE_STREAM__?.destroy(); window.__CODEX_INLINE_STATUS__?.destroy()"); session.inspected = ["removed": true]; continue }
                    let changed = session.replies.takeChange()
                    let elapsed = Date().timeIntervalSince(session.lastRefresh)
                    // 包括输出完成通知在内都受 5 秒下限约束，避免以事件驱动为名恢复高频刷新。
                    if !once && elapsed < 5 { if changed { session.replies.changed() }; continue }
                    try await refresh(session, id: id, meter: meter, script: script, observer: observer)
                } catch {
                    if remove { removalFailures += 1 }; sessions[id]?.inspected = ["issue": "target_temporarily_unavailable"]
                    sessions[id]?.lastRefresh = Date()
                }
            }
            var inspected = sessions.values.map { $0.inspected }
            if targets.count > 32 { inspected.append(["issue": "renderer_limit_reached"]) }
            let count = inspected.reduce(0) { $0 + ($1["count"] as? Int ?? 0) }
            let hasMetrics = inspected.contains { ($0["bindings"] as? [JObject] ?? []).contains { $0["hasMetrics"] as? Bool == true } }
            let unavailable = inspected.contains { $0["issue"] != nil || ($0["bindings"] as? [JObject] ?? []).contains { $0["dataUnavailable"] as? Bool == true } }
            let state = sessions.isEmpty ? "waiting-for-app" : count == 0 ? "waiting-for-conversation" : unavailable ? "attached-partial-data" : hasMetrics ? "attached" : "attached-no-data"
            let removed = remove && discoveryOK && !targets.isEmpty && removalFailures == 0
            if once || remove || state != reportedState || Date() >= nextReport {
                writeHealth(["running": true, "status": remove ? (removed ? "removed" : "removal-unconfirmed") : state,
                             "rendererCount": sessions.count, "bindingCount": count, "cleanupUnconfirmed": cleanupUnconfirmed,
                             "persistenceIssue": history.hasIssue ? "history_unavailable" : null, "views": inspected])
                nextReport = Date().addingTimeInterval(5); reportedState = state
            }
            if once || remove { if (once && !remove && count == 0) || (remove && !removed) { exitCode = 2 }; break }
            if Date().timeIntervalSince(lastSeen) > (hadTarget ? 10 : 180) { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        for session in sessions.values {
            if !once || remove { if !(await destroy(session)) { cleanupUnconfirmed += 1 } }
            session.close()
        }
        var final = health; final["running"] = false; final["cleanupUnconfirmed"] = cleanupUnconfirmed
        if !once && !remove { final["status"] = cleanupUnconfirmed == 0 ? "stopped" : "stopped-cleanup-unconfirmed" }
        writeHealth(final)
        return exitCode
    }
}
