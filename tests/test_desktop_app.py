"""验证 GPT 出口口径、TLS 转发与 App 设置恢复；不发送模型请求。"""
import http.client
import importlib.util
import json
from pathlib import Path
import socket
import socketserver
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "macos/legacy"))
import network_broker as broker
import app_service as service


class TimezoneTests(unittest.TestCase):
    def test_geolocation_queries_only_gpt_reported_address(self):
        calls = []
        def get(host, path, proxy):
            calls.append((host, path, proxy))
            if host == "chatgpt.com":
                return "h=chatgpt.com\nip=8.8.8.8\nloc=US\n"
            return json.dumps({"success": True, "ip": "8.8.8.8", "timezone": {"id": "America/New_York"}})
        value = broker.measure("http://127.0.0.1:7890", get)
        self.assertEqual(value["timezone"], "America/New_York")
        self.assertEqual([x[:2] for x in calls], [("chatgpt.com", "/cdn-cgi/trace"), ("chatgpt.com", "/cdn-cgi/trace"), ("ipwho.is", "/8.8.8.8")])
        self.assertTrue(all(x[2] == "http://127.0.0.1:7890" for x in calls))

    def test_rotating_gpt_egress_is_not_used(self):
        addresses = iter(["8.8.8.8", "1.1.1.1"])
        with self.assertRaisesRegex(ValueError, "不稳定"):
            broker.measure("", lambda *args: "h=chatgpt.com\nip=" + next(addresses))

    def test_foreign_host_private_address_and_wrong_geo_ip_rejected(self):
        for text in ["h=example.org\nip=8.8.8.8", "h=chatgpt.com\nip=127.0.0.1"]:
            with self.assertRaises(ValueError):
                broker.parse_trace(text)
        def get(host, *args):
            return "h=chatgpt.com\nip=8.8.8.8" if host == "chatgpt.com" else json.dumps({"success": True, "ip": "1.1.1.1"})
        with self.assertRaisesRegex(ValueError, "不一致"):
            broker.measure("", get)

    def test_settings_validate_timezone_and_preserve_no_global_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            value = {"mode": "manual", "timezone": "Asia/Tokyo", "upstream": "system", "port": 9335}
            service.save_settings(root, value)
            self.assertEqual(service.settings(root)["timezone"], "Asia/Tokyo")
            self.assertEqual([p.name for p in root.iterdir()], ["desktop-settings.json"])
            with self.assertRaises(ValueError):
                service.save_settings(root, {**value, "timezone": "not/a_timezone"})

    def test_unrecognized_pac_is_not_silently_treated_as_direct(self):
        result = type("Result", (), {"stdout": "ProxyAutoConfigEnable : 1\n"})()
        with patch.object(service.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(ValueError, "PAC"):
                service.system_proxy()

    def test_proxy_validation_and_allowed_destinations(self):
        self.assertTrue(broker.allowed("chatgpt.com", 443))
        self.assertTrue(broker.allowed("auth.openai.com", 443))
        self.assertFalse(broker.allowed("127.0.0.1", 443))
        self.assertFalse(broker.allowed("chatgpt.com.evil.invalid", 443))
        self.assertFalse(broker.allowed("chatgpt.com", 22))
        for proxy in ["http://user:secret@host:7890", "http://host:7890/path", "ftp://host:80"]:
            with self.assertRaises(ValueError):
                broker.proxy_url(proxy)

    def test_launch_uses_detected_timezone_and_same_broker_for_gpt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / "var").mkdir()
            (root / "macos-config.json").write_text(json.dumps({"app": "/Applications/Test.app"}))
            options = {"mode": "automatic", "timezone": "UTC", "upstream": "system", "port": 9335}
            with patch.object(service.manage, "find_app", return_value=(Path("Test.app"), Path("Test"))), patch.object(service.manage, "app_running", return_value=False), patch.object(service, "ensure_broker", return_value={"port": 45678}), patch.object(service, "detect", return_value={"timezone": "Asia/Tokyo"}), patch.object(service.manage, "launch", return_value=0) as start, patch.object(service, "app_pids", return_value=[42]):
                self.assertTrue(service.launch(root, options)["ok"])
                self.assertEqual(start.call_args.kwargs["launch_env"]["TZ"], "Asia/Tokyo")
                self.assertEqual(start.call_args.kwargs["launch_env"]["HTTPS_PROXY"], "http://127.0.0.1:45678")
                self.assertEqual(start.call_args.kwargs["proxy_server"], "http://127.0.0.1:45678")

    def test_existing_gpt_process_is_never_restarted_to_apply_timezone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / "var").mkdir()
            (root / "macos-config.json").write_text(json.dumps({"app": "/Applications/Test.app"}))
            with patch.object(service.manage, "find_app", return_value=(Path("Test.app"), Path("Test"))), patch.object(service.manage, "app_running", return_value=True), patch.object(service, "app_pids", return_value=[77]), patch.object(service.manage, "launch") as start:
                with self.assertRaisesRegex(ValueError, "正常退出"):
                    service.launch(root, {"port": 9335})
                start.assert_not_called()


class EchoProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class EchoHandler(socketserver.BaseRequestHandler):
    def handle(self):
        header = b""
        while b"\r\n\r\n" not in header:
            part = self.request.recv(1)
            if not part: return
            header += part
        self.server.received = header
        self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        while data := self.request.recv(4096):
            self.request.sendall(data)


class BrokerIntegrationTests(unittest.TestCase):
    def test_encrypted_bytes_are_forwarded_unchanged_and_control_requires_token(self):
        upstream = EchoProxy(("127.0.0.1", 0), EchoHandler)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        server = broker.Broker("http://127.0.0.1:" + str(upstream.server_address[1]), "test-token")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with socket.create_connection(server.server_address, timeout=3) as client:
                client.sendall(b"CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n")
                header = b""
                while b"\r\n\r\n" not in header: header += client.recv(1)
                self.assertIn(b"200", header)
                payload = b"\x16\x03\x03\x00\x10opaque-encrypted-data"
                client.sendall(payload)
                self.assertEqual(broker.read_exact(client, len(payload)), payload)
                self.assertTrue(upstream.received.startswith(b"CONNECT chatgpt.com:443"))
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            connection.request("POST", "/health")
            self.assertEqual(connection.getresponse().status, 403)
            connection.close()
            record = {"port": server.server_address[1], "token": "test-token"}
            self.assertTrue(service.broker_call(record, "health")["running"])
        finally:
            server.shutdown(); server.server_close(); upstream.shutdown(); upstream.server_close()


if __name__ == "__main__":
    unittest.main()
