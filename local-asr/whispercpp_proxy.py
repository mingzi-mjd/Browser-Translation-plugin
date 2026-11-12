"""OpenAI-compatible loopback proxy for a whisper.cpp Vulkan server."""
import argparse
import hmac
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_UPLOAD = 4 * 1024 * 1024
UPSTREAM_TIMEOUT = 120
LOG = logging.getLogger("whispercpp-proxy")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(20)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    server_version = "WhisperCppProxy/1.0"

    def log_message(self, message, *args):
        # Do not log uploaded audio, transcripts, or credentials.
        pass

    def cors_headers(self):
        origin = self.headers.get("Origin", "")
        if re.fullmatch(r"(?:chrome|moz)-extension://[a-zA-Z0-9-]+", origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def reply(self, status, payload, content_type="application/json; charset=utf-8"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.cors_headers()
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def error(self, status, message):
        self.reply(status, {"error": {"message": message, "type": "local_asr_error"}})

    def allowed(self, authenticate=True):
        host = self.headers.get("Host", "")
        if host not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            self.error(403, "Only loopback Host headers are accepted")
            return False
        origin = self.headers.get("Origin", "")
        if origin and not re.fullmatch(r"(?:chrome|moz)-extension://[a-zA-Z0-9-]+", origin):
            self.error(403, "Use the browser extension or a local HTTP client")
            return False
        if authenticate and self.server.api_key:
            actual = self.headers.get("Authorization", "").encode("utf-8")
            expected = ("Bearer " + self.server.api_key).encode("utf-8")
            if not hmac.compare_digest(actual, expected):
                self.error(401, "Invalid API key")
                return False
        return True

    def upstream_health(self):
        try:
            with OPENER.open(self.server.upstream_base + "/health", timeout=3) as response:
                return response.status == 200
        except (OSError, urllib.error.URLError, TimeoutError):
            return False

    def do_OPTIONS(self):
        if self.allowed(authenticate=False):
            self.reply(200, {})

    def do_GET(self):
        if not self.allowed():
            return
        path = self.path.split("?", 1)[0].rstrip("/")
        if path == "/v1/models":
            self.reply(200, {"object": "list", "data": [{
                "id": self.server.model_id,
                "object": "model",
                "owned_by": "local-whispercpp-vulkan",
            }]})
        elif path in {"/health", "/v1/health"}:
            if self.upstream_health():
                self.reply(200, {"status": "ready", "model": self.server.model_id, "device": "vulkan"})
            else:
                self.reply(503, {"status": "upstream unavailable", "model": self.server.model_id})
        else:
            self.error(404, "Available endpoints: /health, /v1/models, /v1/audio/transcriptions")

    def do_POST(self):
        if not self.allowed():
            return
        path = self.path.split("?", 1)[0].rstrip("/")
        if path != "/v1/audio/transcriptions":
            self.error(404, "Unknown endpoint")
            return
        if self.headers.get("Transfer-Encoding"):
            self.error(400, "Chunked uploads are not supported")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_UPLOAD:
            self.error(413, "Upload must be between 1 byte and 4 MiB")
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data;") or "\r" in content_type or "\n" in content_type:
            self.error(400, "Use multipart/form-data with file and model fields")
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self.error(429, "Recognition is busy; wait for the current chunk to finish")
            return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete upload")
            request = urllib.request.Request(
                self.server.upstream_base + "/audio/transcriptions",
                data=body,
                method="POST",
                headers={"Content-Type": content_type, "Content-Length": str(length)},
            )
            try:
                with OPENER.open(request, timeout=UPSTREAM_TIMEOUT) as response:
                    self.reply(
                        response.status,
                        response.read(),
                        response.headers.get("Content-Type", "application/json; charset=utf-8"),
                    )
            except urllib.error.HTTPError as error:
                self.reply(
                    error.code,
                    error.read(),
                    error.headers.get("Content-Type", "application/json; charset=utf-8"),
                )
            except (TimeoutError, urllib.error.URLError) as error:
                timeout = isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError)
                self.error(504 if timeout else 502, "whisper.cpp request failed; check the service console")
        except ValueError as error:
            self.error(400, str(error))
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        except Exception:
            LOG.exception("Proxy request failed")
            self.error(500, "Recognition failed; check the service console")
        finally:
            self.server.inference_lock.release()


def find_binary(script_root):
    candidates = sorted(
        (script_root / "whispercpp").glob("**/whisper-server.exe"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def wait_for_upstream(base_url, process, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"whisper-server exited with code {process.returncode}")
        try:
            with OPENER.open(base_url + "/health", timeout=3) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Timed out waiting for whisper-server to become ready")


def stop_process(process):
    if process is None:
        return
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    script_root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--upstream-port", type=int, default=8080)
    parser.add_argument("--upstream-url", default="")
    parser.add_argument("--binary", default="")
    parser.add_argument("--model", default=str(script_root / "models" / "ggml-small.bin"))
    parser.add_argument("--model-id", default="whisper-small")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--prompt", default="")
    parser.add_argument("--no-spawn", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.upstream_port <= 65535:
        parser.error("Ports must be between 1 and 65535")
    if args.threads < 1:
        parser.error("Threads must be positive")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    process = None
    if args.upstream_url:
        upstream_base = args.upstream_url.rstrip("/")
    else:
        upstream_base = f"http://127.0.0.1:{args.upstream_port}/v1"

    if not args.no_spawn:
        binary = Path(args.binary) if args.binary else find_binary(script_root)
        model = Path(args.model)
        if not binary or not binary.is_file():
            parser.error("whisper-server.exe not found; pass --binary or place it under local-asr/whispercpp")
        if not model.is_file():
            parser.error(f"Model not found: {model}")
        command = [
            str(binary), "-m", str(model), "-l", args.language,
            "--host", "127.0.0.1", "--port", str(args.upstream_port),
            "--request-path", "/v1", "--inference-path", "/audio/transcriptions", "-nlp",
            "-t", str(args.threads),
        ]
        if args.prompt:
            command += ["--prompt", args.prompt]
        LOG.info("Starting whisper.cpp Vulkan: %s", binary)
        process = subprocess.Popen(command, cwd=str(binary.parent))

    try:
        wait_for_upstream(upstream_base, process)
        server = ProxyServer(("127.0.0.1", args.port), Handler)
    except Exception:
        stop_process(process)
        raise

    server.model_id = args.model_id or Path(args.model).stem
    server.upstream_base = upstream_base
    server.api_key = os.environ.get("LOCAL_ASR_API_KEY", "").strip()
    server.inference_lock = threading.Lock()
    LOG.info(
        "READY: http://127.0.0.1:%s/v1 | model: %s | device: vulkan | authentication: %s",
        args.port, server.model_id, "enabled" if server.api_key else "off (loopback only)",
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nLocal ASR stopped.")
    finally:
        server.server_close()
        stop_process(process)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nLocal ASR stopped.")
    except Exception as error:
        LOG.error("Startup failed: %s", error)
        raise SystemExit(1)
