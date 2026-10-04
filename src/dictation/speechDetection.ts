/**
 * What to do with a captured clip before and after Whisper: lift quiet mics, keep only the voiced
 * region, and throw away the silence markers and hallucinations Whisper invents on near-silence.
 */

export const SAMPLE_RATE = 16_000;

/** Below this RMS after peak-normalize, the whole buffer is silence. */
const SILENCE_RMS = 0.003;
/** Energy VAD frame (~30 ms at 16 kHz). */
const VAD_FRAME = 480;
/** Whisper needs at least ~120 ms of voiced audio to be trusted. */
export const MIN_VOICED_SAMPLES = 1_920;
/** Context kept around speech bursts (~150 ms). */
const SPEECH_PAD_FRAMES = 5;
/** Word-rate caps: strict for short clips, looser for long holds so real speech is not cut. */
const MAX_WORDS_PER_SECOND_SHORT = 4;
const MAX_WORDS_PER_SECOND_LONG = 6;
const SHORT_CLIP_SECONDS = 3;
/** Long buffers with fewer voiced frames than this are noise (bus, wind). */
const MIN_VOICED_FRAME_RATIO = 0.04;
/** Peak target after normalize, with a gain cap so digital silence cannot explode into noise. */
export const NORMALIZE_PEAK = 0.45;
const MAX_NORMALIZE_GAIN = 50;
/** Fewer words than this are not worth refining; models answer short phrases with commentary. */
const MIN_REFINE_WORDS = 5;

export const rootMeanSquare = (samples: Float32Array): number => {
  if (samples.length === 0) {
    return 0;
  }

  let sumOfSquares = 0;
  for (const sample of samples) {
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples.length);
};

export const samplesFromPcm = (pcm: Int16Array): Float32Array => Float32Array.from(pcm, (sample) => sample / 32_768);

export const pcmFromSamples = (samples: Float32Array): Int16Array =>
  Int16Array.from(samples, (sample) => Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))));

/** Scale so the peak is about `targetPeak`, never by more than the gain cap. */
export const peakNormalize = (samples: Float32Array, targetPeak: number): Float32Array => {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak < 1e-6) {
    return samples;
  }

  const gain = Math.min(Math.max(targetPeak / peak, 1), MAX_NORMALIZE_GAIN);
  return Math.abs(gain - 1) < 0.05 ? samples : samples.map((sample) => sample * gain);
};

const frameEnergies = (samples: Float32Array): ReadonlyArray<number> =>
  Array.from({ length: Math.floor(samples.length / VAD_FRAME) }, (_unused, frame) =>
    rootMeanSquare(samples.subarray(frame * VAD_FRAME, (frame + 1) * VAD_FRAME)),
  );

// Softer than median × 2.2 so continuous soft speech still marks most frames voiced; the floor stays above silence.
const voicedThreshold = (energies: ReadonlyArray<number>): number => {
  const sorted = [...energies].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const ninetieth = sorted[Math.floor((sorted.length * 9) / 10)] || 0;
  return Math.min(Math.max(median * 1.6, SILENCE_RMS * 1.2), Math.max(ninetieth, SILENCE_RMS) * 0.9);
};

/** Energy VAD: the voiced region with a little padding, or undefined when the clip is silence or noise. */
export const extractSpeechRegion = (samples: Float32Array): Float32Array | undefined => {
  if (samples.length < VAD_FRAME) {
    return rootMeanSquare(samples) >= SILENCE_RMS ? samples : undefined;
  }

  const energies = frameEnergies(samples);
  const threshold = voicedThreshold(energies);
  const voiced = energies.map((energy) => energy >= threshold);
  const voicedCount = voiced.filter(Boolean).length;
  const overall = rootMeanSquare(samples);
  // The adaptive threshold can wipe soft continuous speech; keep the whole clip when it is clearly not silence.
  if (voicedCount === 0) {
    return overall >= SILENCE_RMS * 1.5 ? samples : undefined;
  }

  // Only long noise-heavy buffers are discarded; short holds keep any voiced span.
  if (voicedCount / voiced.length < MIN_VOICED_FRAME_RATIO && samples.length > SAMPLE_RATE * 2) {
    return overall >= SILENCE_RMS * 2 ? samples : undefined;
  }

  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  const start = Math.max(first - SPEECH_PAD_FRAMES, 0) * VAD_FRAME;
  const end = Math.min(Math.min(last + 1 + SPEECH_PAD_FRAMES, voiced.length) * VAD_FRAME, samples.length);
  const region = samples.subarray(start, end);
  return end > start && rootMeanSquare(region) >= SILENCE_RMS ? region : undefined;
};

/** Normalized voiced audio ready for Whisper, or undefined when nothing is worth decoding. */
export const prepareForWhisper = (samples: Float32Array): Float32Array | undefined => {
  if (samples.length === 0) {
    return undefined;
  }

  const normalized = peakNormalize(samples, NORMALIZE_PEAK);
  if (rootMeanSquare(normalized) < SILENCE_RMS) {
    return undefined;
  }

  const region = extractSpeechRegion(normalized);
  return region !== undefined && region.length >= MIN_VOICED_SAMPLES ? region : undefined;
};

const splitWords = (text: string): ReadonlyArray<string> => text.split(/\s+/u).filter((word) => word !== "");

/** Whisper invents prose on near-silence: cap the words a clip of this length can hold. */
export const capWordsForDuration = (text: string, sampleCount: number): string => {
  const words = splitWords(text);
  const seconds = Math.max(sampleCount / SAMPLE_RATE, 0.15);
  const rate = seconds < SHORT_CLIP_SECONDS ? MAX_WORDS_PER_SECOND_SHORT : MAX_WORDS_PER_SECOND_LONG;
  const maxWords = Math.max(Math.ceil(seconds * rate), 1);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(" ");
};

/** "hello hello hello" → "hello". */
export const collapseRepeatedRuns = (text: string): string => {
  const kept: Array<string> = [];
  for (const word of splitWords(text)) {
    if (kept.at(-1)?.toLowerCase() !== word.toLowerCase()) {
      kept.push(word);
    }
  }
  return kept.join(" ");
};

const SINGLE_WORD_NOISE = new Set([
  "music",
  "thanks",
  "thank",
  "subscribe",
  "copyright",
  "applause",
  "laughter",
  "silence",
  "blank",
  "mbn",
  "foreign",
  "inaudible",
]);

const NOISE_PHRASES = [
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "see you next time",
  "thanks for listening",
  "subtitles by",
  "transcript by",
];

/** Empty when the text is a known Whisper hallucination for a clip this short. */
export const rejectNoiseHallucination = (text: string, sampleCount: number): string => {
  const clean = text.trim();
  const seconds = sampleCount / SAMPLE_RATE;
  const stripped = clean.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "");
  const words = splitWords(stripped);
  const singleNoise = words.length === 1 && seconds < 2.5 && SINGLE_WORD_NOISE.has(words.join(""));
  const phraseNoise = seconds < 4 && words.length <= 8 && NOISE_PHRASES.some((phrase) => stripped.includes(phrase));
  return singleNoise || phraseNoise ? "" : clean;
};

/** The final text from Whisper's segments for a voiced region of `sampleCount` samples. */
export const tidyWhisperText = (text: string, sampleCount: number): string =>
  rejectNoiseHallucination(collapseRepeatedRuns(capWordsForDuration(text.trim(), sampleCount)), sampleCount);

const NO_SPEECH_TAGS = ["[MUSIC]", "[BLANK_AUDIO]", "[Silence]", "[silence]", "(music)", "(blank)", "♪"];

/** Strip tags and no-speech markers; empty means never type. */
export const cleanTranscript = (text: string): string => {
  const untagged = NO_SPEECH_TAGS.reduce((current, tag) => current.split(tag).join(""), text);
  const clean = splitWords(untagged).join(" ");
  return ["", "no speech", "no speech detected", ".", "..."].includes(clean.toLowerCase()) ? "" : clean;
};

export const isShortPhrase = (transcript: string): boolean => splitWords(transcript).length < MIN_REFINE_WORDS;

/** Speech-like energy (a ~5 Hz syllable envelope over three tones) so the VAD keeps it: for warm-up and bench. */
export const syntheticSpeech = (seconds: number): Float32Array =>
  Float32Array.from({ length: Math.max(Math.round(seconds * SAMPLE_RATE), SAMPLE_RATE / 4) }, (_unused, index) => {
    const time = index / SAMPLE_RATE;
    const turn = 2 * Math.PI;
    const envelope = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(time * 5 * turn));
    return (
      envelope * (Math.sin(time * 180 * turn) + 0.45 * Math.sin(time * 340 * turn) + 0.2 * Math.sin(time * 720 * turn))
    );
  });
