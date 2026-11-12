"""Loopback-only WAV transcription service for the browser extension. No Docker."""
import argparse
import hmac
import io
import json
import logging
import os
import re
import threading
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_UPLOAD = 4 * 1024 * 1024
LOG = logging.getLogger("local-asr")


class ASRServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(20)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalASR/1.0"

    def log_message(self, message, *args):
        # Don't log uploaded text, credentials or caller-controlled URLs.
        pass

    def reply(self, status, payload, text=False):
        data = (payload if text else json.dumps(payload, ensure_ascii=False)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8" if text else "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        origin = self.headers.get("Origin", "")
        if re.fullmatch(r"(?:chrome|moz)-extension://[a-zA-Z0-9-]+", origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # The browser can discard a chunk after seeking or stopping.

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

    def do_OPTIONS(self):
        if self.allowed(authenticate=False):
            self.reply(200, {})

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path.rstrip("/")
        if path == "/v1/models":
            self.reply(200, {"object": "list", "data": [{"id": self.server.model_id, "object": "model", "owned_by": "local-faster-whisper"}]})
        elif path == "/health":
            self.reply(200, {"status": "ready", "model": self.server.model_id, "device": self.server.device})
        else:
            self.error(404, "Available endpoints: /health, /v1/models, /v1/audio/transcriptions")

    def do_POST(self):
        if not self.allowed():
            return
        if urlsplit(self.path).path.rstrip("/") != "/v1/audio/transcriptions":
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
        if not self.server.inference_lock.acquire(blocking=False):
            self.error(429, "Recognition is busy; wait for the current chunk to finish")
            return
        try:
            content_type = self.headers.get("Content-Type", "")
            if not content_type.lower().startswith("multipart/form-data;") or "\r" in content_type or "\n" in content_type:
                raise ValueError("Use multipart/form-data with file and model fields")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete upload")
            message = BytesParser(policy=policy.default).parsebytes(
                ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii") + body
            )
            if not message.is_multipart():
                raise ValueError("Invalid multipart boundary")
            fields, audio = {}, None
            for index, part in enumerate(message.iter_parts()):
                if index >= 16:
                    raise ValueError("Too many form fields")
                name = part.get_param("name", header="content-disposition")
                value = part.get_payload(decode=True)
                if not isinstance(value, bytes):
                    raise ValueError("Invalid form field")
                if name == "file":
                    if audio is not None:
                        raise ValueError("Send one audio file")
                    audio = value
                elif name in {"model", "language", "response_format"}:
                    if len(value) > 512 or name in fields:
                        raise ValueError("Invalid or duplicate form field")
                    fields[name] = value.decode("utf-8").strip()
            if fields.get("model") != self.server.model_id:
                self.error(404, "Model not loaded; select the model listed by /v1/models")
                return
            output_format = fields.get("response_format", "json")
            if output_format not in {"json", "verbose_json", "text"}:
                raise ValueError("Supported response formats: json, verbose_json, text")
            language = fields.get("language")
            if language in {"", "auto"}:
                language = None
            if language and not re.fullmatch(r"[a-z]{2,3}", language):
                raise ValueError("Use an ISO language code, e.g. zh or en")
            if not audio:
                raise ValueError("Missing WAV audio")
            with wave.open(io.BytesIO(audio), "rb") as wav:
                rate, frames = wav.getframerate(), wav.getnframes()
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or rate not in {16000, 22050, 24000, 44100, 48000}:
                    raise ValueError("Expected mono 16-bit PCM WAV, 16–48 kHz")
                duration = frames / rate
                if not 0 < duration <= 30 or len(wav.readframes(frames)) != frames * 2:
                    raise ValueError("Send a complete WAV chunk lasting at most 30 seconds")
            segments, info = self.server.model.transcribe(
                io.BytesIO(audio), language=language, task="transcribe", beam_size=1,
                vad_filter=True, condition_on_previous_text=False,
            )
            rows = [{"id": segment.id, "start": segment.start, "end": segment.end, "text": segment.text.strip()} for segment in segments]
            text = " ".join(row["text"] for row in rows).strip()
            result = {"text": text}
            if output_format == "verbose_json":
                result.update(language=info.language, language_probability=info.language_probability, duration=duration, segments=rows)
            self.reply(200, text if output_format == "text" else result, text=output_format == "text")
        except (ValueError, UnicodeError, wave.Error, EOFError) as error:
            self.error(400, str(error))
        except (TimeoutError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        except Exception:
            LOG.exception("Recognition failed")
            self.error(500, "Recognition failed; check the service console (model, language or GPU dependencies)")
        finally:
            self.server.inference_lock.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="Systran/faster-whisper-small", help="Hugging Face model ID, faster-whisper alias, or local model directory")
    parser.add_argument("--model-id", help="ID advertised to the extension; defaults to --model")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--download-root", default=str(Path(__file__).parent / "models"))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or args.threads < 1:
        parser.error("Invalid port or thread count")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Reserve the port before downloading a model, so conflicts are reported immediately.
    server = ASRServer(("127.0.0.1", args.port), Handler)
    try:
        from faster_whisper import WhisperModel
        LOG.info("Loading %s on %s (%s). First launch may download the model; please wait.", args.model, args.device, args.compute_type)
        server.model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                                   cpu_threads=args.threads, download_root=args.download_root)
        server.model_id = args.model_id or args.model
        server.device = args.device
        server.api_key = os.environ.get("LOCAL_ASR_API_KEY", "").strip()
        server.inference_lock = threading.Lock()
        LOG.info("READY: http://127.0.0.1:%s/v1 | model: %s | authentication: %s", args.port, server.model_id, "enabled" if server.api_key else "off (loopback only)")
        LOG.info("Keep this window open. Press Ctrl+C to stop.")
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nLocal ASR stopped.")
    except Exception:
        LOG.exception("Startup failed. Check the port, model download and installed dependencies.")
        raise SystemExit(1)
