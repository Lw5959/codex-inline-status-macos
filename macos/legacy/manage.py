#!/usr/bin/env python3
"""macOS 安装和启动入口；只使用 Python 标准库。"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import uuid
import venv

# 源码已归档到 macos/legacy；历史安装目录仍保持 macos/manage.py，避免破坏旧入口。
SOURCE = (Path(__file__).resolve().parents[2] if Path(__file__).parent.name == "legacy"
          else Path(__file__).resolve().parents[1])
DEFAULT_ROOT = Path.home() / "Library/Application Support/CodexInlineStatus"
DEFAULT_APP = Path.home() / "Applications/Codex Inline Status.app"
VERSION = "1.3.5-macos.1"
RUNTIME_FILES = (
    "native_statusbar.js", "native_status_injector.mjs", "native_status_backend.py",
    "codex_status_backend.py", "turn_elapsed_meter.py", "visible_stream_observer.js",
    "visible_stream_meter.mjs", "visible_tokenizer.mjs", "DSH-MIT-LICENSE.txt",
    "JS-TIKTOKEN-LICENSE.txt", "BASE64-JS-LICENSE.txt",
)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(path)


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=30, **kwargs)


def find_node(explicit=None):
    # Finder 不加载 nvm，也可能不包含 Homebrew PATH，逐个核实候选运行时。
    candidates = [explicit] if explicit else [shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    if not explicit:
        candidates += [str(p) for p in sorted((Path.home() / ".nvm/versions/node").glob("*/bin/node"), reverse=True)]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            major = int(run([candidate, "--version"]).stdout.strip().lstrip("v").split(".")[0])
            if major >= 22:
                return str(Path(candidate).absolute())
        except (ValueError, OSError, subprocess.SubprocessError):
            continue
    raise RuntimeError("需要 Node.js 22 或更高版本，请安装后重试。")


def find_app(explicit=None):
    # 目前应用可能显示为 ChatGPT.app，但其 Codex bundle id 仍为 com.openai.codex。
    candidates = [Path(explicit)] if explicit else [
        Path("/Applications/Codex.app"), Path("/Applications/ChatGPT.app"),
        Path.home() / "Applications/Codex.app", Path.home() / "Applications/ChatGPT.app",
    ]
    for app in candidates:
        try:
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
            if info.get("CFBundleIdentifier") == "com.openai.codex" and executable.is_file():
                return app.resolve(), executable.resolve()
        except (OSError, ValueError, KeyError, plistlib.InvalidFileException):
            continue
    raise RuntimeError("未找到官方 Codex 应用。可用 --app 指定应用路径。")


def app_running(executable):
    rows = run(["/bin/ps", "-axo", "comm="]).stdout.splitlines()
    return str(executable) in (row.strip() for row in rows)


def cdp_available(port):
    # 禁止代理和重定向，避免调试发现请求离开本机。
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
            targets = json.loads(response.read(1024 * 1024))
        for target in targets if isinstance(targets, list) else []:
            page = urllib.parse.urlparse(target.get("url", ""))
            ws = urllib.parse.urlparse(target.get("webSocketDebuggerUrl", ""))
            if (target.get("type") == "page" and page.scheme == "app"
                and page.path == "/index.html" and ws.scheme == "ws"
                and ws.hostname in {"127.0.0.1", "localhost", "::1"}
                and ws.port == port and not ws.username and not ws.password):
                return True
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return False


def port_free(port):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def fingerprint(root):
    digest = hashlib.sha256()
    for name in sorted(RUNTIME_FILES):
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    for item in sorted((root / "TokenPulse/src").rglob("*.py")):
        digest.update(str(item.relative_to(root)).encode())
        digest.update(item.read_bytes())
    return digest.hexdigest()


def ensure_destination(path, root):
    # 只覆盖自己的已列明文件，拒绝安装目录内部的符号链接。
    cursor = path
    while cursor == root or cursor.is_relative_to(root):
        if cursor.is_symlink():
            raise RuntimeError("安装目标含符号链接，已停止以避免覆盖其他文件。")
        cursor = cursor.parent


def install(root, launcher, app=None, node=None):
    root = root.expanduser().absolute()
    launcher = launcher.expanduser().absolute()
    official, _ = find_app(app)
    protected = [SOURCE, Path.home() / ".codex", official, Path.home(), Path("/")]
    if any(root == p for p in protected) or root.is_relative_to(SOURCE) or root.is_relative_to(Path.home() / ".codex") or root.is_relative_to(official) or root.suffix == ".app":
        raise RuntimeError("安装目录必须独立于源码、Codex 数据和官方应用。")
    if launcher == official or launcher.is_relative_to(official) or launcher.suffix != ".app":
        raise RuntimeError("启动入口必须是独立的 .app，不能覆盖官方应用。")
    node = find_node(node)
    if sys.version_info < (3, 11):
        raise RuntimeError("需要 Python 3.11 或更高版本。")
    node = str(Path(node).absolute())
    files = [(SOURCE / "src" / name, root / name) for name in RUNTIME_FILES]
    files += [(p, root / p.relative_to(SOURCE)) for p in (SOURCE / "TokenPulse/src").rglob("*.py")]
    files += [(Path(__file__).resolve(), root / "macos/manage.py")]
    files += [(SOURCE / name, root / name) for name in (
        "README.md", "docs/legacy-macos.md", "LICENSE", "TokenPulse/LICENSE", "TokenPulse/THIRD_PARTY.md")]
    for source, target in files:
        if not source.is_file() or source.is_symlink():
            raise RuntimeError(f"缺少有效源文件：{source.name}")
        ensure_destination(target, root)
    ensure_destination(root, root)
    ensure_destination(launcher, launcher)
    if launcher.exists() and not (launcher / "Contents/Resources/inline-status-owned").is_file():
        raise RuntimeError("启动入口位置已有其他应用，未覆盖。请用 --launcher 指定其他位置。")
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    state = root / "var"
    ensure_destination(state, root)
    state.mkdir(exist_ok=True)
    with (state / "launch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # 更新之前只停止能够核实属于本工具的后台，不触碰 Codex 进程。
        stop_owned(root, read_json(state / "runtime.json"))
        env_path = root / "TokenPulse/.venv"
        python = env_path / "bin/python3"
        ensure_destination(env_path, root)
        if env_path.exists():
            try:
                run([str(python), "-c", "import sys; assert sys.version_info >= (3,11)"])
            except (OSError, subprocess.SubprocessError):
                raise RuntimeError("已有私有 Python 环境不可用，已保留；请指定新的安装目录。")
        else:
            venv.EnvBuilder(with_pip=False).create(env_path)
        backup = root / "backups" / (dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
        for source, target in files:
            if target.exists():
                old = backup / target.relative_to(root)
                old.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, old)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        env = {**os.environ, "PYTHONPATH": str(root / "TokenPulse/src")}
        run([str(python), "-B", "-c", "import sys; sys.path.insert(0,sys.argv[1]); import native_status_backend", str(root)], env=env)
        atomic_json(root / "macos-config.json", {
            "version": VERSION, "node": node, "app": str(official), "launcher": str(launcher),
            "fingerprint": fingerprint(root),
        })
        create_launcher(root, launcher, python)
    print(f"已安装 macOS 状态条：{root}\n双击启动入口：{launcher}")
    return root


def create_launcher(root, launcher, python):
    contents = launcher / "Contents"
    for relative in ("Contents/Info.plist", "Contents/MacOS/launch", "Contents/Resources/inline-status-owned"):
        ensure_destination(launcher / relative, launcher)
    for relative in ("MacOS", "Resources"):
        (contents / relative).mkdir(parents=True, exist_ok=True)
    info = {"CFBundleName": "Codex Inline Status", "CFBundleDisplayName": "ChatGPT（状态条）",
            "CFBundleIdentifier": "local.codex-inline-status.launcher", "CFBundleExecutable": "launch",
            "CFBundlePackageType": "APPL", "CFBundleVersion": "1.3.5.1", "LSUIElement": True}
    # Dock 使用独立启动器，但沿用官方应用图标，保持熟悉的点击入口。
    official = read_json(root / "macos-config.json").get("app")
    if official:
        try:
            app = Path(official)
            app_info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            icon_name = app_info.get("CFBundleIconFile", "")
            if icon_name and Path(icon_name).name == icon_name:
                icon = app / "Contents/Resources" / icon_name
                if not icon.suffix:
                    icon = icon.with_suffix(".icns")
                if icon.is_file():
                    target_icon = contents / "Resources/AppIcon.icns"
                    ensure_destination(target_icon, launcher)
                    shutil.copy2(icon, target_icon)
                    info["CFBundleIconFile"] = "AppIcon.icns"
        except (OSError, ValueError, plistlib.InvalidFileException):
            pass
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    (contents / "Resources/inline-status-owned").write_text(VERSION)
    script = (contents / "MacOS/launch")
    # Finder 不加载 nvm/Homebrew shell 配置，使用安装时记录的绝对解释器路径。
    script.write_text("#!/bin/sh\nexec " + shlex.quote(str(python)) + " " + shlex.quote(str(root / "macos/manage.py")) + " launch --dialog --install-root " + shlex.quote(str(root)) + "\n")
    script.chmod(0o755)


def owned(root, runtime):
    # PID 可能被复用，必须同时核对完整命令、run id 和端口才能停止后台。
    try:
        pid = int(runtime["pid"])
        if pid <= 1:
            return False
        args = run(["/bin/ps", "-p", str(pid), "-o", "command="]).stdout.strip()
        expected = runtime["command"]
        valid = (expected[1] == str(root / "native_status_injector.mjs")
                 and expected[2:4] == ["--port", str(runtime["port"])]
                 and expected[-2:] == ["--run-id", runtime["runId"]])
        return valid and args == " ".join(expected)
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
        return False


def stop_owned(root, runtime):
    if not owned(root, runtime):
        return False
    os.kill(runtime["pid"], signal.SIGTERM)
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline and owned(root, runtime):
        time.sleep(0.1)
    if owned(root, runtime):
        raise RuntimeError("状态条旧后台仍在清理，未启动第二个后台。请稍后重试。")
    return True


def healthy(runtime, health):
    try:
        stamp = dt.datetime.fromisoformat(health["checkedAt"].replace("Z", "+00:00"))
        age = (dt.datetime.now(dt.timezone.utc) - stamp).total_seconds()
        return (runtime["runId"] == health["runId"] and health["running"] is True
                and 0 <= age <= 15 and health["rendererCount"] > 0)
    except (KeyError, TypeError, ValueError):
        return False


def show_health(health):
    status = health.get("status")
    count = health.get("bindingCount", 0)
    if status in {"attached", "attached-no-data", "attached-partial-data"} and count > 0:
        print(f"已核实状态条显示，数量：{count}。" + ("部分统计暂不可用。" if status == "attached-partial-data" else ""))
        return 0
    print("已连接 Codex，等待可识别的本地对话输入框；尚未确认状态条显示。")
    return 2


def launch(root, port, app=None, attach_only=False, launch_env=None, proxy_server=None):
    config = read_json(root / "macos-config.json")
    if not config:
        raise RuntimeError("尚未安装历史脚本版，请先运行 macos/legacy/Install-macOS.command。")
    official, executable = find_app(app or config.get("app"))
    python = Path(config.get("python") or root / "TokenPulse/.venv/bin/python3")
    app_environment = {**os.environ, "TZ": "America/New_York", **(launch_env or {})}
    try:
        run([config["node"], "--version"])
        run([str(python), "-c", "import sys; assert sys.version_info >= (3,11)"])
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError("Node.js 或私有 Python 环境已失效，请重新运行安装入口。")
    state = root / "var"
    with (state / "launch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("另一个状态条操作正在进行，请稍后重试。")
        if not cdp_available(port):
            if app_running(executable):
                raise RuntimeError("Codex 正在运行，但未开启状态条接入端口。请先正常退出 Codex（⌘Q），再双击 Codex Inline Status 打开；当前聊天和任务未被关闭。")
            if attach_only:
                raise RuntimeError("尚未发现本机 Codex 调试端口；未启动应用。")
            if not port_free(port):
                raise RuntimeError(f"本机端口 {port} 已被其他程序占用。请用 --port 指定其他端口。")
            # 等价于 TZ=America/New_York open -a "ChatGPT"，同时保留状态条接入参数。
            # 仅影响本次新启动的应用；已运行的应用需要用户正常退出后再从此入口打开。
            flags = [f"--remote-debugging-port={port}", "--remote-debugging-address=127.0.0.1"]
            if proxy_server:
                flags += [f"--proxy-server={proxy_server}"]
            run(["/usr/bin/open", "-a", str(official), "--args", *flags], env=app_environment)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and not cdp_available(port):
                time.sleep(0.4)
            if not cdp_available(port):
                raise RuntimeError("Codex 已打开，但 30 秒内未提供可识别的调试页面。应用版本可能限制调试接入；未确认状态条显示。")
        elif not attach_only:
            # 从 Dock 重复点击时仍需激活官方窗口；只读接入模式不抢焦点。
            run(["/usr/bin/open", "-a", str(official)], env=app_environment)
        runtime = read_json(state / "runtime.json")
        health = read_json(state / "health.json")
        code_hash = fingerprint(root)
        if (owned(root, runtime) and runtime.get("port") == port
            and runtime.get("fingerprint") == code_hash and healthy(runtime, health)):
            return show_health(health)
        stop_owned(root, runtime)
        run_id = uuid.uuid4().hex
        command = [config["node"], str(root / "native_status_injector.mjs"), "--port", str(port),
                   "--python", str(python), "--report", str(state / "health.json"), "--run-id", run_id]
        with (state / "injector.log").open("a") as log:
            child = subprocess.Popen(command, cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        runtime = {"pid": child.pid, "port": port, "runId": run_id, "command": command, "fingerprint": code_hash}
        atomic_json(state / "runtime.json", runtime)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f"状态条后台提前退出，请查看 {state / 'injector.log'}。")
            health = read_json(state / "health.json")
            if healthy(runtime, health) and health.get("bindingCount", 0) > 0:
                return show_health(health)
            time.sleep(0.3)
        if healthy(runtime, health):
            return show_health(health)
        stop_owned(root, runtime)
        raise RuntimeError("未收到有效后台状态，已停止本次后台；请查看安装目录 var/injector.log。")


def check(root, port, app=None):
    config = read_json(root / "macos-config.json")
    official, executable = find_app(app or config.get("app"))
    runtime = read_json(root / "var/runtime.json")
    health = read_json(root / "var/health.json")
    result = {"installed": bool(config), "app": str(official), "appRunning": app_running(executable),
              "cdpAvailable": cdp_available(port), "port": port, "ownedWorker": owned(root, runtime),
              "healthFresh": healthy(runtime, health), "status": health.get("status"),
              "bindingCount": health.get("bindingCount", 0)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "launch", "check", "stop"))
    parser.add_argument("--install-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--launcher", type=Path, default=DEFAULT_APP)
    parser.add_argument("--app")
    parser.add_argument("--node")
    parser.add_argument("--port", type=int, default=9335)
    parser.add_argument("--attach-only", action="store_true")
    parser.add_argument("--dialog", action="store_true")
    options = parser.parse_args()
    try:
        if sys.platform != "darwin":
            raise RuntimeError("此入口仅用于 macOS；Windows 请使用原有安装脚本。")
        if not 1024 <= options.port <= 65535:
            raise RuntimeError("端口范围必须为 1024–65535。")
        root = options.install_root.expanduser().absolute()
        if options.action == "install":
            install(root, options.launcher, options.app, options.node)
            return 0
        if options.action == "check":
            return check(root, options.port, options.app)
        if options.action == "stop":
            with (root / "var/launch.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                stopped = stop_owned(root, read_json(root / "var/runtime.json"))
            print("已停止状态条后台。" if stopped else "没有可核实的状态条后台，未停止任何进程。")
            return 0
        result = launch(root, options.port, options.app, options.attach_only)
        if result == 2 and options.dialog:
            subprocess.run(["/usr/bin/osascript", "-e", 'display dialog "已连接 Codex，请打开本地对话以显示状态条。若仍未显示，请运行只读检查入口。" with title "Codex Inline Status" buttons {"好"} default button "好"'], timeout=60)
        return result
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, RuntimeError) else "操作未完成，请检查文件权限或运行环境后重试。"
        print(message, file=sys.stderr)
        if options.dialog:
            # JSON 字符串安全编码为 AppleScript 字面量，不拼接 shell 命令。
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                subprocess.run(["/usr/bin/osascript", "-e", "display dialog " + json.dumps(message, ensure_ascii=False) + ' with title "Codex Inline Status" buttons {"好"} default button "好"'], timeout=60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
