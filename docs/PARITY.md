# Parity table: the old voice feature → voxkey

Source: the voice feature of the multi-tool repo voxkey was split from, branch `refactor/clearer-names-leaner-repo` at `fe2baee` (imported here on `main` as `336920f`). Old Rust modules are named without their extension (they lived in `src/hooks/voice/worker/src/`); the `.py` scripts and the TypeScript hook lived in `src/hooks/voice/`.
Target: voxkey, TypeScript only (Node 22+, macOS). No Rust, Swift, or `.py` scripts.

Status words:

- **kept**: same behavior, ported to TypeScript as is.
- **replaced**: same user-visible behavior, new mechanism (named in the row).
- **dropped**: no longer exists; the reason is in the row and, when a choice was involved, under Open questions.

## Dictation (hold Shift, speak, text at the caret)

| User-visible feature | Old file(s) | New TS module | Status | Reason |
| --- | --- | --- | --- | --- |
| Hold Shift alone ≥ 300 ms to dictate; any other key while Shift is down cancels (capital letters and shortcuts never dictate) | `worker/src/hotkey`, `dictation_worker` | `src/dictation/holdKey.ts` (pure state machine), `src/dictation/keyboard.ts` | replaced | Same poll of `CGEventSourceKeyState` (HID state, every 8 ms, debounced 2 down / 4 up) called through the `koffi` FFI instead of Rust `extern "C"`. The optional `rdev` listener is gone: the poller already sees other keys, including one pressed while the Shift-down edge is still debouncing; keys pressed after Shift reads up no longer cancel the clip. |
| Keys held before Shift (macOS can report key 0 as held forever) do not cancel a hold | `hotkey` `newly_pressed` | `src/dictation/holdKey.ts` | kept | Pure function, unit tested. |
| Mic opened once when the worker starts; Shift only flips a buffer flag, so the first word is not clipped | `microphone` (cpal, resample to 16 kHz) | `src/dictation/microphone.ts` | replaced | `@picovoice/pvrecorder-node` reads 16 kHz mono frames directly; no resampling needed. |
| Mic stays open after release for `dictationKeepListeningSeconds` (0–2 s, default 0.2) | `dictation_worker` `finish_clip` | `src/dictation/dictationWorker.ts` | kept | Read fresh from config on every release. |
| Serial queue: the next hold can start while the previous clip decodes; text is typed once, in order | `dictation_queue` | `src/dictation/dictationQueue.ts` | replaced | Effect `Queue` + one consumer fiber. |
| whisper.cpp large-v3-turbo q5_0 by default, Metal + flash attention, model loaded once per worker and warmed | `stt`, `whisper_models` | `src/dictation/transcriber.ts`, `src/dictation/whisperModels.ts` | replaced | `@fugood/whisper.node` (prebuilt darwin-arm64 with Metal) runs in the worker process. Measured here: turbo-q5 load 234 ms, warm decode 221 ms. |
| Hebrew dictation through the ivrit.ai ggml model (`dictationLanguage he`) | `whisper_models`, `config` | `src/dictation/whisperModels.ts`, `src/config/configSchema.ts` | kept | Same Hugging Face URL and file name. |
| The dictation-model environment variable forces a model (tiny, base, small, turbo, turbo-q8, turbo-q5, ivrit + aliases) | `whisper_models` | `src/dictation/whisperModels.ts` | kept | Now `VOXKEY_DICTATION_MODEL`. |
| Model downloaded from Hugging Face on first use, with progress | `whisper_models` (reqwest) | `src/dictation/whisperModels.ts` | replaced | `fetch` stream to `<file>.partial`, then rename. Done by `voxkey on`. One download of a file runs at a time across processes (a kernel lock on `<file>.lock`); a caller that waited reuses the finished file. |
| Peak normalize, silence gate, energy VAD, word-rate cap, repeated-word collapse, no-speech and hallucination filters (never type "[MUSIC]", "thanks for watching", …) | `stt` | `src/dictation/speechDetection.ts` | kept | Pure functions with the same constants, unit tested. |
| Replacement terms boost Whisper spelling (initial prompt) | `dictation_queue` | `src/dictation/dictationQueue.ts` | kept | Passed as whisper.node `prompt`. |
| Decode settings: greedy best-of 1, temperature 0, no carried context | `stt` | `src/dictation/transcriber.ts` | kept | `bestOf: 1`, `temperature: 0`, `maxContext: 0`. |
| Decode settings not exposed by whisper.node: `no_speech_thold`, `suppress_nst`, preview `audio_ctx 768` / `max_tokens 48` / `single_segment` | `stt` | — | dropped | whisper.cpp defaults apply. The TS no-speech and hallucination filters still run on every result. See Open questions. |
| Live caption in the pill while Shift is held (sliding 8 s tail every 700 ms); the live-preview environment variable set to `off` disables it | `live_preview` | `src/dictation/livePreview.ts` | replaced | Shares one whisper context with the final decode (a preview never runs while a clip is queued). Now `VOXKEY_DICTATION_LIVE_PREVIEW`. |
| When the final decode is empty, the best live caption is typed instead | `live_preview`, `dictation_queue` | `src/dictation/livePreview.ts`, `dictationQueue.ts` | kept | |
| Spoken formatting: comma, period, full stop, question mark, exclamation, colon, semicolon, new line, new paragraph, bullet, numbered list, next item, `literal <word>` | `dictation_format` | `src/dictation/dictationFormat.ts` | kept | Same phrase table and capitalization rules, same tests. |
| `dictationReplacements` (`heard=written;…`) | `config`, `dictation_format` | `src/config/configSchema.ts`, `src/dictation/dictationFormat.ts` | kept | The heard word's closing punctuation now stays ("Joseph." types "Yosef."); the Rust formatter dropped it. |
| Typing at the caret: unicode key events in chunks of 20, newline sent as zero-width space + newline, Shift released first; text over 800 chars pasted with ⌘V (System Events, then key-code fallback) and the old clipboard restored after 400 ms | `typing` (enigo) | `src/dictation/caret.ts`, `src/dictation/keyboard.ts` | replaced | Same CoreGraphics calls enigo makes (`CGEventCreateKeyboardEvent`, `CGEventKeyboardSetUnicodeString`, `CGEventPost`) through `koffi`; `pbcopy`/`pbpaste`/`osascript` for paste. The old clipboard is restored only if nothing else was copied in those 400 ms. |
| `refinePressEnter`: press Enter after typed text | `typing`, `dictation_queue` | `src/dictation/caret.ts` | kept | |
| `dictation.log` with decode/type/total timings per hold | `state_home` | `src/worker/workerLog.ts` | kept | Now `~/.voxkey/dictation.log`. |
| Pill: bottom-centre, red pulsing dot + "Recording" or the live caption, spinner + "Working"/"Refining…", "Mic unavailable", yellow "Connecting"; hidden when idle; follows `status.json`; exits when the worker dies | `overlay`, `overlay_hud.swift` | `src/worker/pill.ts` | replaced | A JavaScript for Automation (JXA) script run by `osascript -l JavaScript`, using the same AppKit calls as the Swift file. One pill per worker is kept by the `pill.pid` file instead of `flock`. |
| `hotkey-check` (print Shift edges for N seconds) | `hotkey` | `voxkey hotkey-check` (`src/cli/hotkeyCheckCommand.ts`) | kept | |
| `bench` (model load + warm decode timing on synthetic speech) | `stt_benchmark` | `src/scripts/benchDictation.ts` (`pnpm bench`) | replaced | A dev script, as allowed by the brief. |

## Narration (agent replies read aloud)

| User-visible feature | Old file(s) | New TS module | Status | Reason |
| --- | --- | --- | --- | --- |
| Stop hook queues one complete agent reply for Claude Code, Codex, and Grok | `hooks/speakReply.ts` + install `hookSettings.ts` | `voxkey reply --agent <id>` (`src/agentHooks/replyHook.ts`), registered by `voxkey on` (`src/agentHooks/hookSettings.ts`) | replaced | One entry per agent settings file, edited with `jsonc-parser` offsets so every other byte is kept, backed up first. Fail-open: every error exits 0 with no output. |
| Reply text: `last_assistant_message` (and its spellings), else every assistant text block after the latest genuine user prompt in the transcript | `speakReply.ts`, `lib/transcriptReader.ts` | `src/agentHooks/agentReply.ts` | kept | Decoded with Effect Schema. |
| Grok: only end-of-turn events are queued | `speakReply.ts` | `src/agentHooks/agentReply.ts` | kept | |
| Nothing queued when `speechMode` is `off` | `speakReply.ts` | `src/agentHooks/replyHook.ts` | kept | Setting renamed `narrationMode`. |
| The hook starts the worker when it is not running | `speakReply.ts` | `src/agentHooks/replyHook.ts` | kept | |
| Cmux: a reply is bound to its workspace + surface; `auto` holds it until that surface is focused and Cmux is in front, speaks at once when Cmux does not answer; `immediate` speaks every reply at once; newer replies from the same surface supersede older ones | `inbox`, `cmux_focus` | `src/narration/inbox.ts`, `src/narration/cmuxFocus.ts` | kept | Same socket JSON-lines calls (`window.list`, `system.identify`). A connection Cmux closes without a reply line counts as no answer, as the Rust `read_line` did. |
| A reply is never spoken twice (id + content keys in `seen.json`, 24 h); queued replies expire after 1 h; a failed reply moves to `failed/` | `inbox`, `speakReply.ts` (FNV-1a token) | `src/narration/inbox.ts` | kept | |
| Markdown read as speech: headings, lists, quotes, links ("label, link url"), images, code blocks announced with their language and read symbol by symbol | `markdown_to_speech` | `src/narration/markdownToSpeech.ts` | kept | Only paired emphasis markers are dropped (the Rust code dropped every `*`, `_`, and `~`, so `2 * 3` and `snake_case` lost them), and inline code is read as written (`Array<T>` is no longer stripped as an HTML tag). |
| Tables read with their column names ("Row 1. Item: Voice. State: Ready.") | the old README only (the Rust code read raw pipes) | `src/narration/markdownToSpeech.ts` | replaced | The README promised it; now the code does it. |
| Supertonic 3 voices F1–F5 / M1–M5, speed from words per minute (÷200, 0.7–2.0), 8 steps, 280-char chunks streamed so the first words play while the rest renders | `text_to_speech.py` (the `supertonic` and `sounddevice` PyPI packages), `tts` | `src/narration/supertonic.ts`, `src/narration/speechChunks.ts`, `src/narration/speechPlayer.ts` | replaced | The same four Supertonic ONNX models run in `onnxruntime-node` (measured: 3.3 s of speech in ~600 ms on CPU). Each chunk is written as a WAV and played with `afplay` while the next chunk renders. Unsupported characters are dropped instead of failing the reply. |
| Supertonic models auto-downloaded | the `supertonic` PyPI package (HF `Supertone/supertonic-3`) | `src/narration/supertonicModels.ts` | replaced | Same repo, same pinned revision `724fb5ab…`, plain HTTPS. |
| `voice speak <text>` | `voiceCommand.ts`, `main speak` | `voxkey speak <text>` | kept | |
| `render --text` (print the speech document) | `main render` | `voxkey render <markdown>` | kept | |
| Tap Shift stops narration | `dictation_worker`, `tts` | `src/dictation/dictationWorker.ts` → `SIGUSR2` to the narration worker | replaced | The Rust single tap only reached a TTS server in its own process, so it could not stop speech in the narration worker; the signal works across processes. |
| Double-tap Shift: stop narration if speaking, else refine the clipboard (clipboard mode), else toggle the narration mute | `dictation_worker`, `narration_mute` | `src/dictation/dictationWorker.ts`, `src/narration/narrationMute.ts` | kept | |
| Narration waits while the mic is listening; starting a hold stops narration | `narration_worker`, `dictation_worker` | `src/narration/narrationWorker.ts` | kept | |
| Narration runs in its own process, only while narration is on | `narration_worker` | `src/narration/narrationWorker.ts` (`voxkey worker narration`) | kept | |
| `voice devin -- <args>`: run Devin with its ATIF export and narrate each finished turn (800 ms debounce) | `voiceCommand.ts devin`, `devin_export_watcher` | `voxkey devin -- <args>` (`src/devin/devinWatcher.ts`) | kept | The watcher now runs ~1.2 s past Devin's exit, so a turn written as Devin exits is still read, and a turn that cannot be queued is logged instead of stopping the watcher. |

## Prompt refine

| User-visible feature | Old file(s) | New TS module | Status | Reason |
| --- | --- | --- | --- | --- |
| `refineMode`: off / clipboard (double-tap) / dictation (before typing) / both | `config`, `dictation_worker`, `dictation_queue` | `src/config/configSchema.ts`, `src/dictation/*` | kept | |
| Dictation refine skips phrases under 5 words; waits at most 20 s, else types the raw transcript; pill shows "Refining (provider/model/effort)…" | `dictation_queue` | `src/dictation/dictationQueue.ts` | kept | |
| Clipboard refine: refine the copied prompt, copy it back, read it aloud; progress shown in the pill | `dictation_worker` (wrote `refinement.json`, which the Swift pill never read) | `src/dictation/dictationWorker.ts` | replaced | Progress now goes through `status.json`, so the pill really shows it. |
| Providers: codex, grok (`agent`), ollama (CLI, then HTTP), opencode, claude, gemini (`agy`), pi (`pie`), auto | `refine_providers.py`, `refine_prompt.py` | `src/refine/refineProviders.ts`, `src/refine/providerModels.ts` | kept | Same argv per CLI, run with `execFile` (no shell), stdin closed, `NO_COLOR=1`. A CLI other than codex or ollama that exits non-zero fails the attempt (the old version could type its stderr as the prompt); model lists come from the CLI refine runs (`gemini` before `agy`, `pi` or `pie`). |
| `local` provider (Apple Foundation Models through `uv` + `apple-fm-sdk`) | `refine_providers.py` | — | dropped | No maintained Node route. `auto` now starts at codex. See Open questions. |
| Reply checks: not empty, not a CLI help dump, not an auth/config failure, not a quota/limit or model-unavailable error, not a JSON error envelope; every protected literal (code, path, URL, quoted text) kept; a whole-reply code fence is stripped | `refine_providers.py` | `src/refine/refineReply.ts` | kept | Same literal patterns and test cases. The quota markers are now error phrases ("budget exceeded", "billing details", …): the old list matched "budget", "billing", "quota", "tpm", and "rpm" anywhere, so a good prompt about a budget was rejected. Of two overlapping literals the longer wins, so a quote holding a URL or path is protected whole. |
| Rotation: preferred model, sticky pick, discovered models (≤ 6 per provider), then other providers on PATH (≤ 4), ≤ 12 attempts; Codex last-good and failed-model caches | `refine_prompt.py`, `refine_choices.py`, `refine_providers.py` | `src/refine/refineAttempts.ts`, `src/refine/refineChoices.ts` | kept | `auto` now also takes one model from each fallback provider; before, the second provider's whole list could use up the queue. |
| Picker after every attempt fails (macOS "choose from list", with "Skip refine"); off with the picker environment variable set to `off`, or in CI | `mac_picker.py` | `src/refine/refinePicker.ts` | kept | `osascript`. Now `VOXKEY_REFINE_PICKER`. |
| `config pick-refine [--gui]`: pick provider, model, effort from the CLIs on this machine and save them | `configCommand.ts`, `pickRefineModel.ts`, `refine_prompt.py --pick-menu` | `voxkey config pick-refine [--gui]` | kept | Terminal menu, or macOS dialogs with `--gui` / without a terminal. |
| `--list-providers` JSON | `refine_prompt.py` | `voxkey refine --list-providers` | kept | |
| `refineSendTo`: caret / cmux-new (new focused workspace, optional command template with `{{prompt_file}}`, `{{prompt}}`, `{{cwd}}`) / cmux-resume (focused surface); `refineCmuxPressEnter` | `cmux_delivery` | `src/refine/cmuxDelivery.ts` | kept | Each placeholder is now one shell-quoted word (`{{cwd}}` and `{{prompt_file}}` were inserted raw). A failed cmux delivery falls back to the caret, as before. Dictation that was not refined (short phrase, failed or slow refine) is typed at the caret instead of being sent to cmux. |
| `voice refine <prompt> [--speak]` and the worker's `refine` flags (`--backend --model --reasoning-effort --delivery --cmux-command --auto-submit`) | `voiceCommand.ts`, `main`, `refine` | `voxkey refine <prompt> [--speak --provider --model --effort --send-to --cmux-command --press-enter]` | kept | Flag names now match the setting names. |

## Control, config, and install

| User-visible feature | Old file(s) | New TS module | Status | Reason |
| --- | --- | --- | --- | --- |
| `voice on` / `stt on`: install the voice feature, prepare models, restart the workers | `voiceCommand.ts`, `sttCommand.ts`, `voiceWorker.ts`, the old installer | `voxkey on` | replaced | Registers the Stop hook for each detected agent, downloads missing models, then restarts the workers. No receipt or feature catalog. |
| `voice off` / `stt off` | same | `voxkey off` | replaced | Stops every voxkey process and removes only voxkey's hook entries. |
| `tts on` / `tts off` | `ttsCommand.ts` | `voxkey config set narration-mode auto` / `off` | replaced | `off` applies at once: the reply being read stops and the narration worker exits. `auto` starts the narration worker at once only while dictation runs; with the workers stopped it is saved, and narration starts with them (`voxkey on`, or the next agent reply). |
| `voice status [--format json]` | `voiceCommand.ts`, `worker_status` | `voxkey status [--json]` | kept | |
| `stt keep-listening [seconds]` | `sttCommand.ts` | `voxkey config get|set dictation-keep-listening-seconds` | replaced | |
| `stt lang [en|he]` with aliases (english, hebrew, ivrit, iw, lang=he); reloads the worker | `sttCommand.ts` | `voxkey config set dictation-language he` | replaced | The aliases are decoded by the setting's Schema; the dictation worker restarts when the language changes. |
| `config show / set / reset` for the 15 voice settings | `configCommand.ts`, `configSchema.ts:73-143` | `voxkey config list / get / set / unset` | replaced | Own config file `~/.voxkey/config.json`. See the rename table in README. |
| Interactive `menu` screens for voice, STT, TTS | `menuSettings.ts` | — | dropped | Every screen was a thin front for one command that voxkey has directly. |
| `--scope global|project` | `cliOptions.ts`, installer | — | dropped | voxkey has one user-level config and user-level agent hooks. See Open questions. |
| `prepare` (download and warm models) | `main` | `voxkey on` | replaced | |
| `stop`, `stop-narration`, `start` | `main` | `voxkey off`, `config set narration-mode off`, `voxkey on` | replaced | |
| `reset`: kill every worker, pill, and TTS process and clear locks; unmute | `worker_processes` | `voxkey reset` | kept | |
| Diagnostics | the old `doctor` (installer health only) | `voxkey doctor` | replaced | Checks macOS, Node, native modules, system tools, models, agent CLIs, and the Accessibility / Input Monitoring / Microphone permissions. |
| The voice-folder and voice-config-file environment variables | `state_home`, `config`, `speakReply.ts`, `refine_choices.py` | `VOXKEY_HOME`, `VOXKEY_CONFIG_FILE` (`src/config/environmentVariables.ts`) | replaced | One folder, `~/.voxkey`, for config, state, models, and logs. |
| Windows and Linux state paths | `state_home`, `speakReply.ts` | — | dropped | Every mechanism (CoreGraphics, `osascript`, `afplay`) is macOS-only, as the Rust worker effectively was. |
| `uv` required for narration; the `.py` lockfile; the Rust build script; Ruff; the `.py` name checker | `text_to_speech.py.lock`, `buildVoiceWorker.sh`, `ruff.toml`, the `.py` name checker script | — | dropped | No `.py` script or Rust code remains. |
| Process hygiene: pid + lock files, process groups, zombie-safe liveness, sweep of stray workers and pills | `worker_processes` | `src/worker/workerProcesses.ts` | replaced | Detached process groups, `ps` sweep by argv in `reset`. A pid file counts (and its pid is signalled) only while `ps` shows that pid running the worker or pill command line, so a pid reused after a reboot is never trusted or killed (the Rust worker checked only that the pid was alive). Each worker lock is a kernel lock (`O_EXLOCK`) that ends with its worker, so racing starters never take over a stale lock together. |

## Open questions

Each was decided with the rule "keep the most user-visible behavior with the least machinery". The chosen option is marked.

1. **Apple Foundation Models (`refineProvider local`, first step of `auto`).** There is no maintained Node binding: the only npm package (`@meridius-labs/apple-on-device-ai`) was last published in August 2025 and pulls in the Vercel AI SDK.
   - (a) **Drop `local`; `auto` starts at codex.** ← chosen
   - (b) Add the stale npm package as an optional dependency.
   - (c) Ship a tiny Swift CLI again (the user asked for no Swift).
2. **Whisper decode settings whisper.node does not expose** (`no_speech_thold`, `suppress_nst`, and the cheaper preview settings `audio_ctx 768`, `max_tokens 48`, `single_segment`).
   - (a) **Accept whisper.cpp defaults; keep the TS silence, VAD, and hallucination filters.** ← chosen
   - (b) Send a patch to `@fugood/whisper.node` to expose them.
   - (c) Use Homebrew `whisper-server`, which exposes more settings but adds an HTTP server process and a WAV round-trip per clip.
3. **One whisper context for the live caption and the final decode** (Rust had two states over one model). A caption in progress can delay a final decode by one caption pass (~100–250 ms with turbo).
   - (a) **One context; captions pause while a clip is queued.** ← chosen
   - (b) Two contexts (about double the model memory).
4. **Which agents get the Stop hook.** The old voice feature supported Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/hooks.json`), and Grok (a shared file in `~/.grok/hooks/`).
   - **voxkey registers for each agent whose home folder exists**; Grok gets its own file `~/.grok/hooks/voxkey.json` so the old tool's file is never touched. ← chosen
5. **Project scope** (`--scope project` installed voice into a repo's `.claude/settings.json`). Dropped: dictation and narration are per user, not per repo. Re-adding it means one more settings path per agent.
6. **Existing config and models from the old tool.** Clean break: voxkey does not read the old tool's `config.json`. The README lists the setting renames, and how to copy the already-downloaded models (the old tool's voice `models/*.bin` folder under `~/Library/Application Support/`) into `~/.voxkey/models/` to skip a 2 GB download.
7. **"new line" in an agent input.** As before, a spoken "new line" types a newline character, which some terminal inputs treat as Enter. Unchanged on purpose.
8. **Microphone indicator.** The mic stays open while the dictation worker runs (same as the Rust worker), so macOS shows the orange mic dot the whole time. Opening it only on Shift-down would clip the first word.
