/** `dufflebag voice` — local reply narration, prompt refinement, and the voice worker's status. */

import { Args, Command as CliCommand, Options } from "@effect/cli";
import { FileSystem, Path, Command as PlatformCommand } from "@effect/platform";
import { Effect } from "effect";

import type { Config } from "../config/configSchema.js";
import { readConfig, resolveConfigTarget } from "../config/configSettings.js";
import {
  inheritedCommand,
  isTtsNarrationEnabled,
  isVoiceInstalled,
  requireInstalledVoice,
  runCommand,
  turnVoiceOff,
  turnVoiceOn,
  withProcessEnv,
} from "../voiceControl/voiceWorker.js";
import { type CliScope, formatOption, type OutputFormat, scopeOption } from "./cliOptions.js";
import * as TerminalUI from "./TerminalUI.js";

export const holdToDictateHint = "Hold Shift to dictate; release to finish.";

/** Turn voice on with `settings(current)` merged into config.json; returns the config before and after. */
export const startVoice = (request: {
  readonly scope: CliScope;
  readonly settings?: (current: Config) => Partial<Config>;
}) =>
  Effect.gen(function* () {
    const current = yield* readConfig(request.scope);
    const config = { ...current.config, ...request.settings?.(current.config) };
    const models = isTtsNarrationEnabled(config.speechMode) ? "+ Supertonic" : "(STT only)";
    yield* TerminalUI.step(`installing voice and preparing the dictation model ${models}`);
    yield* turnVoiceOn({ ...current, config });
    return { previousConfig: current.config, config };
  });

const refineDestinations = {
  caret: "caret",
  "cmux-new": "new cmux workspace",
  "cmux-resume": "focused cmux session",
} satisfies Record<Config["refineSendTo"], string>;

const describeDictationRefine = (config: Config) => {
  const model = config.refineModel === undefined ? "(default model)" : config.refineModel;
  const effort = config.refineEffort === undefined ? "" : ` effort=${config.refineEffort}`;
  const autoEnter = config.refinePressEnter ? " (auto-Enter)" : "";
  return `${config.refineProvider}/${model}${effort} → ${refineDestinations[config.refineSendTo]}${autoEnter}`;
};

export const voiceOn = (scope: CliScope) =>
  Effect.gen(function* () {
    const { config } = yield* startVoice({ scope });
    yield* TerminalUI.success(`Voice is on (${scope}).`);
    yield* TerminalUI.detail(holdToDictateHint);
    yield* TerminalUI.detail(
      isTtsNarrationEnabled(config.speechMode)
        ? `TTS narration: ${config.speechMode} (toggle with \`dufflebag tts on|off\`).`
        : "TTS narration: off (enable with `dufflebag tts on`).",
    );
    if (config.refineMode === "clipboard" || config.refineMode === "both") {
      yield* TerminalUI.detail("Double-tap Shift to refine the copied prompt, then press ⌘V to paste it.");
    }
    if (config.refineMode === "dictation" || config.refineMode === "both") {
      yield* TerminalUI.detail(`Dictation refine: ${describeDictationRefine(config)}.`);
    }
  });

export const voiceOff = (scope: CliScope) =>
  Effect.gen(function* () {
    const { alreadyOff } = yield* turnVoiceOff(scope);
    yield* TerminalUI.success(`Voice is ${alreadyOff ? "already off" : "off"} (${scope}).`);
  });

export const showVoiceStatus = (request: { readonly scope: CliScope; readonly format: OutputFormat }) =>
  Effect.gen(function* () {
    const { scope, format } = request;
    const { config, destination } = yield* readConfig(scope);
    const tts = config.speechMode;
    if (!(yield* isVoiceInstalled(destination.root))) {
      if (format === "json") {
        yield* TerminalUI.json({ installed: false, scope, stt: "off", tts });
        return;
      }
      yield* TerminalUI.note(`feature  off\nscope    ${scope}\nstt      off\ntts      ${tts}`, "Voice");
      yield* TerminalUI.outro("Enable with `dufflebag stt on` (dictation) or `dufflebag tts on` (narration).");
      return;
    }

    const worker = yield* requireInstalledVoice(destination.root);
    const status = (yield* PlatformCommand.string(withProcessEnv(PlatformCommand.make(worker, "status")))).trim();
    if (format === "json") {
      yield* TerminalUI.json({ installed: true, scope, stt: "on", tts, worker: status });
      return;
    }
    yield* TerminalUI.note(`feature  on\nscope    ${scope}\nstt      on\ntts      ${tts}\nworker   ${status}`, "Voice");
    yield* TerminalUI.outro(`${holdToDictateHint} Toggle TTS with \`dufflebag tts on|off\`.`);
  });

const onCommand = CliCommand.make("on", { scope: scopeOption }, (args) =>
  Effect.all([TerminalUI.intro("voice on"), voiceOn(args.scope), TerminalUI.outro("Ready.")], { discard: true }),
).pipe(CliCommand.withDescription("Install and start local voice (STT worker; TTS follows speech-mode)"));

const offCommand = CliCommand.make("off", { scope: scopeOption }, (args) =>
  Effect.all([TerminalUI.intro("voice off"), voiceOff(args.scope), TerminalUI.outro("Done.")], { discard: true }),
).pipe(CliCommand.withDescription("Stop voice and remove only the voice feature"));

const statusCommand = CliCommand.make("status", { scope: scopeOption, format: formatOption }, (args) =>
  Effect.gen(function* () {
    if (args.format === "text") yield* TerminalUI.intro("voice status");
    yield* showVoiceStatus(args);
  }),
).pipe(CliCommand.withDescription("Show install, worker, STT, and TTS state"));

const speakCommand = CliCommand.make(
  "speak",
  {
    text: Args.text({ name: "text" }).pipe(Args.withDescription("Complete Markdown response to read aloud")),
    scope: scopeOption,
  },
  (args) =>
    Effect.gen(function* () {
      const target = yield* resolveConfigTarget(args.scope);
      yield* runCommand({
        executable: yield* requireInstalledVoice(target.destination.root),
        args: ["speak", "--text", args.text],
        label: "Voice narration",
      });
    }),
).pipe(CliCommand.withDescription("Read one complete Markdown response aloud"));

const refineCommand = CliCommand.make(
  "refine",
  {
    prompt: Args.text({ name: "prompt" }).pipe(Args.withDescription("Draft prompt to refine locally")),
    speak: Options.boolean("speak").pipe(
      Options.withDescription("Read the refined prompt aloud with synchronized highlighting"),
    ),
    scope: scopeOption,
  },
  (args) =>
    Effect.gen(function* () {
      const target = yield* resolveConfigTarget(args.scope);
      yield* runCommand({
        executable: yield* requireInstalledVoice(target.destination.root),
        args: ["refine", "--text", args.prompt, ...(args.speak ? ["--speak"] : [])],
        label: "Prompt refinement",
      });
    }),
).pipe(CliCommand.withDescription("Refine one prompt with Apple's local on-device model"));

const devinCommand = CliCommand.make(
  "devin",
  {
    arguments: Args.text({ name: "devin-argument" }).pipe(
      Args.repeated,
      Args.withDescription("Arguments passed to Devin; put -- before Devin flags"),
    ),
    scope: scopeOption,
  },
  (args) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TerminalUI.intro("voice devin");
        const target = yield* resolveConfigTarget(args.scope);
        const worker = yield* requireInstalledVoice(target.destination.root);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sessionRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dufflebag-devin-voice-" });
        const exportPath = path.join(sessionRoot, "session.atif.json");
        const watcherCommand = inheritedCommand(worker, ["watch-devin", "--path", exportPath]);
        const watcher = yield* Effect.acquireRelease(PlatformCommand.start(watcherCommand), (process) =>
          process.kill().pipe(Effect.ignore),
        );
        yield* TerminalUI.detail(`Watching Devin's official ATIF export (watcher ${String(watcher.pid)}).`);
        yield* runCommand({ executable: "devin", args: ["--export", exportPath, ...args.arguments], label: "Devin" });
        yield* TerminalUI.outro("Devin session ended; voice watcher stopped.");
      }),
    ),
).pipe(CliCommand.withDescription("Run Devin and narrate complete turns from its official ATIF export"));

export const voiceCommand = CliCommand.make("voice").pipe(
  CliCommand.withDescription("Natural local response narration and caret dictation"),
  CliCommand.withSubcommands([onCommand, offCommand, statusCommand, speakCommand, refineCommand, devinCommand]),
);
