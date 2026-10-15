"""Loopback-only, bounded offline dictation service. Never stores recordings."""
import hmac
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import imageio_ffmpeg
import numpy as np
import torch
from qwen_asr import Qwen3ASRModel
from qwen_asr.inference.utils import split_audio_into_chunks

MODEL = Path(os.environ["CODEX_STT_MODEL_DIR"])
PRIVATE = Path(os.environ["CODEX_STT_PRIVATE_DIR"])
PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
TOKEN_FILE = PRIVATE / "worker-token"
if not TOKEN_FILE.exists():
    with TOKEN_FILE.open("x") as f:
        os.chmod(TOKEN_FILE, 0o600)
        f.write(secrets.token_hex(32))
TOKEN = TOKEN_FILE.read_text().strip()
torch.cuda.set_per_process_memory_fraction(.18)
recognizer = Qwen3ASRModel.from_pretrained(
    str(MODEL), dtype=torch.bfloat16, device_map="cuda:0",
    max_inference_batch_size=1, max_new_tokens=2048,
)
recognizer.transcribe(audio=(np.zeros(16000, dtype=np.float32), 16000))
gate = threading.BoundedSemaphore(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Do not log transcripts, headers or user recordings.

    def send_json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return hmac.compare_digest(self.headers.get("X-Speech-Token", ""), TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "Unauthorized"})
        self.send_json(200, {"ready": True, "model": "Qwen3-ASR-1.7B", "maxSeconds": 600})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": "Unauthorized"})
        if self.path != "/transcribe":
            return self.send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= 8 * 1024 * 1024:
            return self.send_json(413, {"error": "录音过大，请控制在 10 分钟内"})
        if not gate.acquire(blocking=False):
            return self.send_json(429, {"error": "语音识别正在处理其他录音，请稍后重试"})
        started = time.monotonic()
        try:
            self.connection.settimeout(20)
            raw = self.rfile.read(length)
            received = time.monotonic()
            if len(raw) != length:
                raise ValueError("录音上传不完整")
            with tempfile.TemporaryDirectory(prefix="dictation-", dir=PRIVATE) as directory:
                audio = Path(directory) / "recording"
                audio.write_bytes(raw)
                # No shell/network protocols; bounded decode even for long uploads.
                decoded = subprocess.run([
                    imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error",
                    "-protocol_whitelist", "file,pipe", "-i", str(audio),
                    "-t", "601", "-vn", "-ac", "1", "-ar", "16000",
                    "-f", "f32le", "pipe:1",
                ], capture_output=True, timeout=20)
                if decoded.returncode:
                    raise ValueError("无法读取录音格式，请重新录音")
                samples = np.frombuffer(decoded.stdout, dtype=np.float32).copy()
                decoded_at = time.monotonic()
                duration = len(samples) / 16000
                if duration > 600.2:
                    raise ValueError("录音不能超过 10 分钟")
                if duration < .25 or not len(samples) or float(np.max(np.abs(samples))) < .002:
                    raise ValueError("没有检测到清晰语音，请靠近麦克风重试")
                # Keep short dictation unchanged. For long speech, official
                # low-energy boundaries preserve every sample without gaps or
                # overlaps, and bound decoder context/output per segment.
                segments = split_audio_into_chunks(samples, 16000, max_chunk_sec=30, search_expand_sec=3)
                texts = []
                with torch.inference_mode():
                    for segment, _offset in segments:
                        if float(np.max(np.abs(segment))) < .002:
                            continue
                        result = recognizer.transcribe(audio=(segment, 16000))
                        part = result[0].text.strip() if result else ""
                        if part:
                            texts.append(part)
                inferred = time.monotonic()
                text = "\n".join(texts)
                if not text:
                    raise ValueError("没有识别到文字，请重新录音")
                self.send_json(200, {"text": text, "durationSeconds": round(duration, 2),
                    "elapsedMs": round((time.monotonic() - started) * 1000),
                    "timings": {"receiveMs": round((received - started) * 1000),
                        "decodeMs": round((decoded_at - received) * 1000),
                        "inferenceMs": round((inferred - decoded_at) * 1000)},
                    "segments": len(segments), "model": "Qwen3-ASR-1.7B"})
        except ValueError as error:
            self.send_json(422, {"error": str(error)})
        except Exception:
            self.send_json(503, {"error": "语音转换失败，请稍后重试"})
        finally:
            gate.release()


host = os.environ.get("CODEX_STT_HOST", "127.0.0.1")
server = ThreadingHTTPServer((host, int(os.environ.get("CODEX_STT_PORT", "4593"))), Handler)
if (PRIVATE / "server.crt").exists():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(PRIVATE / "server.crt"), str(PRIVATE / "server.key"))
    server.socket = context.wrap_socket(server.socket, server_side=True)
elif host not in ("127.0.0.1", "localhost"):
    raise RuntimeError("Public speech endpoint requires TLS")
server.daemon_threads = True
print("Local speech recognizer ready", flush=True)
server.serve_forever()
