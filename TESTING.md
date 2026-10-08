# TESTING.md — checks that need you

`pnpm verify` covers the decisions, file formats, hook edits, refine checks, and (when the models are on your Mac) Whisper and Supertonic. These checks need a microphone, a keyboard, speakers, and macOS permissions, so they are done by hand. Do them in order; each lists what you should see.

Before you start: if another voice tool also listens for Shift on this Mac, stop it first, or both will type.

## 0. Build and install

```bash
pnpm install && pnpm build && pnpm link --global
voxkey doctor
```

Expect ✓ for macOS, Node, the native modules, and the system tools. Before step 1 these are expected too: Accessibility ✗ (not allowed yet), Microphone ! (not asked yet), a ! hook line for each installed agent (not registered yet), and possibly ! for the Whisper model and the Supertonic voices (not downloaded yet) and for Input Monitoring.

## 1. Permissions

```bash
voxkey on
```

- macOS asks for **Microphone** access for your terminal: allow it. If you missed it: System Settings → Privacy & Security → Microphone → enable your terminal, then `voxkey off && voxkey on`.
- System Settings → Privacy & Security → **Accessibility**: enable your terminal (needed to type into other apps).
- `voxkey doctor` now shows Microphone ✓ and Accessibility ✓.
- `voxkey status` shows `dictation on (pid …) · inactive · Ready (model load … ms, once)`.

## 2. Hotkey

```bash
voxkey hotkey-check --seconds 8
```

Press and release Shift a few times. Expect `SHIFT DOWN` / `SHIFT UP` lines and `✓ Shift detection works.` If nothing appears: System Settings → Privacy & Security → **Input Monitoring** → enable your terminal, then retry.

## 3. Dictation and the pill

1. Focus a text field (TextEdit, a browser box, or an agent's input).
2. Hold Shift alone for about half a second. The pill appears at the bottom centre with a pulsing red dot and "Recording", then a live caption of what you are saying.
3. Say: "hello comma my name is Joseph period new line bullet fix the login next bullet add tests".
4. Release Shift. The pill shows a spinner ("Working"), then hides.
5. Expect at the caret:

   ```text
   Hello, my name is Joseph.
   - Fix the login
   - Add tests 
   ```

6. Type a capital letter (Shift+A) in the field: no pill, no dictation.
7. Hold Shift, then press another key while still holding: the pill disappears and nothing is typed.
8. Hold, say one long sentence, release, and immediately hold again for a second sentence: both are typed, in order.
9. `tail ~/.voxkey/dictation.log` shows `stt … decode_ms=…` and `delivered … total_ms=…` lines.

Replacements: `voxkey config set dictation-replacements "Joseph=Yosef"`, dictate "my name is Joseph": expect "My name is Yosef".

Hebrew: `voxkey config set dictation-language he` (expect "Dictation restarted with ivrit.ai Hebrew Turbo V3"; the first time it downloads ~1.6 GB), then dictate a Hebrew sentence. Set it back with `voxkey config set dictation-language en`.

## 4. Narration

```bash
voxkey speak $'# Release\n\nThe voice worker is **ready**.\n\n| Item | State |\n| --- | --- |\n| Voice | Ready |'
```

Expect: "Release. The voice worker is ready. Row 1. Item: Voice. State: Ready." in voice F4.

Live, from an agent: with a fresh config, `voxkey status` shows "muted" and a finished turn stays silent. Double-tap Shift when nothing is speaking (the pill says "Narration unmuted"), then ask Claude Code, Codex, or Grok anything short. When the turn ends you should hear the reply.

- Tap Shift while it speaks: speech stops at once.
- Double-tap Shift when nothing is speaking: `voxkey status` shows "muted" again and agent replies stay silent; unmuting does not read the replies that came in meanwhile.
- Hold Shift to dictate while a reply is being read: the reading stops.
- `voxkey config set narration-mode off`: replies are no longer read; dictation still works. `voxkey config set narration-mode auto` brings narration back.

Inside Cmux (`narration-mode auto`): a reply from a background surface waits; switch to that surface and it is read.

## 5. Refine

```bash
voxkey refine "uh can you like make a branch and change the bio line to hello and open a pr but dont merge"
```

Expect one clean prompt line (needs a logged-in agent CLI, e.g. `codex login`). Then:

- `voxkey config set refine-mode dictation`, dictate something rambling of 5+ words: the pill shows "Refining (codex/…)…" and the refined prompt is typed.
- `voxkey config set refine-mode clipboard`, copy a messy prompt, double-tap Shift: the pill shows "Refined prompt copied — press ⌘V to paste"; ⌘V pastes it.
- `voxkey config pick-refine`: a terminal menu lists only the CLIs on your Mac; the choice shows in `voxkey status`.
- Set `voxkey config set refine-mode off` when done.

## 6. Agent hooks

- `cat ~/.claude/settings.json` (and `~/.codex/hooks.json`, `~/.grok/hooks/voxkey.json` if you use those agents): one Stop entry whose command ends in `reply --agent <id>`; everything else is unchanged. A copy of the original is in `~/.voxkey/backups/`.
- `voxkey off`: the entries are gone, the rest of each file is byte for byte what it was before `voxkey on` (`diff` it against the backup), no pill, no voxkey processes (`ps ax | grep "voxkey.*worker"`).

## 7. Reset

If something is stuck (pill stays, Shift does nothing): `voxkey reset`, then `voxkey on`.
