"""Interactive refine picker (macOS dialogs, or a numbered stdin menu in a terminal): a provider
found on this machine, then a model and, when the provider supports it, a reasoning effort."""

from __future__ import annotations

import contextlib
import os
import subprocess
import sys
from typing import Any

from refine_choices import DEFAULT_REASONING_EFFORT, read_codex_model_cache, read_user_choice
from refine_providers import (
    CODEX_MODEL_FALLBACKS,
    CODEX_PICKER_MODELS,
    REASONING_EFFORT_OPTIONS,
    dedupe,
    discover_providers,
    read_codex_models_cache_file,
)

# ASCII hyphens: AppleScript choose-from-list can choke on em-dashes.
SKIP_REFINE_LABEL = "-- Skip refine (keep raw STT) --"
_NO_PROVIDERS = "No known agent CLIs found on PATH (codex, claude, gemini, grok, ollama, opencode, …)."


def _applescript_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def _osascript(source: str, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["osascript", "-e", source], capture_output=True, text=True, timeout=timeout, check=False)


def _macos_choose_from_list(*, title: str, prompt: str, items: list[str], default: str = "") -> str | None:
    """Native macOS list picker; None when cancelled."""
    if not items:
        return None
    # AppleScript pre-selects the first item, so put the default first.
    ordered = [default, *[item for item in items if item != default]] if default and default in items else items
    quoted = ", ".join(f'"{_applescript_escape(item)}"' for item in ordered)
    script = f'''
try
  set theList to {{{quoted}}}
  set theChoice to choose from list theList with title "{_applescript_escape(title)}" with prompt "{_applescript_escape(prompt)}" default items {{item 1 of theList}} OK button name "Use" cancel button name "Cancel"
  if theChoice is false then
    return "CANCEL"
  end if
  return item 1 of theChoice
on error errMsg number errNum
  return "ERROR:" & errMsg
end try
'''
    chosen = (_osascript(script).stdout or "").strip()
    if not chosen or chosen == "CANCEL" or chosen.startswith("ERROR:"):
        return None
    return chosen


def _macos_alert(title: str, message: str) -> None:
    script = f'''
try
  display alert "{_applescript_escape(title)}" message "{_applescript_escape(message[:900])}" as warning buttons {{"OK"}} default button "OK"
end try
'''
    with contextlib.suppress(OSError, subprocess.TimeoutExpired):
        _osascript(script, timeout=60)


def _ask_numbered(heading: str, items: list[str], question: str) -> str | None:
    """Print a numbered menu on stderr and read one answer; None at end of input."""
    print(heading, file=sys.stderr)
    for index, item in enumerate(items, start=1):
        print(f"  {index}. {item}", file=sys.stderr)
    try:
        return input(question).strip()
    except EOFError:
        return None


def _numbered_item(answer: str, items: list[str]) -> str | None:
    return items[int(answer) - 1] if answer.isdigit() and 1 <= int(answer) <= len(items) else None


def picker_enabled() -> bool:
    if os.environ.get("DUFFLEBAG_REFINE_PICKER", "").strip().lower() in ("off", "0", "false", "no"):
        return False
    if os.environ.get("CI", "").strip():
        return False
    return sys.platform == "darwin"


def _picker_models_for_backend(
    backend: str,
    *,
    providers: list[dict[str, Any]],
    preferred: str = "",
    exclude: set[str] | None = None,
) -> list[str]:
    """Model ids for one already-discovered backend, preferred first."""
    models = next((provider["models"] for provider in providers if provider["id"] == backend), [])
    head = [preferred]
    if backend in ("codex", "auto"):
        head += [read_codex_model_cache(), read_user_choice().get("model", "")]
        models = [*models, *read_codex_models_cache_file(), *CODEX_PICKER_MODELS, *CODEX_MODEL_FALLBACKS]
    return [name for name in dedupe([*head, *models]) if name not in (exclude or set())]


def _pick_backend(providers: list[dict[str, Any]], preferred_backend: str, summary: str, gui: bool) -> str | None:
    labels = [f"{p['id']}  ({p['binary']}, {len(p['models'])} models)" for p in providers]
    ids = [p["id"] for p in providers]
    preferred = (preferred_backend or "").strip().lower()
    if gui:
        chosen = _macos_choose_from_list(
            title="Dufflebag refine",
            prompt="Provider (detected on this Mac):",
            items=labels,
            default=labels[ids.index(preferred)] if preferred in ids else labels[0],
        )
        if chosen is None:
            return None
        return ids[labels.index(chosen)] if chosen in labels else ids[0]
    print(summary, file=sys.stderr)
    answer = _ask_numbered("Providers:", labels, f"Provider [1-{len(labels)}]: ")
    if answer is None:
        return None
    if not answer:
        return ids[0]
    return _numbered_item(answer, ids) or (answer.lower() if answer.lower() in ids else None)


def _pick_model(backend: str, models: list[str], preferred_model: str, gui: bool) -> str | None:
    if gui:
        return _macos_choose_from_list(
            title="Dufflebag refine",
            prompt=f"Model for {backend}:",
            items=models,
            default=preferred_model if preferred_model in models else models[0],
        )
    answer = _ask_numbered(f"Models for {backend}:", models, f"Model [1-{len(models)}]: ")
    if answer is None:
        return None
    # Any other text is taken as a custom model id.
    return (_numbered_item(answer, models) or answer) if answer else models[0]


def _pick_effort(model: str, preferred_effort: str, gui: bool) -> str | None:
    effort_default = (preferred_effort or DEFAULT_REASONING_EFFORT).strip().lower()
    if effort_default not in REASONING_EFFORT_OPTIONS:
        effort_default = DEFAULT_REASONING_EFFORT
    if gui:
        return _macos_choose_from_list(
            title="Dufflebag refine",
            prompt=f"Reasoning effort for {model}:",
            items=list(REASONING_EFFORT_OPTIONS),
            default=effort_default,
        )
    print(f"Reasoning: {', '.join(REASONING_EFFORT_OPTIONS)}", file=sys.stderr)
    try:
        answer = input(f"Effort [{effort_default}]: ").strip().lower()
    except EOFError:
        return None
    return answer if answer in REASONING_EFFORT_OPTIONS else effort_default


def pick_refine_target(
    *,
    reason: str = "",
    preferred_backend: str = "",
    preferred_model: str = "",
    preferred_effort: str = "",
    exclude_models: set[str] | None = None,
    include_skip: bool = True,
    use_gui: bool | None = None,
) -> dict[str, str] | None:
    """{"backend", "model", "reasoningEffort"} picked from providers on this machine, or None when
    cancelled. The model is SKIP_REFINE_LABEL when the user skips (only offered with include_skip)."""
    gui = picker_enabled() if use_gui is None else use_gui
    print("Discovering refine providers on this machine…", file=sys.stderr, flush=True)
    providers = discover_providers()
    if not providers:
        if gui:
            _macos_alert("No refine providers", _NO_PROVIDERS)
        else:
            print(_NO_PROVIDERS, file=sys.stderr)
        return None

    summary = reason.strip() or "Choose a refine provider available on this machine."
    if len(summary) > 280:
        summary = summary[:277] + "…"
    if gui and reason.strip():
        _macos_alert("Prompt refine — pick provider / model", summary)
    backend = _pick_backend(providers, preferred_backend, summary, gui)
    if backend is None:
        return None

    models = _picker_models_for_backend(backend, providers=providers, preferred=preferred_model, exclude=exclude_models)
    if include_skip:
        models = [*models, SKIP_REFINE_LABEL]
    elif not models:
        models = ["default"]
    model = _pick_model(backend, models, preferred_model, gui)
    if model is None:
        return None
    if model == SKIP_REFINE_LABEL:
        return {"backend": backend, "model": SKIP_REFINE_LABEL, "reasoningEffort": ""}

    effort = ""
    if any(provider["id"] == backend and provider.get("effort") for provider in providers):
        effort = _pick_effort(model, preferred_effort, gui)
        if effort is None:
            return None
    return {"backend": backend, "model": model, "reasoningEffort": effort}
