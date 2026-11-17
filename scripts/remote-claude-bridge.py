#!/usr/bin/python3
"""Restricted SSH entry point. Never accepts a shell command or exports auth."""
import hashlib
import json
import os
import base64
import re
import signal
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
import sys

os.umask(0o077)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def read_scope():
    scope = json.loads(Path(__file__).with_name("scope.json").read_text())
    if set(scope) != {"userId", "sourceThreadId", "orgId", "configRoot", "executable", "allowedModels"}:
        raise ValueError("invalid_scope")
    if not scope["orgId"].isdigit() or not scope["sourceThreadId"]:
        raise ValueError("invalid_scope")
    if not scope["allowedModels"] or any(not re.fullmatch(r"claude-opus-[a-z0-9-]+", m) for m in scope["allowedModels"]):
        raise ValueError("invalid_models")
    return scope


def probe(scope):
    config = Path(scope["configRoot"]).resolve(strict=True)
    device = json.loads((config.parent / "device.json").read_text())
    native = json.loads((config / ".claude.json").read_text())
    if str(device.get("org_id")) != scope["orgId"] or not device.get("sk"):
        raise ValueError("device_binding_mismatch")
    identity = native.get("oauthAccount", {}).get("accountUuid")
    if not isinstance(identity, str) or not identity:
        raise ValueError("native_identity_missing")
    return {"ok": True, "userId": scope["userId"],
            "sourceThreadId": scope["sourceThreadId"], "orgId": scope["orgId"],
            "label": str(device.get("org_name", scope["orgId"])),
            "accountKey": hashlib.sha256(identity.encode()).hexdigest(),
            "deviceId": config.parent.name,
            "executablePresent": os.access(scope["executable"], os.X_OK),
            "models": scope["allowedModels"],
            "credentialCopied": False}


def job_root(job_id):
    if not re.fullmatch(r"[a-f0-9]{64}", job_id):
        raise ValueError("invalid_job")
    root = Path(__file__).with_name("requests")
    root.mkdir(mode=0o700, exist_ok=True)
    return root / job_id


def validate_request(scope, row):
    if row.get("userId") != scope["userId"] or row.get("sourceThreadId") != scope["sourceThreadId"]:
        raise ValueError("scope_denied")
    body = base64.b64decode(row.get("body", ""), validate=True)
    if len(body) > 16 * 1024 * 1024:
        raise ValueError("request_too_large")
    method, url = row.get("method"), row.get("path")
    if (method, url) not in {("POST", "/v1/messages"), ("POST", "/v1/messages/count_tokens"), ("GET", "/v1/models")}:
        raise ValueError("endpoint_denied")
    if method == "POST" and json.loads(body).get("model") not in scope["allowedModels"]:
        raise ValueError("model_denied")
    headers = row.get("headers", {})
    if not isinstance(headers, dict) or any(not isinstance(v, str) or "\n" in v or "\r" in v for v in headers.values()):
        raise ValueError("invalid_headers")
    return body


def worker(scope, job_id):
    folder = job_root(job_id)
    row = json.loads((folder / "request.json").read_text())
    body = validate_request(scope, row)
    # The device identity, CA and OAuth token never leave this host. Do not
    # invoke login/status or change the client's global selected organization.
    probe(scope)
    config = Path(scope["configRoot"])
    credentials = json.loads((config / ".credentials.json").read_text())
    token = credentials.get("claudeAiOauth", {}).get("accessToken")
    if not isinstance(token, str) or not token:
        raise ValueError("credential_missing")
    settings = json.loads((config / "settings.json").read_text()).get("env", {})
    proxy = settings.get("HTTPS_PROXY") or settings.get("HTTP_PROXY")
    if proxy != "http://127.0.0.1:6461":
        raise ValueError("proxy_binding_changed")
    ca_file = settings.get("NODE_EXTRA_CA_CERTS")
    context = ssl.create_default_context(cafile=ca_file)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy}), urllib.request.HTTPSHandler(context=context), NoRedirect())
    headers = {k: v for k, v in row.get("headers", {}).items() if k in {"anthropic-version", "anthropic-beta", "content-type", "accept", "user-agent", "x-app"}}
    headers["Authorization"] = "Bearer " + token
    headers.setdefault("anthropic-version", "2023-06-01")
    headers.setdefault("content-type", "application/json")
    beta = [x.strip() for x in headers.get("anthropic-beta", "").split(",") if x.strip()]
    if "oauth-2025-04-20" not in beta:
        beta.append("oauth-2025-04-20")
    headers["anthropic-beta"] = ",".join(beta)
    request = urllib.request.Request("https://api.anthropic.com" + row["path"], data=body if row["method"] == "POST" else None, headers=headers, method=row["method"])
    with (folder / "events.jsonl").open("ab", buffering=0) as events:
        sequence = 0
        def emit(event):
            nonlocal sequence
            sequence += 1
            events.write((json.dumps({"seq": sequence, **event}) + "\n").encode())
        try:
            try:
                response = opener.open(request, timeout=120)
            except urllib.error.HTTPError as error:
                response = error
            safe_headers = {k.lower(): v for k, v in response.headers.items() if k.lower() in {"content-type", "retry-after", "request-id"}}
            emit({"type": "headers", "status": response.status, "headers": safe_headers})
            with response:
                read = getattr(response, "read1", response.read)
                while True:
                    chunk = read(16384)
                    if not chunk:
                        break
                    emit({"type": "chunk", "data": base64.b64encode(chunk).decode()})
            emit({"type": "end"})
        except Exception:
            emit({"type": "error", "error": "upstream_transport_failed"})
        finally:
            (folder / "done").touch(mode=0o600)


def relay(scope, row):
    if row.get("userId") != scope["userId"] or row.get("sourceThreadId") != scope["sourceThreadId"]:
        raise ValueError("scope_denied")
    folder = job_root(row.get("id", ""))
    if row.get("action") == "cancel":
        if not folder.exists():
            print(json.dumps({"cancelled": False}), flush=True)
            return
        try:
            pid = int((folder / "pid").read_text())
            argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
            if [str(Path(__file__).resolve()).encode(), b"--worker", row["id"].encode()] == argv[1:4]:
                os.kill(pid, signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError):
            pass
        (folder / "done").touch(mode=0o600)
        print(json.dumps({"cancelled": True}), flush=True)
        return
    validate_request(scope, row)
    stable = {k: row[k] for k in ("userId", "sourceThreadId", "method", "path", "headers", "body")}
    try:
        folder.mkdir(mode=0o700)
        fd = os.open(folder / "request.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(stable, file)
        # A durable exclusive start marker is never cleared/replayed. If the
        # host crashes here, report uncertainty rather than submit twice.
        (folder / "started").touch(mode=0o600)
        env = {k: v for k, v in os.environ.items() if k != "SSH_ORIGINAL_COMMAND"}
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", row["id"]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=env)
        (folder / "pid").write_text(str(child.pid))
    except FileExistsError:
        if json.loads((folder / "request.json").read_text()) != stable:
            raise ValueError("request_identity_conflict")
    cursor = row.get("cursor", 0)
    if not isinstance(cursor, int) or cursor < 0:
        raise ValueError("invalid_cursor")
    started = time.monotonic()
    heartbeat = started
    events_file = folder / "events.jsonl"
    while not events_file.exists():
        if time.monotonic() - started > 15:
            raise ValueError("request_start_uncertain")
        time.sleep(.1)
    with events_file.open() as events:
        while True:
            line = events.readline()
            if line:
                event = json.loads(line)
                if event["seq"] > cursor:
                    print(line.rstrip(), flush=True)
                if event.get("type") in {"end", "error"}:
                    return
            elif (folder / "done").exists():
                return
            else:
                if time.monotonic() - heartbeat > 5:
                    print(json.dumps({"type": "heartbeat"}), flush=True)
                    heartbeat = time.monotonic()
                time.sleep(.1)


def main():
    scope = read_scope()
    action = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if action == "probe":
        print(json.dumps(probe(scope), ensure_ascii=False), flush=True)
    elif action == "relay":
        raw = sys.stdin.buffer.read(24 * 1024 * 1024 + 1)
        if len(raw) > 24 * 1024 * 1024:
            raise ValueError("request_too_large")
        relay(scope, json.loads(raw))
    else:
        raise ValueError("unsupported_bridge_action")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--worker" and not os.environ.get("SSH_ORIGINAL_COMMAND"):
            worker(read_scope(), sys.argv[2])
        else:
            main()
    except Exception:
        print(json.dumps({"ok": False, "error": "bridge_request_denied"}), flush=True)
        sys.exit(1)
