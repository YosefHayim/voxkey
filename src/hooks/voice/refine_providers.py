"""Each AI tool refine can run: find its CLI, list its models, run it, and judge its reply.

A reply is rejected when it is empty, a CLI help dump, an auth or quota error envelope, or
when it dropped a protected literal (code, path, URL, or quoted text) from the draft.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from refine_choices import (
    DEFAULT_BACKEND,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    read_codex_failed_models,
    read_codex_model_cache,
)

# Backends refine can run, with their aliases (agent = grok, agy = gemini, pie = pi).
KNOWN_BACKENDS = (
    "codex",
    "local",
    "auto",
    "grok",
    "agent",
    "ollama",
    "opencode",
    "claude",
    "gemini",
    "agy",
    "pi",
    "pie",
)
_BACKEND_ALIASES = {"agent": "grok", "agy": "gemini", "pie": "pi"}

# Tried in order when the requested Codex model is missing or not allowed for the signed-in
# account (ChatGPT vs API); fast models first so dictation stays snappy.
CODEX_MODEL_FALLBACKS = (
    "gpt-5.3-codex-spark",
    "gpt-5.4-mini",
    "gpt-5.6-terra",
    "gpt-5.1-codex-mini",
    "o4-mini",
    "gpt-4.1-mini",
)

# Offered by the picker after the live ~/.codex/models_cache.json entries.
CODEX_PICKER_MODELS = (
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex-spark",
    "gpt-5.1-codex-mini",
    "o4-mini",
    "gpt-4.1-mini",
    "gpt-4.1",
)

REASONING_EFFORT_OPTIONS = ("minimal", "low", "medium", "high", "xhigh")

# Short timeouts so pick-refine does not hang on slow CLIs; discovery runs them in parallel.
_DISCOVERY_CMD_TIMEOUT = 12
_DISCOVERY_CACHE_TTL_SECS = 120.0
_discovered: list[dict[str, Any]] | None = None
_discovered_at = 0.0

# Agent CLIs that print auth/help failures with exit 0.
_CLI_AUTH_OR_CONFIG_FAIL_MARKERS = (
    "no api key found",
    "use /login",
    "not logged in",
    "not signed in",
    "no models available",
    "please log in",
    "authentication required",
    "unauthorized",
    "login required",
)

_MODEL_UNAVAILABLE_MARKERS = (
    "model is not supported",
    "model not found",
    "unknown model",
    "invalid model",
    "unsupported model",
    "does not exist",
    "not available for",
    "not supported when using",
    "model_not_found",
    "invalid_model",
    "no such model",
    "the requested model is not supported",
    "model_not_supported",
)

_QUOTA_OR_LIMIT_MARKERS = (
    "quota",
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    'status":429',
    "status code 429",
    "http 429",
    " 429",
    " 402",
    'status":402',
    "usage limit",
    "usage_limit",
    "insufficient_quota",
    "exceeded your current quota",
    "billing",
    "limit reached",
    "tokens per min",
    "requests per min",
    "tpm",
    "rpm",
    "out of credits",
    "requires more credits",
    "can only afford",
    "openrouter.ai/settings/credits",
    "payment required",
    "spending limit",
    "budget",
    "credit balance",
    "insufficient credits",
)

REFINE_INSTRUCTIONS = """You refine messy freeform or spoken drafts into a single paste-ready prompt for a coding agent.

Rules:
1. Preserve exact intent, facts, constraints, code, commands, paths, URLs, quoted literals, and acceptance criteria.
2. Remove filler, false starts, and repetition. Make implied deliverables explicit only when already supported by the draft.
3. Prefer routing to existing skills when the draft is clearly that workflow (finish-and-push, organize-commits, simplify-code, clean-repo-by-feature, run-tasks-in-parallel, run-local-and-check, deploy-and-check, which-skill, etc.). Lead with the primary skill id when helpful: "finish-and-push: …".
4. Do not invent a multi-skill plan, a routing chat, or a long report. Output is the agent message the user would paste/send next.
5. Do not answer the prompt. Do not add commentary, labels, Markdown fences around the whole reply, or invented requirements.
6. Return only the revised prompt text."""

_LITERAL_PATTERNS = (
    r"```[\s\S]*?```",
    r"`[^`\n]+`",
    r"https?://[^\s<>()]+",
    r"(?<!\w)(?:\.{0,2}/)[^\s,;:!?]+",
    r"(?<!\w)(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+",
    r"(?<!\w)(?:'[^'\n]+'|\"[^\"\n]+\")",
)


def prompt_literals(text: str) -> list[str]:
    literals: list[str] = []
    occupied: list[tuple[int, int]] = []
    for pattern in _LITERAL_PATTERNS:
        for match in re.finditer(pattern, text):
            span = match.span()
            if any(span[0] < end and start < span[1] for start, end in occupied):
                continue
            occupied.append(span)
            literals.append(match.group(0))
    return literals


def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in markers)


def _looks_like_cli_help(text: str) -> bool:
    """True when stdout is a CLI --help dump (e.g. OpenCode's yargs help), not a refined prompt."""
    blob = (text or "").strip().lower()
    if not blob:
        return False
    if sum(anchor in blob for anchor in ("positionals:", "options:", "show help", "[boolean]")) >= 3:
        return True
    if "run opencode with a message" in blob and "positionals:" in blob:
        return True
    return blob.startswith("opencode run [message") or "opencode run [message..]" in blob


def _looks_like_cli_auth_or_config_failure(text: str) -> bool:
    return _contains_any((text or "").strip(), _CLI_AUTH_OR_CONFIG_FAIL_MARKERS)


def is_model_unavailable_error(message: str) -> bool:
    return _contains_any(message, _MODEL_UNAVAILABLE_MARKERS)


def is_quota_or_limit_error(message: str) -> bool:
    return _contains_any(message, _QUOTA_OR_LIMIT_MARKERS)


def looks_like_failed_model_output(text: str) -> bool:
    """True when CLI stdout is an error envelope, not a refined prompt.

    Several agents (pi, OpenRouter wrappers) print 402/JSON errors with exit 0; those must
    never be typed into the caret as the refined draft.
    """
    blob = (text or "").strip()
    if not blob:
        return True
    if _looks_like_cli_help(blob) or _looks_like_cli_auth_or_config_failure(blob):
        return True
    if is_quota_or_limit_error(blob) or is_model_unavailable_error(blob):
        return True
    lower = blob.lower()
    if lower.startswith("402") or '"code":402' in lower or '"code": 402' in lower:
        return True
    if "invalid_request_error" in lower:
        return True
    return blob.startswith("{") and (
        '"error"' in lower or ('"code"' in lower and ("message" in lower or "credits" in lower))
    )


def validate_refined_prompt(original: str, refined: str) -> str:
    clean = refined.strip()
    if clean.startswith("```") and clean.endswith("```"):
        lines = clean.splitlines()
        if len(lines) >= 2:
            clean = "\n".join(lines[1:-1]).strip()
    if not clean:
        raise ValueError("The model returned an empty prompt")
    if _looks_like_cli_help(clean):
        raise ValueError("The model returned CLI help text instead of a refined prompt")
    missing = [literal for literal in prompt_literals(original) if literal not in clean]
    if missing:
        raise ValueError(f"The model changed a protected literal: {missing[0]}")
    return clean


def build_user_prompt(original: str) -> str:
    return f"{REFINE_INSTRUCTIONS}\n\nDraft to refine:\n---\n{original}\n---\nReturn only the revised prompt text."


_APPLE_UNAVAILABLE_REASONS = {
    "APPLE_INTELLIGENCE_NOT_ENABLED": "Apple Intelligence is not enabled in System Settings",
    "DEVICE_NOT_ELIGIBLE": "this Mac is not eligible for Apple Intelligence",
    "MODEL_NOT_READY": "the Apple Intelligence model is still downloading or preparing",
    "UNKNOWN": "Apple did not report why the model is unavailable",
}


def refinement_unavailable_reason(reason: Any) -> str:
    fallback = str(reason) if reason is not None else _APPLE_UNAVAILABLE_REASONS["UNKNOWN"]
    return _APPLE_UNAVAILABLE_REASONS.get(getattr(reason, "name", ""), fallback)


async def generate_refined_prompt_local(original: str) -> str:
    import apple_fm_sdk as fm

    model = fm.SystemLanguageModel(guardrails=fm.SystemLanguageModelGuardrails.PERMISSIVE_CONTENT_TRANSFORMATIONS)
    available, reason = model.is_available()
    if not available:
        raise RuntimeError(f"Apple Foundation Models is unavailable: {refinement_unavailable_reason(reason)}")
    session = fm.LanguageModelSession(model=model, instructions=REFINE_INSTRUCTIONS)
    refined_reply = await session.respond(prompt=original)
    return validate_refined_prompt(original, str(refined_reply))


def refine_prompt_local(original: str) -> str:
    if sys.platform != "darwin":
        raise RuntimeError("Local prompt refinement requires macOS with Apple Foundation Models")
    return asyncio.run(generate_refined_prompt_local(original))


def find_cli(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".local", "bin", name),
        os.path.join(home, ".grok", "bin", name),
        os.path.join(home, ".npm-global", "bin", name),
        os.path.join(home, "Library", "pnpm", name),
        os.path.join(home, "Library", "pnpm", "bin", name),
        os.path.join(home, ".local", "share", "pnpm", name),
        os.path.join(home, ".local", "share", "pnpm", "bin", name),
        f"/usr/local/bin/{name}",
        f"/opt/homebrew/bin/{name}",
        f"/usr/local/opt/{name}/bin/{name}",
    ]
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError(f"{name} CLI not found on PATH")


def find_cli_or_none(name: str) -> str | None:
    try:
        return find_cli(name)
    except RuntimeError:
        return None


def _first_cli(names: tuple[str, ...]) -> tuple[str, str] | None:
    """(name, path) of the first binary found, e.g. `gemini` before `agy`."""
    for name in names:
        path = find_cli_or_none(name)
        if path:
            return name, path
    return None


def _run(command: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    # Close stdin: several agent CLIs (codex exec, some print modes) block on
    # "Reading additional input from stdin..." when a pipe/TTY is inherited.
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=os.path.expanduser("~"),
        env={**os.environ, "NO_COLOR": "1"},
        stdin=subprocess.DEVNULL,
        check=False,
    )


def _stdout_text(completed: subprocess.CompletedProcess[str]) -> str:
    return (completed.stdout or "").strip() or (completed.stderr or "").strip()


def _run_lines(command: list[str], *, timeout: int = 20) -> list[str]:
    try:
        completed = _run(command, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return []
    blob = (completed.stdout or "") + "\n" + (completed.stderr or "")
    return [line.strip() for line in blob.splitlines() if line.strip()]


def dedupe(names: list[str]) -> list[str]:
    """Stripped, non-empty names in first-seen order."""
    kept: list[str] = []
    for name in names:
        token = (name or "").strip()
        if token and token not in kept:
            kept.append(token)
    return kept


def _part_text(value: dict[str, Any]) -> str:
    """Text from an OpenCode-style `{type, part: {type, text}}` event."""
    part = value.get("part")
    if not isinstance(part, dict):
        return ""
    if str(part.get("type") or "") not in ("", "text") and str(value.get("type") or "") != "text":
        return ""
    text = part.get("text")
    return text.strip() if isinstance(text, str) else ""


def _block_texts(content: list[Any]) -> list[str]:
    """Texts of Claude-style content blocks."""
    return [block["text"] for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)]


def _json_document_text(value: dict[str, Any]) -> str | None:
    """Text of one whole JSON reply, or None to fall back to the JSONL scan."""
    for key in ("result", "text", "content", "message", "output", "response"):
        item = value.get(key)
        if isinstance(item, str) and item.strip():
            return item.strip()
        if isinstance(item, dict):
            nested = item.get("text") or item.get("content")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
    part_text = _part_text(value)
    if part_text:
        return part_text
    content = value.get("content")
    texts = _block_texts(content) if isinstance(content, list) else []
    return "\n".join(texts).strip() if texts else None


def _extract_json_text(blob: str) -> str:
    """Best-effort final text from agent JSON or JSONL stdout."""
    blob = blob.strip()
    if not blob:
        return ""
    try:
        value = json.loads(blob)
    except json.JSONDecodeError:
        value = None
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        text = _json_document_text(value)
        if text is not None:
            return text

    last = ""
    text_parts: list[str] = []
    for line in blob.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        for key in ("result", "text", "content", "message", "output"):
            item = event.get(key)
            if isinstance(item, str) and item.strip():
                last = item.strip()
        part_text = _part_text(event)
        if part_text:
            text_parts.append(part_text)
            last = part_text
        message = event.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            last = content.strip()
        elif isinstance(content, list):
            joined = "\n".join(text for text in _block_texts(content) if text).strip()
            if joined:
                last = joined
    if text_parts:
        # Streamed parts are often cumulative: prefer the longest when it contains the rest.
        longest = max(text_parts, key=len)
        if all(longest.startswith(part) or part in longest for part in text_parts):
            return longest
        return "\n".join(text_parts).strip()
    return last


def list_ollama_models() -> list[str]:
    lines = _run_lines(["ollama", "list"], timeout=_DISCOVERY_CMD_TIMEOUT)
    names = [line.split()[0] for line in lines[1:] if line.split()]  # skip the NAME ID SIZE header
    return [name for name in names if name.upper() != "NAME"]


def read_codex_models_cache_file() -> list[str]:
    """Live account catalog from the Codex CLI cache (~/.codex/models_cache.json)."""
    try:
        with open(os.path.expanduser("~/.codex/models_cache.json"), encoding="utf-8") as handle:
            models_cache_document = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError):
        return []
    rows = models_cache_document.get("models") if isinstance(models_cache_document, dict) else None
    if not isinstance(rows, list):
        return []
    slugs: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("slug") or row.get("id") or "").strip()
        if slug and str(row.get("visibility") or "list").strip().lower() not in ("hide", "hidden", "never"):
            slugs.append(slug)
    return slugs


def list_codex_models() -> list[str]:
    """Config default, live models cache, last-good model, then curated fallbacks."""
    ordered: list[str] = []
    try:
        with open(os.path.expanduser("~/.codex/config.toml"), encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith("model") and "=" in line and not line.startswith("model_"):
                    value = line.split("=", 1)[1].strip().strip("\"'")
                    if value:
                        ordered.append(value)
                        break
    except OSError:
        pass
    ordered.extend(read_codex_models_cache_file())
    ordered.append(read_codex_model_cache())
    ordered.extend(CODEX_PICKER_MODELS)
    ordered.extend(CODEX_MODEL_FALLBACKS)
    return dedupe(ordered)


def list_claude_models() -> list[str]:
    fallback = ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "sonnet", "opus", "haiku"]
    for command in (["claude", "models"], ["claude", "--list-models"]):
        lines = _run_lines(command, timeout=_DISCOVERY_CMD_TIMEOUT)
        if _contains_any("\n".join(lines), ("not logged in", "please run /login", "please login")):
            return fallback
        tokens: list[str] = []
        for line in lines:
            if line.lower().startswith("usage") or line.startswith("-"):
                continue
            tokens.extend(re.findall(r"\bclaude-[\w.\-]+\b", line))
            tokens.extend(part for part in re.split(r"[\s,|]+", line) if part in ("sonnet", "opus", "haiku"))
        if tokens:
            return dedupe(tokens)
    return fallback


def _unglue_label(text: str) -> str:
    # agy prints ids glued to their Title Case label: "gemini-3.6-flash-highGemini 3.6 Flash (High)".
    return re.split(r"(?<=[a-z0-9])(?=[A-Z][a-z])", text, maxsplit=1)[0].strip()


def list_gemini_models() -> list[str]:
    """Gemini models from `agy models` (Antigravity), else from `gemini --help`."""
    agy = find_cli_or_none("agy")
    if agy:
        found: list[str] = []
        for line in _run_lines([agy, "models"], timeout=_DISCOVERY_CMD_TIMEOUT):
            if not line or line.lower().startswith(("usage", "fetching", "error", "options")):
                continue
            head = _unglue_label(line)
            token = head.split()[0].strip("()[],") if head.split() else ""
            if token.startswith(("gemini-", "claude-", "gpt-")):
                found.append(token)
        if found:
            return dedupe(found)[:80]
    for binary in ("gemini", "agy"):
        path = find_cli_or_none(binary)
        if not path:
            continue
        found = [
            _unglue_label(token)
            for line in _run_lines([path, "--help"], timeout=5)
            for token in re.findall(r"gemini-[\w.\-]+", line)
        ]
        if found:
            return dedupe(found)[:80]
    return [
        "gemini-3.6-flash-low",
        "gemini-3.6-flash-medium",
        "gemini-3.5-flash-low",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
    ]


def list_grok_models() -> list[str]:
    lines = _run_lines(["grok", "models"], timeout=_DISCOVERY_CMD_TIMEOUT) or _run_lines(
        ["agent", "models"], timeout=_DISCOVERY_CMD_TIMEOUT
    )
    ordered: list[str] = []
    in_available = False
    for line in lines:
        lower = line.lower()
        if "available model" in lower:
            in_available = True
            continue
        if in_available:
            # "* grok-4.5 (default)" or "  grok-4.5"
            token = re.sub(r"^[\s*•\-]+", "", line).split()[0].strip("()[],") if line.split() else ""
            if token.startswith("grok-") and token not in ordered:
                ordered.append(token)
                continue
            if lower.startswith(("usage", "options", "grok ")):
                break
        for token in re.findall(r"\bgrok-[\w.\-]+\b", line):
            if token not in ordered:
                ordered.append(token)
    if ordered:
        return ordered
    help_lines = _run_lines(["grok", "--help"], timeout=5)
    found = [token for line in help_lines for token in re.findall(r"\bgrok-[\w.\-]+\b", line)]
    return dedupe(found) or ["grok-4.5", "grok-4", "grok-3", "grok-3-mini"]


def list_opencode_models() -> list[str]:
    for command in (["opencode", "models"], ["opencode", "model", "list"]):
        found: list[str] = []
        for line in _run_lines(command, timeout=_DISCOVERY_CMD_TIMEOUT):
            if line.lower().startswith(("usage", "error", "options")):
                continue
            # Usually one provider/model id per line.
            if re.fullmatch(r"[\w.-]+/[\w.\-]+", line):
                found.append(line)
            else:
                found.extend(token for token in re.findall(r"[\w.-]+/[\w.\-]+", line) if "http" not in token)
        if found:
            return dedupe(found)[:80]
    return []


def _pi_rank(token: str) -> tuple[int, str]:
    # OAuth providers (codex, copilot) usually work; OpenRouter often needs credits.
    lower = token.lower()
    if "openrouter" in lower:
        return (9, token)
    for rank, prefix in enumerate(("openai-codex/", "github-copilot/", "kimi")):
        if lower.startswith(prefix):
            return (rank, token)
    return (5, token)


def list_pi_models() -> list[str]:
    """provider/model ids from the `pi --list-models` table ("openai-codex  gpt-5.4-mini  272K ...")."""
    lines = _run_lines(["pi", "--list-models"], timeout=_DISCOVERY_CMD_TIMEOUT)
    if _contains_any("\n".join(lines), ("no models available", "no api key", "use /login", "not logged in")):
        return ["default"]
    found: list[str] = []
    for line in lines:
        lower = line.lower()
        if lower.startswith(("usage", "options", "commands", "pi ", "use ", "see:", "error", "provider")):
            continue
        if any(noise in lower for noise in ("login", "api key", "providers.md", "models.md")):
            continue
        slash = re.findall(r"\b[a-z][\w.-]*/[\w.:\-]+\b", line, flags=re.I)
        if slash:
            found.extend(token for token in slash if "http" not in token.lower())
            continue
        parts = line.split()
        if len(parts) >= 2:
            provider, model_id = parts[0], parts[1]
            if (
                not provider.startswith("-")
                and model_id not in ("context", "max-out", "thinking", "images")
                and "http" not in model_id.lower()
            ):
                found.append(f"{provider}/{model_id}")
    return sorted(dedupe(found), key=_pi_rank)[:80] or ["default"]


# id → binary names (first found wins), reasoning-effort support, model lister.
_PROVIDER_DISCOVERY: tuple[dict[str, Any], ...] = (
    {"id": "codex", "bins": ("codex",), "effort": True, "list": list_codex_models},
    {"id": "claude", "bins": ("claude",), "effort": False, "list": list_claude_models},
    {"id": "gemini", "bins": ("gemini", "agy"), "effort": True, "list": list_gemini_models},
    {"id": "grok", "bins": ("grok", "agent"), "effort": True, "list": list_grok_models},
    {"id": "ollama", "bins": ("ollama",), "effort": False, "list": list_ollama_models},
    {"id": "opencode", "bins": ("opencode",), "effort": True, "list": list_opencode_models},
    {"id": "pi", "bins": ("pi", "pie"), "effort": True, "list": list_pi_models},
)


def _describe_provider(spec: dict[str, Any], cli: tuple[str, str]) -> dict[str, Any]:
    try:
        models = list(spec["list"]())
    except Exception:
        models = []
    return {
        "id": spec["id"],
        "binary": cli[0],
        "path": cli[1],
        "effort": bool(spec["effort"]),
        "models": models or ["default"],
    }


def discover_providers(*, force_refresh: bool = False) -> list[dict[str, Any]]:
    """Providers with a binary on this machine and their model ids.

    Model listing runs in parallel and is memoized so `pick-refine` does not wait on slow CLIs twice.
    """
    global _discovered, _discovered_at
    now = time.time()
    if force_refresh or _discovered is None or now - _discovered_at >= _DISCOVERY_CACHE_TTL_SECS:
        present = [(spec, cli) for spec in _PROVIDER_DISCOVERY if (cli := _first_cli(spec["bins"]))]
        _discovered = []
        if present:
            with ThreadPoolExecutor(max_workers=min(8, len(present))) as pool:
                _discovered = list(pool.map(lambda found: _describe_provider(*found), present))
        _discovered_at = now
    return _discovered


def normalize_backend(backend: str) -> str:
    choice = (backend or DEFAULT_BACKEND).strip().lower() or DEFAULT_BACKEND
    return _BACKEND_ALIASES.get(choice, choice)


def backend_is_launchable(backend: str) -> bool:
    be = normalize_backend(backend)
    if be == "local":
        return sys.platform == "darwin"
    spec = next((spec for spec in _PROVIDER_DISCOVERY if spec["id"] == be), None)
    return spec is not None and _first_cli(spec["bins"]) is not None


def codex_model_candidates(preferred: str) -> list[str]:
    """Try order: last-good (when the preferred id is known-dead), preferred, then fallbacks.

    Known-unavailable models go last so a ChatGPT-account rejection (~3 s) is not paid again
    on every dictation after the first failure.
    """
    preferred_name = (preferred or "").strip() or DEFAULT_MODEL
    last_good = read_codex_model_cache()
    failed = read_codex_failed_models()
    last_good_usable = bool(last_good) and last_good not in failed
    head = [last_good, preferred_name] if preferred_name in failed and last_good_usable else [preferred_name, last_good]

    ordered: list[str] = []
    deferred: list[str] = []
    for candidate in (*head, *CODEX_MODEL_FALLBACKS):
        name = (candidate or "").strip()
        if not name or name in ordered or name in deferred:
            continue
        if name in failed and (name != preferred_name or last_good_usable):
            deferred.append(name)
        else:
            ordered.append(name)
    return ordered + deferred


def refine_prompt_codex(original: str, model: str, effort: str) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        out_path = handle.name
    try:
        command = [find_cli("codex"), "exec", "-m", model, "--ephemeral", "--skip-git-repo-check"]
        command += ["-s", "read-only", "--color", "never", "-o", out_path, build_user_prompt(original)]
        if effort:
            command[2:2] = ["-c", f'model_reasoning_effort="{effort}"']
        completed = _run(command)
        # Trust the -o file. Codex prints ERROR JSON on stdout with a non-zero exit for bad
        # models, and that must not be taken as a refined prompt (it blocked rotation).
        file_refined = ""
        if os.path.isfile(out_path):
            with open(out_path, encoding="utf-8") as out_file:
                file_refined = out_file.read().strip()
        detail = _stdout_text(completed)[:2000]
        if completed.returncode != 0 and not file_refined:
            raise RuntimeError(detail or "codex exec failed")
        refined = file_refined
        if not refined:
            text = _extract_json_text(completed.stdout or "") or _stdout_text(completed)
            lines = [
                line.strip()
                for line in text.splitlines()
                if line.strip()
                and not line.strip().startswith(("ERROR:", "warning:"))
                and "invalid_request_error" not in line
            ]
            refined = lines[-1] if lines else ""
        if not refined.strip():
            raise RuntimeError(detail or "codex refine returned empty output")
        if looks_like_failed_model_output(refined):
            raise RuntimeError((detail or refined)[:2000])
        return refined
    finally:
        with contextlib.suppress(OSError):
            os.unlink(out_path)


def _failed_unless_reply(refined: str, fallback_message: str) -> None:
    if looks_like_failed_model_output(refined):
        raise RuntimeError((refined or fallback_message)[:2000])


def refine_prompt_grok(original: str, model: str = "", reasoning_effort: str = "") -> str:
    # grok and `agent` are the same Grok Build CLI.
    command = [find_cli_or_none("grok") or find_cli("agent"), "-p", build_user_prompt(original)]
    command += ["--output-format", "plain", "--always-approve", "--max-turns", "1"]
    command += ["--no-subagents", "--disable-web-search"]
    if model.strip():
        command.extend(["-m", model.strip()])
    if reasoning_effort.strip():
        command.extend(["--reasoning-effort", reasoning_effort.strip()])
    refined = _stdout_text(_run(command, timeout=180))
    _failed_unless_reply(refined, "grok refine failed")
    return validate_refined_prompt(original, refined)


def refine_prompt_ollama(original: str, model: str = "llama3.2") -> str:
    model = (model or "llama3.2").strip() or "llama3.2"
    prompt = build_user_prompt(original)
    completed = _run([find_cli("ollama"), "run", model, prompt], timeout=180)
    refined = _stdout_text(completed)
    if completed.returncode != 0 and not refined:
        refined = _ollama_http(model, prompt)
    if not refined:
        raise RuntimeError("ollama returned empty refine output")
    return validate_refined_prompt(original, refined)


def _ollama_http(model: str, prompt: str) -> str:
    import urllib.error
    import urllib.request

    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps({"model": model, "prompt": prompt, "stream": False}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as ollama_http_reply:
            ollama_generate_document = json.loads(ollama_http_reply.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"ollama HTTP refine failed: {error}") from error
    return str(ollama_generate_document.get("response") or "").strip()


def refine_prompt_opencode(original: str, model: str = "", reasoning_effort: str = "") -> str:
    """`opencode run [options] <message>`: the message is positional.

    `--prompt` is not a flag; yargs then prints its help with exit 0, which must never be pasted.
    """
    command = [find_cli("opencode"), "run", "--format", "json"]
    model_token = (model or "").strip()
    if model_token and model_token not in ("default", "opencode", "auto"):
        command.extend(["-m", model_token])
    # --variant is the provider-specific reasoning effort.
    effort = (reasoning_effort or "").strip().lower()
    if effort in ("minimal", "low", "medium", "high", "max", "xhigh"):
        command.extend(["--variant", "max" if effort == "xhigh" else effort])
    command.append(build_user_prompt(original))

    completed = _run(command, timeout=180)
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    refined = _extract_json_text(stdout)
    if not refined:
        refined = _stdout_text(completed)
        if _looks_like_cli_help(refined):
            raise RuntimeError(
                "opencode refine got CLI help instead of a reply "
                "(invoke as: opencode run -m provider/model --format json <prompt>)"
            )
    if completed.returncode != 0 and not refined:
        raise RuntimeError((stderr or stdout or "opencode refine failed").strip()[:2000])
    _failed_unless_reply(refined, "opencode refine failed")
    try:
        return validate_refined_prompt(original, refined)
    except ValueError as error:
        raise RuntimeError(f"{error}; stderr={stderr[:400]}"[:2000]) from error


def refine_prompt_claude(original: str, model: str = "") -> str:
    command = [find_cli("claude"), "-p", build_user_prompt(original), "--output-format", "text"]
    if model.strip():
        command.extend(["--model", model.strip()])
    completed = _run(command, timeout=180)
    refined = _extract_json_text(completed.stdout or "") or _stdout_text(completed)
    _failed_unless_reply(refined, "claude refine failed")
    return validate_refined_prompt(original, refined)


# agy accepts low/medium/high only.
_AGY_EFFORTS = {"minimal": "low", "low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


def refine_prompt_gemini(original: str, model: str = "", reasoning_effort: str = "") -> str:
    """Google `gemini` CLI, or Antigravity `agy`.

    `-p`/`--print` consumes the next argv as the prompt, so it goes last.
    """
    binary = find_cli_or_none("gemini") or find_cli_or_none("agy")
    if not binary:
        raise RuntimeError("gemini/agy CLI not found on PATH")
    prompt = build_user_prompt(original)
    model_token = (model or "").strip()
    pick_model = model_token and model_token not in ("default", "gemini", "auto")
    if os.path.basename(binary).lower() == "agy":
        command = [binary, "--output-format", "json"]
        if pick_model:
            command.extend(["--model", model_token])
        effort = _AGY_EFFORTS.get((reasoning_effort or "").strip().lower())
        if effort:
            command.extend(["--effort", effort])
        command.extend(["--print", prompt])
    else:
        command = [binary, "-p", prompt]
        if pick_model:
            command.extend(["-m", model_token])
    completed = _run(command, timeout=180)
    refined = _extract_json_text(completed.stdout or "") or _stdout_text(completed)
    _failed_unless_reply(refined, "gemini/agy refine failed")
    return validate_refined_prompt(original, refined)


def refine_prompt_pi(original: str, model: str = "", reasoning_effort: str = "") -> str:
    """`pi` (pi-coding-agent) print mode: no tools, no saved session."""
    binary = find_cli_or_none("pi") or find_cli_or_none("pie")
    if not binary:
        raise RuntimeError("pi (or pie) not found on PATH")
    command = [binary, "--no-tools", "--no-session", "--mode", "text"]
    model_token = (model or "").strip()
    if model_token and model_token not in ("default", "pi-latest"):
        # "provider/id", optionally with a ":thinking" suffix.
        command.extend(["--model", model_token])
    effort = (reasoning_effort or "").strip().lower()
    if effort:
        command.extend(["--thinking", effort if effort in (*REASONING_EFFORT_OPTIONS, "off", "max") else "low"])
    command.extend(["-p", build_user_prompt(original)])
    completed = _run(command, timeout=180)
    refined = _extract_json_text(completed.stdout or "") or _stdout_text(completed)
    # pi often prints OpenRouter 402 JSON with exit 0.
    _failed_unless_reply(refined, "pi refine failed")
    return validate_refined_prompt(original, refined)


def refine_with_provider(backend: str, model: str, reasoning_effort: str, original: str) -> str:
    """One backend+model attempt with no rotation; raises on failure."""
    be = normalize_backend(backend)
    effort = (reasoning_effort or "").strip().lower()
    if be == "local":
        refined = refine_prompt_local(original)
    elif be == "codex":
        refined = refine_prompt_codex(original, model or DEFAULT_MODEL, effort or DEFAULT_REASONING_EFFORT)
    elif be == "grok":
        refined = refine_prompt_grok(original, model=model, reasoning_effort=effort)
    elif be == "ollama":
        refined = refine_prompt_ollama(original, model=model or "llama3.2")
    elif be == "opencode":
        refined = refine_prompt_opencode(original, model=model, reasoning_effort=effort)
    elif be == "claude":
        refined = refine_prompt_claude(original, model=model)
    elif be == "gemini":
        refined = refine_prompt_gemini(original, model=model, reasoning_effort=effort)
    elif be == "pi":
        refined = refine_prompt_pi(original, model=model, reasoning_effort=effort)
    else:
        raise RuntimeError(f"Unknown prompt refinement backend: {backend!r}")
    if looks_like_failed_model_output(refined):
        raise RuntimeError(refined[:2000])
    return validate_refined_prompt(original, refined)
