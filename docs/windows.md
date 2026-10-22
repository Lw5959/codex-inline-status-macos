# Windows 兼容入口（上游 v1.3.5）

以下命令均从工程根目录执行。macOS 原生版请阅读[主说明](../README.md)。

本项目是非官方本地增强工具，与 OpenAI 无隶属关系，也不是官方 Codex 组件。运行环境为 Windows、Node.js 22+ 和 Python 3.11+。通过启动器加载状态条，保留官方 App 及其登录设置。

这份包包含状态条、可见文本流式计量器、离线 tokenizer、Python 后端、TokenPulse 源码和启动脚本。适用于当前 Windows 用户的官方 Codex App；官方账号登录或 API 登录均沿用 App 自己的设置。安装器不读取或修改凭据，不替换官方 App 文件。

## 安装与重新接入

1. 保留整个源码包目录，不要单独移动脚本。先安装 **Node.js 22 或更高版本、Python 3.11 或更高版本**，并使命令可发现。脚本不会下载运行时或第三方包，也不安装 PySide GUI。
2. 双击 `安装或更新.cmd`。默认安装至 `%LOCALAPPDATA%\Programs\CodexInlineStatus`。若已有可用的私有 Python 环境，会复用它；否则用本机 Python 创建不含 pip 的私有 venv。
3. 双击 `启动状态条.vbs`。它定位当前用户最新的 `OpenAI.Codex` 包：App 未运行时通过 Windows 正式激活接口打开，并启用只监听 `127.0.0.1` 的 CDP；App 已带 CDP 运行时直接接入。
4. App 已运行但没有 CDP 时，脚本会保留现状。请自行正常退出 App，再通过本包启动器打开。它不会关闭、杀死或重启 App。

官方 App 升级后，可再次运行启动器。需要恢复状态条自身源码时，再运行安装或更新。包按名称查找当前 App 包，不固定官方版本路径；不过官方更新若改变页面结构或事件协议，状态条仍可能需要适配，不能保证永久兼容。

## 只读检查和可选参数

在源码包目录打开 PowerShell：

```powershell
.\Install-Status.ps1 -CheckOnly
.\Launch-Codex.ps1 -CheckOnly
.\Install-Status.ps1 -NoStart
```

`-CheckOnly` 只报告源文件、运行环境和现有本机 CDP 状态，不复制文件、不创建 venv、不启动后台或 App。`-NoStart` 安装源码但不接入已运行 App。两个脚本均支持 `-InstallRoot 'D:\Tools\CodexInlineStatus'` 和 `-Port 9335`；自定义安装目录时请在 PowerShell 运行安装目录内的 `Launch-Codex.ps1 -InstallRoot ...`，默认 VBS 启动器只查默认目录。

安装器只覆盖 `src/` 中列出的 9 个运行文件、`TokenPulse/src/`、自身启动脚本/说明和随包许可证。旧文件先备份到安装目录的 `backups/<时间>-<随机后缀>/`；不会清空目录、删除旧环境或修改用户 auth/config。无可用 Python、Node 或源码验证失败时会停止。若旧 venv 损坏会保留它，并要求修复或指定新的安装目录。

## 数据含义

- 可见流式速度使用实际收到的 `agentMessage` 文本，以 `o200k_base` 对全文分词。只计首批文本 UTF-8 边界之后的 token，时间取首个到最后一个非空文本 delta 的实际间隔。
- 不把后端总输出 token 或隐藏推理用量除以可见文本的短时间。它表示本机观测到的可见文本吞吐，不是服务端纯解码速度，也不是 DSH 的 provider usage 原口径。
- 观测器只在当前窗口活动对话采集，不补历史；无合格样本时不显示虚构速度。累计范围是当前观测器下最近 128 条合格观测记录。

## 源码结构与检查

`src/` 有 9 个运行文件：`native_statusbar.js`、`native_status_injector.mjs`、`native_status_backend.py`、`codex_status_backend.py`、`turn_elapsed_meter.py`、`start-inline-status.ps1`、`visible_stream_observer.js`、`visible_stream_meter.mjs`、`visible_tokenizer.mjs`。`TokenPulse/src/token_pulse/` 保留 Python 源码；`tests/` 保留离线验证源码，安装器不会把测试复制到运行目录。

状态条后台的状态、启动错误和运行记录位于系统“文档”目录下的 `ChatGPT-Tools\inline-status-state`。这些是本工具自己的运行文件；诊断故障时先运行 `Launch-Codex.ps1 -CheckOnly`，再检查该目录。状态条未接入不等于官方 App 无法使用。


## 开发与重新构建

当前版本将状态条放在输入框整体几何中心左侧 16 CSS 像素处，作视觉平衡微调；左右实际按钮边界仅用于限制两侧对称的可用宽度，防止遮挡。定位不改为左右按钮空白区域的中心。保留各窗口独立统计和切换时后台刷新。
本包没有账号、API Key、认证文件或真实会话日志。Node tokenizer 已随源码提供，正常安装无需联网下载库。
开发依赖已统一到根目录：运行 `npm ci --ignore-scripts`，再按主说明执行测试。
重新生成 tokenizer：

    node node_modules/esbuild/bin/esbuild development/visible_tokenizer_entry.mjs --bundle --platform=node --format=esm --outfile=src/visible_tokenizer.mjs

每个窗口只统计自己当前绑定的对话；即使两个窗口显示同一对话，也不混用观测时钟或样本。状态条由启动器加载，并不会替换官方 App 文件。

仓库只包含源码、开发依赖锁文件及许可证，不包含个人接续文档、账户凭据、会话日志、虚拟环境或运行报告。官方更新改变页面结构或事件协议后，可能需要重新适配。


## 许可

项目新增代码按根目录 `LICENSE` 的 MIT 条款提供。第三方代码保留各自版权与许可：`TokenPulse/LICENSE`、`TokenPulse/THIRD_PARTY.md`、`src/DSH-MIT-LICENSE.txt`、`src/JS-TIKTOKEN-LICENSE.txt` 和 `src/BASE64-JS-LICENSE.txt`。离线 tokenizer 的第三方许可不因打包而改变。
