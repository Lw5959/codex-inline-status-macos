# Codex Inline Status for macOS

GPT 启动助手：为官方 Codex 桌面应用添加输入区状态条、可见文本速度和缓存命中率，通过共用本机通道检测 GPT 出口时区。

这是基于 [wenalang05-arch/codex-inline-status](https://github.com/wenalang05-arch/codex-inline-status) v1.3.5 的非官方 macOS 适配，与 OpenAI 无隶属关系，不分发或修改官方应用。保留上游历史、MIT 许可和 Windows 入口。

## 下载与使用

适用于 **Apple Silicon Mac、macOS 14+**，需要已安装并登录官方 Codex 桌面应用。原生 App 仅依赖系统框架，**不内嵌、不调用 Node 或 Python**。

1. 从 [Releases](https://github.com/Lw5959/codex-inline-status-macos/releases/latest) 下载 `GPT-Launcher-2.1.4-macos-arm64.dmg`。
2. 打开 DMG，将 `GPT Launcher.app` 拖入 Applications，再打开「GPT 启动助手」。
3. 检测 GPT 出口。国家代码为美国 `US` 且对应时区属于美国时才允许启动或连接；未知、失败和非美国结果均拦截。
4. 首次使用时，正常退出官方应用后通过助手启动。已经通过助手启动的窗口升级后可点「连接现有窗口」，核验通过后直接接入。

助手从菜单栏打开，不需要另固定到 Dock。不会自动退出当前任务，不修改系统时区、系统代理、官方应用或登录配置。发行包使用本地 ad-hoc 签名，尚未 Apple 公证。

详细操作见 [App 使用说明](docs/app-usage.md)，网络口径和限制见 [原生版说明](docs/desktop-app.md)。

## 功能和统计口径

- **5 秒刷新**：生成中显示最近采样区间的可见正文 tok/s；暂停、思考和工具执行期间保留最近一次有效读数。无有效样本显示「—」，有效低速显示 `<1 tok/s`。
- **会话恢复**：切换回来立即恢复该会话的速度和缓存命中率。已确认摘要按 UUID 落盘，展示快照单独保存；悬浮说明标明历史来源，不继承其他窗口的采样时钟。
- **数字动效**：速度与缓存数字采用约 700ms 上下模糊切换，横线和数字双向过渡，位数变化时宽度平滑变化，遵守系统减少动态效果设置。
- **原生运行**：AppKit 界面，Swift 后台，系统 JavaScriptCore 分词，SQLite 只读获取本机对话的缓存统计。
- **出口校验**：真实 GPT 连接与检测共用本工具的本机 CONNECT 通道；按 GPT 同域回显的明确 IP 查询时区，不读取 Clash 等代理软件配置，不解密 TLS。

速度使用 `o200k_base` 对可见正文分词，扣除首批已经到达的文本；不包含隐藏推理、工具执行或首字等待。它是客户端观测值，不等于服务器解码速度或账单 token。缓存命中率为累计缓存输入 token / 累计输入 token。

CDP 只允许本机连接。保存的统计和展示快照不含聊天正文或认证信息；未知归属、冲突或失效样本会排除。动态出口池中另一条连接的探测结果，不能证明某一条后续模型请求的实际源 IP。

## 工程结构

```text
.
├── macos/
│   ├── AppMain.swift       # 原生菜单栏 App 入口
│   ├── native/             # 通道、监视器、统计、持久化与服务
│   ├── tools/              # 图标构建工具
│   └── legacy/             # 历史 Python/Node 实现，仅供兼容和对照
├── src/                    # 状态条、观察器、计量器、离线 tokenizer 与 Windows 后端
├── scripts/                # App、DMG 构建和性能基准
├── tests/                  # 单元、布局、恢复与原生链路夹具
├── development/            # tokenizer 的可编辑构建入口
├── TokenPulse/             # 保留许可的上游 Python 源码快照
├── docs/                   # 使用、开发和历史兼容说明
├── .github/workflows/      # macOS 构建与回归检查
├── package.json            # 仅用于开发的 Node 依赖和命令
├── package-lock.json
└── Makefile                # 统一构建、测试和打包入口
```

`build/`、`release/`、`outputs/`、依赖缓存和本地诊断记录均不进入源码仓库。DMG 和 ZIP 通过 GitHub Releases 分发。根目录的 PowerShell、CMD 和 VBS 文件继续作为 Windows 兼容入口，见 [Windows 说明](docs/windows.md)。

## 本地开发

构建 App 需要 Apple Silicon Mac、Xcode Command Line Tools 和 Python 3.11+。运行测试、基准或重建 tokenizer 另需 Node.js 22+；这些是开发工具，均不进入发行包。

```sh
npm ci --ignore-scripts
make build
make test
make dmg
```

也可用 `make verify` 按顺序执行构建、测试和 DMG 校验。打包脚本拒绝覆盖同名 DMG，重新打包前需先处理旧产物。开发方法和检查边界见 [构建与验证](docs/macos.md)。

## 许可与来源

新增代码采用 [MIT](LICENSE)。上游来源、第三方许可证和 tokenizer 依赖见 [NOTICE](NOTICE.md)。原始 TokenPulse 的 [许可](TokenPulse/LICENSE)及[第三方声明](TokenPulse/THIRD_PARTY.md)随源码保留。
