# macOS 构建与验证

当前发布产品是纯原生 `GPT Launcher.app`。使用方法见 [App 使用说明](app-usage.md)，网络口径和限制见 [原生版说明](desktop-app.md)。历史 Python/Node 入口已归档至 `macos/legacy/`，不进入原生发行包。

## 开发环境

- Apple Silicon Mac、macOS 14+、Xcode Command Line Tools。
- Python 3.11+：开发期打包及历史实现回归，不进入原生产品。
- Node.js 22+：DOM/流式测试、性能基准及 tokenizer 重建，不参与 App 运行。
- 根目录 `package.json` 和 `package-lock.json` 固定开发依赖；不用安装 TokenPulse GUI 依赖。

在工程根目录执行：

```sh
npm ci --ignore-scripts
make build
make test
make dmg
```

`make verify` 顺序执行后三步。已有同名 DMG 时打包脚本会停止，避免误覆盖发行文件；确认不再需要旧产物后再移动或删除。

## 源码与产物

| 目录 | 职责 |
| --- | --- |
| `macos/AppMain.swift`、`macos/native/` | AppKit 界面与 Swift 原生运行链路 |
| `macos/tools/` | 仅在构建时使用的图标工具 |
| `src/` | 状态条、观察器、计量器、离线词表及 Windows 兼容后端 |
| `macos/legacy/` | 历史 Python/Node 启动器、服务和转发器 |
| `scripts/` | 可维护的构建、DMG 校验和性能基准 |
| `tests/`、`tests/fixtures/` | 自动回归和明确标注的模拟页面 |
| `development/` | tokenizer 的未打包入口 |
| `build/` | 生成的 Swift 入口、图标工具和本地过程文件 |
| `release/` | 正式 App 和 DMG |
| `outputs/` | 交付副本、ZIP、校验结果；全部由构建生成 |

源码 `macos/legacy/manage.py` 迁移后，历史安装目录仍使用 `macos/manage.py`，保持旧启动入口兼容。回归通过临时安装根目录执行，不使用真实聊天数据。旧版使用方法见 [历史 macOS 说明](legacy-macos.md)。

## 验证入口

```sh
npm test
PYTHONPATH=src:TokenPulse/src python3 -m unittest discover -s tests -p 'test_*.py'
npm run benchmark
```

`npm test` 运行前必须已构建 App。原生夹具实际启动编译后的 Swift 程序，通过合成 CDP 页面核对分词、独立窗口、5 秒刷新、缓存统计、切换恢复、持久化、美国限制、旧版通道兼容及停止清理。

Python 回归覆盖归档实现。平台不支持的测试会明确标为跳过。Windows 入口另有 `tests/test-inline-status-launcher.ps1`；macOS 上不把它视作已执行。

`npm run benchmark` 是 100 次相同更新、32 条完成样本与 1000 条历史节点的合成负载，用于核对扫描和布局读取开销，不能代替真实应用帧率验收。

DMG 构建会检查映像校验和、只读挂载后的 App 文件与权限、ad-hoc 签名和 Applications 链接，并卸载映像。`outputs/DMG验证记录.json` 只作为本地结果保存。

## 真实应用验收

自动测试不能证明新版本官方应用仍接受 CDP 和当前 DOM。真实验收应通过助手启动或「连接现有窗口」，核对状态条接入、连续输出、会话切回历史回显及新采样覆盖。不得为了验收自动退出或重启正在运行的官方应用。

没有自己的有效样本时保持无数据；恢复值要标明来源，不能借用另一会话或窗口的时钟。真实验收产生的 IP、UUID、日志、截图和安装路径只留在本地忽略目录，不放进公开提交或 Release。

## 重建 tokenizer

```sh
npm run build:tokenizer
```

从 `development/visible_tokenizer_entry.mjs` 生成 `src/visible_tokenizer.mjs`。依赖固定为 `js-tiktoken@1.0.21` 与 `o200k_base`，修改后重新构建 App 并运行分词和原生 JavaScriptCore 回归，保留相关许可证。

CI 使用公开仓库的 macOS Apple Silicon runner，标签与架构依据 [GitHub 托管运行器文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，结果以对应 Actions 任务为准。
