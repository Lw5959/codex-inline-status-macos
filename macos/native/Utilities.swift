import Foundation
import CryptoKit
import Darwin
import CoreFoundation

typealias JObject = [String: Any]
struct UserError: LocalizedError {
    let message: String
    init(_ value: String) { message = value }
    var errorDescription: String? { message }
}
let nativeVersion = "2.1.4"
let null = NSNull()
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
func jsonText(_ value: Any) -> String { String(data: (try? jsonData(value)) ?? Data("null".utf8), encoding: .utf8)! }
func readObject(_ url: URL) -> JObject { ((try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? JObject) ?? [:] }
func writeObject(_ value: JObject, _ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try jsonData(value).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func hashData(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func fileHash(_ url: URL) throws -> String { hashData(try Data(contentsOf: url)) }
func defaultDataRoot() -> URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CodexInlineStatus") }
func option(_ args: [String], _ name: String, _ fallback: String? = nil) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return fallback }; return args[i + 1]
}
func runTool(_ executable: String, _ args: [String], environment: [String: String]? = nil) throws -> String {
    let p = Process(); p.executableURL = URL(fileURLWithPath: executable); p.arguments = args
    if let environment { p.environment = environment }
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
    try p.run()
    let timeout = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
    let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit(); timeout.cancel()
    guard p.terminationStatus == 0 else { throw UserError("系统操作未完成，请稍后重试。") }
    return String(decoding: data, as: UTF8.self)
}
func officialApp(_ explicit: String? = nil) throws -> (URL, URL) {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let candidates = explicit.map { [URL(fileURLWithPath: $0)] } ?? [URL(fileURLWithPath: "/Applications/Codex.app"), URL(fileURLWithPath: "/Applications/ChatGPT.app"), home.appendingPathComponent("Applications/Codex.app"), home.appendingPathComponent("Applications/ChatGPT.app")]
    for app in candidates {
        if let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")), info["CFBundleIdentifier"] as? String == "com.openai.codex", let name = info["CFBundleExecutable"] as? String {
            let binary = app.appendingPathComponent("Contents/MacOS/" + name)
            if FileManager.default.isExecutableFile(atPath: binary.path) { return (app, binary) }
        }
    }
    throw UserError("未找到官方 Codex / 本机 ChatGPT 应用。请先安装并登录官方应用。")
}
func appPids(_ executable: URL) -> [Int32] {
    let rows = (try? runTool("/bin/ps", ["-axo", "pid=,comm="])) ?? ""
    return rows.split(separator: "\n").compactMap { line in
        let parts = line.trimmingCharacters(in: .whitespaces).split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 2, String(parts[1]) == executable.path else { return nil }; return Int32(parts[0])
    }
}
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
func httpData(_ url: URL, method: String = "GET", headers: [String: String] = [:], proxyPort: Int? = nil, timeout: Double = 15) throws -> Data {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout; configuration.timeoutIntervalForResource = timeout
    if let port = proxyPort {
        configuration.connectionProxyDictionary = ["HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": port, "HTTPSEnable": 1, "HTTPSProxy": "127.0.0.1", "HTTPSPort": port]
    } else { configuration.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0] }
    let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url); request.httpMethod = method; request.cachePolicy = .reloadIgnoringLocalCacheData
    headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<Data, Error> = .failure(UserError("网络请求超时，请稍后重试。"))
    let task = session.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error { result = .failure(error); return }
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, let data, data.count <= 1_048_576 else { result = .failure(UserError("服务未返回可核实的数据，请检查网络后重试。")); return }
        result = .success(data)
    }
    task.resume()
    if semaphore.wait(timeout: .now() + timeout + 1) == .timedOut { task.cancel(); throw UserError("网络请求超时，请稍后重试。") }
    return try result.get()
}
func healthyRuntime(_ root: URL) -> Bool {
    let runtime = readObject(root.appendingPathComponent("var/runtime.json")); let health = readObject(root.appendingPathComponent("var/health.json"))
    guard runtime["runId"] as? String == health["runId"] as? String, health["running"] as? Bool == true else { return false }
    let stamp = health["checkedAt"] as? String ?? ""
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: stamp), Date().timeIntervalSince(date) >= 0, Date().timeIntervalSince(date) < 15 else { return false }
    return ownsMonitor(root, runtime)
}
func ownsMonitor(_ root: URL, _ runtime: JObject) -> Bool {
    guard let pid = runtime["pid"] as? Int, pid > 1, let command = runtime["command"] as? [String], let runId = runtime["runId"] as? String, command.count >= 4, command.suffix(2) == ["--run-id", runId] else { return false }
    let native = command.first == root.appendingPathComponent("native/GPTLauncher").path && command.contains("--monitor")
    let legacy = command.count > 1 && command[1] == root.appendingPathComponent("native_status_injector.mjs").path
    guard native || legacy else { return false }
    let line = (try? runTool("/bin/ps", ["-p", String(pid), "-o", "command="]))?.trimmingCharacters(in: .whitespacesAndNewlines)
    return line == command.joined(separator: " ")
}
func stopMonitor(_ root: URL) throws {
    let value = readObject(root.appendingPathComponent("var/runtime.json"))
    guard ownsMonitor(root, value), let number = value["pid"] as? NSNumber else { return }
    let pid = number.int32Value
    kill(pid, SIGTERM)
    let limit = Date().addingTimeInterval(7)
    while ownsMonitor(root, value) && Date() < limit { Thread.sleep(forTimeInterval: 0.1) }
    if ownsMonitor(root, value) { throw UserError("旧状态条后台仍在清理，请稍后重试。") }
}
func timestamp() -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: Date())
}
