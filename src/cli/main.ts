#!/usr/bin/env node
/** voxkey CLI entry point: the only file that starts the Effect runtime. */

import { CliConfig, Command, ValidationError } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, ParseResult } from "effect";

import { CliUsageError } from "./cliUsageError.js";
import * as TerminalUI from "./TerminalUI.js";
import { voxkeyVersion } from "./voxkeyVersion.js";

const voxkey = Command.make("voxkey").pipe(
  Command.withDescription("Hold Shift to dictate into any text field and hear coding-agent replies read aloud."),
);

const exitCodeFor = (error: unknown) =>
  ValidationError.isValidationError(error) || ParseResult.isParseError(error) || error instanceof CliUsageError ? 2 : 1;

// @effect/cli already printed its own validation message; everything else is shown once here.
const reportFailure = (error: unknown) =>
  (ValidationError.isValidationError(error) ? Effect.void : TerminalUI.showError(error)).pipe(
    Effect.zipRight(
      Effect.sync(() => {
        process.exitCode = exitCodeFor(error);
      }),
    ),
  );

const invocation = process.argv.length <= 2 ? ["node", "voxkey", "--help"] : process.argv;

const program = Command.run(voxkey, { name: "voxkey", version: voxkeyVersion })(invocation).pipe(
  Effect.catchAll(reportFailure),
  Effect.provide(NodeContext.layer),
  Effect.provide(CliConfig.layer({ showBuiltIns: false })),
);

NodeRuntime.runMain(program);
