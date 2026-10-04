/** `voxkey hotkey-check [--seconds 8]`: print Shift edges so Shift detection can be checked by hand. */

import { Command, Options } from "@effect/cli";
import { Effect, Schema } from "effect";

import { loadKeyboard } from "../dictation/keyboard.js";
import * as TerminalUI from "./TerminalUI.js";

class NoShiftSeen extends Schema.TaggedError<NoShiftSeen>()("NoShiftSeen", {}) {
  get message(): string {
    return "No Shift press seen. Allow Input Monitoring for your terminal in System Settings → Privacy & Security.";
  }
}

export const hotkeyCheckCommand = Command.make(
  "hotkey-check",
  {
    seconds: Options.integer("seconds").pipe(
      Options.withDefault(8),
      Options.withDescription("How long to watch Shift"),
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const keyboard = yield* loadKeyboard;
      yield* TerminalUI.step(`Hold Shift… (watching for ${String(args.seconds)} s)`);
      const deadline = Date.now() + args.seconds * 1_000;
      let wasDown = false;
      let sawDown = false;
      while (Date.now() < deadline) {
        const down = keyboard.shiftDown();
        if (down !== wasDown) {
          yield* TerminalUI.text(down ? "SHIFT DOWN" : "SHIFT UP");
        }
        sawDown = sawDown || down;
        wasDown = down;
        yield* Effect.sleep("20 millis");
      }
      if (!sawDown) {
        return yield* new NoShiftSeen();
      }

      yield* TerminalUI.success("Shift detection works.");
    }),
).pipe(Command.withDescription("Print Shift presses for a few seconds, to check that voxkey can see the keyboard"));
