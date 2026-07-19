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

import json
import subprocess
import sys
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)
SESSIONS: dict[str, dict] = {}
SKILLS_DIR = Path(__file__).resolve().parent / "hermes-skills"


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "hermes-proxy"})


@app.route("/api/session/start", methods=["POST"])
def session_start():
    data = request.get_json(force=True)
    skill = data.get("skill", "")
    params = data.get("params", {})

    sid = str(uuid.uuid4())[:8]

    prompt = json.dumps(params, ensure_ascii=False)
    skill_path = SKILLS_DIR / skill / "SKILL.md"

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
        SESSIONS[sid] = {"status": "completed" if ok else "failed", "result": result}
    except Exception as e:
        SESSIONS[sid] = {"status": "failed", "result": {"error": str(e)}}

    return jsonify({"session_id": sid, **SESSIONS[sid]})


@app.route("/api/session/<sid>")
def session_status(sid):
    return jsonify(SESSIONS.get(sid, {"status": "unknown"}))


@app.route("/api/session/<sid>/result")
def session_result(sid):
    s = SESSIONS.get(sid)
    return jsonify(s["result"] if s else {"error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
    app.run(host="0.0.0.0", port=port)
