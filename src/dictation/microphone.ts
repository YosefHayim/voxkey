/**
 * The microphone stays open for the dictation worker's lifetime (PvRecorder, 16 kHz mono), so Shift
 * only flips a recording flag and the first word is never clipped by device start-up.
 */

import { Effect, Fiber, Schema } from "effect";

import { SAMPLE_RATE, samplesFromPcm } from "./speechDetection.js";

export class MicrophoneError extends Schema.TaggedError<MicrophoneError>()("MicrophoneError", {
  issue: Schema.String,
}) {
  get message(): string {
    return `Microphone: ${this.issue}`;
  }
}

const microphoneError = (error: unknown) =>
  new MicrophoneError({ issue: error instanceof Error ? error.message : String(error) });

/** 32 ms frames at 16 kHz. */
const FRAME_SAMPLES = 512;
/** PvRecorder's own buffer: about 3 s of frames, so a busy event loop never drops audio. */
const BUFFERED_FRAMES = 100;
const DEFAULT_DEVICE = -1;

/**
 * The audio of the current hold; frames arriving while not recording are dropped. Shift down begins a clip that
 * may still be a capital letter; `confirm` marks it a hold, which owns the audio until it ends or is cancelled.
 * Every begin starts a new clip number, so work started for an earlier clip can tell it is late.
 */
export const makeClipBuffer = () => {
  let frames: Array<Int16Array> = [];
  let recording = false;
  let confirmed = false;
  let clipNumber = 0;

  const begin = () => {
    frames = [];
    recording = true;
    confirmed = false;
    clipNumber += 1;
  };

  const append = (frame: Int16Array) => {
    if (recording) {
      frames.push(frame);
    }
  };

  const joined = (selected: ReadonlyArray<Int16Array>): Float32Array => {
    const pcm = new Int16Array(selected.reduce((total, frame) => total + frame.length, 0));
    let offset = 0;
    for (const frame of selected) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    return samplesFromPcm(pcm);
  };

  const end = (): Float32Array => {
    recording = false;
    confirmed = false;
    const captured = joined(frames);
    frames = [];
    return captured;
  };

  const cancel = () => {
    recording = false;
    confirmed = false;
    frames = [];
  };

  /** The last `seconds` of the current capture, for the live caption. */
  const tail = (seconds: number): Float32Array =>
    joined(frames.slice(-Math.max(Math.ceil((seconds * SAMPLE_RATE) / FRAME_SAMPLES), 1)));

  return {
    begin,
    append,
    end,
    cancel,
    tail,
    confirm: () => {
      confirmed = recording;
    },
    isRecording: () => recording,
    isConfirmedHold: () => confirmed,
    clipNumber: () => clipNumber,
    sampleCount: () => frames.length * FRAME_SAMPLES,
  };
};

export type ClipBuffer = ReturnType<typeof makeClipBuffer>;

/**
 * Open the default input and feed every frame to `clip` until the scope closes. `failure` fails when a read
 * fails, so the worker ends (and is started fresh) instead of recording silence from then on.
 */
export const openMicrophone = (clip: ClipBuffer) =>
  Effect.gen(function* () {
    const { PvRecorder } = yield* Effect.tryPromise({
      try: () => import("@picovoice/pvrecorder-node"),
      catch: microphoneError,
    });
    const recorder = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const opened = new PvRecorder(FRAME_SAMPLES, DEFAULT_DEVICE, BUFFERED_FRAMES);
          opened.start();
          return opened;
        },
        catch: microphoneError,
      }),
      (opened) =>
        Effect.sync(() => {
          opened.stop();
          opened.release();
        }),
    );
    const readFrame = Effect.tryPromise({ try: () => recorder.read(), catch: microphoneError });
    const reader = yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(readFrame, (frame) => Effect.sync(() => clip.append(frame)))),
    );
    return { device: recorder.getSelectedDevice(), failure: Fiber.join(reader) };
  });
