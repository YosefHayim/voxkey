import { describe, expect, it } from "vitest";

import {
  capWordsForDuration,
  cleanTranscript,
  collapseRepeatedRuns,
  extractSpeechRegion,
  isShortPhrase,
  MIN_VOICED_SAMPLES,
  NORMALIZE_PEAK,
  pcmFromSamples,
  peakNormalize,
  prepareForWhisper,
  rejectNoiseHallucination,
  rootMeanSquare,
  SAMPLE_RATE,
  samplesFromPcm,
  syntheticSpeech,
  tidyWhisperText,
} from "./speechDetection.js";

const peakOf = (samples: Float32Array) => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);

describe("speech detection", () => {
  it("caps a hallucinated run on a short clip to the words it could hold", () => {
    const invented = "hello there thank you for watching please subscribe and like this video forever";
    const capped = capWordsForDuration(invented, 8_000);
    expect(capped.split(" ").length).toBeLessThanOrEqual(3);
    expect(capped.startsWith("hello")).toBe(true);
  });

  it("never truncates a real 20 second dictation", () => {
    const spoken =
      "like sometimes when i'm holding the control it still doesn't properly stt everything i'm saying and sometimes it's just partial understand what i'm saying or not even getting it so i'm not sure if it's the mic so please check the logs and fix the silence gate and the token cap";
    expect(spoken.split(" ").length).toBeGreaterThanOrEqual(45);
    expect(capWordsForDuration(spoken, SAMPLE_RATE * 20)).toBe(spoken);
  });

  it("tells silence from sound", () => {
    expect(rootMeanSquare(new Float32Array(1_600))).toBeLessThan(0.003);
    expect(rootMeanSquare(new Float32Array(1_600).fill(0.2))).toBeGreaterThan(0.003);
    expect(prepareForWhisper(new Float32Array(SAMPLE_RATE))).toBeUndefined();
  });

  it("lifts a quiet laptop mic into Whisper's range", () => {
    const quiet = Float32Array.from({ length: 8_000 }, (_unused, index) => 0.004 * Math.sin(index * 0.1));
    expect(rootMeanSquare(quiet)).toBeLessThan(0.01);
    expect(peakOf(peakNormalize(quiet, NORMALIZE_PEAK))).toBeGreaterThan(0.15);
  });

  it("keeps quiet continuous speech after normalizing", () => {
    const soft = Float32Array.from({ length: SAMPLE_RATE * 3 }, (_unused, index) => 0.006 * Math.sin(index * 0.08));
    const region = extractSpeechRegion(peakNormalize(soft, NORMALIZE_PEAK));
    expect(region?.length).toBeGreaterThanOrEqual(MIN_VOICED_SAMPLES);
  });

  it("cuts a loud burst out of steady background noise", () => {
    const noisy = new Float32Array(SAMPLE_RATE).fill(0.005);
    noisy.fill(0.15, 8_000, 12_000);
    const region = extractSpeechRegion(noisy);
    expect(region?.length).toBeLessThan(noisy.length);
    expect(rootMeanSquare(region || new Float32Array())).toBeGreaterThan(0.05);
  });

  it("rejects one-word music hallucinations on short clips but keeps real words", () => {
    const halfSecond = SAMPLE_RATE / 2;
    expect(rejectNoiseHallucination("music", halfSecond)).toBe("");
    expect(rejectNoiseHallucination("Music.", halfSecond)).toBe("");
    expect(rejectNoiseHallucination("Thanks for watching!", SAMPLE_RATE * 2)).toBe("");
    expect(rejectNoiseHallucination("hello", halfSecond)).toBe("hello");
  });

  it("collapses repeated words", () => {
    expect(collapseRepeatedRuns("hello hello hello")).toBe("hello");
    expect(collapseRepeatedRuns("Hello Hello world")).toBe("Hello world");
    expect(collapseRepeatedRuns("go go go now")).toBe("go now");
    expect(tidyWhisperText(" go go now ", SAMPLE_RATE * 2)).toBe("go now");
  });

  it("never types no-speech markers or tags", () => {
    for (const marker of ["", "  ", "[MUSIC]", "[BLANK_AUDIO]", "no speech detected", "..."]) {
      expect(cleanTranscript(marker)).toBe("");
    }
    expect(cleanTranscript("hello world")).toBe("hello world");
    expect(cleanTranscript("hello [MUSIC] world")).toBe("hello world");
  });

  it("skips refine for phrases under five words", () => {
    expect(isShortPhrase("Thank you.")).toBe(true);
    expect(isShortPhrase("I'm going to go.")).toBe(true);
    expect(isShortPhrase("Check the worktrees folder and push every branch.")).toBe(false);
  });

  it("round-trips PCM and makes synthetic speech the VAD keeps", () => {
    const pcm = Int16Array.from([0, 16_384, -16_384, 32_767]);
    expect(Array.from(pcmFromSamples(samplesFromPcm(pcm)))).toEqual([0, 16_384, -16_383, 32_766]);
    expect(prepareForWhisper(syntheticSpeech(1))).toBeDefined();
  });
});
