import AppKit
import Foundation

final class FlippedDocument: NSView {
    override var isFlipped: Bool { true }
}

// 原生 UI 只负责设置和状态反馈；网络与统计都在随包、受限的本机服务中运行。
func bridge(_ action: String, extra: [String] = []) throws -> (Int32, Data) {
    guard let resources = Bundle.main.resourceURL else {
        throw NSError(domain: "Launcher", code: 1, userInfo: [NSLocalizedDescriptionKey: "App 资源不完整，请重新解压。"])
    }
    let process = Process()
    process.executableURL = Bundle.main.executableURL
    process.arguments = ["--native-service", action, "--resources", resources.path] + extra
    var environment = ProcessInfo.processInfo.environment
    // Finder 的启动环境不含开发工具；只使用包内运行时和系统工具。
    environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    process.environment = environment
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    try process.run()
    DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
        if process.isRunning { process.terminate() }
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, data)
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var item: NSStatusItem!
    private var panel: NSWindow!
    private let mode = NSPopUpButton()
    private let zone = NSComboBox()
    private let upstream = NSTextField()
    private let port = NSTextField()
    private let ip = NSTextField(wrappingLabelWithString: "尚未检测")
    private let state = NSTextField(wrappingLabelWithString: "正在初始化原生助手…")
    private let policy = NSTextField(wrappingLabelWithString: "区域限制：仅允许美国出口和美国时区")
    private let notice = NSTextField(wrappingLabelWithString: "")
    private var buttons: [NSButton] = []
    private var busy = false
    private var ready = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // 菜单栏 App 仍需标准主菜单，保证 ⌘Q 及输入框的复制、粘贴快捷键可用。
        let mainMenu = NSMenu()
        let appEntry = NSMenuItem(); let appMenu = NSMenu()
        let quitItem = NSMenuItem(title: "退出 GPT 启动助手", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = NSApp; appMenu.addItem(quitItem); appEntry.submenu = appMenu; mainMenu.addItem(appEntry)
        let editEntry = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); let editMenu = NSMenu(title: "编辑")
        for (title, selector, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        editEntry.submenu = editMenu; mainMenu.addItem(editEntry); NSApp.mainMenu = mainMenu
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "globe.badge.chevron.backward", accessibilityDescription: "GPT 启动助手")
        item.button?.toolTip = "GPT 启动助手"
        let menu = NSMenu()
        menu.addItem(withTitle: "打开控制面板…", action: #selector(showPanel), keyEquivalent: "")
        menu.addItem(withTitle: "启动 ChatGPT", action: #selector(startGPT), keyEquivalent: "")
        menu.addItem(withTitle: "检测 GPT 出口", action: #selector(detectIP), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出启动助手", action: #selector(quit), keyEquivalent: "q")
        for entry in menu.items { entry.target = self }
        item.menu = menu
        createPanel()
        showPanel()
        execute("prepare", successMessage: "原生版已就绪。启动前必须核实美国出口和美国时区。")
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel(); return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false // 关闭面板后继续通过菜单栏使用，不创建第二个 Dock 图标。
    }

    @objc func showPanel() {
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func quit() { NSApp.terminate(nil) }

    private func label(_ text: String, size: CGFloat = 13, color: NSColor = .labelColor) -> NSTextField {
        let result = NSTextField(wrappingLabelWithString: text)
        result.font = .systemFont(ofSize: size)
        result.textColor = color
        return result
    }

    private func row(_ title: String, _ control: NSView) -> NSStackView {
        let name = label(title)
        name.widthAnchor.constraint(equalToConstant: 108).isActive = true
        let stack = NSStackView(views: [name, control])
        stack.orientation = .horizontal; stack.spacing = 12; stack.alignment = .centerY
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return stack
    }

    private func button(_ text: String, _ action: Selector) -> NSButton {
        let result = NSButton(title: text, target: self, action: action)
        result.bezelStyle = .rounded
        buttons.append(result)
        return result
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        return box
    }

    private func createPanel() {
        // 参考用户截图的紧凑窗口：约 720×615（含标题栏），字号不缩小。
        // 内容高度变化时由滚动容器承接，避免错误提示或底部操作被裁掉。
        panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 580), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        panel.title = "GPT 启动助手"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.minSize = NSSize(width: 660, height: 540)
        panel.center()
        let scroll = NSScrollView(frame: panel.contentView!.bounds)
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        let document = FlippedDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        panel.contentView!.addSubview(scroll)
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        let content = NSStackView()
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 28),
            content.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -28),
            content.topAnchor.constraint(equalTo: document.topAnchor, constant: 24),
            content.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -24)
        ])
        let title = label("GPT 启动助手", size: 25)
        title.font = .systemFont(ofSize: 25, weight: .semibold)
        content.addArrangedSubview(title)
        content.addArrangedSubview(label("内嵌状态条 · GPT 出口时区 · 不额外占用 Dock", size: 13, color: .secondaryLabelColor))
        state.font = .systemFont(ofSize: 13, weight: .medium)
        state.setAccessibilityIdentifier("connection-status")
        content.addArrangedSubview(state)
        policy.font = .systemFont(ofSize: 12, weight: .medium)
        policy.textColor = .systemRed
        policy.setAccessibilityIdentifier("us-region-policy")
        content.addArrangedSubview(policy)
        content.addArrangedSubview(separator())
        mode.addItems(withTitles: ["自动：按 GPT 出口设置", "手动指定时区"])
        mode.target = self; mode.action = #selector(modeChanged)
        zone.addItems(withObjectValues: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu"])
        zone.stringValue = "America/New_York"; zone.completes = true
        upstream.placeholderString = "system、direct 或 http://127.0.0.1:7890"
        port.stringValue = "9335"
        ip.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        ip.setAccessibilityIdentifier("gpt-egress-result")
        for view in [row("时区模式", mode), row("手动时区", zone), row("上游代理", upstream), row("状态条端口", port), row("GPT 出口", ip)] {
            content.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }
        content.addArrangedSubview(label("system：跟随系统 HTTPS 代理；direct：直接连接（仍受 VPN / TUN 路由影响）。\n本 App 通过同一本机通道访问 GPT 和检测出口，不读取 Clash 等代理软件。", size: 12, color: .secondaryLabelColor))
        let settingsButtons = NSStackView(views: [button("保存设置", #selector(save)), button("检测 GPT 出口", #selector(detectIP)), button("刷新状态", #selector(refresh))])
        settingsButtons.spacing = 10
        content.addArrangedSubview(settingsButtons)
        content.addArrangedSubview(separator())
        let launchButton = button("启动 ChatGPT 并加载状态条", #selector(startGPT))
        launchButton.keyEquivalent = "\r"
        let actions = NSStackView(views: [launchButton, button("连接现有窗口", #selector(attach)), button("停止状态条", #selector(stop))])
        actions.spacing = 8
        content.addArrangedSubview(actions)
        notice.font = .systemFont(ofSize: 12)
        notice.textColor = .secondaryLabelColor
        notice.setAccessibilityIdentifier("operation-message")
        content.addArrangedSubview(notice)
        notice.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        let footer = label("非美国结果或无法核实时禁止启动，手动设置和旧缓存均不能绕过。\n不会自动退出当前 ChatGPT。动态出口池无法证明某条后续模型请求的源 IP。", size: 11, color: .secondaryLabelColor)
        content.addArrangedSubview(footer)
        footer.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        for view in [state, ip] { view.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor).isActive = true }
    }

    @objc func modeChanged() { zone.isEnabled = mode.indexOfSelectedItem == 1 && !busy }

    private func selectedSettings() throws -> String {
        guard let number = Int(port.stringValue) else {
            throw NSError(domain: "Launcher", code: 2, userInfo: [NSLocalizedDescriptionKey: "请输入有效端口号。"])
        }
        let value: [String: Any] = ["mode": mode.indexOfSelectedItem == 0 ? "automatic" : "manual", "timezone": zone.stringValue, "upstream": upstream.stringValue.isEmpty ? "system" : upstream.stringValue, "port": number]
        return String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
    }

    private func apply(_ value: [String: Any], loadSettings: Bool) {
        let current = value["status"] as? String ?? "未连接"
        let descriptions = ["attached": "状态条已连接", "attached-no-data": "已连接，等待新的可测回复", "attached-partial-data": "已连接，部分统计暂不可用", "waiting-for-conversation": "已连接，等待本地对话"]
        state.stringValue = (descriptions[current] ?? current) + " · 输入区 \(value["bindingCount"] as? Int ?? 0) 个"
        policy.stringValue = "区域限制：" + (value["regionPolicy"] as? String ?? "未核实为美国出口，禁止启动")
        policy.textColor = (value["detection"] as? [String: Any])?["allowed"] as? Bool == true ? .systemGreen : .systemRed
        if loadSettings, let settings = value["settings"] as? [String: Any] {
            mode.selectItem(at: settings["mode"] as? String == "manual" ? 1 : 0)
            zone.stringValue = settings["timezone"] as? String ?? "America/New_York"
            upstream.stringValue = settings["upstream"] as? String ?? "system"
            port.stringValue = String(settings["port"] as? Int ?? 9335)
        }
        if let detection = value["detection"] as? [String: Any], let address = detection["ip"] as? String {
            let timezone = detection["timezone"] as? String ?? "未知"
            let location = [detection["country"] as? String, detection["city"] as? String].compactMap { $0 }.joined(separator: " · ")
            let checked = Date(timeIntervalSince1970: detection["checkedAt"] as? Double ?? 0)
            let formatter = DateFormatter(); formatter.dateStyle = .short; formatter.timeStyle = .short
            ip.stringValue = "\(address) → \(timezone)\n\(location) · 检测于 \(formatter.string(from: checked))"
        } else { ip.stringValue = "尚未取得可核实结果" }
        modeChanged()
    }

    private func execute(_ action: String, saveFirst: Bool = false, successMessage: String? = nil) {
        guard !busy else { return }
        guard ready || action == "prepare" else { return }
        var payload: String? = nil
        if saveFirst {
            do { payload = try selectedSettings() }
            catch { notice.stringValue = error.localizedDescription; return }
        }
        busy = true
        for button in buttons { button.isEnabled = false }
        mode.isEnabled = false; zone.isEnabled = false; upstream.isEnabled = false; port.isEnabled = false
        notice.textColor = .secondaryLabelColor
        notice.stringValue = action == "detect" || action == "launch" ? "正在核对 GPT 出口与时区，请稍候…" : "正在处理…"
        let savedPayload = payload
        DispatchQueue.global(qos: .userInitiated).async {
            var response: [String: Any] = [:]
            do {
                if let savedPayload {
                    let (_, data) = try bridge("save", extra: ["--settings-json", savedPayload])
                    let saved = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                    if saved["ok"] as? Bool != true { throw NSError(domain: "Launcher", code: 3, userInfo: [NSLocalizedDescriptionKey: saved["message"] as? String ?? "保存设置失败。"]) }
                }
                let (_, data) = try bridge(action, extra: action == "save" ? ["--settings-json", savedPayload ?? "{}"] : [])
                response = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            } catch { response = ["ok": false, "message": error.localizedDescription] }
            let finished = response
            DispatchQueue.main.async {
                self.busy = false
                if action == "prepare" { self.ready = finished["ok"] as? Bool == true }
                for button in self.buttons { button.isEnabled = self.ready }
                self.mode.isEnabled = self.ready; self.upstream.isEnabled = self.ready; self.port.isEnabled = self.ready
                let ok = finished["ok"] as? Bool == true
                self.notice.textColor = ok ? .secondaryLabelColor : .systemRed
                self.notice.stringValue = finished["message"] as? String ?? successMessage ?? (ok ? "操作完成。" : "操作未完成。")
                if let state = finished["status"] as? [String: Any] { self.apply(state, loadSettings: action == "prepare" || action == "save") }
                self.modeChanged()
            }
        }
    }

    @objc func save() { execute("save", saveFirst: true) }
    @objc func detectIP() { showPanel(); execute("detect", saveFirst: true) }
    @objc func refresh() { execute("status") }
    @objc func startGPT() { showPanel(); execute("launch", saveFirst: true) }
    @objc func startCached() { execute("launch-cached", saveFirst: true) }
    @objc func attach() { execute("attach") }
    @objc func stop() { execute("stop") }
}

// 复用同一真实入口做无界面验收，验证应用移动后仍能使用包内资源。
_ = NativeEntry.handle(CommandLine.arguments)
if let index = CommandLine.arguments.firstIndex(of: "--service"), CommandLine.arguments.count > index + 1 {
    do {
        let (code, data) = try bridge(CommandLine.arguments[index + 1], extra: Array(CommandLine.arguments.dropFirst(index + 2)))
        FileHandle.standardOutput.write(data)
        exit(code)
    } catch {
        print("{\"ok\":false,\"message\":\"包内服务启动失败\"}")
        exit(1)
    }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
