#!/usr/bin/env python3
"""袁采 · 处己篇《袁氏世范》——对话后端代理（比赛部署版）"

把扣子(Coze)的 API Token 与 Bot ID 藏在本服务端，前端只需向 /api/chat 请求，
任何访客打开页面即可直接对谈，无需也看不到密钥。

运行：
    COZE_API_TOKEN=pat_xxxx COZE_BOT_ID=7683854178863087650 python3 server.py
然后打开 http://localhost:8080

环境变量：
    COZE_API_TOKEN  扣子开放平台「个人访问令牌」（必填）
    COZE_BOT_ID     你的「袁采」扣子智能体 Bot ID（必填）
    COZE_BASE       扣子 API 地址，国内默认 https://api.coze.cn
    PORT            监听端口，默认 8080
只依赖 Python 3 标准库，无需 pip 安装。
"""
import json
import os
import random
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def _load_env():
    """若存在同目录 .env，则以 KEY=VALUE 形式读取（已存在环境变量优先）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip().strip('"').strip("'"), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


_load_env()

BASE = os.environ.get("COZE_BASE", "https://api.coze.cn").rstrip("/")
TOKEN = os.environ.get("COZE_API_TOKEN", "").strip()
BOT = os.environ.get("COZE_BOT_ID", "").strip()
PORT = int(os.environ.get("PORT", "8080"))
HERE = os.path.dirname(os.path.abspath(__file__))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def coze(method, path, payload=None, timeout=60):
    """向扣子 OpenAPI 发起请求，返回解析后的 dict。"""
    url = BASE + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # 扣子为固定 HTTPS 域名。个别 macOS 本地证书链注入自签名根证书时，默认验证会抛 SSL 错误，
    # 这里仅在 SSL 校验失败时对扣子域名回退为不校验证书，保证作品可运行。
    try:
        kt = buildresp(req, timeout)
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ssl.SSLError):
            kt = buildresp(req, timeout, ssl._create_unverified_context())
        else:
            raise
    return kt


def buildresp(req, timeout, ctx=None):
    kw = {"timeout": timeout}
    if ctx is not None:
        kw["context"] = ctx
    with urllib.request.urlopen(req, **kw) as r:
        body = r.read().decode("utf-8") or "{}"
        return json.loads(body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    # ---------- CORS ----------
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ---------- 静态文件 ----------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/chat":
            self._send_json(405, {"error": "/api/chat 请用 POST 调用"})
            return
        if path in ("/", ""):
            path = "/index.html"
        fpath = os.path.normpath(os.path.join(HERE, path.lstrip("/")))
        if not fpath.startswith(HERE) or not os.path.isfile(fpath):
            self.send_error(404, "Not Found")
            return
        ext = os.path.splitext(fpath)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(fpath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if ext in (".html", ".htm"):
            self.send_header("Cache-Control", "no-store, max-age=0")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    # ---------- 对话代理 ----------
    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/chat":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            message = (body.get("message") or "").strip()
        except Exception:
            self._send_json(400, {"error": "请求体须为合法 JSON，且包含 message 字段"})
            return
        if not message:
            self._send_json(400, {"error": "message 不能为空"})
            return
        if not TOKEN or not BOT:
            self._send_json(500, {"error": "服务端未配置 COZE_API_TOKEN 或 COZE_BOT_ID，请先补充环境变量"})
            return
        try:
            reply, src = self._chat(message)
            self._send_json(200, {"reply": reply, "src": src})
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            self._send_json(502, {"error": "扣子接口错误 HTTP %s：%s" % (e.code, detail)})
        except Exception as e:
            self._send_json(502, {"error": str(e)})

    def _send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _chat(self, text):
        # 每个提问新建一次会话，避免在共享账号里积累历史
        # 注意：不能设置 auto_save_history=false，否则扣子强制要求流式且无法 retrieve；
        # 此处用「非流式 + retrieve」取回完整回复，故保持 auto_save_history 为默认(开启)。
        user_id = "guest_%s" % random.randint(100000, 999999)
        created = coze("POST", "/v3/chat", {
            "bot_id": BOT,
            "user_id": user_id,
            "stream": False,
            "additional_messages": [{"role": "user", "content": text, "content_type": "text"}],
        })
        if created.get("code") not in (None, 0):
            raise RuntimeError(created.get("msg") or created.get("detail") or "创建对话失败")
        data = created.get("data") or {}
        chat_id = data.get("id")
        conv_id = data.get("conversation_id")
        if not chat_id:
            raise RuntimeError("扣子未返回对话 id")

        deadline = time.time() + 90
        while True:
            st = coze("GET", "/v3/chat/retrieve?chat_id=%s&conversation_id=%s"
                      % (_q(chat_id), _q(conv_id)))
            status = (st.get("data") or {}).get("status")
            if status in ("completed", "local_success"):
                break
            if status == "failed":
                raise RuntimeError("对话生成失败，请重试")
            if time.time() > deadline:
                raise RuntimeError("对话生成超时，请重试")
            time.sleep(1.2)

        msgs = coze("GET", "/v3/chat/message/list?chat_id=%s&conversation_id=%s"
                    % (_q(chat_id), _q(conv_id)))
        arr = msgs.get("data") or []
        answer_lines, sources = [], []
        for m in reversed(arr):
            if m.get("role") != "assistant":
                continue
            content = m.get("content")
            texts = []

            def collect(items):
                out = []
                for x in items:
                    if not isinstance(x, dict):
                        continue
                    if x.get("type") in ("text", "answer") and x.get("text"):
                        out.append(x["text"])
                    elif x.get("type") == "document" and x.get("document", {}).get("name"):
                        n = x["document"]["name"]
                        if n not in sources:
                            sources.append(n)
                return out

            if isinstance(content, list):
                texts = collect(content)
            elif isinstance(content, str):
                try:
                    parsed = json.loads(content)
                except Exception:
                    parsed = None
                if isinstance(parsed, list):
                    texts = collect(parsed)
                else:
                    # 纯文本 answer：content 直接就是答复正文
                    if m.get("type") == "answer" and content.strip():
                        texts = [content]
            if texts:
                answer_lines.extend(texts)
                break

        reply = "\n".join(answer_lines).strip()
        src = "；".join(sources)
        if not reply:
            raise RuntimeError("模型未返回文字内容，请改一种问法再试")
        return reply, src


def _q(s):
    import urllib.parse
    return urllib.parse.quote(str(s), safe="")


def main():
    if not TOKEN or not BOT:
        print("  ⚠ 检测到未设置 COZE_API_TOKEN / COZE_BOT_ID，页面将无法对话。")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("  ✓ 袁采「处己篇」已启动： http://localhost:%d" % PORT)
    if not TOKEN or not BOT:
        print("     请先设置环境变量再访问：")
        print("     COZE_API_TOKEN=pat_xxxx COZE_BOT_ID=xxx python3 server.py")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  ✓ 已停止")


if __name__ == "__main__":
    main()