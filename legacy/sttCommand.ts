/** `dufflebag stt` — hold-Shift dictation: turn it on or off, and tune the mic tail and language. */

import { Args, Command as CliCommand } from "@effect/cli";
import { Effect, Option } from "effect";

import type { Config } from "../config/configSchema.js";
import { readConfig } from "../config/configSettings.js";
import {
  isTtsNarrationEnabled,
  reloadVoiceWorker,
  saveVoiceSettings,
  turnVoiceOff,
} from "../voiceControl/voiceWorker.js";
import { type CliScope, CliUsageError, scopeOption } from "./cliOptions.js";
import * as TerminalUI from "./TerminalUI.js";
import { holdToDictateHint, startVoice } from "./voiceCommand.js";

type DictationLanguage = Config["dictationLanguage"];

const englishAliases = ["en", "english", "en-us", "en_us"];
const hebrewAliases = ["he", "he-il", "he_il", "hebrew", "ivrit", "iw"];

/** Map a CLI language token (`he`, `hebrew`, `lang=he`, …) to its config value; null when unknown. */
export const normalizeDictationLanguage = (languageToken: string): DictationLanguage | null => {
  const token = languageToken
    .trim()
    .toLowerCase()
    .replace(/^lang=/, "");
  if (englishAliases.includes(token)) return "en";
  if (hebrewAliases.includes(token)) return "he";
  return null;
};

const dictationModel = (language: DictationLanguage) =>
  language === "he" ? "ivrit.ai whisper-large-v3-turbo ggml" : "whisper.cpp large-v3-turbo (default)";

export const sttOn = (scope: CliScope) =>
  Effect.gen(function* () {
    const { config } = yield* startVoice({ scope });
    yield* TerminalUI.success(`STT is on (${scope}).`);
    yield* TerminalUI.detail(holdToDictateHint);
    yield* TerminalUI.detail(
      isTtsNarrationEnabled(config.speechMode)
        ? `TTS narration mode: ${config.speechMode}.`
        : "TTS is off — agent replies stay silent. Enable with `dufflebag tts on`.",
    );
  });

export const sttOff = (scope: CliScope) =>
  Effect.gen(function* () {
    const { alreadyOff } = yield* turnVoiceOff(scope);
    yield* TerminalUI.success(`STT is ${alreadyOff ? "already off" : "off"} (${scope}).`);
    yield* TerminalUI.detail("Stopped the voice worker (dictation and live narration).");
  });

export const setKeepListening = (request: { readonly scope: CliScope; readonly seconds: number }) =>
  Effect.gen(function* () {
    const { config, changed } = yield* saveVoiceSettings({
      scope: request.scope,
      settings: { dictationKeepListeningSeconds: request.seconds },
    });
    const seconds = `${String(config.dictationKeepListeningSeconds)} s (${request.scope})`;
    yield* TerminalUI.success(changed ? `keep-listening → ${seconds}.` : `keep-listening already ${seconds}.`);
    yield* TerminalUI.detail("Applied on the next Shift release (no worker restart needed).");
  });

export const setDictationLanguage = (request: { readonly scope: CliScope; readonly language: DictationLanguage }) =>
  Effect.gen(function* () {
    const { config, changed, destination } = yield* saveVoiceSettings({
      scope: request.scope,
      settings: { dictationLanguage: request.language },
    });
    const model = dictationModel(config.dictationLanguage);
    const language = `${config.dictationLanguage} (${request.scope}); model: ${model}`;
    yield* TerminalUI.success(changed ? `lang → ${language}.` : `lang already ${language}.`);
    if (!changed) {
      yield* TerminalUI.detail("No config change; worker left as-is.");
      return;
    }

    const reloaded = yield* reloadVoiceWorker({ root: destination.root, config });
    yield* TerminalUI.detail(
      reloaded
        ? `Worker reloaded with ${model}.`
        : "Voice worker not installed yet — model applies on `dufflebag stt on`.",
    );
  });

const sttOnCommand = CliCommand.make("on", { scope: scopeOption }, (args) =>
  Effect.all([TerminalUI.intro("stt on"), sttOn(args.scope), TerminalUI.outro("Ready.")], { discard: true }),
).pipe(CliCommand.withDescription("Install and start local dictation (hold Shift to speak)"));

const sttOffCommand = CliCommand.make("off", { scope: scopeOption }, (args) =>
  Effect.all([TerminalUI.intro("stt off"), sttOff(args.scope), TerminalUI.outro("Done.")], { discard: true }),
).pipe(CliCommand.withDescription("Stop dictation and remove the local voice worker"));

const keepListeningSeconds = Args.float({ name: "seconds" }).pipe(
  Args.withDescription("Seconds to keep the mic open after Shift is released (0–2)"),
  Args.optional,
);

const sttKeepListeningCommand = CliCommand.make(
  "keep-listening",
  { seconds: keepListeningSeconds, scope: scopeOption },
  (args) =>
    Effect.gen(function* () {
      yield* TerminalUI.intro("stt keep-listening");
      if (Option.isSome(args.seconds)) {
        yield* setKeepListening({ scope: args.scope, seconds: args.seconds.value });
        yield* TerminalUI.outro("Done.");
        return;
      }

      const { config, scope } = yield* readConfig(args.scope);
      yield* TerminalUI.note(
        `scope                     ${scope}\nkeep listening (seconds)  ${String(config.dictationKeepListeningSeconds)}`,
        "dictation release tail",
      );
      yield* TerminalUI.detail(
        "After you release Shift, the mic stays open this long so trailing words are not clipped.",
      );
      yield* TerminalUI.outro("Set with `dufflebag stt keep-listening <seconds>` (0–2).");
    }),
).pipe(
  CliCommand.withDescription(
    "Show or set how long the mic stays open after Shift is released, in seconds (catches trailing words; default 0.2)",
  ),
);

const dictationLanguageArgument = Args.text({ name: "language" }).pipe(
  Args.withDescription("Dictation language: en | he (aliases: english, hebrew, ivrit, lang=he)"),
  Args.optional,
);

const sttLangCommand = CliCommand.make("lang", { language: dictationLanguageArgument, scope: scopeOption }, (args) =>
  Effect.gen(function* () {
    yield* TerminalUI.intro("stt lang");
    if (Option.isSome(args.language)) {
      const language = normalizeDictationLanguage(args.language.value);
      if (language === null) {
        return yield* new CliUsageError({
          issue: `Unknown dictation language "${args.language.value}". Use en or he (aliases: english, hebrew, ivrit).`,
        });
      }
      yield* setDictationLanguage({ scope: args.scope, language });
      yield* TerminalUI.outro("Done.");
      return;
    }

    const { config, scope } = yield* readConfig(args.scope);
    yield* TerminalUI.note(
      `scope     ${scope}\nlang      ${config.dictationLanguage}\nmodel     ${dictationModel(config.dictationLanguage)}`,
      "dictation language",
    );
    yield* TerminalUI.detail("Hebrew (he) downloads/loads the ivrit.ai ggml model on next prepare/start.");
    yield* TerminalUI.outro("Set with `dufflebag stt lang he` or `dufflebag stt lang en`.");
  }),
).pipe(CliCommand.withDescription("Show or set dictation language (en default; he = ivrit.ai Hebrew model)"));

export const sttCommand = CliCommand.make("stt").pipe(
  CliCommand.withDescription("Speech-to-text dictation (hold Shift)"),
  CliCommand.withSubcommands([sttOnCommand, sttOffCommand, sttKeepListeningCommand, sttLangCommand]),
);
