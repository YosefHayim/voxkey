#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "numpy==2.2.6; python_version < '3.11'",
#   "numpy==2.4.6; python_version == '3.11'",
#   "numpy==2.5.1; python_version >= '3.12'",
#   "sounddevice==0.5.5",
#   "supertonic==1.3.1",
# ]
# [tool.uv]
# exclude-newer = "2026-07-30T00:00:00Z"
# ///

"""Warm Supertonic TTS for the Rust voice worker: `serve` loads the models once, then answers
JSON lines and streams speech chunk by chunk."""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import sys
import threading
import time
from typing import Any

_tts_engine: Any = None
_tts_style: Any = None
_tts_voice: str = ""
_stop_event = threading.Event()
# Short chunks so the first words are heard sooner.
STREAM_CHUNK_CHARS = 280


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _voice_name(voice: str) -> str:
    return voice.upper() if re.fullmatch(r"[MF][1-5]", voice.upper() or "") else "F4"


def chunk_speech(text: str, max_chars: int = STREAM_CHUNK_CHARS) -> list[str]:
    if max_chars < 1:
        raise ValueError("max_chars must be positive")
    chunks: list[str] = []
    remaining = text
    while len(remaining) > max_chars:
        window = remaining[: max_chars + 1]
        sentence_breaks = [match.end() for match in re.finditer(r"[.!?](?:\s|$)", window)]
        split_at = sentence_breaks[-1] if sentence_breaks else window.rfind(" ") + 1
        if split_at <= 0 or split_at > max_chars:
            split_at = max_chars
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]
    if remaining:
        chunks.append(remaining)
    return chunks


def tts_runtime(voice: str) -> tuple[Any, Any]:
    global _tts_engine, _tts_style, _tts_voice
    voice_name = _voice_name(voice)
    if _tts_engine is None:
        from supertonic import TTS

        _tts_engine = TTS(auto_download=True)
    if _tts_style is None or _tts_voice != voice_name:
        _tts_style = _tts_engine.get_voice_style(voice_name=voice_name)
        _tts_voice = voice_name
    return _tts_engine, _tts_style


def play_samples(samples: Any, sample_rate: int) -> str:
    import sounddevice

    if getattr(samples, "size", 0) == 0:
        return "ok"
    duration = min(max(0.01, float(len(samples)) / float(sample_rate)), 120.0)
    sounddevice.play(samples, sample_rate, blocking=False)
    started = time.monotonic()
    while time.monotonic() - started < duration:
        if _stop_event.is_set():
            with contextlib.suppress(Exception):
                sounddevice.stop()
            return "stopped"
        time.sleep(0.03)
    try:
        sounddevice.wait(timeout=1.0)
    except TypeError:
        sounddevice.wait()
    except Exception:
        pass
    return "ok"


def _done(status: str) -> str:
    emit({"event": "done", "status": status})
    return status


def speak(text: str, voice: str, speed: float) -> str:
    import sounddevice

    def stopped() -> str:
        with contextlib.suppress(Exception):
            sounddevice.stop()
        return _done("stopped")

    clean = text.strip()
    if not clean:
        return _done("completed")
    _stop_event.clear()
    engine, style = tts_runtime(voice)
    pieces = [chunk.strip() for chunk in chunk_speech(clean) if chunk.strip()]
    for index, piece in enumerate(pieces):
        if _stop_event.is_set():
            return stopped()
        emit({"event": "chunk", "i": index, "n": len(pieces)})
        audio, _ = engine.synthesize(
            piece,
            voice_style=style,
            total_steps=8,
            speed=min(2.0, max(0.7, speed)),
            max_chunk_length=300,
            silence_duration=0.18,
            lang="en",
            verbose=False,
        )
        if _stop_event.is_set():
            return stopped()
        if play_samples(audio.squeeze(), int(engine.sample_rate)) == "stopped":
            return _done("stopped")
    return _done("completed")


def serve(default_voice: str) -> int:
    try:
        tts_runtime(default_voice)
    except Exception as error:
        emit({"event": "error", "message": str(error)})
        return 1
    emit({"event": "ready", "voice": _voice_name(default_voice)})
    for stdin_line in sys.stdin:
        line = stdin_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            emit({"event": "error", "message": "invalid json"})
            continue
        if not isinstance(message, dict):
            emit({"event": "error", "message": "expected object"})
            continue
        cmd = str(message.get("cmd", "")).strip().lower()
        voice = str(message.get("voice", default_voice))
        if cmd == "quit":
            emit({"event": "bye"})
            return 0
        if cmd == "stop":
            _stop_event.set()
            with contextlib.suppress(Exception):
                import sounddevice

                sounddevice.stop()
            _done("stopped")
        elif cmd == "ping":
            emit({"event": "pong"})
        elif cmd == "speak":
            text = str(message.get("text", ""))
            speed = float(message.get("speed", 1.15))
            try:
                speak(text, voice, speed)
            except Exception as error:
                emit({"event": "error", "message": str(error)})
                _done("error")
        else:
            emit({"event": "error", "message": f"unknown cmd: {cmd}"})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Dufflebag Supertonic TTS server")
    parser.add_subparsers(dest="command", required=True).add_parser("serve").add_argument("--voice", default="F4")
    return serve(parser.parse_args().voice)


if __name__ == "__main__":
    raise SystemExit(main())
