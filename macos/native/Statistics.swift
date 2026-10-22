import Foundation
import SQLite3
import JavaScriptCore
import CoreFoundation

// 只读取当前已绑定对话的累计缓存计数；不采集日志正文或把其他线程的用量借给当前窗口。
final class ThreadStatistics {
    let codex: URL
    let thread: String
    var path: URL?
    var offset: UInt64 = 0
    var identity = ""
    var pending = Data()
    var skipping = false
    var owner: String?
    var input: Double?
    var cached: Double?
    var lastStamp: Date?
    var nextPathLookup = Date.distantPast
    let fractionalDate = ISO8601DateFormatter()
    let wholeDate = ISO8601DateFormatter()
    init(_ codex: URL, _ thread: String) {
        self.codex = codex.resolvingSymlinksInPath(); self.thread = thread
        fractionalDate.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        wholeDate.formatOptions = [.withInternetDateTime]
    }
    func reset() { offset = 0; pending.removeAll(); skipping = false; owner = nil; input = nil; cached = nil; lastStamp = nil }
    func selectPath() throws -> URL {
        // 对话的 rollout 路径通常固定；定期重新确认索引，避免每次采样都扫描目录、重开 SQLite。
        if let path, Date() < nextPathLookup {
            let checked = path.resolvingSymlinksInPath()
            guard checked.pathExtension == "jsonl", checked.path.hasPrefix(codex.path + "/") else { throw UserError("source_unavailable") }
            return checked
        }
        let files = try FileManager.default.contentsOfDirectory(at: codex, includingPropertiesForKeys: nil)
        let states = files.compactMap { file -> (Int, URL)? in
            let name = file.deletingPathExtension().lastPathComponent
            guard file.pathExtension == "sqlite", name.hasPrefix("state_"), let version = Int(name.dropFirst(6)) else { return nil }; return (version, file)
        }.sorted { $0.0 > $1.0 }
        guard let database = states.first?.1 else { throw UserError("state_unavailable") }
        var connection: OpaquePointer?
        guard sqlite3_open_v2(database.path, &connection, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else { if connection != nil { sqlite3_close(connection) }; throw UserError("state_unavailable") }
        defer { sqlite3_close(connection) }
        sqlite3_busy_timeout(connection, 200); sqlite3_exec(connection, "PRAGMA query_only=ON", nil, nil, nil)
        var query: OpaquePointer?
        guard sqlite3_prepare_v2(connection, "SELECT rollout_path FROM threads WHERE id=? LIMIT 1", -1, &query, nil) == SQLITE_OK else { throw UserError("state_unavailable") }
        defer { sqlite3_finalize(query) }
        sqlite3_bind_text(query, 1, thread, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        guard sqlite3_step(query) == SQLITE_ROW, let text = sqlite3_column_text(query, 0) else { throw UserError("no_thread") }
        let result = URL(fileURLWithPath: String(cString: text)).resolvingSymlinksInPath()
        guard result.pathExtension == "jsonl", result.path.hasPrefix(codex.path + "/") else { throw UserError("source_unavailable") }
        path = result; nextPathLookup = Date().addingTimeInterval(10); return result
    }
    private func count(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let n = number.doubleValue; return n.isFinite && n >= 0 && n.rounded(.down) == n && n <= Double(Int64.max) ? n : nil
    }
    func feed(_ data: Data) {
        guard let record = (try? JSONSerialization.jsonObject(with: data)) as? JObject, let payload = record["payload"] as? JObject else { owner = nil; input = nil; cached = nil; return }
        if record["type"] as? String == "session_meta" {
            owner = payload["id"] as? String; input = nil; cached = nil; lastStamp = nil; return
        }
        if let explicit = payload["thread_id"] as? String {
            guard explicit == thread else { return }
            if owner != explicit { owner = explicit; input = nil; cached = nil; lastStamp = nil }
        }
        guard owner == thread, record["type"] as? String == "event_msg", payload["type"] as? String == "token_count" else { return }
        guard let text = record["timestamp"] as? String else { return }
        let stamp = fractionalDate.date(from: text) ?? wholeDate.date(from: text)
        guard let stamp, lastStamp == nil || stamp.timeIntervalSince(lastStamp!) >= -0.001 else { return }
        lastStamp = stamp
        let total = (payload["info"] as? JObject)?["total_token_usage"] as? JObject
        input = count(total?["input_tokens"]); cached = count(total?["cached_input_tokens"])
    }
    func poll() -> JObject {
        do {
            let selected = try selectPath()
            let attributes = try FileManager.default.attributesOfItem(atPath: selected.path)
            let size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
            let nextIdentity = selected.path + ":" + String(describing: attributes[.systemFileNumber])
            if identity != nextIdentity || size < offset { reset(); identity = nextIdentity; path = selected }
            var bytes = Data()
            // 文件未增长时只读元数据；不为流式 UI 刷新重复打开和 seek 日志。
            if size > offset {
                let file = try FileHandle(forReadingFrom: selected); defer { try? file.close() }
                try file.seek(toOffset: offset)
                bytes = try file.read(upToCount: offset == 0 ? 4 * 1024 * 1024 : 2 * 1024 * 1024) ?? Data()
            }
            offset += UInt64(bytes.count)
            pending.append(bytes)
            var start = pending.startIndex
            while let newline = pending[start...].firstIndex(of: 10) {
                let line = pending[start..<newline]; start = pending.index(after: newline)
                if skipping { skipping = false; continue }
                if line.count > 4 * 1024 * 1024 { owner = nil; input = nil; cached = nil; continue }
                if !line.isEmpty { feed(Data(line)) }
            }
            pending = Data(pending[start...])
            if pending.count > 4 * 1024 * 1024 { pending.removeAll(); skipping = true; owner = nil; input = nil; cached = nil }
            if offset < size { return ["issue": "catching_up", "cache_hit": null] }
            guard owner == thread else { return ["issue": owner == nil ? "ownership_unverified" : "inherited_history", "cache_hit": null] }
            let value = input.flatMap { n in cached.map { n > 0 ? min(1.0, max(0.0, $0 / n)) : Double.nan } }.flatMap { $0.isFinite ? $0 : nil }
            let ratio: Any = value.map { $0 as Any } ?? null
            return ["issue": null, "cache_hit": ratio]
        } catch let error as UserError { nextPathLookup = .distantPast; return ["issue": error.message, "cache_hit": null] }
        catch { nextPathLookup = .distantPast; return ["issue": "source_unavailable", "cache_hit": null] }
    }
}

final class MeterRuntime {
    let context: JSContext
    init(root: URL) throws {
        guard let ctx = JSContext() else { throw UserError("无法初始化系统 JavaScriptCore。") }; context = ctx
        let decode: @convention(block) (JSValue) -> String = { value in
            let bytes = (value.toArray() ?? []).compactMap { ($0 as? NSNumber)?.uint8Value }; return String(decoding: bytes, as: UTF8.self)
        }
        context.setObject(decode, forKeyedSubscript: "__nativeDecodeUTF8" as NSString)
        context.evaluateScript(try String(contentsOf: root.appendingPathComponent("native_meter.js"), encoding: .utf8))
        if context.exception != nil { throw UserError("系统分词模块初始化失败。") }
    }
    func call(_ name: String, _ arguments: [Any]) throws -> Any {
        context.exception = nil
        let result = context.objectForKeyedSubscript(name)?.call(withArguments: arguments)
        if context.exception != nil { throw UserError("分词输入无法计量。") }
        return result?.toObject() ?? null
    }
    func update(_ session: String, _ thread: String, _ snapshot: Any) throws -> JObject { try call("__updateMeter", [session, thread, snapshot]) as? JObject ?? [:] }
    func remove(_ session: String) { _ = try? call("__removeMeter", [session]) }
}
