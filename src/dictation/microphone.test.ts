import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeClipBuffer, openMicrophone } from "./microphone.js";

// The recorder is the only external system here: one frame arrives, then the device fails.
vi.mock("@picovoice/pvrecorder-node", () => ({
  PvRecorder: vi.fn(() => ({
    start: () => undefined,
    stop: () => undefined,
    release: () => undefined,
    getSelectedDevice: () => "Fake microphone",
    read: vi.fn().mockResolvedValueOnce(new Int16Array(512).fill(100)).mockRejectedValue(new Error("device gone")),
  })),
}));

describe("clip buffer", () => {
  it("marks a clip as a hold only while it records, until it ends or is cancelled", () => {
    const clip = makeClipBuffer();
    clip.confirm();
    expect(clip.isConfirmedHold()).toBe(false);

    clip.begin();
    clip.confirm();
    expect(clip.isConfirmedHold()).toBe(true);
    clip.end();
    expect(clip.isConfirmedHold()).toBe(false);

    clip.begin();
    clip.confirm();
    clip.cancel();
    expect(clip.isConfirmedHold()).toBe(false);
  });

  it("numbers each clip, so work started for an earlier clip can tell it is late", () => {
    const clip = makeClipBuffer();
    clip.begin();
    const first = clip.clipNumber();
    clip.end();
    clip.begin();
    expect(clip.clipNumber()).toBe(first + 1);
  });
});

describe("openMicrophone", () => {
  it("reports a failed read instead of going on with no audio", async () => {
    const clip = makeClipBuffer();
    clip.begin();

    const failure = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(openMicrophone(clip), (microphone) => Effect.flip(microphone.failure))),
    );

    expect(failure.message).toBe("Microphone: device gone");
    expect(clip.sampleCount()).toBe(512);
  });
});
