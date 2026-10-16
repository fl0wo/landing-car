#!/usr/bin/env python3
"""Tiny local server for the Ollaya demos.

Serves the pages in web/ (Food Chain at /, Sorting Machine at /sort, Flying Car
at /car) and proxies
/api/systemone to Ollaya, so the API key from .env never reaches the browser.
Run: python3 server.py, then open http://localhost:8000
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = (ROOT / "web").resolve()


def load_env(path):
    env = {}
    for line in path.read_text().splitlines():
        m = re.match(r'\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"#]*?)"?\s*(#.*)?$', line)
        if m:
            env[m.group(1)] = m.group(2).strip()
    return env


ENV = load_env(ROOT / ".env")
URL = ENV["OLLAYA_URL"].rstrip("/")
KEY = ENV["OLLAYA_API_KEY"]
MODEL = ENV.get("OLLAYA_MODEL", "laya:latest")


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/config":
            return self.send(200, json.dumps({"model": MODEL}).encode())
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
        if self.path != "/api/systemone":
            return self.send(404, b'{"error":"not found"}')
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        body.setdefault("model", MODEL)
        req = urllib.request.Request(
            URL + "/v1/systemone",
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
        )
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (urllib.error.URLError, TimeoutError) as e:
            status, raw = 502, json.dumps({"error": str(e)}).encode()
        ms = (time.perf_counter() - start) * 1000
        try:
            out = json.loads(raw)
        except ValueError:
            out = {"error": raw.decode(errors="replace")}
        out["latency_ms"] = round(ms, 1)
        self.send(status, json.dumps(out).encode())

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"Food Chain:      http://localhost:{port}")
    print(f"Sorting Machine: http://localhost:{port}/sort")
    print(f"Flying Car:      http://localhost:{port}/car")
    print(f"(Ollaya {URL}, model {MODEL})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
