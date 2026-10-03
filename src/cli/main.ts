#!/usr/bin/env node
/** voxkey CLI entry point: the only file that starts the Effect runtime. */

import { CliConfig, Command, ValidationError } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, ParseResult } from "effect";

import { CliUsageError } from "./cliUsageError.js";
import { configCommand } from "./configCommand.js";
import { devinCommand } from "./devinCommand.js";
import { doctorCommand } from "./doctorCommand.js";
import { hotkeyCheckCommand } from "./hotkeyCheckCommand.js";
import { offCommand } from "./offCommand.js";
import { onCommand } from "./onCommand.js";
import { refineCommand } from "./refineCommand.js";
import { renderCommand } from "./renderCommand.js";
import { replyCommand } from "./replyCommand.js";
import { resetCommand } from "./resetCommand.js";
import { speakCommand } from "./speakCommand.js";
import { statusCommand } from "./statusCommand.js";
import * as TerminalUI from "./TerminalUI.js";
import { voxkeyVersion } from "./voxkeyVersion.js";
import { workerCommand } from "./workerCommand.js";

const voxkey = Command.make("voxkey").pipe(
  Command.withDescription("Hold Shift to dictate into any text field and hear coding-agent replies read aloud."),
  Command.withSubcommands([
    onCommand,
    offCommand,
    statusCommand,
    doctorCommand,
    configCommand,
    speakCommand,
    renderCommand,
    refineCommand,
    devinCommand,
    hotkeyCheckCommand,
    resetCommand,
    replyCommand,
    workerCommand,
  ]),
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
