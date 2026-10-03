"""Route-aware prompt refinement: try the preferred provider, rotate models and then other
providers on this machine, and offer the macOS picker when every attempt fails.

Provider CLIs live in refine_providers.py, saved picks in refine_choices.py, the picker in mac_picker.py.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from mac_picker import SKIP_REFINE_LABEL, pick_refine_target, picker_enabled
from refine_choices import (
    DEFAULT_BACKEND,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    mark_codex_model_failed,
    read_user_choice,
    save_refine_choice,
)
from refine_providers import (
    KNOWN_BACKENDS,
    backend_is_launchable,
    codex_model_candidates,
    dedupe,
    discover_providers,
    is_model_unavailable_error,
    list_claude_models,
    list_gemini_models,
    list_grok_models,
    list_ollama_models,
    list_opencode_models,
    list_pi_models,
    looks_like_failed_model_output,
    normalize_backend,
    refine_with_provider,
)

# Bounds so a dictation release never hangs on rotation.
MAX_MODELS_PER_BACKEND = 6
MAX_CROSS_BACKEND_ATTEMPTS = 4
MAX_TOTAL_ATTEMPTS = 12
# Order for trying other providers after the requested one fails.
_BACKEND_FALLBACK_ORDER = ("codex", "opencode", "gemini", "grok", "pi", "ollama", "claude")
# Model lister and last-resort model per backend (codex has its own candidate order).
_MODEL_LISTERS = {
    "ollama": (list_ollama_models, "llama3.2"),
    "grok": (list_grok_models, "grok-4.5"),
    "claude": (list_claude_models, "sonnet"),
    "gemini": (list_gemini_models, "gemini-3.6-flash-low"),
    "opencode": (list_opencode_models, "opencode/big-pickle"),
    "pi": (list_pi_models, "default"),
}
# Generic failures (network, CLI errors) still move on to the next candidate.
_ROTATE_MARKERS = ("failed", "error", "timeout", "timed out", "connection", "refused", "not found", "empty")


def _should_rotate_after_failure(detail: str) -> bool:
    return looks_like_failed_model_output(detail) or any(marker in detail.lower() for marker in _ROTATE_MARKERS)


def _model_candidates_for_backend(backend: str, preferred: str = "") -> list[str]:
    """Model ids for one backend: preferred, then the sticky pick, then discovery."""
    be = normalize_backend(backend)
    preferred_name = (preferred or "").strip()
    head = [preferred_name] if preferred_name not in ("default", "auto") else []
    sticky = read_user_choice()
    if sticky.get("backend") == be and sticky.get("model"):
        head.append(sticky["model"])
    if be == "codex":
        discovered, fallback = codex_model_candidates(preferred_name or DEFAULT_MODEL), DEFAULT_MODEL
    elif be in _MODEL_LISTERS:
        lister, fallback = _MODEL_LISTERS[be]
        discovered = lister()
    else:
        discovered, fallback = [preferred_name or "default"], "default"
    return dedupe([*head, *discovered])[:MAX_MODELS_PER_BACKEND] or [fallback]


def _build_attempt_queue(backend: str, model: str, *, cross_backend: bool = True) -> list[tuple[str, str]]:
    """(backend, model) attempts: the preferred provider first, then others on PATH."""
    preferred_backend = normalize_backend(backend)
    preferred_model = (model or "").strip()
    attempts: list[tuple[str, str]] = []

    def add(be: str, mo: str) -> None:
        key = (normalize_backend(be), (mo or "").strip())
        if not key[1] or key in attempts:
            return
        if not backend_is_launchable(key[0]) and key[0] != "local":
            return
        attempts.append(key)

    sticky = read_user_choice()
    if preferred_backend == "auto":
        sticky_be = sticky.get("backend") or ""
        order = list(_BACKEND_FALLBACK_ORDER)
        if sticky_be in order:
            order = [sticky_be, *[be for be in order if be != sticky_be]]
        # Apple local is free and fast when available.
        if backend_is_launchable("local"):
            add("local", "apple-fm")
        for be in order:
            sticky_model = sticky.get("model") if sticky.get("backend") == be else ""
            for mo in _model_candidates_for_backend(be, preferred_model if be == sticky_be else sticky_model):
                add(be, mo)
                if len(attempts) >= MAX_MODELS_PER_BACKEND + MAX_CROSS_BACKEND_ATTEMPTS:
                    return attempts
        return attempts

    if preferred_backend == "local":
        add("local", "apple-fm")
        if cross_backend:
            # After local fails, behave like auto without retrying local.
            for be, mo in _build_attempt_queue("auto", preferred_model, cross_backend=False):
                if be != "local":
                    add(be, mo)
        return attempts

    for mo in _model_candidates_for_backend(preferred_backend, preferred_model):
        add(preferred_backend, mo)
    if not cross_backend:
        return attempts
    cross = 0
    for be in _BACKEND_FALLBACK_ORDER:
        if be == preferred_backend or not backend_is_launchable(be):
            continue
        sticky_model = sticky.get("model") if sticky.get("backend") == be else ""
        candidates = _model_candidates_for_backend(be, sticky_model)
        if not candidates:
            continue
        add(be, candidates[0])
        cross += 1
        if cross >= MAX_CROSS_BACKEND_ATTEMPTS:
            break
    return attempts[:MAX_TOTAL_ATTEMPTS]


def refine_prompt(
    original: str,
    backend: str = DEFAULT_BACKEND,
    model: str = DEFAULT_MODEL,
    reasoning_effort: str = "",
    *,
    allow_picker: bool = True,
) -> str:
    """Refine with the preferred provider, rotating models and then providers on failure;
    after that, optionally ask via the macOS picker (which can also skip refine)."""
    draft = original.strip()
    if not draft:
        raise ValueError("Nothing to refine")
    choice = normalize_backend(backend)
    if choice not in KNOWN_BACKENDS:
        raise ValueError(f"Unknown prompt refinement backend: {backend!r}. Known: {', '.join(KNOWN_BACKENDS)}")
    sticky = read_user_choice()
    effort = (reasoning_effort or "").strip().lower() or sticky.get("reasoningEffort") or DEFAULT_REASONING_EFFORT
    requested_model = (model or "").strip()

    attempts = _build_attempt_queue(choice, model or sticky.get("model") or DEFAULT_MODEL)
    if not attempts:
        raise RuntimeError(
            "No refine providers available on PATH (install codex/opencode/pi/agy/… or enable Apple local)."
        )

    errors: list[str] = []
    for be, mo in attempts:
        try:
            print(f"refine try {be}/{mo}", file=sys.stderr)
            refined = refine_with_provider(be, mo, effort, draft)
            if be != choice or mo != requested_model:
                print(
                    f"refine fell back to {be}/{mo} (preferred {choice}/{requested_model or 'default'})",
                    file=sys.stderr,
                )
            # Also records a Codex model as last-good and clears its failed mark.
            save_refine_choice(mo, effort, backend=be)
            return refined
        except Exception as error:
            detail = str(error)
            errors.append(f"{be}/{mo}: {detail[:400]}")
            if be == "codex" and is_model_unavailable_error(detail):
                mark_codex_model_failed(mo)
            if not _should_rotate_after_failure(detail):
                break
            print(f"refine rotate after {be}/{mo}: {detail[:160]}", file=sys.stderr)

    joined = "; ".join(errors) if errors else "all refine attempts failed"
    if not (allow_picker and picker_enabled()):
        raise RuntimeError(f"refine failed after fallbacks: {joined}"[:2000])
    picked = pick_refine_target(
        reason=f"Automatic refine fallbacks failed.\n{joined[:500]}",
        preferred_backend=choice,
        preferred_model=requested_model,
        preferred_effort=effort,
        include_skip=True,
        use_gui=True,
    )
    if picked is None:
        raise RuntimeError(f"refine cancelled at picker: {joined}"[:2000])
    if picked["model"] == SKIP_REFINE_LABEL:
        print("refine skipped via picker; returning raw draft", file=sys.stderr)
        return draft
    pick_backend = normalize_backend(picked.get("backend") or choice)
    pick_effort = picked.get("reasoningEffort") or effort or DEFAULT_REASONING_EFFORT
    save_refine_choice(picked["model"], pick_effort, backend=pick_backend)
    # One explicit attempt with the user's pick; no second picker.
    return refine_with_provider(pick_backend, picked["model"], pick_effort, draft)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refine a coding-agent prompt (route-aware, multi-provider).")
    parser.add_argument("--text", default="", help="Draft prompt text")
    parser.add_argument(
        "--backend",
        default=DEFAULT_BACKEND,
        help=f"Provider: {', '.join(KNOWN_BACKENDS)} (default: {DEFAULT_BACKEND})",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model id for the provider (default: {DEFAULT_MODEL})")
    parser.add_argument(
        "--reasoning-effort",
        default="",
        dest="reasoning_effort",
        help="Optional reasoning effort (low|medium|high|xhigh|minimal)",
    )
    parser.add_argument(
        "--no-picker",
        action="store_true",
        help="Disable the macOS model/effort picker on quota or total failure (CI/headless).",
    )
    parser.add_argument(
        "--list-providers",
        action="store_true",
        help="JSON: providers + models discovered on this machine (no refine).",
    )
    parser.add_argument(
        "--pick-menu",
        action="store_true",
        help="Interactive pick of backend/model/effort; print it as JSON for `dufflebag config pick-refine` to save.",
    )
    parser.add_argument(
        "--gui",
        action="store_true",
        help="With --pick-menu, force macOS GUI dialogs (default on darwin TTY uses stdin).",
    )
    args = parser.parse_args(argv)

    if args.list_providers:
        print(json.dumps({"providers": discover_providers(force_refresh=True)}, indent=2))
        return 0

    if args.pick_menu:
        # macOS dialogs unless running in an interactive terminal (then a stdin menu).
        use_gui = args.gui or (sys.platform == "darwin" and not sys.stdin.isatty())
        picked = pick_refine_target(
            reason="Pick refine provider + model + effort for STT.",
            preferred_backend=args.backend,
            preferred_model=args.model,
            preferred_effort=args.reasoning_effort,
            include_skip=False,
            use_gui=use_gui,
        )
        if picked is None:
            print("cancelled", file=sys.stderr)
            return 1
        save_refine_choice(
            picked["model"],
            picked.get("reasoningEffort") or DEFAULT_REASONING_EFFORT,
            backend=picked.get("backend") or "",
        )
        print(json.dumps(picked, indent=2))
        return 0

    text = args.text
    if not text and not sys.stdin.isatty():
        text = sys.stdin.read()
    if not text.strip():
        print("error: pass --text or pipe stdin", file=sys.stderr)
        return 2
    if args.no_picker:
        os.environ["DUFFLEBAG_REFINE_PICKER"] = "off"
    try:
        print(
            refine_prompt(
                text,
                backend=args.backend,
                model=args.model,
                reasoning_effort=args.reasoning_effort,
                allow_picker=not args.no_picker,
            )
        )
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
