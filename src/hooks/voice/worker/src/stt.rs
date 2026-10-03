//! whisper.cpp STT for hold-to-talk: Metal + flash-attn, reused state, energy VAD, a dictionary
//! prompt boost, and cleanup so silence and hallucinations never type.

use parking_lot::Mutex;
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

use crate::microphone::SAMPLE_RATE;

#[derive(Debug, Clone)]
pub struct TimedTranscript {
    pub text: String,
    /// Wall time for VAD isolation + whisper full + cleanup (ms).
    pub decode_ms: f64,
    /// Peak RMS of the raw capture (pre-normalize), for dictation.log diagnostics.
    pub input_rms: f32,
    /// True when Whisper full() ran (false = silence/VAD early exit).
    pub ran_whisper: bool,
}

/// Below this RMS *after* peak-normalize, treat the whole buffer as silence.
/// Quiet laptop mics often land at 0.003–0.009 raw; we normalize first so this
/// only rejects true near-zero buffers.
const SILENCE_RMS: f32 = 0.003;
/// Frame size for energy VAD (~30 ms @ 16 kHz).
const VAD_FRAME: usize = 480;
/// Require at least this much voiced audio before trusting Whisper (~120 ms).
const MIN_VOICED_SAMPLES: usize = 1_920;
/// Keep this much context around speech bursts (~150 ms).
const SPEECH_PAD_FRAMES: usize = 5;
/// Whisper often invents prose when fed near-silence; cap only short clips hard.
/// Longer holds use a looser cap so real speech is not mid-sentence truncated.
const MAX_WORDS_PER_SECOND_SHORT: f32 = 4.0;
const MAX_WORDS_PER_SECOND_LONG: f32 = 6.0;
/// Clips shorter than this (seconds) use the strict hallucination word cap.
const SHORT_CLIP_SECONDS: f32 = 3.0;
/// If less than this fraction of frames is voiced, treat as noise (bus / wind).
/// Only applied to longer buffers so short holds are not discarded.
const MIN_VOICED_FRAME_RATIO: f32 = 0.04;
/// Peak target after normalize (keeps quiet mics in Whisper's happy range).
const NORMALIZE_PEAK: f32 = 0.45;
/// Cap gain so pure digital silence cannot explode into noise.
const MAX_NORMALIZE_GAIN: f32 = 50.0;

pub struct SttEngine {
    /// Owns the model the states below point into (whisper.cpp ownership).
    _context: WhisperContext,
    /// Final offline decode state — one at a time (the dictation queue serializes).
    state: Mutex<WhisperState>,
    /// Separate state for live HUD preview so it never races final decode.
    preview_state: Mutex<WhisperState>,
    model_name: String,
    n_threads: i32,
}

// WhisperContext/State used under Mutex; only one transcribe at a time per state.
unsafe impl Send for SttEngine {}
unsafe impl Sync for SttEngine {}

impl SttEngine {
    pub fn load(model_path: &Path) -> Result<Self, String> {
        let mut ctx_params = WhisperContextParameters::default();
        // Metal is enabled via the `metal` crate feature; force GPU path on.
        ctx_params.use_gpu(true);
        ctx_params.flash_attn(true);

        let context = WhisperContext::new_with_params(
            model_path.to_str().ok_or_else(|| "model path is not UTF-8".to_string())?,
            ctx_params,
        )
        .map_err(|e| format!("failed to load whisper model: {e}"))?;
        let model_name = model_path.file_name().and_then(|s| s.to_str()).unwrap_or("whisper").to_string();
        let state = context.create_state().map_err(|e| format!("whisper state: {e}"))?;
        let preview_state = context.create_state().map_err(|e| format!("whisper preview state: {e}"))?;
        let n_threads = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4).clamp(2, 8);
        Ok(Self {
            _context: context,
            state: Mutex::new(state),
            preview_state: Mutex::new(preview_state),
            model_name,
            n_threads,
        })
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }

    /// Warm Metal kernels so the first real dictation is not a cold compile.
    /// Must use speech-like energy — pure silence exits before `whisper full`.
    pub fn warmup(&self) {
        let samples = crate::stt_benchmark::synthetic_speech_seconds(1.0);
        let _ = self.transcribe_timed(&samples, "en", None);
    }

    /// Offline final pass with wall-clock decode timing.
    pub fn transcribe_timed(
        &self,
        samples: &[f32],
        language: &str,
        initial_prompt: Option<&str>,
    ) -> Result<TimedTranscript, String> {
        let started = std::time::Instant::now();
        let input_rms = rms(samples);
        let outcome = self.transcribe_inner(&self.state, samples, language, initial_prompt, false)?;
        Ok(TimedTranscript {
            text: outcome.text,
            decode_ms: started.elapsed().as_secs_f64() * 1000.0,
            input_rms,
            ran_whisper: outcome.ran_whisper,
        })
    }

    /// Cheap sliding-window caption for the HUD only.
    pub fn transcribe_preview(&self, samples: &[f32], language: &str) -> Result<String, String> {
        Ok(self.transcribe_inner(&self.preview_state, samples, language, None, true)?.text)
    }

    fn transcribe_inner(
        &self,
        state_slot: &Mutex<WhisperState>,
        samples: &[f32],
        language: &str,
        initial_prompt: Option<&str>,
        preview: bool,
    ) -> Result<DecodeOutcome, String> {
        if samples.is_empty() {
            return Ok(DecodeOutcome::empty());
        }

        // Quiet mics: bring peak into range before silence/VAD so soft speech
        // is not discarded with decode_ms≈0 (never reaches Whisper).
        let normalized = peak_normalize(samples, NORMALIZE_PEAK);
        if rms(&normalized) < SILENCE_RMS {
            return Ok(DecodeOutcome::empty());
        }

        let Some(isolated) = extract_speech_region(&normalized) else {
            return Ok(DecodeOutcome::empty());
        };
        if isolated.len() < MIN_VOICED_SAMPLES {
            return Ok(DecodeOutcome::empty());
        }

        let mut state = state_slot.lock();
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(if preview { self.n_threads.min(4) } else { self.n_threads });
        params.set_language(Some(language));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        // Slightly less aggressive than 0.9 so quiet tails still decode.
        params.set_no_speech_thold(if preview { 0.85 } else { 0.6 });
        params.set_temperature(0.0);
        params.set_no_context(true);
        params.set_suppress_nst(true);
        if preview {
            // HUD only: cheap + single segment is fine (tail window is short).
            params.set_single_segment(true);
            params.set_max_tokens(48);
            params.set_audio_ctx(768);
        } else {
            // Final insert: multi-segment, full context, no token cap.
            // Any token cap cuts long holds off mid-sentence.
            params.set_single_segment(false);
            params.set_max_tokens(0);
            params.set_audio_ctx(0);
        }
        // Dictionary boost: replacement terms steer spelling.
        if let Some(prompt) = initial_prompt.filter(|prompt| !prompt.is_empty()) {
            params.set_initial_prompt(prompt);
        }

        state.full(params, &isolated).map_err(|e| format!("whisper full: {e}"))?;

        let parts: Vec<String> = (0..state.full_n_segments())
            .filter_map(|i| state.get_segment(i))
            .map(|segment| segment.to_str().unwrap_or("").trim().to_string())
            .filter(|text| !text.is_empty())
            .collect();
        let joined = parts.join(" ");
        let capped = cap_words_for_duration(&joined, isolated.len());
        let collapsed = collapse_repeated_runs(&capped);
        Ok(DecodeOutcome { text: reject_noise_hallucination(&collapsed, isolated.len()), ran_whisper: true })
    }
}

struct DecodeOutcome {
    text: String,
    ran_whisper: bool,
}

impl DecodeOutcome {
    fn empty() -> Self {
        Self { text: String::new(), ran_whisper: false }
    }
}

/// Scale samples so peak abs amplitude ≈ `target_peak` (capped gain).
fn peak_normalize(samples: &[f32], target_peak: f32) -> Vec<f32> {
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if peak < 1e-6 {
        return samples.to_vec();
    }
    let gain = (target_peak / peak).clamp(1.0, MAX_NORMALIZE_GAIN);
    if (gain - 1.0).abs() < 0.05 {
        return samples.to_vec();
    }
    samples.iter().map(|s| s * gain).collect()
}

/// Post-STT cleanup: strip tags, no-speech markers — empty means never type.
pub fn clean_transcript(text: &str) -> String {
    let mut t = text.trim().to_string();
    for tag in ["[MUSIC]", "[BLANK_AUDIO]", "[Silence]", "[silence]", "(music)", "(blank)", "♪"] {
        t = t.replace(tag, "");
    }
    t = t.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string();
    // Explicit no-speech / empty tokens.
    let lower = t.to_ascii_lowercase();
    if lower.is_empty() || lower == "no speech" || lower == "no speech detected" || lower == "." || lower == "..." {
        return String::new();
    }
    t
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// Energy VAD: keep only frames louder than an adaptive threshold (speech vs constant bus rumble).
fn extract_speech_region(samples: &[f32]) -> Option<Vec<f32>> {
    if samples.len() < VAD_FRAME {
        return if rms(samples) >= SILENCE_RMS { Some(samples.to_vec()) } else { None };
    }

    let energies: Vec<f32> = samples.chunks_exact(VAD_FRAME).map(rms).collect();

    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2];
    let p90 = sorted[(sorted.len() * 9) / 10];
    // Softer than median*2.2 so continuous soft speech (median ≈ speech) still
    // marks most frames voiced. Floor stays above pure silence.
    let threshold = (median * 1.6).max(SILENCE_RMS * 1.2).min(p90.max(SILENCE_RMS) * 0.9);

    let voiced: Vec<bool> = energies.iter().map(|e| *e >= threshold).collect();
    let voiced_count = voiced.iter().filter(|v| **v).count();
    if voiced_count == 0 {
        // Adaptive threshold can wipe soft continuous speech; fall back to full
        // buffer when overall energy is clearly above silence.
        if rms(samples) >= SILENCE_RMS * 1.5 {
            return Some(samples.to_vec());
        }
        return None;
    }
    let ratio = voiced_count as f32 / voiced.len() as f32;
    // Only discard long noise-heavy buffers; short holds keep any voiced span.
    if ratio < MIN_VOICED_FRAME_RATIO && samples.len() > SAMPLE_RATE as usize * 2 {
        if rms(samples) >= SILENCE_RMS * 2.0 {
            return Some(samples.to_vec());
        }
        return None;
    }

    let first = voiced.iter().position(|v| *v)?;
    let last = voiced.iter().rposition(|v| *v)?;
    let start_frame = first.saturating_sub(SPEECH_PAD_FRAMES);
    let end_frame = (last + 1 + SPEECH_PAD_FRAMES).min(voiced.len());
    let start = start_frame * VAD_FRAME;
    let end = (end_frame * VAD_FRAME).min(samples.len());
    if end <= start {
        return None;
    }
    let region = samples[start..end].to_vec();
    if rms(&region) < SILENCE_RMS {
        return None;
    }
    Some(region)
}

fn cap_words_for_duration(text: &str, sample_count: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let seconds = (sample_count as f32 / SAMPLE_RATE as f32).max(0.15);
    let rate = if seconds < SHORT_CLIP_SECONDS { MAX_WORDS_PER_SECOND_SHORT } else { MAX_WORDS_PER_SECOND_LONG };
    let max_words = ((seconds * rate).ceil() as usize).max(1);
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= max_words {
        return text.to_string();
    }
    words[..max_words].join(" ")
}

fn collapse_repeated_runs(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        let word = words[i];
        let mut run = 1usize;
        while i + run < words.len() && words[i + run].eq_ignore_ascii_case(word) {
            run += 1;
        }
        out.push(word.to_string());
        i += run;
    }
    out.join(" ")
}

fn reject_noise_hallucination(text: &str, sample_count: usize) -> String {
    let clean = text.trim();
    if clean.is_empty() {
        return String::new();
    }
    let seconds = sample_count as f32 / SAMPLE_RATE as f32;
    let lower = clean.to_ascii_lowercase();
    let stripped: String = lower.chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect();
    let words: Vec<&str> = stripped.split_whitespace().collect();

    const SINGLE: &[&str] = &[
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
    ];
    if words.len() == 1 && seconds < 2.5 && SINGLE.contains(&words[0]) {
        return String::new();
    }

    const PHRASES: &[&str] = &[
        "thank you for watching",
        "thanks for watching",
        "please subscribe",
        "like and subscribe",
        "see you next time",
        "thanks for listening",
        "subtitles by",
        "transcript by",
    ];
    if seconds < 4.0 {
        for phrase in PHRASES {
            if stripped.contains(phrase) && words.len() <= 8 {
                return String::new();
            }
        }
    }

    clean.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_hallucinated_length_on_short_clip() {
        let long = "hello there thank you for watching please subscribe and like this video forever";
        // 0.5s @ 16kHz → short-clip cap (~2 words at 4 wps)
        let samples = 8_000;
        let capped = cap_words_for_duration(long, samples);
        assert!(capped.split_whitespace().count() <= 3);
        assert!(capped.to_lowercase().starts_with("hello"));
    }

    #[test]
    fn does_not_truncate_real_long_dictation() {
        // A real 20 s hold must come through whole.
        let text = "like sometimes when i'm holding the control it still doesn't properly stt everything i'm saying and sometimes it's just partial understand what i'm saying or not even getting it so i'm not sure if it's the mic so please check the logs and fix the silence gate and the token cap";
        let samples = SAMPLE_RATE as usize * 20;
        let wc = text.split_whitespace().count();
        assert!(wc >= 45, "fixture word count {wc}");
        let capped = cap_words_for_duration(text, samples);
        assert_eq!(capped, text);
    }

    #[test]
    fn rms_detects_silence() {
        let silence = vec![0.0f32; 1600];
        assert!(rms(&silence) < SILENCE_RMS);
        let loud = vec![0.2f32; 1600];
        assert!(rms(&loud) > SILENCE_RMS);
    }

    #[test]
    fn peak_normalize_lifts_quiet_mic() {
        // Quiet laptop mic levels.
        let quiet: Vec<f32> = (0..8_000).map(|i| 0.004 * ((i as f32) * 0.1).sin()).collect();
        assert!(rms(&quiet) < 0.010);
        let lifted = peak_normalize(&quiet, NORMALIZE_PEAK);
        let peak = lifted.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        // Gain is capped (MAX_NORMALIZE_GAIN) so peak may land below target.
        assert!(peak > 0.15, "peak after normalize {peak}");
        assert!(rms(&lifted) > SILENCE_RMS);
    }

    #[test]
    fn extract_keeps_quiet_continuous_speech() {
        // Soft continuous speech after normalize — must not return None.
        let mut soft = vec![0.0f32; SAMPLE_RATE as usize * 3];
        for (i, s) in soft.iter_mut().enumerate() {
            *s = 0.006 * ((i as f32) * 0.08).sin();
        }
        let normalized = peak_normalize(&soft, NORMALIZE_PEAK);
        let region = extract_speech_region(&normalized).expect("quiet speech region");
        assert!(region.len() >= MIN_VOICED_SAMPLES);
        assert!(rms(&region) >= SILENCE_RMS);
    }

    #[test]
    fn rejects_music_hallucination_on_short_clip() {
        let short = (SAMPLE_RATE as usize) / 2;
        assert_eq!(reject_noise_hallucination("music", short), "");
        assert_eq!(reject_noise_hallucination("Music.", short), "");
        assert_eq!(reject_noise_hallucination("hello", short), "hello");
    }

    #[test]
    fn collapses_hello_hello_hello() {
        assert_eq!(collapse_repeated_runs("hello hello hello"), "hello");
        assert_eq!(collapse_repeated_runs("Hello Hello world"), "Hello world");
        assert_eq!(collapse_repeated_runs("go go go now"), "go now");
    }

    #[test]
    fn extracts_loud_region_from_noise() {
        let mut samples = vec![0.005f32; SAMPLE_RATE as usize];
        for s in &mut samples[8000..12000] {
            *s = 0.15;
        }
        let region = extract_speech_region(&samples).expect("speech region");
        assert!(region.len() < samples.len());
        assert!(rms(&region) > 0.05);
    }

    #[test]
    fn clean_never_types_no_speech_or_tags() {
        assert_eq!(clean_transcript(""), "");
        assert_eq!(clean_transcript("  "), "");
        assert_eq!(clean_transcript("[MUSIC]"), "");
        assert_eq!(clean_transcript("[BLANK_AUDIO]"), "");
        assert_eq!(clean_transcript("no speech detected"), "");
        assert_eq!(clean_transcript("hello world"), "hello world");
        assert_eq!(clean_transcript("hello [MUSIC] world"), "hello world");
    }
}
