/** `voxkey worker dictation|narration`: the background workers' entry point; `voxkey on` starts them. */

import { Args, Command } from "@effect/cli";
import type { Effect } from "effect";

import { runDictationWorker } from "../dictation/dictationWorker.js";
import { runNarrationWorker } from "../narration/narrationWorker.js";

type WorkerFailure = Effect.Effect.Error<typeof runDictationWorker> | Effect.Effect.Error<typeof runNarrationWorker>;

export const workerCommand = Command.make(
  "worker",
  {
    kind: Args.choice(
      [
        ["dictation", "dictation"],
        ["narration", "narration"],
      ] as const,
      { name: "kind" },
    ),
  },
  (args): Effect.Effect<void, WorkerFailure> => {
    switch (args.kind) {
      case "dictation":
        return runDictationWorker;
      case "narration":
        return runNarrationWorker;
    }
  },
).pipe(Command.withDescription("Internal: run a background worker in this process (voxkey on starts them)"));
