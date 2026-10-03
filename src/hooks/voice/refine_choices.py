"""Saved refine choices in the voice state folder: the sticky backend/model/effort pick and the
Codex last-good and failed-model caches, so the next dictation skips models that already failed."""

from __future__ import annotations

import json
import os
import sys
import time

DEFAULT_BACKEND = "codex"
DEFAULT_MODEL = "gpt-5.3-codex-spark"
# Low effort keeps dictation refine fast; Codex reasoning models otherwise default to xhigh.
DEFAULT_REASONING_EFFORT = "low"


def _voice_state_dir() -> str:
    # Same override the Rust worker and the Stop hook honor, so all three share one state folder.
    override = os.environ.get("DUFFLEBAG_VOICE_DIR", "").strip()
    if override:
        return os.path.abspath(override)
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/dufflebag/voice")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "dufflebag", "voice")
    return os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "dufflebag", "voice")


def _state_path(name: str) -> str:
    return os.path.join(_voice_state_dir(), name)


def _read_state_file(name: str) -> str:
    try:
        with open(_state_path(name), encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def _write_state_file(name: str, text: str) -> None:
    path = _state_path(name)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass


def read_codex_model_cache() -> str:
    return _read_state_file("refine-codex-model.cache").strip()


def write_codex_model_cache(model: str) -> None:
    _write_state_file("refine-codex-model.cache", model.strip() + "\n")


def read_codex_failed_models() -> set[str]:
    return {line.strip() for line in _read_state_file("refine-codex-failed-models.cache").splitlines() if line.strip()}


def _write_codex_failed_models(failed: set[str]) -> None:
    _write_state_file("refine-codex-failed-models.cache", "\n".join(sorted(failed)) + ("\n" if failed else ""))


def mark_codex_model_failed(model: str) -> None:
    name = model.strip()
    failed = read_codex_failed_models()
    if name and name not in failed:
        _write_codex_failed_models(failed | {name})


def clear_codex_model_failed(model: str) -> None:
    name = model.strip()
    failed = read_codex_failed_models()
    if name and name in failed:
        _write_codex_failed_models(failed - {name})


def read_user_choice() -> dict[str, str]:
    try:
        value = json.loads(_read_state_file("refine-user-choice.json"))
        if isinstance(value, dict):
            return {
                "backend": str(value.get("backend") or "").strip().lower(),
                "model": str(value.get("model") or "").strip(),
                "reasoningEffort": str(value.get("reasoningEffort") or "").strip().lower(),
            }
    except (json.JSONDecodeError, TypeError):
        pass
    return {"backend": "", "model": "", "reasoningEffort": ""}


def save_refine_choice(model: str, reasoning_effort: str, backend: str = "") -> None:
    """Remember backend+model+effort in voice state for the next dictation.

    config.json is receipt-owned by the dufflebag CLI, so a pick reaches it only through
    `dufflebag config pick-refine`, which reads the JSON `--pick-menu` prints.
    """
    model = model.strip()
    if not model:
        return
    backend = (backend or "").strip().lower()
    effort = (reasoning_effort or DEFAULT_REASONING_EFFORT).strip().lower() or DEFAULT_REASONING_EFFORT
    choice = {"backend": backend, "model": model, "reasoningEffort": effort, "updatedAt": time.time()}
    _write_state_file("refine-user-choice.json", json.dumps(choice, indent=2) + "\n")
    if backend in ("", "codex", "auto"):
        write_codex_model_cache(model)
        clear_codex_model_failed(model)
