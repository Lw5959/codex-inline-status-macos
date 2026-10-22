# 历史 macOS Python/Node 版本

此说明仅用于兼容和开发对照。当前用户请使用 [纯原生 App](app-usage.md)，它不依赖 Node 或 Python；归档版本不提供现行原生版的美国区域限制保证。

源码位于 `macos/legacy/`，保留安装、只读检查、接入及后台停止流程。根目录 Windows 入口不受归档影响。

## 旧版入口

旧实现要求 Node.js 22+、Python 3.11+ 及官方 Codex App：

```sh
./macos/legacy/Install-macOS.command
python3 macos/legacy/manage.py check
python3 macos/legacy/manage.py launch --attach-only
python3 macos/legacy/manage.py stop
```

`check` 只读检查，不启动应用。`stop` 仅停止命令、run id 和端口可核实的本工具后台，不退出官方应用。

默认使用独立的 `~/Library/Application Support/CodexInlineStatus` 安装目录和私有 Python 环境。源码迁移后，历史安装目录仍保留 `macos/manage.py`，旧 App 启动脚本无需变更。`app_service.py` 与 `network_broker.py` 是 2.0 版的对照源码，不进入当前原生 App。

固定 `TZ=America/New_York` 仅影响从历史入口新启动的进程，不修改系统时区，也不能改变已有进程。旧方案曾使用独立 Dock 启动器，当前原生版使用菜单栏。

归档回归使用合成数据和临时目录。不要用历史入口更新正在使用原生版的同一安装目录；需要对照时通过 `--install-root` 和 `--launcher` 指定独立位置。
