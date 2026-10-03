# Testing STT → route-aware refine → input

Goal: speak a messy freeform request, see a **refined** prompt land in the agent input, hit Enter, same session continues. No second “routing chat.”

## Prerequisites

1. **Codex CLI logged in** (for default backend):

   ```bash
   codex login
   codex exec -m gpt-5.3-codex-spark --ephemeral --skip-git-repo-check -s read-only "Reply with exactly: ok"
   ```

2. **Voice built and installed** from this package:

   ```bash
   cd /path/to/dufflebag
   ./src/scripts/buildVoiceWorker.sh
   pnpm cli voice on --scope global   # or project
   ```

3. **Mic + Accessibility** allowed for Terminal / the host that runs `dufflebag-voice` (macOS System Settings).

## Configure cheap Spark refine on STT

```bash
# Enable refine on dictation release (keeps double-tap off unless you use both)
pnpm cli config set refine-mode dictation

# Defaults are already codex + Spark; set explicitly if needed:
pnpm cli config set refine-provider codex
pnpm cli config set refine-model gpt-5.3-codex-spark

pnpm cli config show
```

Restart voice so the worker reloads config:

```bash
pnpm cli voice off
pnpm cli voice on
```

Optional: `both` also enables Shift double-tap clipboard refine.

## Offline refine (no mic) — prove Codex path first

```bash
# Via worker CLI (uses config.json, or pass flags)
src/hooks/voice/dufflebag-voice refine \
  --text "uh can you like make a branch and change the bio line to hello and open a pr but dont merge"

# Or Python directly
python3 src/hooks/voice/refine_prompt.py \
  --backend codex \
  --model gpt-5.3-codex-spark \
  --text "deslop this repo its full of ceremony and wrappers"
```

Expect a single paste-ready line (often starting with a skill id like `finish-and-push:` or `simplify-code:`), not a multi-page plan.

## Live STT test

1. Focus an agent input (Claude Code, Codex, Cursor, Grok terminal, TextEdit, etc.).
2. **Hold Shift** on its own for 300 ms (pressing any other key while Shift is down cancels, so capital letters and Shift shortcuts never start dictation), then speak something messy, e.g.:

   > “yeah so um can you finish and ship this, make a branch, commit the voice refine stuff, open a pr, don’t merge it”

3. **Release Shift**.
4. **Immediately** (after offline STT decode, ~100–300ms) raw transcript lands in the input and the HUD **hides** (no lingering “Refining…” spinner over already-pasted text).
5. Refine runs in the background. If the rewrite differs from raw, a brief `Updating…` flash appears while the caret is replaced; if it’s the same, nothing else is shown.
6. If the preferred model is missing / not allowed for your Codex account (e.g. Spark on ChatGPT login), the worker **rotates** to a working model (`gpt-5.4-mini`, `gpt-5.6-terra`, …) and remembers the last-good id.
7. If refine hits a **quota / rate limit / billing** error (or every automatic model fails), a **macOS picker** appears:
   - Alert explaining the limit
   - Choose **model** from the available list (or “Skip refine”)
   - Choose **reasoning effort** (`minimal` … `xhigh`)
   - Choice is remembered in the voice state folder and tried right after the configured model on the next dictation; run `dufflebag config pick-refine` to make it the configured default
8. Glance, press **Enter** — real work starts in the same session.

Headless / CI: set `DUFFLEBAG_REFINE_PICKER=off` or pass `--no-picker` to `refine_prompt.py`.

### Pick refine model interactively (dynamic providers)

Lists backends that are actually on your PATH (codex, claude, grok, ollama, opencode, …) and their models:

```bash
# JSON inventory
python3 src/hooks/voice/refine_prompt.py --list-providers

# Interactive TTY menu → writes config.json
pnpm cli config pick-refine

# Force macOS GUI dialogs
pnpm cli config pick-refine --gui
```

### Logs

```bash
tail -f ~/Library/Application\ Support/dufflebag/voice/dictation.log
```

Look for:

- `stt refine gen=… backend=codex model=gpt-5.3-codex-spark … refined=…`
- `typed gen=… text=…`

If refine fails, the raw transcript is typed anyway (`stt refine failed …; typing raw transcript`).

## Modes cheat sheet

| `refineMode` | Behavior |
| --- | --- |
| `off` | Type STT as-is (default) |
| `dictation` | Refine after final transcript, then deliver |
| `clipboard` | Double-tap Shift refines **clipboard** only |
| `both` | Dictation refine + double-tap clipboard |

| `refineProvider` | Engine (ytcap-style; pair with `refineModel`) |
| --- | --- |
| `codex` | Codex CLI (default model `gpt-5.3-codex-spark`) |
| `grok` | Grok Build (`-m`, `--reasoning-effort`) |
| `ollama` | Local Ollama (`ollama run <model>`) |
| `opencode` | OpenCode CLI when installed |
| `claude` / `gemini` | Headless print modes |
| `local` | Apple Foundation Models |
| `auto` | local, then codex fallback |

| Extra knobs | Default | Purpose |
| --- | --- | --- |
| `refineModel` | absent (worker uses `gpt-5.3-codex-spark`) | Preferred model id; Codex path rotates if unavailable |
| `refineEffort` | absent (worker uses `low`) | `low` / `medium` / `high` / … (**low** by default so release is not stuck on xhigh reasoning) |
| `refinePressEnter` | `false` | Press **Enter** after refined text lands in the caret |

### Switch providers like ytcap (`agent=` / `model=` / `reasoning-effort=`)

```bash
# Codex Spark (cheap default)
pnpm cli config set refine-provider codex
pnpm cli config set refine-model gpt-5.3-codex-spark

# Grok with low reasoning
pnpm cli config set refine-provider grok
pnpm cli config set refine-model grok-4.5
pnpm cli config set refine-effort low

# Ollama local
pnpm cli config set refine-provider ollama
pnpm cli config set refine-model llama3.2

# Optional auto-Enter after the refined text replaces the raw STT
pnpm cli config set refine-press-enter false   # true = Enter after refined paste

pnpm cli voice off && pnpm cli voice on
```

Offline one-shots:

```bash
# Grok
src/hooks/voice/dufflebag-voice refine \
  --backend grok --model grok-4.5 --reasoning-effort low \
  --text "uh make a branch and open a pr dont merge"

# Ollama
src/hooks/voice/dufflebag-voice refine \
  --backend ollama --model llama3.2 \
  --text "deslop this its full of wrappers"
```

| `refineSendTo` | Where the refined text goes |
| --- | --- |
| `caret` | Focused input (default) — same as classic STT type |
| `cmux-new` | **New focused cmux workspace/terminal** (paste refined text; optional command) |
| `cmux-resume` | Inject into the **focused cmux surface** (uses session when resume binding exists) |

### Spawn a new cmux terminal (watch the agent run)

**Paste only** (you review + Enter in the new tab):

```bash
pnpm cli config set refine-mode dictation
pnpm cli config set refine-send-to cmux-new
pnpm cli config set refine-cmux-command ""
pnpm cli config set refine-cmux-press-enter false
pnpm cli voice off && pnpm cli voice on
```

Offline smoke (no mic):

```bash
src/hooks/voice/dufflebag-voice refine \
  --backend codex \
  --model gpt-5.3-codex-spark \
  --delivery cmux-new \
  --text "uh make a branch change bio to hello open pr dont merge"
```

A new cmux workspace opens focused with the refined prompt typed into the terminal. Submit yourself (or set auto-submit true to send Enter).

**Auto-start Codex in the new workspace:**

```bash
pnpm cli config set refine-send-to cmux-new
pnpm cli config set refine-cmux-command 'codex --yolo -- "$(cat {{prompt_file}})"'
```

Other templates:

```bash
# Claude
pnpm cli config set refine-cmux-command 'claude --dangerously-skip-permissions -- "$(cat {{prompt_file}})"'

# Grok
pnpm cli config set refine-cmux-command 'grok "$(cat {{prompt_file}})"'
```

Placeholders: `{{prompt_file}}` (safe temp path), `{{prompt}}` (shell-escaped), `{{cwd}}`.

### Resume / inject into the current cmux session

```bash
pnpm cli config set refine-send-to cmux-resume
# optional: send Enter after inject
pnpm cli config set refine-cmux-press-enter true
```

Offline:

```bash
src/hooks/voice/dufflebag-voice refine \
  --delivery cmux-resume \
  --text "also fix the typo in the header while you are there"
```

Uses the focused cmux surface (and reports agent/session from `surface.resume` when available).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Always types raw mess | Mode still `off`; config path wrong; worker not restarted |
| Refine hangs / errors | `codex login`; model name; network; `dictation.log` |
| Empty input after release | No speech / Whisper empty — try longer hold |
| Holding Shift shows no HUD | Run `src/hooks/voice/dufflebag-voice hotkey-check` and hold Shift; no `SHIFT DOWN` line means Input Monitoring is missing for `dufflebag-voice` |
| Clipboard path only | You set `clipboard` not `dictation` |
| Want free Apple path | `refine-provider local` (needs Apple Intelligence) |

## Turn off

```bash
pnpm cli config set refine-mode off
pnpm cli voice off && pnpm cli voice on
```
