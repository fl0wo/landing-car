#!/usr/bin/env python3
"""Tiny local server for the System One demos.

Serves the pages in web/ (Food Chain at /, Sorting Machine at /sort, Flying Car
at /car) and proxies /api/systemone to a pilot (a System One provider), so API
keys from .env never reach the browser.

Pilots come from .env: every <NAME>_URL with a <NAME>_API_KEY is one, using
<NAME>_MODEL and an optional <NAME>_NAME. Pick one with /api/systemone?pilot=<name>;
without it the first pilot in .env is used.

Each pilot also gets its own local port (8000, 8001, ...): browsers allow only 6
connections per host:port, so pilots sharing one would queue behind each other.

Run: python3 server.py, then open http://localhost:8000
"""
import http.client
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
WEB = (ROOT / "web").resolve()
DEFAULT_NAMES = {"ollaya": "Laya", "jev": "Jev"}
LOCAL_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1):\d+$")
PORT = int(os.environ.get("PORT", 8000))


def load_env(path):
    env = {}
    for line in path.read_text().splitlines():
        m = re.match(r'\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"#]*?)"?\s*(#.*)?$', line)
        if m:
            env[m.group(1)] = m.group(2).strip()
    return env


def load_pilots(env):
    pilots = {}
    for var, url in env.items():   # .env order, so the first pilot listed is the default
        if not var.endswith("_URL") or not env.get(var[:-4] + "_API_KEY"):
            continue
        p = var[:-4]
        pid = p.lower()
        pilots[pid] = {
            "id": pid,
            "name": env.get(p + "_NAME") or DEFAULT_NAMES.get(pid, pid),
            "url": urlsplit(url.rstrip("/")),
            "key": env[p + "_API_KEY"],
            "model": env.get(p + "_MODEL", ""),
            "port": PORT + len(pilots),
        }
    return pilots


PILOTS = load_pilots(load_env(ROOT / ".env"))
DEFAULT = next(iter(PILOTS))


class Pool:
    """Keep-alive connections per host, so HTTPS pilots don't pay a TLS handshake per request."""

    def __init__(self):
        self.idle, self.lock = {}, threading.Lock()

    def request(self, url, path, body, headers, timeout=15):
        host = (url.scheme, url.hostname, url.port)
        for attempt in (0, 1):   # a pooled connection may have been closed by the server: retry once on a new one
            with self.lock:
                conn = self.idle.get(host, []).pop() if self.idle.get(host) else None
            if conn is None:
                cls = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
                conn = cls(url.hostname, url.port, timeout=timeout)
            try:
                conn.request("POST", url.path + path, body, headers)
                r = conn.getresponse()
                raw = r.read()
            except (http.client.HTTPException, OSError):
                conn.close()
                if attempt:
                    raise
                continue
            with self.lock:
                self.idle.setdefault(host, []).append(conn)
            return r.status, raw


POOL = Pool()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # keep-alive to the browser too

    def cors(self):   # the car page on :8000 posts to each pilot's own port
        origin = self.headers.get("Origin", "")
        if LOCAL_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/config":
            pilots = [{k: p[k] for k in ("id", "name", "model", "port")} for p in PILOTS.values()]
            return self.send(200, json.dumps({"model": PILOTS[DEFAULT]["model"], "pilots": pilots}).encode())
        # "/" is the Food Chain; "/sort" or "/car" are the other pages; .js modules load from web/ too
        name = self.path.split("?")[0].strip("/") or "index"
        if not name.endswith((".html", ".js")):
            name += ".html"
        path = (WEB / name).resolve()
        if path.is_relative_to(WEB) and path.is_file():
            ctype = "text/javascript" if path.suffix == ".js" else "text/html"
            self.send(200, path.read_bytes(), ctype + "; charset=utf-8")
        else:
            self.send(404, b'{"error":"not found"}')

    def do_POST(self):
        parts = urlsplit(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if parts.path != "/api/systemone":
            return self.send(404, b'{"error":"not found"}')
        pid = parse_qs(parts.query).get("pilot", [""])[0] or DEFAULT
        pilot = PILOTS.get(pid)
        if not pilot:
            return self.send(404, json.dumps({"error": f"unknown pilot {pid!r}"}).encode())
        body = json.loads(body or b"{}")
        if pilot["model"]:
            body.setdefault("model", pilot["model"])
        headers = {"Authorization": "Bearer " + pilot["key"], "Content-Type": "application/json"}
        start = time.perf_counter()
        try:
            status, raw = POOL.request(pilot["url"], "/v1/systemone", json.dumps(body).encode(), headers)
        except (http.client.HTTPException, OSError) as e:
            status, raw = 502, json.dumps({"error": str(e)}).encode()
        ms = (time.perf_counter() - start) * 1000
        try:
            out = json.loads(raw)
        except ValueError:
            out = {"error": raw.decode(errors="replace")}
        if not isinstance(out, dict):
            out = {"error": out}
        out["latency_ms"] = round(ms, 1)
        self.send(status, json.dumps(out).encode())   # 429 / 529 pass through so the page can back off

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"Food Chain:      http://localhost:{PORT}")
    print(f"Sorting Machine: http://localhost:{PORT}/sort")
    print(f"Flying Car:      http://localhost:{PORT}/car")
    for p in PILOTS.values():
        print(f"pilot {p['id']:<8} {p['name']:<6} :{p['port']}  {p['url'].geturl()}  model {p['model']}" + ("  (default)" if p["id"] == DEFAULT else ""))
    ports = sorted({PORT} | {p["port"] for p in PILOTS.values()})
    for port in ports[1:]:
        threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
