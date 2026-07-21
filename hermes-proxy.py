#!/usr/bin/env python3
"""Hermes HTTP Proxy — 把 Hermes CLI 包装成 HTTP，供 Docker 后端调用。

Hermes 在 Windows 宿主机上，Docker 在 WSL 里。在 Windows 上运行此脚本:
    pip install flask
    python hermes-proxy.py --port 8080

在 WSL 里查 Windows IP:
    cat /etc/resolv.conf | grep nameserver | awk '{print $2}'

.env 配置:
    HERMES_GATEWAY_URL=http://<windows_ip>:8080
"""

import argparse
import json
import re
import subprocess
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)
SESSIONS: dict[str, dict] = {}
SKILLS_DIR = Path(__file__).resolve().parent / "hermes-skills"
SESSION_TTL = 3600  # 1 hour max lifetime per session
_SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _cleanup_expired() -> None:
    """Remove sessions older than SESSION_TTL."""
    now = time.time()
    expired = [sid for sid, s in SESSIONS.items() if now - s.get("_created", 0) > SESSION_TTL]
    for sid in expired:
        del SESSIONS[sid]


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "hermes-proxy"})


@app.route("/api/session/start", methods=["POST"])
def session_start():
    _cleanup_expired()
    data = request.get_json(force=True)
    skill = data.get("skill", "")
    params = data.get("params", {})

    # Validate skill name to prevent path traversal
    if not _SKILL_NAME_RE.match(skill):
        return jsonify({"error": f"invalid skill name: {skill}"}), 400

    sid = str(uuid.uuid4())[:8]

    prompt = json.dumps(params, ensure_ascii=False)
    # Truncate overly long prompts
    if len(prompt) > 50000:
        return jsonify({"error": "prompt too long"}), 400

    skill_path = SKILLS_DIR / skill / "SKILL.md"
    if not skill_path.resolve().is_relative_to(SKILLS_DIR.resolve()):
        return jsonify({"error": "path traversal denied"}), 403

    if not skill_path.exists():
        return jsonify({"error": f"skill not found: {skill}"}), 400

    try:
        r = subprocess.run(
            ["hermes", "chat", "--skill", str(skill_path),
             "--prompt", prompt, "--json"],
            capture_output=True, text=True, timeout=600
        )
        ok = r.returncode == 0
        result = json.loads(r.stdout) if ok and r.stdout.strip() else (
            {"output": r.stdout} if ok else {"error": r.stderr.strip() or str(r.returncode)}
        )
        SESSIONS[sid] = {"status": "completed" if ok else "failed", "result": result, "_created": time.time()}
    except subprocess.TimeoutExpired:
        SESSIONS[sid] = {"status": "failed", "result": {"error": "execution timed out"}, "_created": time.time()}
    except Exception as e:
        SESSIONS[sid] = {"status": "failed", "result": {"error": str(e)}, "_created": time.time()}

    return jsonify({"session_id": sid, **{k: v for k, v in SESSIONS[sid].items() if k != "_created"}})


@app.route("/api/session/<sid>")
def session_status(sid):
    return jsonify(SESSIONS.get(sid, {"status": "unknown"}))


@app.route("/api/session/<sid>/result")
def session_result(sid):
    s = SESSIONS.get(sid)
    return jsonify(s["result"] if s else {"error": "not found"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hermes HTTP Proxy")
    parser.add_argument("--port", type=int, default=8080, help="Listen port (default: 8080)")
    parser.add_argument("--host", default="127.0.0.1", help="Listen host (default: 127.0.0.1)")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port)
