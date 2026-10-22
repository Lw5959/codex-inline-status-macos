import Foundation
import CoreFoundation
import Darwin

// 只保存已经核实的数值摘要；正文、认证信息和 renderer 的计时状态永不落盘。
// 读回的摘要仅作明确标注的历史回显，不能作为新窗口的流式采样证据。
final class ConversationMetricsStore {
    struct Speed: Codable, Equatable {
        let tps: Double
        let tokens: Double
        let seconds: Double
        let samples: Int
        let savedAt: Double
        let observer: String
        let key: String
    }
    struct Cache: Codable, Equatable {
        let ratio: Double
        let savedAt: Double
    }
    struct Record: Codable, Equatable {
        let schemaVersion: Int
        let threadID: String
        var speed: Speed?
        var cache: Cache?
    }
    private struct Entry {
        var record: Record
        var dirty = false
        var issue: String?
        var nextAttempt = Date.distantPast
    }
    private let directory: URL
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    // 同一完成样本在多窗口轮询时只获得一次时间戳，避免旧样本来回覆盖较新的历史。
    private var seen: [String: Double] = [:]
    private var seenOrder: [String] = []
    var hasIssue: Bool { entries.values.contains { $0.issue != nil } }

    init(root: URL) { directory = root.appendingPathComponent("var/conversations", isDirectory: true) }
    private func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue.isFinite ? n.doubleValue : nil
    }
    private func valid(_ record: Record, thread: String) -> Bool {
        guard record.schemaVersion == 1, record.threadID == thread else { return false }
        if let speed = record.speed {
            guard speed.tps.isFinite, speed.tps > 0, speed.tokens.isFinite, speed.tokens > 0,
                  speed.seconds.isFinite, speed.seconds > 0, speed.samples == 1,
                  abs(speed.tps - speed.tokens / speed.seconds) <= max(0.000001, speed.tps * 0.000001),
                  validTime(speed.savedAt), !speed.observer.isEmpty, speed.observer.count <= 256,
                  !speed.key.isEmpty, speed.key.count <= 1024 else { return false }
        }
        if let cache = record.cache {
            guard cache.ratio.isFinite, (0...1).contains(cache.ratio), validTime(cache.savedAt) else { return false }
        }
        return true
    }
    private func validTime(_ time: Double) -> Bool { time.isFinite && time > 0 && time <= Date().timeIntervalSince1970 + 300 }
    private func load(_ thread: String) -> Entry {
        if let previous = entries[thread] { return previous }
        let empty = Record(schemaVersion: 1, threadID: thread)
        let file = directory.appendingPathComponent(thread + ".json")
        guard FileManager.default.fileExists(atPath: file.path) else { return Entry(record: empty) }
        do {
            let info = try FileManager.default.attributesOfItem(atPath: file.path)
            guard info[.type] as? FileAttributeType == .typeRegular,
                  ((info[.size] as? NSNumber)?.intValue ?? Int.max) <= 65536 else { return Entry(record: empty, issue: "history_invalid") }
            let record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: file))
            guard valid(record, thread: thread) else { return Entry(record: empty, issue: "history_invalid") }
            return Entry(record: record)
        } catch { return Entry(record: empty, issue: "history_unavailable") }
    }
    private func save(_ entry: inout Entry) {
        guard entry.dirty, Date() >= entry.nextAttempt else { return }
        let file = directory.appendingPathComponent(entry.record.threadID + ".json")
        let temporary = directory.appendingPathComponent("." + UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let bytes = try encoder.encode(entry.record)
            // 临时文件从创建时即为 0600；同目录原子替换，不留下半份 JSON。
            guard FileManager.default.createFile(atPath: temporary.path, contents: bytes, attributes: [.posixPermissions: 0o600]) else { throw UserError("history_unavailable") }
            guard rename(temporary.path, file.path) == 0 else { throw UserError("history_unavailable") }
            entry.dirty = false; entry.issue = nil; entry.nextAttempt = .distantPast
        } catch { entry.issue = "history_write_failed"; entry.nextAttempt = Date().addingTimeInterval(5) }
    }
    func merge(thread rawThread: String, stream: JObject, cache: JObject) -> JObject {
        var result = cache.merging(stream) { _, new in new }
        result["issue"] = stream["issue"] ?? null; result["cache_issue"] = cache["issue"] ?? null
        result["scope"] = "visible_text_client"; result["measurement_method"] = "visible_stream"
        result["observation_id"] = stream["nativeObserverId"] ?? null
        result["measured_tokens"] = stream["tokens"] ?? null; result["measured_seconds"] = stream["seconds"] ?? null
        guard let uuid = UUID(uuidString: rawThread) else { return result }
        let thread = uuid.uuidString.lowercased()
        var entry = load(thread)
        let before = entry.record
        let observer = stream["nativeObserverId"] as? String ?? ""
        if let speed = entry.record.speed, speed.observer == observer,
           (stream["invalidated_keys"] as? [String] ?? []).contains(speed.key) {
            // 后续证据撤销已保存样本时，连同磁盘摘要一起撤销，不能下次启动又恢复它。
            entry.record.speed = nil
        }
        if let confirmed = stream["confirmed"] as? JObject,
           let tps = number(confirmed["tps"]), tps > 0,
           let tokens = number(confirmed["tokens"]), tokens > 0,
           let seconds = number(confirmed["seconds"]), seconds > 0,
           number(confirmed["measured_samples"]) == 1,
           let key = stream["confirmed_key"] as? String, !key.isEmpty, key.count <= 1024,
           !observer.isEmpty, observer.count <= 256 {
            let identity = jsonText([thread, observer, key])
            let firstSeen: Double
            if let previous = seen[identity] { firstSeen = previous }
            else {
                firstSeen = Date().timeIntervalSince1970; seen[identity] = firstSeen; seenOrder.append(identity)
                while seenOrder.count > 4096 { seen.removeValue(forKey: seenOrder.removeFirst()) }
            }
            if entry.record.speed?.observer == observer && entry.record.speed?.key == key {
                // 相同确认样本不改时间戳，也不产生磁盘写入。
            } else if firstSeen >= (entry.record.speed?.savedAt ?? 0) {
                entry.record.speed = Speed(tps: tps, tokens: tokens, seconds: seconds, samples: 1, savedAt: firstSeen, observer: observer, key: key)
            }
        }
        if (cache["issue"] == nil || cache["issue"] is NSNull), let ratio = number(cache["cache_hit"]), (0...1).contains(ratio), entry.record.cache?.ratio != ratio {
            entry.record.cache = Cache(ratio: ratio, savedAt: Date().timeIntervalSince1970)
        }
        if entry.record != before { entry.dirty = true }
        save(&entry)
        entries[thread] = entry; order.removeAll { $0 == thread }; order.append(thread)
        // 内存缓存有界，完整历史保留在磁盘；活跃条目的失败写入每 5 秒重试。
        while order.count > 32 {
            entries.removeValue(forKey: order.removeFirst())
        }
        if let saved = entry.record.speed {
            let previous: JObject = ["tps": saved.tps, "tokens": saved.tokens, "seconds": saved.seconds, "measured_samples": saved.samples, "saved_at": saved.savedAt]
            result["saved_reading"] = previous
            if !(number(stream["tps"]).map { $0 > 0 } ?? false) {
                result["tps"] = saved.tps; result["measured_tokens"] = saved.tokens; result["measured_seconds"] = saved.seconds
                result["measured_samples"] = saved.samples; result["state"] = "saved"
                result["speed_persisted"] = true; result["speed_saved_at"] = saved.savedAt
                result["reading_observer_id"] = saved.observer; result["sample_key"] = saved.key
            }
        }
        if let saved = entry.record.cache, number(cache["cache_hit"]) == nil || !(cache["issue"] == nil || cache["issue"] is NSNull) {
            result["cache_hit"] = saved.ratio; result["cache_persisted"] = true; result["cache_saved_at"] = saved.savedAt
        }
        result["persistence_issue"] = entry.issue ?? (null as Any)
        return result
    }
}
