/** `voxkey reset`: a clean slate when something is stuck: kill every voxkey worker and pill and clear the locks. */

import { Command } from "@effect/cli";
import { Effect } from "effect";

import { resetWorkers } from "../worker/workerProcesses.js";
import * as TerminalUI from "./TerminalUI.js";

export const resetCommand = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    yield* resetWorkers;
    yield* TerminalUI.success("Stopped every voxkey worker and pill, cleared the locks, and unmuted narration.");
    yield* TerminalUI.detail("Start again with `voxkey on`.");
  }),
).pipe(Command.withDescription("Kill every voxkey worker and pill, clear locks and the mute (hooks stay registered)"));
