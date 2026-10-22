"""启动器边界测试：不退出应用，不使用真实会话数据。"""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("macos_manager", Path(__file__).resolve().parents[1] / "macos/legacy/manage.py")
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class ManagerTests(unittest.TestCase):
    def test_only_codex_bundle_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "Example.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/MacOS/Test").touch()
            plist = app / "Contents/Info.plist"
            plist.write_bytes(plistlib.dumps({"CFBundleIdentifier": "other.app", "CFBundleExecutable": "Test"}))
            with self.assertRaises(RuntimeError):
                manager.find_app(str(app))
            plist.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.openai.codex", "CFBundleExecutable": "Test"}))
            self.assertEqual(manager.find_app(str(app))[0], app.resolve())

    def test_stale_health_and_wrong_run_id_are_not_reused(self):
        runtime = {"runId": "current"}
        health = {"runId": "current", "checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "running": True, "rendererCount": 1}
        self.assertTrue(manager.healthy(runtime, health))
        self.assertFalse(manager.healthy({"runId": "old"}, health))
        health["checkedAt"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=20)).isoformat()
        self.assertFalse(manager.healthy(runtime, health))

    def test_unrelated_pid_is_never_stopped(self):
        root = Path("/tmp/test-status")
        runtime = {"pid": 123, "port": 9335, "runId": "abc", "command": ["node", str(root / "native_status_injector.mjs"), "--port", "9335", "--run-id", "abc"]}
        with patch.object(manager, "run", return_value=subprocess.CompletedProcess([], 0, "some-other-process\n")), patch.object(manager.os, "kill") as kill:
            self.assertFalse(manager.stop_owned(root, runtime))
            kill.assert_not_called()

    def test_running_app_without_cdp_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "var").mkdir()
            (root / "macos-config.json").write_text(json.dumps({"node": "node", "app": "/Applications/Test.app"}))
            with patch.object(manager, "find_app", return_value=(Path("/Applications/Test.app"), Path("/Applications/Test.app/Contents/MacOS/Test"))), patch.object(manager, "run"), patch.object(manager, "cdp_available", return_value=False), patch.object(manager, "app_running", return_value=True), patch.object(manager.subprocess, "Popen") as spawn:
                with self.assertRaisesRegex(RuntimeError, "正常退出"):
                    manager.launch(root, 9335)
                spawn.assert_not_called()

    def test_destination_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "redirect").symlink_to(root.parent, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                manager.ensure_destination(root / "redirect/file", root)

    def test_new_app_launch_sets_new_york_timezone_and_keeps_cdp(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "var").mkdir()
            (root / "macos-config.json").write_text(json.dumps({"node": "node", "app": "/Applications/Test.app"}))
            def intercept(argv, **kwargs):
                if argv[0] == "/usr/bin/open":
                    self.assertEqual(kwargs["env"]["TZ"], "America/New_York")
                    self.assertIn("--remote-debugging-port=9335", argv)
                    self.assertIn("--remote-debugging-address=127.0.0.1", argv)
                    raise RuntimeError("已核验启动参数，测试不启动真实应用")
            with patch.object(manager, "find_app", return_value=(Path("/Applications/Test.app"), Path("/Applications/Test.app/Contents/MacOS/Test"))), patch.object(manager, "run", side_effect=intercept) as run, patch.object(manager, "cdp_available", return_value=False), patch.object(manager, "app_running", return_value=False), patch.object(manager, "port_free", return_value=True):
                with self.assertRaisesRegex(RuntimeError, "已核验启动参数"):
                    manager.launch(root, 9335)
                self.assertEqual(sum(call.args[0][0] == "/usr/bin/open" for call in run.call_args_list), 1)

    def test_occupied_port_does_not_launch_app(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "var").mkdir()
            (root / "macos-config.json").write_text(json.dumps({"node": "node", "app": "/Applications/Test.app"}))
            with patch.object(manager, "find_app", return_value=(Path("/Applications/Test.app"), Path("/Applications/Test.app/Contents/MacOS/Test"))), patch.object(manager, "run") as run, patch.object(manager, "cdp_available", return_value=False), patch.object(manager, "app_running", return_value=False), patch.object(manager, "port_free", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "已被其他程序占用"):
                    manager.launch(root, 9335)
                self.assertFalse(any(call.args[0][0] == "/usr/bin/open" for call in run.call_args_list))

    def test_dock_repeated_click_activates_app_and_reuses_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "var").mkdir()
            (root / "macos-config.json").write_text(json.dumps({"node": "node", "app": "/Applications/Test.app"}))
            (root / "var/runtime.json").write_text(json.dumps({"fingerprint": "same", "port": 9335}))
            (root / "var/health.json").write_text(json.dumps({"status": "attached", "bindingCount": 1}))
            with patch.object(manager, "find_app", return_value=(Path("/Applications/Test.app"), Path("Test"))), patch.object(manager, "run") as run, patch.object(manager, "cdp_available", return_value=True), patch.object(manager, "fingerprint", return_value="same"), patch.object(manager, "owned", return_value=True), patch.object(manager, "healthy", return_value=True), patch.object(manager.subprocess, "Popen") as spawn:
                self.assertEqual(manager.launch(root, 9335), 0)
                activations = [call for call in run.call_args_list if call.args[0][0] == "/usr/bin/open"]
                self.assertEqual(len(activations), 1)
                self.assertEqual(activations[0].args[0], ["/usr/bin/open", "-a", "/Applications/Test.app"])
                self.assertEqual(activations[0].kwargs["env"]["TZ"], "America/New_York")
                spawn.assert_not_called()

    def test_readonly_check_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "missing"
            with patch.object(manager, "find_app", return_value=(Path("Test.app"), Path("Test"))), patch.object(manager, "app_running", return_value=True), patch.object(manager, "cdp_available", return_value=False):
                manager.check(root, 9335)
            self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
