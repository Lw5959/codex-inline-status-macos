#!/usr/bin/env python3
"""原生菜单栏 App 的 JSON 服务桥；打包运行时与用户数据分离。"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import manage
from network_broker import proxy_url


def system_proxy():
    output = subprocess.run(["/usr/sbin/scutil", "--proxy"], capture_output=True, text=True, timeout=5).stdout
    values = {}
    for line in output.splitlines():
        if " : " in line:
            key, value = line.strip().split(" : ", 1); values[key] = value
    if values.get("HTTPSEnable") == "1":
        return proxy_url(f"http://{values['HTTPSProxy']}:{values['HTTPSPort']}")
    if values.get("ProxyAutoConfigEnable") == "1":
        raise ValueError("当前系统使用 PAC，不能直接确定上游代理。请在面板填入实际使用的 HTTP 或 SOCKS 代理地址。")
    return ""


def settings(root):
    return {"mode": "automatic", "timezone": "America/New_York", "upstream": "system", "port": 9335,
            **manage.read_json(root / "desktop-settings.json")}


def save_settings(root, value):
    if value.get("mode") not in {"automatic", "manual"}:
        raise ValueError("请选择自动或手动时区模式。")
    zone = value.get("timezone", "")
    try:
        ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        raise ValueError("请输入有效 IANA 时区，例如 America/New_York。")
    upstream = value.get("upstream", "system").strip()
    if upstream not in {"system", "direct"}:
        upstream = proxy_url(upstream)
    port = value.get("port", 9335)
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("接入端口必须为 1024–65535。")
    saved = {"mode": value["mode"], "timezone": zone, "upstream": upstream, "port": port}
    manage.atomic_json(root / "desktop-settings.json", saved)
    return saved


def prepare(root, resources):
    engine = resources / "engine"
    manifest = manage.read_json(resources / "payload.json")
    if not manifest or not (engine / "macos/manage.py").is_file():
        raise ValueError("App 运行文件不完整，请重新解压完整 App。")
    root.mkdir(parents=True, exist_ok=True); root.chmod(0o700)
    (root / "var").mkdir(exist_ok=True)
    with (root / "var/launch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = manage.read_json(root / "macos-config.json")
        if current.get("payloadVersion") == manifest["version"] and (root / "runtime/python/bin/python3").exists():
            return
        for source in engine.rglob("*"):
            if source.is_symlink():
                raise ValueError("App 源码包含不支持的链接。")
            if not source.is_file():
                continue
            relative = source.relative_to(engine)
            target = root / relative
            manage.ensure_destination(target, root)
            if target.exists() and target.read_bytes() != source.read_bytes():
                old = root / "backups" / ("desktop-" + manifest["version"]) / relative
                if not old.exists():
                    old.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(target, old)
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(target.name + ".app.tmp")
            shutil.copy2(source, temp); temp.replace(target)
        runtime = root / "runtime"
        marker = manage.read_json(runtime / "runtime-version.json")
        if marker != manifest["runtime"]:
            staging = root / ("runtime-stage-" + uuid.uuid4().hex)
            shutil.copytree(resources / "runtime", staging, symlinks=True)
            manage.atomic_json(staging / "runtime-version.json", manifest["runtime"])
            if runtime.exists():
                backup = root / "backups" / ("runtime-" + uuid.uuid4().hex)
                backup.parent.mkdir(exist_ok=True); runtime.rename(backup)
            staging.rename(runtime)
        official, _ = manage.find_app(current.get("app"))
        current.update(node=str(runtime / "node"), python=str(runtime / "python/bin/python3"),
                       app=str(official), payloadVersion=manifest["version"], version="2.0.0")
        manage.atomic_json(root / "macos-config.json", current)


def broker_call(record, action):
    connection = http.client.HTTPConnection("127.0.0.1", record["port"], timeout=65)
    try:
        connection.request("POST", "/" + action, headers={"Authorization": "Bearer " + record["token"]})
        response = connection.getresponse()
        data = json.loads(response.read(65536))
        if response.status != 200:
            raise ValueError(data.get("error", "本机网络通道暂不可用。"))
        return data
    finally:
        connection.close()


def ensure_broker(root, options):
    upstream = options["upstream"]
    upstream = system_proxy() if upstream == "system" else "" if upstream == "direct" else proxy_url(upstream)
    state = root / "var/broker.json"
    record = manage.read_json(state)
    try:
        health = broker_call(record, "health")
        if record.get("upstream") == upstream:
            return record
        # 不在已有模型连接中途换通道，避免打断正在运行的任务。
        if health.get("activeConnections", 0) > 0:
            raise ValueError("上游代理已改变。请先正常退出 ChatGPT，再重新启动以切换网络通道。")
    except (KeyError, OSError, http.client.HTTPException):
        pass
    run_id = uuid.uuid4().hex
    record = {"runId": run_id, "upstream": upstream, "token": uuid.uuid4().hex + uuid.uuid4().hex}
    manage.atomic_json(state, record); state.chmod(0o600)
    config = manage.read_json(root / "macos-config.json")
    with (root / "var/broker.log").open("a") as log:
        child = subprocess.Popen([config["python"], "-B", str(root / "macos/network_broker.py"), "--state", str(state), "--run-id", run_id],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise ValueError("本机网络通道未启动，请查看诊断后重试。")
        record = manage.read_json(state)
        if record.get("runId") == run_id and record.get("port"):
            broker_call(record, "health"); return record
        time.sleep(0.1)
    raise ValueError("本机网络通道启动超时。")


def detect(root, options):
    record = ensure_broker(root, options)
    result = broker_call(record, "trace")
    manage.atomic_json(root / "var/last-detection.json", result)
    return result


def launch(root, options, cached=False, attach=False):
    config = manage.read_json(root / "macos-config.json")
    official, executable = manage.find_app(config.get("app"))
    running = manage.app_running(executable)
    port = options["port"]
    if attach:
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = manage.launch(root, port, attach_only=True)
        return {"ok": code == 0, "message": output.getvalue().strip(), "status": status(root)}
    if running:
        previous = manage.read_json(root / "var/desktop-launch.json")
        if previous.get("appPid") not in app_pids(executable):
            raise ValueError("ChatGPT 已经在运行，无法补设当前进程的网络通道或时区。请正常退出 ChatGPT（⌘Q），再点击本 App 的启动按钮。当前任务不会被关闭。")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = manage.launch(root, port)
        return {"ok": code == 0, "message": output.getvalue().strip() + " 当前进程时区保持不变。", "status": status(root)}
    record = ensure_broker(root, options)
    if options["mode"] == "manual":
        zone = options["timezone"]
    else:
        if cached:
            observation = manage.read_json(root / "var/last-detection.json")
            if (time.time() - observation.get("checkedAt", 0) > 300
                or observation.get("upstreamHash") != hashlib.sha256(record["upstream"].encode()).hexdigest()):
                raise ValueError("上次检测已超过 5 分钟或网络路径已变，请重新检测。")
        else:
            observation = detect(root, options)
        zone = observation["timezone"]
    # 转发器只取系统分配的空闲端口；不占用 CDP 或其他插件的固定端口。
    proxy = f"http://127.0.0.1:{record['port']}"
    environment = {"TZ": zone, "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
                   "http_proxy": proxy, "https_proxy": proxy, "all_proxy": proxy,
                   "NO_PROXY": "localhost,127.0.0.1,::1", "no_proxy": "localhost,127.0.0.1,::1"}
    with contextlib.redirect_stdout(io.StringIO()) as output:
        code = manage.launch(root, port, launch_env=environment, proxy_server=proxy)
    pids = app_pids(executable)
    manage.atomic_json(root / "var/desktop-launch.json", {"timezone": zone, "appPid": pids[0] if pids else None, "brokerPort": record["port"]})
    return {"ok": code == 0, "message": output.getvalue().strip() + f" 时区：{zone}。", "status": status(root)}


def app_pids(executable):
    rows = subprocess.run(["/bin/ps", "-axo", "pid=,comm="], capture_output=True, text=True, timeout=5).stdout.splitlines()
    return [int(row.strip().split(None, 1)[0]) for row in rows if row.strip().endswith(" " + str(executable))]


def status(root):
    options = settings(root)
    config = manage.read_json(root / "macos-config.json")
    health = manage.read_json(root / "var/health.json")
    runtime = manage.read_json(root / "var/runtime.json")
    fresh = manage.healthy(runtime, health) and manage.owned(root, runtime)
    return {"settings": options, "detection": manage.read_json(root / "var/last-detection.json"),
            "status": health.get("status", "未连接") if fresh else "未连接", "bindingCount": health.get("bindingCount", 0) if fresh else 0,
            "installed": bool(config), "lastLaunch": manage.read_json(root / "var/desktop-launch.json")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "status", "save", "detect", "launch", "launch-cached", "attach", "stop"])
    parser.add_argument("--root", type=Path, default=manage.DEFAULT_ROOT)
    parser.add_argument("--resources", type=Path)
    parser.add_argument("--settings-json")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().absolute()
        if args.action == "prepare":
            prepare(root, args.resources)
            result = {"ok": True, "status": status(root)}
        elif args.action == "status":
            result = {"ok": True, "status": status(root)}
        elif args.action == "save":
            save_settings(root, json.loads(args.settings_json)); result = {"ok": True, "status": status(root), "message": "设置已保存；时区和网络设置在下次从本 App 启动 ChatGPT 时生效。"}
        elif args.action == "detect":
            detect(root, settings(root)); result = {"ok": True, "status": status(root), "message": "已取得 GPT 同域、同转发通道的出口与时区。"}
        elif args.action in {"launch", "launch-cached", "attach"}:
            result = launch(root, settings(root), args.action == "launch-cached", args.action == "attach")
        else:
            with (root / "var/launch.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                manage.stop_owned(root, manage.read_json(root / "var/runtime.json"))
            result = {"ok": True, "status": status(root), "message": "已停止状态条；保留 ChatGPT 及它使用的网络通道。"}
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError, http.client.HTTPException):
        error = sys.exception()
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else "操作未完成。请检查网络与 App 文件完整性后重试。"
        print(json.dumps({"ok": False, "message": message}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
