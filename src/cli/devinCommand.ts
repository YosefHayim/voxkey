/** `voxkey devin -- <devin arguments>`: run Devin with its ATIF export and narrate each finished turn. */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { Args, Command } from "@effect/cli";
import { Effect, Fiber, Schema } from "effect";

import { watchDevinExport } from "../devin/devinWatcher.js";
import { stateFolder } from "../state/statePaths.js";
import { startWorkers } from "../worker/workerProcesses.js";
import * as TerminalUI from "./TerminalUI.js";

class DevinFailed extends Schema.TaggedError<DevinFailed>()("DevinFailed", { issue: Schema.String }) {
  get message(): string {
    return `devin: ${this.issue}`;
  }
}

const runDevin = (args: ReadonlyArray<string>) =>
  Effect.async<number, DevinFailed>((resume) => {
    const child = spawn("devin", [...args], { stdio: "inherit" });
    child.on("error", (error) => resume(Effect.fail(new DevinFailed({ issue: error.message }))));
    child.on("exit", (code) => resume(Effect.succeed(code === null ? 1 : code)));
    return Effect.sync(() => child.kill("SIGTERM"));
  });

export const devinCommand = Command.make(
  "devin",
  {
    devinArguments: Args.text({ name: "devin-argument" }).pipe(
      Args.repeated,
      Args.withDescription("Arguments passed to Devin; put -- before Devin flags"),
    ),
  },
  (args) =>
    Effect.gen(function* () {
      yield* TerminalUI.intro("devin");
      yield* startWorkers;
      const folder = path.join(stateFolder("devin"), new Date().toISOString().replace(/[:.]/gu, "-"));
      mkdirSync(folder, { recursive: true });
      const exportFile = path.join(folder, "session.atif.json");
      const watcher = yield* Effect.fork(watchDevinExport(exportFile));
      yield* TerminalUI.detail(`Narrating finished turns from Devin's ATIF export (${exportFile}).`);
      const code = yield* runDevin(["--export", exportFile, ...args.devinArguments]);
      yield* Fiber.interrupt(watcher);
      yield* TerminalUI.outro(`Devin exited with ${String(code)}; the watcher stopped.`);
    }),
).pipe(Command.withDescription("Run Devin and read each finished turn aloud from its official ATIF export"));
