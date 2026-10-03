/** `voxkey off`: stop every voxkey process and remove only voxkey's entries from the agent settings. */

import { Command } from "@effect/cli";
import { Effect } from "effect";

import { unregisterReplyHooks } from "../agentHooks/hookRegistration.js";
import { resetWorkers } from "../worker/workerProcesses.js";
import { showHookChanges } from "./onCommand.js";
import * as TerminalUI from "./TerminalUI.js";

export const offCommand = Command.make("off", {}, () =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("off");
    yield* TerminalUI.step("Stopping the workers and the pill");
    yield* resetWorkers;
    yield* TerminalUI.step("Removing voxkey's Stop hook from the agent settings");
    yield* showHookChanges(yield* unregisterReplyHooks);
    yield* TerminalUI.outro("voxkey is off. Your config and models stay in ~/.voxkey.");
  }),
).pipe(Command.withDescription("Stop dictation and narration and remove voxkey's agent hooks (everything else stays)"));
