#!/usr/bin/env python3
"""GPT 与出口探测共用的本机 CONNECT 转发器；不解密模型请求。"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import select
import socket
import ssl
import struct
import threading
import time
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

GPT_HOST = "chatgpt.com"
ALLOWED_DOMAINS = ("chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com", "chat.com", "auth0.com")


def proxy_url(value):
    if not value:
        return ""
    u = urlsplit(value)
    if (u.scheme not in {"http", "socks5", "socks5h"} or not u.hostname or not u.port
        or u.username or u.password or u.path not in {"", "/"} or u.query or u.fragment):
        raise ValueError("代理地址应为 http://主机:端口 或 socks5h://主机:端口，不包含账号密码。")
    return value.rstrip("/")


def read_exact(sock, size):
    result = b""
    while len(result) < size:
        block = sock.recv(size - len(result))
        if not block:
            raise OSError("proxy closed")
        result += block
    return result


def tunnel(host, port, upstream):
    """代理探测和真实 CONNECT 都必须调用同一函数，保持进程与上游路径一致。"""
    if not upstream:
        return socket.create_connection((host, port), timeout=15)
    u = urlsplit(upstream)
    sock = socket.create_connection((u.hostname, u.port), timeout=15)
    try:
        if u.scheme == "http":
            sock.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode("ascii"))
            header = b""
            while b"\r\n\r\n" not in header:
                header += read_exact(sock, 1)
                if len(header) > 16384:
                    raise OSError("proxy header too large")
            if header.split(b" ", 2)[1] != b"200":
                raise OSError("proxy rejected CONNECT")
        else:
            sock.sendall(b"\x05\x01\x00")
            if read_exact(sock, 2) != b"\x05\x00":
                raise OSError("SOCKS authentication not supported")
            name = host.encode("idna")
            if len(name) > 255:
                raise ValueError("host too long")
            sock.sendall(b"\x05\x01\x00\x03" + bytes([len(name)]) + name + struct.pack("!H", port))
            reply = read_exact(sock, 4)
            if reply[1] != 0:
                raise OSError("SOCKS rejected CONNECT")
            size = {1: 4, 4: 16}.get(reply[3])
            if reply[3] == 3:
                size = read_exact(sock, 1)[0]
            if size is None:
                raise OSError("invalid SOCKS address")
            read_exact(sock, size + 2)
        return sock
    except Exception:
        sock.close()
        raise


def https_get(host, path, upstream):
    # 使用 macOS 系统证书，避免随包 OpenSSL 依赖开发机证书路径。
    context = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    class RoutedHTTPS(http.client.HTTPSConnection):
        def connect(self):
            self.sock = context.wrap_socket(tunnel(host, 443, upstream), server_hostname=host)
    connection = RoutedHTTPS(host, timeout=15)
    try:
        connection.request("GET", path, headers={"User-Agent": "CodexInlineStatus/2.0", "Cache-Control": "no-cache"})
        response = connection.getresponse()
        body = response.read(65537)
        if response.status != 200 or len(body) > 65536:
            raise ValueError("目标服务未返回可用结果，请检查网络后重试。")
        return body.decode("utf-8")
    finally:
        connection.close()


def parse_trace(text):
    values = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    if values.get("h", "").lower() != GPT_HOST:
        raise ValueError("出口检测没有来自 GPT 域名，已拒绝使用。")
    ip = ipaddress.ip_address(values.get("ip", ""))
    if not ip.is_global:
        raise ValueError("GPT 返回了无效的公网出口地址。")
    return str(ip)


def measure(upstream, getter=https_get):
    first = parse_trace(getter(GPT_HOST, "/cdn-cgi/trace", upstream))
    second = parse_trace(getter(GPT_HOST, "/cdn-cgi/trace", upstream))
    if first != second:
        raise ValueError("连续两次访问 GPT 的出口 IP 不同；当前节点出口不稳定，未自动设置时区。")
    # 地理服务只解析 GPT 已经回显的明确 IP，绝不采用地理服务自己看到的请求 IP。
    geo = json.loads(getter("ipwho.is", f"/{first}", upstream))
    if geo.get("success") is not True or str(ipaddress.ip_address(geo.get("ip", ""))) != first:
        raise ValueError("IP 时区查询结果与 GPT 出口不一致，已拒绝使用。")
    zone = geo.get("timezone", {}).get("id", "")
    try:
        ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        raise ValueError("地理服务未返回有效的 IANA 时区。")
    return {"ip": first, "timezone": zone, "country": str(geo.get("country", ""))[:80],
            "city": str(geo.get("city", ""))[:80], "host": GPT_HOST, "checkedAt": time.time(),
            "method": "gpt-origin-shared-broker", "upstreamHash": hashlib.sha256(upstream.encode()).hexdigest()}


def allowed(host, port):
    host = host.lower().rstrip(".")
    return port == 443 and (host in {"challenges.cloudflare.com", "accounts.google.com", "oauth2.googleapis.com"}
                           or any(host == domain or host.endswith("." + domain) for domain in ALLOWED_DOMAINS))


class Broker(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, upstream, token):
        super().__init__(("127.0.0.1", 0), Handler)
        self.upstream, self.token = upstream, token
        self.active = 0
        self.last_access = time.monotonic()
        self.guard = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # 不记录请求 URL、头部、聊天内容或身份信息。

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.server.last_access = time.monotonic()
        if self.headers.get("Authorization") != "Bearer " + self.server.token:
            self.reply(403, {"error": "not_authorized"}); return
        try:
            if self.path == "/trace":
                self.reply(200, measure(self.server.upstream))
            elif self.path == "/health":
                self.reply(200, {"running": True, "activeConnections": self.server.active})
            elif self.path == "/shutdown" and self.server.active == 0:
                self.reply(200, {"stopped": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self.reply(404, {"error": "not_found"})
        except ValueError as error:
            message = str(error)
            self.reply(502, {"error": message if any(word in message for word in ["出口", "时区", "GPT"]) else "GPT 返回的数据无法核实，请稍后重试。"})
        except (OSError, http.client.HTTPException, ssl.SSLError):
            self.reply(502, {"error": "GPT 出口或时区检测失败。请检查网络后重试；不会改用普通网站的出口。"})

    def do_CONNECT(self):
        remote = None
        counted = False
        try:
            host, text_port = self.path.rsplit(":", 1)
            port = int(text_port)
            if not allowed(host, port):
                self.send_error(403, "Only official GPT HTTPS destinations are allowed"); return
            remote = tunnel(host, port, self.server.upstream)
            self.send_response(200, "Connection established")
            self.end_headers()
            with self.server.guard:
                self.server.active += 1
                counted = True
            sockets = [self.connection, remote]
            # 原样双向搬运 TLS 字节；不持有证书、不读取或解密模型协议。
            while True:
                ready, _, _ = select.select(sockets, [], [], 180)
                if not ready:
                    break
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (remote if source is self.connection else self.connection).sendall(data)
                self.server.last_access = time.monotonic()
        except (ValueError, OSError):
            pass
        finally:
            if remote:
                remote.close()
            if counted:
                with self.server.guard:
                    self.server.active -= 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    config = json.loads(args.state.read_text())
    if config.get("runId") != args.run_id:
        return
    server = Broker(proxy_url(config.get("upstream", "")), config["token"])
    config.update(pid=os.getpid(), port=server.server_address[1])
    temporary = args.state.with_suffix(".tmp")
    temporary.write_text(json.dumps(config)); temporary.chmod(0o600); temporary.replace(args.state)
    def idle_cleanup():
        while True:
            time.sleep(30)
            if server.active == 0 and time.monotonic() - server.last_access > 600:
                server.shutdown(); return
    threading.Thread(target=idle_cleanup, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
