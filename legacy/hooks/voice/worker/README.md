# dufflebag-voice

Native local voice worker for the `voice` feature.

## What it is

- **STT:** whisper.cpp via `whisper-rs`, **Whisper large-v3-turbo** (default `q5_0`), Metal on Apple Silicon
- **TTS:** separate `narration-worker` process + warm `text_to_speech.py serve` (Supertonic)
- **UX:** hold Shift to dictate (any other key cancels); floating OSW-style pill with **live preview** caption
- **Devin:** `watch-devin --path <atif.json>` debounces and enqueues agent turns
- **Refine:** route-aware rewrite before paste/type — STT inject (`refineMode=dictation|both`), Shift double-tap clipboard (`clipboard|both`), or `refine --text …`. Backend: `codex` (default `gpt-5.3-codex-spark`), `local` (Apple FM), or `auto`

## Architecture (OpenSuperWhisper-shaped)

```
hold Shift → open mic (always open) → release → enqueue clip
                                                    ↓
                              serial offline STT queue → clean → type once
                                                    ↑
while holding: sliding-window live preview → HUD only (never types)

narration-worker (separate process): inbox → TTS
```

| Piece | Role |
| --- | --- |
| Open mic | Device opened once at dictation worker start; Shift only flips a buffer flag |
| Serial queue | Record never waits on Whisper; next hold can start while previous decodes |
| Dictionary boost | `dictationReplacements` terms feed Whisper `initial_prompt` |
| No-speech | Empty / `[MUSIC]` / tags never type |
| Live preview | Sliding-window Whisper caption for HUD (`DUFFLEBAG_DICTATION_LIVE_PREVIEW=off` to disable) |
| Process split | `dictation-worker` = dictation; `narration-worker` = inbox/TTS |

## Build

Requires Rust, CMake, and Xcode CLT:

```bash
# from package root
./src/scripts/buildVoiceWorker.sh
```

Output: `src/hooks/voice/dufflebag-voice` (gitignored; built during package preparation when missing).

## Model

`prepare` downloads Whisper weights into Application Support and warms Supertonic:

| `DUFFLEBAG_DICTATION_MODEL` | File | Notes |
| --- | --- | --- |
| `turbo-q5` (default) | `ggml-large-v3-turbo-q5_0.bin` | Best quality default (OSW turbo small) |
| `turbo-q8` | `ggml-large-v3-turbo-q8_0.bin` | |
| `turbo` | `ggml-large-v3-turbo.bin` | |
| `small` / `small.en` | `ggml-small.en.bin` | Faster short holds |
| `base` / `base.en` | `ggml-base.en.bin` | Faster still |
| `tiny` / `fast` | `ggml-tiny.en.bin` | Fastest English-only |

Same Hugging Face `ggerganov/whisper.cpp` sources as OpenSuperWhisper.

### Latency bench

Warm-model decode timing (no mic, no typing). Use this before changing languages or engines:

```bash
./src/scripts/buildVoiceWorker.sh
src/hooks/voice/dufflebag-voice bench --models tiny,base,small,turbo-q5 --seconds 1,2,4 --runs 3
```

Live holds also log `decode_ms` / `type_ms` / `total_ms` to
`~/Library/Application Support/dufflebag/voice/dictation.log`.

The dictation worker loads the model **once** at start and reuses it for every utterance
(`start` while already running reuses the same pid).

### Measured on Apple M5 Max (Metal, 2026-08)

Warm decode on synthetic speech-like audio (not mic). Host language is not on this path.

| Model | Load once | Warm decode ~1s clip | Warm decode ~2s clip |
| --- | --- | --- | --- |
| `tiny.en` | ~180 ms | ~200–400 ms (first) | often VAD-empty on synth |
| `base.en` | ~60 ms | ~15–50 ms | ~17 ms |
| `small.en` | ~160 ms | ~30–60 ms | ~29 ms |
| `turbo-q5` (default) | ~150–380 ms | ~105–140 ms | ~100–340 ms |

Takeaway: default turbo is already **sub-second** on this machine. Faster English models help a bit; switching Rust→Swift does not move these numbers.

## Hybrid surface

| Path | Implementation |
| --- | --- |
| STT / hotkey / workers / HUD / inbox / Devin | Rust binary |
| Supertonic synthesize + play (warm serve, streamed chunks) | `text_to_speech.py serve` |
| Route-aware prompt refinement (codex / Apple FM) | `refine_prompt.py` |

Python is off the dictation hot path except when STT refine is enabled (one shot after final transcript). Narration still shells to Supertonic for quality parity.

## STT → refine → input (mode A)

When `refineMode` is `dictation` or `both`, after Whisper cleans the final transcript the worker:

1. Calls `refine_prompt.py` with config `refineProvider` + `refineModel`
2. Types the refined text into the focused caret (same as normal dictation)
3. You review and press Enter in the **same** agent session

Defaults when you enable refine:

| Setting | Default | Purpose |
| --- | --- | --- |
| `refineProvider` | `codex` | Fast CLI refine |
| `refineModel` | absent (worker uses `gpt-5.3-codex-spark`) | Cheap/fast Codex Spark |
| `refineSendTo` | `caret` | `caret` \| `cmux-new` \| `cmux-resume` |
| `refineCmuxCommand` | `""` | Optional shell for `cmux-new` (`{{prompt_file}}`, `{{prompt}}`, `{{cwd}}`) |
| `refineCmuxPressEnter` | `false` | Send Enter after cmux inject |

**cmux-new:** opens a new focused workspace and pastes the refined prompt (or runs `refineCmuxCommand`).  
**cmux-resume:** injects into the focused surface / existing agent session.

See [TESTING.md](./TESTING.md) for a step-by-step live check.
