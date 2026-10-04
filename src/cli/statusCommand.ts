/** `voxkey status [--json]`: the workers, the dictation stage, the hooks, and the main settings. */

import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { registeredAgents } from "../agentHooks/hookRegistration.js";
import { readConfigOrDefaults } from "../config/configFile.js";
import { isNarrationMuted } from "../narration/inbox.js";
import { configFilePath, voxkeyHome } from "../state/statePaths.js";
import { isWorkerRunning, readPid } from "../worker/workerProcesses.js";
import { readWorkerStatus } from "../worker/workerStatus.js";
import * as TerminalUI from "./TerminalUI.js";

const jsonOption = Options.boolean("json").pipe(Options.withDescription("Print one JSON document"));

const currentStatus = Effect.gen(function* () {
  const config = yield* readConfigOrDefaults;
  const dictationRunning = isWorkerRunning("dictation");
  const saved = readWorkerStatus();
  return {
    home: voxkeyHome(),
    configFile: configFilePath(),
    dictation: {
      running: dictationRunning,
      pid: Option.getOrUndefined(readPid("dictation.pid")),
      stage: dictationRunning
        ? Option.getOrElse(
            Option.map(saved, (status) => status.stage),
            () => "starting",
          )
        : "inactive",
      detail: Option.getOrElse(
        Option.map(saved, (status) => status.detail),
        () => "",
      ),
      model: Option.getOrElse(
        Option.map(saved, (status) => status.model),
        () => "",
      ),
      backend: Option.getOrElse(
        Option.map(saved, (status) => status.backend),
        () => "",
      ),
      language: config.dictationLanguage,
      hotkey: "hold-shift",
    },
    narration: {
      running: isWorkerRunning("narration"),
      mode: config.narrationMode,
      voice: config.narrationVoice,
      muted: isNarrationMuted(),
    },
    refine: {
      mode: config.refineMode,
      provider: config.refineProvider,
      model: config.refineModel || "",
      sendTo: config.refineSendTo,
    },
    hooks: registeredAgents().map((target) => target.agent),
  };
});

export const statusCommand = Command.make("status", { json: jsonOption }, (args) =>
  Effect.gen(function* () {
    const status = yield* currentStatus;
    if (args.json) {
      yield* TerminalUI.json(status);
      return;
    }

    const dictation = status.dictation.running
      ? `on (pid ${String(status.dictation.pid)}) · ${status.dictation.stage}${status.dictation.detail === "" ? "" : ` · ${status.dictation.detail}`}`
      : "off";
    yield* TerminalUI.note(
      [
        `dictation   ${dictation}`,
        `model       ${status.dictation.model || "(not loaded)"} ${status.dictation.backend} · language ${status.dictation.language}`,
        `narration   ${status.narration.running ? "on" : "off"} · mode ${status.narration.mode} · voice ${status.narration.voice}${status.narration.muted ? " · muted" : ""}`,
        `refine      ${status.refine.mode}${status.refine.mode === "off" ? "" : ` · ${status.refine.provider}/${status.refine.model || "default"} → ${status.refine.sendTo}`}`,
        `hooks       ${status.hooks.length === 0 ? "none (run voxkey on)" : status.hooks.join(", ")}`,
        `config      ${status.configFile}`,
      ].join("\n"),
      "voxkey status",
    );
  }),
).pipe(Command.withDescription("Show the workers, the dictation stage, the agent hooks, and the main settings"));
