/** `dufflebag tts` — agent reply narration on or off (speech-mode). */

import { Command as CliCommand } from "@effect/cli";
import { Effect } from "effect";

import { narratingSpeechMode, saveVoiceSettings, stopNarration } from "../voiceControl/voiceWorker.js";
import { type CliScope, scopeOption } from "./cliOptions.js";
import * as TerminalUI from "./TerminalUI.js";
import { holdToDictateHint, startVoice } from "./voiceCommand.js";

// speechMode goes in with the install, so the worker restart already prepares and starts narration.
export const ttsOn = (scope: CliScope) =>
  Effect.gen(function* () {
    const { previousConfig, config } = yield* startVoice({
      scope,
      settings: (current) => ({ speechMode: narratingSpeechMode(current.speechMode) }),
    });
    yield* TerminalUI.success(
      previousConfig.speechMode === config.speechMode
        ? `TTS is on (${scope}) — speech-mode already ${config.speechMode}.`
        : `TTS is on (${scope}) — speech-mode → ${config.speechMode}.`,
    );
    yield* TerminalUI.detail("Agent responses are narrated when speech-mode is not off.");
    yield* TerminalUI.detail(`${holdToDictateHint} (STT is available while the worker runs.)`);
  });

export const ttsOff = (scope: CliScope) =>
  Effect.gen(function* () {
    const { changed, destination } = yield* saveVoiceSettings({ scope, settings: { speechMode: "off" } });
    const stopped = yield* stopNarration(destination.root);
    yield* TerminalUI.success(
      changed ? `TTS is off (${scope}) — speech-mode → off.` : `TTS is already off (${scope}).`,
    );
    if (stopped) {
      yield* TerminalUI.detail("Stopped the narration worker and TTS server; dictation worker left running.");
    }
    yield* TerminalUI.detail(
      "Dictation is unchanged. Turn STT off with `dufflebag stt off` if you want the worker stopped too.",
    );
  });

const ttsOnCommand = CliCommand.make("on", { scope: scopeOption }, (args) =>
  Effect.all([TerminalUI.intro("tts on"), ttsOn(args.scope), TerminalUI.outro("Ready.")], { discard: true }),
).pipe(CliCommand.withDescription("Enable agent response narration (speech-mode off → auto)"));

const ttsOffCommand = CliCommand.make("off", { scope: scopeOption }, (args) =>
  Effect.all([TerminalUI.intro("tts off"), ttsOff(args.scope), TerminalUI.outro("Done.")], { discard: true }),
).pipe(CliCommand.withDescription("Disable agent response narration without stopping dictation"));

export const ttsCommand = CliCommand.make("tts").pipe(
  CliCommand.withDescription("Text-to-speech response narration"),
  CliCommand.withSubcommands([ttsOnCommand, ttsOffCommand]),
);
