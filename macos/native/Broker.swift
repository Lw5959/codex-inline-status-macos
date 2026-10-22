import Foundation
import SystemConfiguration
import Darwin

struct ProxySpec {
    let raw: String
    let scheme: String
    let host: String
    let port: Int
    init(_ value: String) throws {
        raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { scheme = "direct"; host = ""; port = 0; return }
        guard let u = URLComponents(string: raw), ["http", "socks5", "socks5h"].contains(u.scheme ?? ""), let hostname = u.host, let number = u.port, number > 0, number <= 65535,
              u.user == nil, u.password == nil, u.path.isEmpty || u.path == "/", u.query == nil, u.fragment == nil else {
            throw UserError("上游代理应为 http://主机:端口 或 socks5h://主机:端口，不包含账号密码。")
        }
        scheme = u.scheme!; host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")); port = number
    }
}

func currentUpstream(_ value: String) throws -> ProxySpec {
    if value == "direct" { return try ProxySpec("") }
    if value != "system" { return try ProxySpec(value) }
    let settings = SCDynamicStoreCopyProxies(nil) as? JObject ?? [:]
    if settings["HTTPSEnable"] as? Int == 1, let host = settings["HTTPSProxy"] as? String, let port = settings["HTTPSPort"] as? Int {
        return try ProxySpec("http://" + (host.contains(":") ? "[\(host)]" : host) + ":\(port)")
    }
    if settings["ProxyAutoConfigEnable"] as? Int == 1 { throw UserError("当前使用 PAC。请填入实际 HTTP / SOCKS 代理地址，不会自动绕过代理。") }
    return try ProxySpec("")
}

func socketWrite(_ fd: Int32, _ bytes: Data) throws {
    try bytes.withUnsafeBytes { pointer in
        var offset = 0
        while offset < bytes.count {
            let sent = Darwin.send(fd, pointer.baseAddress!.advanced(by: offset), bytes.count - offset, 0)
            if sent <= 0 { if errno == EINTR { continue }; throw UserError("网络通道写入失败。") }; offset += sent
        }
    }
}
func socketRead(_ fd: Int32, count: Int) throws -> Data {
    var data = Data(); var byte = [UInt8](repeating: 0, count: count)
    while data.count < count {
        let amount = Darwin.recv(fd, &byte, count - data.count, 0)
        if amount <= 0 { if errno == EINTR { continue }; throw UserError("网络通道提前关闭。") }
        data.append(contentsOf: byte.prefix(amount))
    }
    return data
}
func socketHeader(_ fd: Int32) throws -> String {
    var data = Data()
    while data.count < 16384 {
        data.append(try socketRead(fd, count: 1))
        if data.suffix(4) == Data([13, 10, 13, 10]) { return String(decoding: data, as: UTF8.self) }
    }
    throw UserError("代理响应过大，无法核实。")
}
func connectSocket(_ host: String, _ port: Int) throws -> Int32 {
    var hints = addrinfo(); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM
    var addresses: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, String(port), &hints, &addresses) == 0 else { throw UserError("无法解析目标域名。") }
    defer { freeaddrinfo(addresses) }
    var cursor = addresses
    while let address = cursor {
        let fd = Darwin.socket(address.pointee.ai_family, SOCK_STREAM, 0)
        if fd >= 0 {
            var yes: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout.size(ofValue: yes)))
            let flags = fcntl(fd, F_GETFL); _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
            let result = Darwin.connect(fd, address.pointee.ai_addr, address.pointee.ai_addrlen)
            var ready = result == 0
            if !ready && errno == EINPROGRESS {
                var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                if Darwin.poll(&descriptor, 1, 15000) > 0 {
                    var error: Int32 = 0; var length = socklen_t(MemoryLayout.size(ofValue: error))
                    getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length); ready = error == 0
                }
            }
            _ = fcntl(fd, F_SETFL, flags)
            if ready {
                var timeout = timeval(tv_sec: 15, tv_usec: 0)
                setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
                setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
                return fd
            }
            close(fd)
        }
        cursor = address.pointee.ai_next
    }
    throw UserError("无法连接上游代理或 GPT，请检查网络后重试。")
}
func outboundTunnel(_ host: String, _ port: Int, proxy: ProxySpec) throws -> Int32 {
    let fd = try connectSocket(proxy.scheme == "direct" ? host : proxy.host, proxy.scheme == "direct" ? port : proxy.port)
    do {
        if proxy.scheme == "http" {
            try socketWrite(fd, Data("CONNECT \(host):\(port) HTTP/1.1\r\nHost: \(host):\(port)\r\n\r\n".utf8))
            let header = try socketHeader(fd)
            guard header.split(separator: " ").dropFirst().first == "200" else { throw UserError("上游代理拒绝了 GPT 连接。") }
        } else if proxy.scheme.hasPrefix("socks") {
            try socketWrite(fd, Data([5, 1, 0])); guard try socketRead(fd, count: 2) == Data([5, 0]) else { throw UserError("SOCKS 代理不支持无认证连接。") }
            let bytes = Data(host.utf8); guard bytes.count < 256 else { throw UserError("目标域名过长。") }
            try socketWrite(fd, Data([5, 1, 0, 3, UInt8(bytes.count)]) + bytes + Data([UInt8(port >> 8), UInt8(port & 255)]))
            let reply = Array(try socketRead(fd, count: 4)); guard reply[1] == 0 else { throw UserError("SOCKS 代理拒绝了 GPT 连接。") }
            let size: Int
            if reply[3] == 1 { size = 4 } else if reply[3] == 4 { size = 16 }
            else if reply[3] == 3 { size = Int(try socketRead(fd, count: 1).first!) }
            else { throw UserError("SOCKS 代理返回了无效地址。") }
            _ = try socketRead(fd, count: size + 2)
        }
        return fd
    } catch { close(fd); throw error }
}

func allowedDestination(_ host: String, _ port: Int) -> Bool {
    let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    let domains = ["chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com", "chat.com", "auth0.com"]
    return port == 443 && (["challenges.cloudflare.com", "accounts.google.com", "oauth2.googleapis.com", "ipwho.is"].contains(host) || domains.contains { host == $0 || host.hasSuffix("." + $0) })
}
func publicIP(_ value: String) -> Bool {
    var address = in_addr()
    if inet_pton(AF_INET, value, &address) == 1 {
        let bytes = value.split(separator: ".").compactMap { Int($0) }; guard bytes.count == 4 else { return false }
        return !(bytes[0] == 0 || bytes[0] == 10 || bytes[0] == 127 || bytes[0] >= 224 || (bytes[0] == 169 && bytes[1] == 254) || (bytes[0] == 172 && (16...31).contains(bytes[1])) || (bytes[0] == 192 && [0, 168].contains(bytes[1])) || (bytes[0] == 100 && (64...127).contains(bytes[1])) || (bytes[0] == 198 && [18, 19, 51].contains(bytes[1])) || (bytes[0] == 203 && bytes[1] == 0))
    }
    var six = in6_addr(); guard inet_pton(AF_INET6, value, &six) == 1 else { return false }
    let lower = value.lowercased(); return !lower.hasPrefix("fc") && !lower.hasPrefix("fd") && !lower.hasPrefix("fe8") && !lower.hasPrefix("fe9") && !lower.hasPrefix("fea") && !lower.hasPrefix("feb") && !lower.hasPrefix("ff") && !lower.hasPrefix("2001:db8") && lower != "::1" && lower != "::" && !lower.hasPrefix("::ffff:")
}
func parseGPTTrace(_ text: String) throws -> String {
    let values = text.split(separator: "\n").reduce(into: [String: String]()) { result, line in
        let parts = line.split(separator: "=", maxSplits: 1); if parts.count == 2 { result[String(parts[0])] = String(parts[1]) }
    }
    guard values["h"]?.lowercased() == "chatgpt.com", let address = values["ip"], publicIP(address) else { throw UserError("未取得 GPT 域名返回的有效公网 IP，禁止启动。") }
    return address
}
let usTimezones: Set<String> = {
    // IANA 区名的 America 前缀同时覆盖加拿大等地区，不能用前缀判定美国。
    var zones = Set<String>()
    if let text = try? String(contentsOfFile: "/usr/share/zoneinfo/zone.tab", encoding: .utf8) {
        for line in text.split(separator: "\n") where !line.hasPrefix("#") {
            let columns = line.split(separator: "\t"); if columns.count >= 3 && columns[0] == "US" { zones.insert(String(columns[2])) }
        }
    }
    zones.formUnion(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "America/Adak", "America/Phoenix", "America/Detroit", "America/Indiana/Indianapolis", "America/Kentucky/Louisville", "Pacific/Honolulu"])
    return zones
}()
func regionAllowed(_ result: JObject) -> Bool { result["country_code"] as? String == "US" && usTimezones.contains(result["timezone"] as? String ?? "") }
func requireUS(_ result: JObject) throws {
    guard regionAllowed(result) else { throw UserError("检测到非美国出口或时区（\(result["timezone"] as? String ?? "未知")），已禁止启动和加载。请切换美国出口后重新检测；手动改时区不能绕过。") }
}

final class NativeBroker {
    let proxy: ProxySpec
    let token: String
    let listener: Int32
    let port: Int
    let lock = NSLock()
    var active = 0
    var lastAccess = Date()
    var stopping = false
    init(proxy: ProxySpec, token: String) throws {
        self.proxy = proxy; self.token = token
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { throw UserError("无法创建本机网络通道。") }
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_port = 0; address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard result == 0, Darwin.listen(fd, 128) == 0 else { close(fd); throw UserError("无法绑定本机网络通道。") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        listener = fd; port = Int(UInt16(bigEndian: address.sin_port))
    }
    func shutdownIfIdle() -> Bool {
        lock.lock(); defer { lock.unlock() }; guard active == 0 else { return false }; stopping = true
        Darwin.shutdown(listener, SHUT_RDWR); close(listener); return true
    }
    func serve() {
        DispatchQueue.global().async { [self] in
            while true {
                Thread.sleep(forTimeInterval: 30)
                lock.lock(); let idle = Date().timeIntervalSince(lastAccess) > 600; let done = stopping; lock.unlock()
                if done { return }; if idle && shutdownIfIdle() { return }
            }
        }
        while !stopping {
            let fd = Darwin.accept(listener, nil, nil)
            if fd < 0 { if errno == EINTR { continue }; break }
            var yes: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout.size(ofValue: yes)))
            var timeout = timeval(tv_sec: 15, tv_usec: 0); setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
            DispatchQueue.global(qos: .utility).async { [self] in handle(fd) }
        }
    }
    func reply(_ fd: Int32, _ object: JObject, code: Int = 200) {
        let data = (try? jsonData(object)) ?? Data("{}".utf8)
        try? socketWrite(fd, Data("HTTP/1.1 \(code) Response\r\nContent-Type: application/json\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n".utf8) + data)
    }
    func measure() throws -> JObject {
        let trace = URL(string: "https://chatgpt.com/cdn-cgi/trace")!
        let first = try parseGPTTrace(String(decoding: httpData(trace, proxyPort: port), as: UTF8.self))
        let second = try parseGPTTrace(String(decoding: httpData(trace, proxyPort: port), as: UTF8.self))
        guard first == second else { throw UserError("两次访问 GPT 的出口 IP 不同，无法确认美国区域，已禁止启动。") }
        let geoURL = URL(string: "https://ipwho.is/" + first)!
        guard let geo = try JSONSerialization.jsonObject(with: httpData(geoURL, proxyPort: port)) as? JObject,
              geo["success"] as? Bool == true, geo["ip"] as? String == first, let timezone = (geo["timezone"] as? JObject)?["id"] as? String,
              TimeZone(identifier: timezone) != nil else { throw UserError("无法核实 GPT 出口对应的时区，已禁止启动。") }
        // 查询的是 GPT 已回显的明确 IP；地理服务自身的出口与返回机房不参与判定。
        var result: JObject = ["ip": first, "timezone": timezone, "country": geo["country"] as? String ?? "", "country_code": geo["country_code"] as? String ?? "",
                               "city": geo["city"] as? String ?? "", "host": "chatgpt.com", "checkedAt": Date().timeIntervalSince1970,
                               "method": "gpt-origin-shared-native-broker", "upstreamHash": hashData(Data(proxy.raw.utf8))]
        result["allowed"] = regionAllowed(result)
        return result
    }
    func handle(_ fd: Int32) {
        defer { close(fd) }
        do {
            let header = try socketHeader(fd); let lines = header.components(separatedBy: "\r\n")
            let request = (lines.first ?? "").split(separator: " "); guard request.count >= 2 else { return }
            lock.lock(); lastAccess = Date(); lock.unlock()
            if request[0] == "POST" {
                let authorized = lines.contains { $0.lowercased().hasPrefix("authorization:") && $0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) == "Bearer " + token }
                guard authorized else { reply(fd, ["error": "not_authorized"], code: 403); return }
                if request[1] == "/health" { lock.lock(); let count = active; lock.unlock(); reply(fd, ["running": true, "activeConnections": count]) }
                else if request[1] == "/trace" {
                    do { reply(fd, try measure()) } catch { reply(fd, ["error": error is UserError ? error.localizedDescription : "GPT 出口或时区检测失败，未放行启动。请检查网络后重试。 "]) }
                } else if request[1] == "/shutdown" {
                    lock.lock(); let idle = active == 0; lock.unlock(); reply(fd, ["stopped": idle])
                    if idle { DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { [self] in _ = shutdownIfIdle() } }
                }
                else { reply(fd, ["error": "not_found"], code: 404) }; return
            }
            guard request[0] == "CONNECT", let split = request[1].lastIndex(of: ":"), let remotePort = Int(request[1][request[1].index(after: split)...]) else { reply(fd, ["error": "CONNECT required"], code: 405); return }
            let host = String(request[1][..<split])
            guard allowedDestination(host, remotePort) else { reply(fd, ["error": "destination_not_allowed"], code: 403); return }
            let remote = try outboundTunnel(host, remotePort, proxy: proxy); defer { close(remote) }
            try socketWrite(fd, Data("HTTP/1.1 200 Connection established\r\n\r\n".utf8))
            lock.lock(); active += 1; lock.unlock(); defer { lock.lock(); active -= 1; lock.unlock() }
            var buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                var descriptors = [pollfd(fd: fd, events: Int16(POLLIN), revents: 0), pollfd(fd: remote, events: Int16(POLLIN), revents: 0)]
                let count = Darwin.poll(&descriptors, 2, 30000)
                if count == 0 { continue }; if count < 0 { if errno == EINTR { continue }; return }
                for (index, descriptor) in descriptors.enumerated() where descriptor.revents != 0 {
                    let n = Darwin.recv(descriptor.fd, &buffer, buffer.count, 0); if n <= 0 { return }
                    try socketWrite(index == 0 ? remote : fd, Data(buffer.prefix(n)))
                }
                lock.lock(); lastAccess = Date(); lock.unlock()
            }
        } catch { /* TLS 字节不解析，错误不回显用户请求和认证信息。 */ }
    }
}
