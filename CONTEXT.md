# CONTEXT.md

How voxkey runs on a Mac. Words are defined in `LANGUAGE.md`.

## Processes

| Process | Started by | Lives | Does |
| --- | --- | --- | --- |
| `voxkey <command>` | the user | one command | everything in `src/cli/` |
| dictation worker (`voxkey worker dictation`) | `voxkey on`, or `voxkey reply` after a reboot | until `voxkey off` / `reset` | loads Whisper, opens the mic, polls Shift every 8 ms, runs the queue, starts the pill and the narration worker |
| narration worker (`voxkey worker narration`) | the dictation worker, `voxkey reply`, or `config set narration-mode` | until narration is off or `voxkey off` | inbox → Supertonic → `afplay` |
| pill (`osascript -l JavaScript`) | the dictation worker | until that worker exits | shows `status.json` at the bottom of the screen |
| `voxkey reply` | an agent's Stop hook | one turn | queues the reply, wakes the workers, prints nothing, exits 0 |

Workers are spawned detached in their own process groups and log to `~/.voxkey/*-worker.log`. A worker holds its kind's lock (`*.lock` created exclusively, plus `*.pid`); `voxkey off` writes `stop`, sends SIGTERM to each group, then SIGKILL. A tap or a new hold sends SIGUSR2 to the narration worker to stop speech at once.

## Files

All state is in `~/.voxkey` (`VOXKEY_HOME`). Writes go through a temporary sibling and a rename. The only files voxkey edits outside it are the agents' hook settings (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.grok/hooks/voxkey.json`), always backed up to `~/.voxkey/backups/` first.

## Permissions

macOS grants these to the app that runs voxkey (usually the terminal):

- **Microphone**: the dictation worker's PvRecorder.
- **Accessibility**: posting key events at the caret and `System Events` ⌘V.
- **Input Monitoring**: reading key state; voxkey reads HID state, which usually works without it, so it is a warning in `voxkey doctor`.

## Network

Only model downloads (Hugging Face) and whatever the chosen refine CLI does. Dictation and narration never leave the Mac.
