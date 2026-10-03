/**
 * The narration worker (`voxkey worker narration`): inbox → Supertonic → afplay, in its own process so
 * speech never competes with the Shift poller. It exits when narration is turned off.
 */

import { Effect, Option } from "effect";

import { readConfigOrDefaults } from "../config/configFile.js";
import { ensureSupertonicModels } from "../models/supertonicModels.js";
import { appendNarrationLog } from "../worker/workerLog.js";
import { claimWorkerLock, releaseWorkerLock, stopRequested } from "../worker/workerProcesses.js";
import { dictationOwnsAudio } from "../worker/workerStatus.js";
import { claimNextReply, completeReply, failReply, isNarrationMuted, removeInboxFiles } from "./inbox.js";
import { makeSpeechPlayer, speakMarkdown } from "./speechPlayer.js";
import { loadSupertonic, type SupertonicEngine } from "./supertonic.js";

/** The dictation worker sends SIGUSR2 to stop speech now (a tap, or a new hold). */
const STOP_SPEECH_SIGNAL = "SIGUSR2";

const speakNextReply = (engine: SupertonicEngine, player: ReturnType<typeof makeSpeechPlayer>) =>
  Effect.gen(function* () {
    const config = yield* readConfigOrDefaults;
    if (dictationOwnsAudio()) {
      return "wait";
    }

    if (isNarrationMuted()) {
      return "wait";
    }

    const next = yield* claimNextReply(config.narrationMode);
    if (Option.isNone(next)) {
      return "idle";
    }

    player.reset();
    const spoken = yield* Effect.either(
      speakMarkdown({
        engine,
        player,
        markdown: next.value.reply.markdown,
        voice: { voice: config.narrationVoice, wordsPerMinute: config.narrationWordsPerMinute },
      }),
    );
    if (spoken._tag === "Right") {
      completeReply(next.value.file);
    } else {
      appendNarrationLog(`speech failed: ${String(spoken.left)}`);
      failReply(next.value.file);
    }
    return "spoke";
  });

const speakUntilStopped = (engine: SupertonicEngine, player: ReturnType<typeof makeSpeechPlayer>) =>
  Effect.gen(function* () {
    while (!stopRequested()) {
      const config = yield* readConfigOrDefaults;
      if (config.narrationMode === "off") {
        removeInboxFiles([".json", ".speaking"]);
        return;
      }

      const step = yield* speakNextReply(engine, player);
      yield* Effect.sleep(step === "spoke" ? "10 millis" : "150 millis");
    }
  });

export const runNarrationWorker: Effect.Effect<void, unknown> = Effect.gen(function* () {
  // Installed first: the default action of SIGUSR2 would end the process while the models load.
  let stopSpeech = () => {};
  process.on(STOP_SPEECH_SIGNAL, () => stopSpeech());
  if (!claimWorkerLock("narration")) {
    return;
  }

  yield* Effect.gen(function* () {
    // A claim left by a crash would otherwise look like speech in progress forever.
    removeInboxFiles([".speaking"]);
    const config = yield* readConfigOrDefaults;
    if (config.narrationMode === "off") {
      removeInboxFiles([".json"]);
      return;
    }

    const folder = yield* ensureSupertonicModels((file, bytes) =>
      appendNarrationLog(`downloading ${file}: ${String(Math.round(bytes / 1e6))} MB`),
    );
    const engine = yield* loadSupertonic(folder);
    const player = makeSpeechPlayer();
    stopSpeech = player.stop;
    appendNarrationLog(`ready pid=${String(process.pid)}`);
    yield* speakUntilStopped(engine, player);
  }).pipe(
    Effect.tapError((failure) => Effect.sync(() => appendNarrationLog(`worker failed: ${String(failure)}`))),
    Effect.ensuring(Effect.sync(() => releaseWorkerLock("narration"))),
  );
});
