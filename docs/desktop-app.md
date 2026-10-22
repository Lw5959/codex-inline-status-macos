# GPT 启动助手 2.1.4 · 纯原生版

适用于 Apple Silicon、macOS 14+，需要已经安装并登录官方 Codex 桌面 App（本机名称为 ChatGPT）。运行只使用系统 AppKit、Foundation、JavaScriptCore、SystemConfiguration 与 SQLite。**不内嵌 Node 或 Python，也不要求用户安装它们。**

## 安装和操作

1. 打开 `GPT-Launcher-2.1.4-macos-arm64.dmg`，把 `GPT Launcher.app` 拖到 `Applications`，再从应用程序目录打开。
2. 默认使用「自动：按 GPT 出口设置」。点击「检测 GPT 出口」，核对 IP、时区和区域限制提示。
3. 已有 ChatGPT 正在运行时，请先自行正常退出（⌘Q），再点击启动按钮。助手不会自动退出当前任务，也不能给已有进程补改网络通道或时区。
4. 助手从菜单栏打开面板，关闭面板后继续留在菜单栏；不要再单独固定助手到 Dock。

默认窗口约 720×615（包含标题栏）；保留正常字号，并可滚动和调整窗口大小。

## 美国区域限制

启动和连接操作每次都重新检测。出口 IP 的国家代码必须为 `US`，时区也必须属于 IANA 数据中美国的时区；两个条件同时成立才放行。

- `America/Toronto`、`America/Vancouver`、`America/Mexico_City` 等不是美国时区，不因 `America/` 前缀而放行。
- 手动时区仅接受美国时区；改为纽约不能绕过非美国出口。
- 检测失败、无国家代码、无有效时区或出口不稳定时，提示并禁止从助手启动或加载。
- 不再提供缓存放行。旧的 `launch-cached` 接口也会重新检测，旧美国结果不能覆盖新出现的非美国或未知结果。
- 后续切换代理节点时应重新检测；助手不会强行关闭从其他入口运行的 ChatGPT。

## 出口口径与边界

真实 GPT 连接与探测共用一个原生本机 CONNECT 转发进程，走相同的上游函数；不读取 Clash 或其他代理软件的配置。

```text
ChatGPT / Codex ──┐
                 ├─ 原生本机转发进程 ─ 上游代理或直接路由 ─ GPT 域名
GPT 出口检测 ────┘
```

检测访问 `https://chatgpt.com/cdn-cgi/trace`，要求连续两次返回相同公网 IP，再向 `https://ipwho.is/<该IP>` 查询时区。不会拿地理网站自己的出口、Cloudflare 机房或国家码推测时区。地理查询只发送这个明确的公开 IP，不发送账号、聊天或密钥。[Cloudflare 端点](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/)、[时区字段](https://ipwhois.io/documentation)。

这是 GPT 同域、同转发通道的即时观测，仍不能证明某条后续模型请求的实际源 IP。上游若逐连接随机分配出口，需要使用稳定节点；软件不宣称独立探测可以证明每一次推理的源地址。

`system` 跟随系统 HTTPS 代理；`direct` 不使用额外 HTTP/SOCKS 上游，但仍受 VPN/TUN 路由影响。也可填写不带账号密码的 HTTP 或 SOCKS5h 地址。PAC 无法自动解析时提示填写实际地址，不静默直连。

本机通道只监听 `127.0.0.1`，由系统分配空闲端口；只接受允许的 GPT、登录和时区查询 HTTPS 域名。控制接口有随机令牌。TLS 字节原样透传，不安装证书，不解密模型连接。

## 原生统计与运行管理

Swift 的 URLSessionWebSocketTask 处理本机 CDP，系统 JavaScriptCore 执行与原版相同的离线 tokenizer 和流式计量代码。保留完整文本 BPE、UTF-8 边界、不同窗口独立观测、观察器重置和无样本不显示速度的规则。

2.1.4 每 5 秒采样一次，有新正文时更新最近区间速度；暂停、思考、工具执行和下一轮等待期间保留本对话最近一次有效读数，不归零。完成后显示最近一段已确认回复的速度，避免跨轮历史平均抹平变化。无有效样本时显示破折号；低于 1 tok/s 的有效速度显示 `<1 tok/s`。已完成消息不重复传输全文，普通数值刷新不扫描整页或同步测量布局。

动效默认开启，横线占位符恢复为数字、数字首次出现和变化时播放约 700ms 的上下切换。只动画位移和透明度，轻微模糊采用静态叠层交叉淡入淡出；数字固有宽度由 ResizeObserver 异步交付，容器宽度同样用 700ms 过渡，三位与两位互换时单位和整组位置平滑移动。没有逐帧 JS 或同步字宽测量；系统开启“减少动态效果”时直接切换。同值不播放，图标与文字间距为 3px。

会话切回立即恢复上次显示的速度与缓存命中率，展示快照按 UUID 保存在插件专用的本地页面存储；不等待下一次采样，也不把旧窗口的计时状态带入新窗口。已确认统计另保存在 `var/conversations/`。未完成采样的回显明确标为历史值；出现实质冲突时撤销，切换导致的采样中止本身不抹去离开前已经显示的区间读数。

SQLite 只读连接按选中线程查找 JSONL；读取有字节预算，逐段追赶。只在确认记录属于当前线程后采用累计缓存计数。历史继承、未知归属、异常来源和追赶阶段不会冒用其他线程的统计。

源码为 `macos/AppMain.swift` 和 `macos/native/*.swift`。助手数据位于 `~/Library/Application Support/CodexInlineStatus`，原生后台复制到 `native/GPTLauncher`。发布包不带旧 Python 源码、解释器、Node 可执行文件或 node_modules。工程保留的旧实现仅供上游兼容与开发期对照，不进入原生包；历史安装的备份不自动删除。

升级助手后，如果原 ChatGPT 进程仍在使用可核实的本工具通道，上游设置一致、GPT 出口重新通过美国限制且 renderer 的真实时区一致，可直接连接；不要求启动器版本一致，不退出或重启 ChatGPT。通道不匹配、未开启 CDP 或实际时区不一致时仍说明原因并提示必要的恢复操作。旧通道在被当前应用使用时保留；应用退出后，下次启动再更新通道程序。

不改官方 App、账号、系统时区、全局代理、Dock 或开机启动项。本地 ad-hoc 签名用于完整性检查，未做 Developer ID / Apple 公证。

## 构建和验证

构建机需要 Xcode 命令行工具。`python3 scripts/build_macos_app.py` 生成原生 App 和 ZIP；这里 Python 仅用作开发期打包脚本，不进入产物，也不会成为用户的运行依赖。

`python3 scripts/build_macos_dmg.py` 使用 App 的版本号生成只读 DMG，并实际挂载核对文件、权限、Applications 链接和签名，最后卸载。正式产物位于 `release/`，`outputs/` 是交付副本。

`node --test tests/native-runtime.test.mjs` 是开发期对照测试，覆盖原生 JavaScriptCore 与原版 tokenizer 的一致性、半个 UTF-16 surrogate 边界、窗口隔离、SQLite 归属、原生 TLS 透传、美国策略及缓存绕过阻断。Node 只运行开发测试，不进入或参与发布 App 的运行。
