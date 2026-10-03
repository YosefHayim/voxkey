/**
 * The dictation worker (`voxkey worker dictation`): load Whisper once, keep the mic open, poll Shift every
 * 8 ms, show the pill, and start the narration worker; it runs until `voxkey off` or `voxkey reset`.
 */

import { Duration, Effect, Schedule } from "effect";

import { readConfigOrDefaults } from "../config/configFile.js";
import { readEnvironment } from "../config/environmentVariables.js";
import { ensureWhisperModel, selectWhisperModel } from "../models/whisperModels.js";
import { startPill, stopPill } from "../worker/pill.js";
import { appendDictationLog } from "../worker/workerLog.js";
import { claimWorkerLock, releaseWorkerLock, startNarrationWorker, stopRequested } from "../worker/workerProcesses.js";
import { makeStatusWriter } from "../worker/workerStatus.js";
import { startDictationQueue } from "./dictationQueue.js";
import { makeHoldController } from "./holdController.js";
import { SHIFT_POLL_MS } from "./holdKey.js";
import { loadKeyboard } from "./keyboard.js";
import { captionLoop, makeLiveCaption } from "./livePreview.js";
import { makeClipBuffer, openMicrophone } from "./microphone.js";
import { loadTranscriber, whisperBackend } from "./transcriber.js";

const waitForStop: Effect.Effect<void> = Effect.repeat(Effect.void, {
  schedule: Schedule.spaced("100 millis"),
  until: () => stopRequested(),
});

const runWorker = Effect.gen(function* () {
  const config = yield* readConfigOrDefaults;
  const model = selectWhisperModel({ environment: readEnvironment(), config });
  const loading = makeStatusWriter({ model: model.file, backend: whisperBackend() });
  loading.write("starting", `Loading ${model.label}`);
  const modelPath = yield* ensureWhisperModel({
    model,
    onProgress: (bytes) =>
      loading.write("starting", `Downloading ${model.label}: ${String(Math.round(bytes / 1e6))} MB`),
  });
  const loadStarted = performance.now();
  const transcriber = yield* Effect.acquireRelease(loadTranscriber(modelPath), (loaded) => loaded.release);
  const loadMs = (performance.now() - loadStarted).toFixed(0);
  const status = makeStatusWriter({ model: transcriber.modelName, backend: whisperBackend() });
  const keyboard = yield* loadKeyboard;
  const clip = makeClipBuffer();
  const microphone = yield* openMicrophone(clip);
  appendDictationLog(
    `worker pid=${String(process.pid)} model=${model.file} load_ms=${loadMs} mic=${microphone.device}`,
  );
  status.write("inactive", `Ready (model load ${loadMs} ms, once)`);

  yield* Effect.acquireRelease(
    Effect.sync(() => startPill(process.pid)),
    () => Effect.sync(stopPill),
  );
  if (config.narrationMode !== "off") {
    startNarrationWorker();
  }
  yield* Effect.forkScoped(transcriber.warm);

  const caption = makeLiveCaption();
  const queue = yield* startDictationQueue({ transcriber, keyboard, status });
  if (readEnvironment().VOXKEY_DICTATION_LIVE_PREVIEW) {
    yield* Effect.forkScoped(captionLoop({ clip, transcriber, caption, status }));
  }
  const controller = makeHoldController({ keyboard, clip, caption, status, queue });
  yield* Effect.forkScoped(Effect.repeat(controller.poll, Schedule.spaced(Duration.millis(SHIFT_POLL_MS))));
  yield* waitForStop;
});

/** Runs until the stop file appears; a start-up failure is written to status.json for `voxkey on` to report. */
export const runDictationWorker: Effect.Effect<void, unknown> = Effect.gen(function* () {
  if (!claimWorkerLock("dictation")) {
    return;
  }

  yield* Effect.scoped(runWorker).pipe(
    Effect.tapError((failure) =>
      Effect.sync(() => {
        const message = failure instanceof Error ? failure.message : String(failure);
        appendDictationLog(`worker failed: ${message}`);
        makeStatusWriter({ model: "", backend: whisperBackend() }).write("unavailable", message);
      }),
    ),
    Effect.ensuring(Effect.sync(() => releaseWorkerLock("dictation"))),
  );
});
