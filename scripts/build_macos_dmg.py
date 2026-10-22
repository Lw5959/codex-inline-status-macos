#!/usr/bin/env python3
"""将已签名的发布 App 制作为带 Applications 拖拽入口的只读 DMG。"""
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(arguments):
    return subprocess.run(arguments, check=True, capture_output=True)


def manifest(root):
    # 比较内容、链接和可执行权限，避免只验证映像能挂载却漏掉损坏的运行依赖。
    result = {}
    for path in sorted(root.rglob("*")):
        name = str(path.relative_to(root))
        if path.is_symlink():
            result[name] = ["symlink", str(path.readlink())]
        elif path.is_file():
            result[name] = ["file", hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mode & 0o777]
    return result


def main():
    source = ROOT / "release/GPT Launcher.app"
    if not source.is_dir():
        raise SystemExit("请先运行 scripts/build_macos_app.py 构建发布 App。")
    version = plistlib.loads((source / "Contents/Info.plist").read_bytes())["CFBundleShortVersionString"]
    name = f"GPT-Launcher-{version}-macos-arm64.dmg"
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(source)])
    expected = manifest(source)
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    target = ROOT / "release" / name
    if target.exists():
        raise SystemExit(f"发布目标已存在，未覆盖：{target}")
    with tempfile.TemporaryDirectory(prefix="dmg-stage-", dir=build) as stage_name:
        stage = Path(stage_name)
        shutil.copytree(source, stage / source.name, symlinks=True)
        (stage / "Applications").symlink_to("/Applications", target_is_directory=True)
        (stage / "安装说明.txt").write_text(
            f"GPT 启动助手 {version}（纯原生版）\n\n"
            "1. 将 GPT Launcher.app 拖到 Applications 文件夹。\n"
            "2. 从应用程序目录双击打开，使用菜单栏面板。不要将助手另固定到 Dock。\n"
            "3. 点击“检测 GPT 出口”查看出口 IP 及对应时区。\n"
            "4. 首次使用正常退出 ChatGPT（⌘Q）后经助手启动；升级已接入版本可点击“连接现有窗口”。\n\n"
            "适用于 Apple Silicon Mac、macOS 14+，不含 Node 或 Python，也无需另行安装。\n"
            "仅允许美国出口和美国时区；非美国、检测失败或未知结果均禁止启动。\n"
            "本包使用本地签名，尚未 Apple 公证；不会自动退出 ChatGPT 或更改系统代理、时区。\n"
            "动态出口池不能保证每条推理请求的实际 IP；检测不稳定时不会自动设置时区。\n",
            encoding="utf-8",
        )
        shutil.copy2(ROOT / "docs/app-usage.md", stage / "详细使用说明.md")
        run(["/usr/bin/hdiutil", "create", "-volname", "GPT Launcher", "-srcfolder", str(stage),
             "-format", "UDZO", "-fs", "HFS+", "-nospotlight", str(target)])
    run(["/usr/bin/hdiutil", "verify", str(target)])
    with tempfile.TemporaryDirectory(prefix="gpt-dmg-check-") as mount_name:
        mount = Path(mount_name)
        device = None
        try:
            attached = plistlib.loads(run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), "-plist", str(target)]).stdout)
            # macOS 会把 /var 的挂载点返回为 /private/var；按真实路径比较。
            # 先保留本次映像的设备，后续检查失败时也必须先卸载再清理临时目录。
            entities = attached["system-entities"]
            device = next((entry["dev-entry"] for entry in entities if entry.get("dev-entry")), None)
            matched = False
            for entity in entities:
                if entity.get("mount-point") and Path(entity["mount-point"]).resolve() == mount.resolve():
                    device = entity["dev-entry"]
                    matched = True
            if not matched:
                raise RuntimeError("DMG 未挂载到预期检查位置。")
            installed_app = mount / source.name
            run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(installed_app)])
            assert manifest(installed_app) == expected, "DMG 内 App 与发布 App 内容不一致"
            assert (mount / "Applications").is_symlink()
            assert str((mount / "Applications").readlink()) == "/Applications"
            assert (mount / "安装说明.txt").is_file()
        finally:
            if device:
                run(["/usr/bin/hdiutil", "detach", device])
    output = ROOT / "outputs" / name
    shutil.copy2(ROOT / "docs/app-usage.md", ROOT / "outputs/App使用说明.md")
    shutil.copy2(target, output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    report = {"file": name, "sha256": digest, "bytes": output.stat().st_size,
              "verification": {"diskImageChecksum": "passed", "readOnlyMount": "passed",
                               "appContentsAndPermissions": "passed", "appSignature": "passed-adhoc",
                               "applicationsDragLink": "passed", "detach": "passed", "appleNotarization": "not-performed"}}
    (ROOT / "outputs/DMG验证记录.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"dmg": str(output), **report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
