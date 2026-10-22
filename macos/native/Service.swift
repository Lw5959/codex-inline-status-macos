import Foundation
import Darwin

private final class TimezoneProbeResult {
    private let lock = NSLock()
    private var value: Set<String>?
    func store(_ zones: Set<String>?) { lock.lock(); value = zones; lock.unlock() }
    func read() -> Set<String>? { lock.lock(); defer { lock.unlock() }; return value }
}

final class NativeService {
    let root: URL
    let resources: URL
    let manager = FileManager.default
    init(root: URL, resources: URL) { self.root = root.standardizedFileURL; self.resources = resources }
    var config: JObject { readObject(root.appendingPathComponent("macos-config.json")) }
    var helper: URL { root.appendingPathComponent("native/GPTLauncher") }
    var options: JObject {
        ["mode": "automatic", "timezone": "America/New_York", "upstream": "system", "port": 9335].merging(readObject(root.appendingPathComponent("desktop-settings.json"))) { _, new in new }
    }
    func locked<T>(_ name: String, _ action: () throws -> T) throws -> T {
        try manager.createDirectory(at: root.appendingPathComponent("var"), withIntermediateDirectories: true)
        let fd = Darwin.open(root.appendingPathComponent("var/" + name).path, O_CREAT | O_RDWR, mode_t(0o600))
        guard fd >= 0 else { throw UserError("无法访问助手数据目录。") }; defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw UserError("另一个操作正在进行，请稍后重试。") }
        defer { flock(fd, LOCK_UN) }; return try action()
    }
    func prepare() throws {
        let source = resources.appendingPathComponent("engine")
        let payload = readObject(resources.appendingPathComponent("payload.json"))
        guard let version = payload["version"] as? String, let executable = Bundle.main.executableURL else { throw UserError("App 资源不完整，请重新安装完整 App。") }
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        try locked("launch.lock") {
            if config["payloadVersion"] as? String == version && manager.isExecutableFile(atPath: helper.path) { return }
            let files = try manager.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isRegularFileKey])
            let backup = root.appendingPathComponent("backups/native-" + UUID().uuidString)
            for item in files where (try item.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true {
                let target = root.appendingPathComponent(item.lastPathComponent)
                if manager.fileExists(atPath: target.path), try Data(contentsOf: target) != Data(contentsOf: item) {
                    try manager.createDirectory(at: backup, withIntermediateDirectories: true); try manager.copyItem(at: target, to: backup.appendingPathComponent(target.lastPathComponent))
                }
                try atomicCopy(item, target)
            }
            try manager.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
            try atomicCopy(executable, helper)
            try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
            let (app, _) = try officialApp(config["app"] as? String)
            var next = config
            next.removeValue(forKey: "node"); next.removeValue(forKey: "python")
            next["nativeHelper"] = helper.path; next["version"] = nativeVersion; next["payloadVersion"] = version; next["app"] = app.path
            try writeObject(next, root.appendingPathComponent("macos-config.json"))
        }
    }
    func atomicCopy(_ source: URL, _ target: URL) throws {
        let attributes = try? manager.attributesOfItem(atPath: target.path)
        if attributes?[.type] as? FileAttributeType == .typeSymbolicLink { throw UserError("安装路径包含重定向链接，已停止更新。") }
        try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = target.deletingLastPathComponent().appendingPathComponent(".native-copy-" + UUID().uuidString)
        try manager.copyItem(at: source, to: temporary)
        if Darwin.rename(temporary.path, target.path) != 0 { try? manager.removeItem(at: temporary); throw UserError("无法更新助手文件，请检查目录权限。") }
    }
    func save(_ value: JObject) throws {
        guard ["automatic", "manual"].contains(value["mode"] as? String ?? ""), let zone = value["timezone"] as? String, TimeZone(identifier: zone) != nil else { throw UserError("请选择有效时区。") }
        if value["mode"] as? String == "manual", !usTimezones.contains(zone) { throw UserError("仅允许美国时区，已禁止保存该设置。加拿大、墨西哥等 America 时区不属于美国。") }
        guard let port = value["port"] as? Int, (1024...65535).contains(port) else { throw UserError("状态条端口必须为 1024–65535。") }
        let upstream = (value["upstream"] as? String ?? "system").trimmingCharacters(in: .whitespacesAndNewlines)
        if !["system", "direct"].contains(upstream) { _ = try ProxySpec(upstream) }
        try writeObject(["mode": value["mode"]!, "timezone": usTimezones.contains(zone) ? zone : "America/New_York", "upstream": upstream, "port": port], root.appendingPathComponent("desktop-settings.json"))
    }
    func brokerCall(_ record: JObject, _ action: String) throws -> JObject {
        guard let port = record["port"] as? Int, (1024...65535).contains(port), let token = record["token"] as? String else { throw UserError("本机网络通道尚未就绪。") }
        let data = try httpData(URL(string: "http://127.0.0.1:\(port)/" + action)!, method: "POST", headers: ["Authorization": "Bearer " + token], timeout: action == "trace" ? 55 : 2)
        guard let value = try JSONSerialization.jsonObject(with: data) as? JObject else { throw UserError("本机网络通道返回无效数据。") }
        if let error = value["error"] as? String { throw UserError(error) }; return value
    }
    func ownsBroker(_ record: JObject) -> Bool {
        guard let pid = record["pid"] as? Int, pid > 1, let runId = record["runId"] as? String, !runId.isEmpty else { return false }
        let expected = [helper.path, "--broker", "--state", root.appendingPathComponent("var/broker.json").path, "--run-id", runId]
        return (try? runTool("/bin/ps", ["-p", String(pid), "-o", "command="]).trimmingCharacters(in: .whitespacesAndNewlines)) == expected.joined(separator: " ")
    }
    func runningAppUsesBroker(_ record: JObject, port: Int? = nil) -> Bool {
        let launch = readObject(root.appendingPathComponent("var/desktop-launch.json"))
        guard let pid = (launch["appPid"] as? NSNumber)?.int32Value, let brokerPort = record["port"] as? Int,
              launch["brokerPort"] as? Int == brokerPort, (1024...65535).contains(brokerPort),
              let (_, executable) = try? officialApp(config["app"] as? String), appPids(executable).contains(pid),
              let command = try? runTool("/bin/ps", ["-p", String(pid), "-o", "command="]) else { return false }
        let arguments = Set(command.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty })
        guard arguments.contains("--proxy-server=http://127.0.0.1:\(brokerPort)") else { return false }
        return port == nil || arguments.contains("--remote-debugging-port=\(port!)")
    }
    func verifyRunningTimezone(_ port: Int, expected: String) throws {
        // 读取真实 renderer 的时区，不以旧启动记录或助手版本代替运行时证据，也不修改时区。
        let targets = try cdpTargets(port)
        guard !targets.isEmpty, targets.count <= 32 else { throw UserError("无法核实当前 ChatGPT 的时区，请检查状态条接入端口后重试。") }
        let result = TimezoneProbeResult(); let done = DispatchSemaphore(value: 0)
        Task.detached {
            var zones = Set<String>()
            do {
                for target in targets {
                    let session = try CDPSession(target: target, port: port)
                    defer { session.close() }
                    guard let zone = try await session.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone") as? String else { throw UserError("timezone_unavailable") }
                    zones.insert(zone)
                }
                result.store(zones)
            } catch { result.store(nil) }
            done.signal()
        }
        guard done.wait(timeout: .now() + 12) == .success, let zones = result.read(), zones == Set([expected]) else {
            throw UserError("当前 ChatGPT 的运行时区与检测结果不一致或无法核实。请正常退出 ChatGPT（⌘Q）后从助手启动；当前任务未被关闭。")
        }
    }
    func ensureBroker() throws -> JObject {
        try locked("broker.lock") {
            let upstream = try currentUpstream(options["upstream"] as? String ?? "system")
            let code = try fileHash(helper)
            let state = root.appendingPathComponent("var/broker.json")
            let previous = readObject(state)
            if let health = try? brokerCall(previous, "health"), health["running"] as? Bool == true {
                if previous["upstream"] as? String == upstream.raw && previous["codeHash"] as? String == code { return previous }
                // Swift 可执行文件同时包含界面和状态条；它的 hash 改变不代表使用中的通道需要重建。
                // 仅在上游相同、进程确属本工具且真实 ChatGPT 正在使用该端口时兼容旧版通道。
                if previous["upstream"] as? String == upstream.raw && ownsBroker(previous) && runningAppUsesBroker(previous) { return previous }
                guard health["activeConnections"] as? Int == 0 else { throw UserError("网络通道仍被 ChatGPT 使用。请先正常退出 ChatGPT，再切换或升级通道。") }
                _ = try? brokerCall(previous, "shutdown")
            }
            let runID = UUID().uuidString; let token = UUID().uuidString + UUID().uuidString
            try writeObject(["runId": runID, "token": token, "upstream": upstream.raw, "codeHash": code], state)
            _ = try startProcess(["--broker", "--state", state.path, "--run-id", runID], log: "broker-native.log")
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                let value = readObject(state)
                if value["runId"] as? String == runID, value["port"] != nil, (try? brokerCall(value, "health")) != nil { return value }
                Thread.sleep(forTimeInterval: 0.1)
            }
            throw UserError("本机网络通道启动超时，请重试。")
        }
    }
    func detect() throws -> JObject {
        do {
            let record = try ensureBroker(); let evidence = try brokerCall(record, "trace")
            try writeObject(evidence, root.appendingPathComponent("var/last-detection.json"))
            try requireUS(evidence)
            return evidence
        } catch {
            // 新的失败或非美国结果必须撤销旧的美国结论，不能靠缓存或手动时区绕过。
            var evidence = readObject(root.appendingPathComponent("var/last-detection.json"))
            if regionAllowed(evidence) || evidence.isEmpty { evidence = ["checkedAt": Date().timeIntervalSince1970] }
            evidence["allowed"] = false; evidence["error"] = error is UserError ? error.localizedDescription : "无法核实 GPT 出口，禁止启动。"
            try? writeObject(evidence, root.appendingPathComponent("var/last-detection.json"))
            throw error
        }
    }
    func startProcess(_ arguments: [String], log: String) throws -> Process {
        let process = Process(); process.executableURL = helper; process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        let destination = root.appendingPathComponent("var/" + log)
        if !manager.fileExists(atPath: destination.path) { manager.createFile(atPath: destination.path, contents: nil) }
        let file = try FileHandle(forWritingTo: destination); try file.seekToEnd()
        process.standardOutput = file; process.standardError = file
        try process.run(); try? file.close(); return process
    }
    func fingerprint() throws -> String {
        var data = Data(try fileHash(helper).utf8)
        for file in ["native_statusbar.js", "visible_stream_observer.js", "native_meter.js"] { data.append(try Data(contentsOf: root.appendingPathComponent(file))) }
        return hashData(data)
    }
    func connectMonitor(_ port: Int) throws -> String {
        try locked("launch.lock") {
            guard cdpAvailable(port) else { throw UserError("未发现本机应用的状态条接入端口，请正常退出后从本 App 重新启动。") }
            let code = try fingerprint()
            let old = readObject(root.appendingPathComponent("var/runtime.json"))
            if healthyRuntime(root), old["fingerprint"] as? String == code, old["port"] as? Int == port { return phaseMessage() }
            try stopMonitor(root)
            let runID = UUID().uuidString
            let codex = ProcessInfo.processInfo.environment["CODEX_HOME"] ?? manager.homeDirectoryForCurrentUser.appendingPathComponent(".codex").path
            let arguments = ["--monitor", "--root", root.path, "--port", String(port), "--report", root.appendingPathComponent("var/health.json").path, "--codex-root", codex, "--run-id", runID]
            let child = try startProcess(arguments, log: "monitor-native.log")
            try writeObject(["pid": Int(child.processIdentifier), "port": port, "runId": runID, "command": [helper.path] + arguments, "fingerprint": code], root.appendingPathComponent("var/runtime.json"))
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline {
                if !child.isRunning { throw UserError("原生状态条后台提前退出，请检查 App 文件完整性。") }
                if healthyRuntime(root), (readObject(root.appendingPathComponent("var/health.json"))["bindingCount"] as? Int ?? 0) > 0 { return phaseMessage() }
                Thread.sleep(forTimeInterval: 0.25)
            }
            if healthyRuntime(root) { return phaseMessage() }
            try stopMonitor(root); throw UserError("未收到原生状态条的有效反馈，请重试。")
        }
    }
    func phaseMessage() -> String {
        let value = readObject(root.appendingPathComponent("var/health.json")); let count = value["bindingCount"] as? Int ?? 0
        return count > 0 ? "原生状态条已连接，输入区 \(count) 个。" : "已连接应用，等待可识别的本地对话。"
    }
    func startGPT(attachOnly: Bool = false) throws -> String {
        let (app, executable) = try officialApp(config["app"] as? String)
        let pids = appPids(executable)
        let previous = readObject(root.appendingPathComponent("var/desktop-launch.json"))
        if !pids.isEmpty {
            let record = readObject(root.appendingPathComponent("var/broker.json"))
            guard let pid = (previous["appPid"] as? NSNumber)?.int32Value, pids.contains(pid),
                  ownsBroker(record), runningAppUsesBroker(record, port: options["port"] as? Int ?? 9335) else {
                throw UserError("当前 ChatGPT 未使用可核实的助手通道或未开启状态条端口。请正常退出 ChatGPT（⌘Q）后从助手启动；当前任务未被关闭。")
            }
        }
        let evidence = try detect(); try requireUS(evidence)
        let desired = options["mode"] as? String == "manual" ? options["timezone"] as? String ?? "" : evidence["timezone"] as? String ?? ""
        guard usTimezones.contains(desired) else { throw UserError("检测或手动设置为非美国时区，已禁止启动。") }
        let record = try ensureBroker(); let port = options["port"] as? Int ?? 9335
        if !pids.isEmpty {
            guard previous["brokerPort"] as? Int == record["port"] as? Int, previous["timezone"] as? String == desired else { throw UserError("时区或通道已经改变，请正常退出 ChatGPT 后再启动以应用。") }
            try verifyRunningTimezone(port, expected: desired)
            if !attachOnly { _ = try runTool("/usr/bin/open", ["-a", app.path]) }
            return try connectMonitor(port)
        }
        if attachOnly { throw UserError("ChatGPT 未运行，请点击启动按钮。") }
        if !cdpAvailable(port) {
            let probe = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = UInt16(port).bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let available = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(probe, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 } }; close(probe)
            guard available else { throw UserError("状态条端口被占用，请在面板更换端口。") }
        } else { throw UserError("接入端口属于另一个应用实例，未启动第二个 ChatGPT。") }
        guard let brokerPort = record["port"] as? Int else { throw UserError("网络通道未就绪。") }
        let proxy = "http://127.0.0.1:\(brokerPort)"
        var env = ProcessInfo.processInfo.environment
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] { env[key] = proxy }
        for key in ["NO_PROXY", "no_proxy"] { env[key] = "localhost,127.0.0.1,::1" }; env["TZ"] = desired
        _ = try runTool("/usr/bin/open", ["-a", app.path, "--args", "--remote-debugging-port=\(port)", "--remote-debugging-address=127.0.0.1", "--proxy-server=\(proxy)"], environment: env)
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline && !cdpAvailable(port) { Thread.sleep(forTimeInterval: 0.3) }
        guard cdpAvailable(port) else { throw UserError("应用已打开，但尚未提供状态条接入端口。未确认状态条显示。") }
        try writeObject(["appPid": Int(appPids(executable).first ?? 0), "brokerPort": brokerPort, "timezone": desired, "nativeVersion": nativeVersion, "country_code": "US"], root.appendingPathComponent("var/desktop-launch.json"))
        return try connectMonitor(port) + " 时区：\(desired)。"
    }
    func status() -> JObject {
        let health = readObject(root.appendingPathComponent("var/health.json"))
        let detection = readObject(root.appendingPathComponent("var/last-detection.json"))
        let fresh = healthyRuntime(root)
        return ["settings": options, "detection": detection, "status": fresh ? health["status"] ?? "未连接" : "未连接", "bindingCount": fresh ? health["bindingCount"] ?? 0 : 0,
                "installed": manager.isExecutableFile(atPath: helper.path), "lastLaunch": readObject(root.appendingPathComponent("var/desktop-launch.json")), "runtime": "native-swift-javascriptcore",
                "regionPolicy": detection["allowed"] as? Bool == true && regionAllowed(detection) ? "美国出口已核实；每次启动仍会重新检测" : "未核实为美国出口：禁止启动" ]
    }
    func execute(_ action: String, args: [String]) -> (Int32, JObject) {
        do {
            var message = ""
            switch action {
            case "prepare": try prepare(); message = "纯原生版本已就绪，不使用 Node 或 Python。仅允许美国出口和美国时区启动。"
            case "status": break
            case "save":
                guard let text = option(args, "--settings-json"), let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? JObject else { throw UserError("设置数据无效。") }
                try save(value); message = "设置已保存。美国区域限制不能通过手动时区绕过。"
            case "detect": _ = try detect(); message = "GPT 同域出口和时区均属于美国。"
            case "launch", "launch-cached": message = try startGPT()
            case "attach": message = try startGPT(attachOnly: true)
            case "stop": try locked("launch.lock") { try stopMonitor(root) }; message = "已停止状态条，保留 ChatGPT 及其使用中的网络通道。"
            default: throw UserError("未知操作。")
            }
            return (0, ["ok": true, "message": message, "status": status()])
        } catch {
            let message = error is UserError ? error.localizedDescription : "操作未完成；网络、区域或文件状态无法核实，未放行启动。"
            return (1, ["ok": false, "message": message, "status": status()])
        }
    }
}

enum NativeEntry {
    static func handle(_ args: [String]) -> Bool {
        let root = URL(fileURLWithPath: option(args, "--root", defaultDataRoot().path)!)
        if args.contains("--native-service"), let action = option(args, "--native-service") {
            let resources = URL(fileURLWithPath: option(args, "--resources", Bundle.main.resourceURL?.path ?? "")!)
            let (code, value) = NativeService(root: root, resources: resources).execute(action, args: args)
            print(jsonText(value)); exit(code)
        }
        if args.contains("--monitor") {
            _ = setsid()
            let port = Int(option(args, "--port", "9335")!) ?? 0
            let report = URL(fileURLWithPath: option(args, "--report", root.appendingPathComponent("var/health.json").path)!)
            let codex = URL(fileURLWithPath: option(args, "--codex-root", ProcessInfo.processInfo.environment["CODEX_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex").path)!)
            let monitor = NativeMonitor(root: root, port: port, report: report, runId: option(args, "--run-id", UUID().uuidString)!, codex: codex, once: args.contains("--once"), remove: args.contains("--remove"))
            Task { let code = await monitor.run(); exit(code) }; dispatchMain()
        }
        if args.contains("--broker"), let state = option(args, "--state"), let runId = option(args, "--run-id") {
            do {
                _ = setsid()
                signal(SIGPIPE, SIG_IGN)
                let file = URL(fileURLWithPath: state); var record = readObject(file)
                guard record["runId"] as? String == runId, let token = record["token"] as? String else { exit(1) }
                let broker = try NativeBroker(proxy: ProxySpec(record["upstream"] as? String ?? ""), token: token)
                record["port"] = broker.port; record["pid"] = Int(getpid()); try writeObject(record, file); broker.serve(); exit(0)
            } catch { exit(1) }
        }
        if args.contains("--native-test") {
            do {
                let request = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? JObject ?? [:]
                let action = request["action"] as? String ?? ""
                var value: Any = null
                if action == "region" { value = regionAllowed(request) }
                else if action == "gate" { try requireUS(request); value = true }
                else if action == "trace" { value = try parseGPTTrace(request["text"] as? String ?? "") }
                else if action == "allowed" { value = allowedDestination(request["host"] as? String ?? "", request["port"] as? Int ?? 0) }
                else if action == "metrics" { value = ThreadStatistics(URL(fileURLWithPath: request["codexRoot"] as? String ?? ""), request["thread"] as? String ?? "").poll() }
                else if action == "history" {
                    let location = URL(fileURLWithPath: request["root"] as? String ?? "")
                    var history = ConversationMetricsStore(root: location)
                    value = (request["events"] as? [JObject] ?? []).map { event -> JObject in
                        if event["reopen"] as? Bool == true { history = ConversationMetricsStore(root: location) }
                        return history.merge(thread: event["thread"] as? String ?? "", stream: event["stream"] as? JObject ?? [:], cache: event["cache"] as? JObject ?? [:])
                    }
                }
                else {
                    let meter = try MeterRuntime(root: URL(fileURLWithPath: option(args, "--engine", root.path)!))
                    value = try meter.call("__nativeTest", [request])
                }
                print(jsonText(["ok": true, "value": value])); exit(0)
            } catch { print(jsonText(["ok": false, "message": error is UserError ? error.localizedDescription : "原生测试输入未通过校验。"])); exit(1) }
        }
        return false
    }
}
