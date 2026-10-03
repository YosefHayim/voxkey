//! `bench`: Whisper model load vs warm decode time on synthetic speech (no mic, no typing).

use crate::microphone::SAMPLE_RATE;
use crate::stt::SttEngine;
use crate::whisper_models::{self, ModelKey};
use serde_json::{json, Value};
use std::time::Instant;

/// Speech-like energy bursts so energy VAD does not discard the clip.
pub fn synthetic_speech_seconds(secs: f32) -> Vec<f32> {
    let n = ((secs * SAMPLE_RATE as f32).round() as usize).max(SAMPLE_RATE as usize / 4);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / SAMPLE_RATE as f32;
        // ~5 Hz syllabic envelope + formant-ish sines.
        let env = 0.08 + 0.12 * (0.5 + 0.5 * (t * 5.0 * std::f32::consts::TAU).sin());
        let s = env
            * ((t * 180.0 * std::f32::consts::TAU).sin()
                + 0.45 * (t * 340.0 * std::f32::consts::TAU).sin()
                + 0.2 * (t * 720.0 * std::f32::consts::TAU).sin());
        out.push(s);
    }
    out
}

/// Parse the comma-separated `--models` and `--seconds` flags, then run the bench.
pub fn run_bench_command(models: &str, seconds: &str, runs: u32) -> Result<Value, String> {
    let csv = |text: &str| -> Vec<String> {
        text.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_string).collect()
    };
    let keys: Vec<ModelKey> = csv(models).iter().map(|key| ModelKey::parse(key)).collect();
    if keys.is_empty() {
        return Err("pass at least one --models key".into());
    }
    let audio_secs = csv(seconds)
        .iter()
        .map(|s| s.parse::<f32>().map_err(|e| format!("bad --seconds value {s}: {e}")))
        .collect::<Result<Vec<f32>, String>>()?;
    if audio_secs.is_empty() {
        return Err("pass at least one --seconds value".into());
    }
    run_bench(&keys, &audio_secs, runs)
}

fn run_bench(models: &[ModelKey], audio_secs: &[f32], runs: u32) -> Result<Value, String> {
    if runs == 0 {
        return Err("runs must be >= 1".into());
    }
    let mut model_reports = Vec::new();

    for &key in models {
        eprintln!("— bench model {} —", key.label());
        let path = whisper_models::ensure_model(key)?;
        let load_started = Instant::now();
        let engine = SttEngine::load(&path)?;
        let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;
        eprintln!("  load_ms={load_ms:.0}");

        let warm_started = Instant::now();
        engine.warmup();
        let warm_ms = warm_started.elapsed().as_secs_f64() * 1000.0;
        eprintln!("  warm_ms={warm_ms:.0}");

        let mut clips = Vec::new();
        for &secs in audio_secs {
            let samples = synthetic_speech_seconds(secs);
            let mut decode_ms: Vec<f64> = Vec::with_capacity(runs as usize);
            for run in 0..runs {
                let timed = engine.transcribe_timed(&samples, "en", None)?;
                decode_ms.push(timed.decode_ms);
                eprintln!(
                    "  audio={secs:.1}s run={} decode_ms={:.0} chars={}",
                    run + 1,
                    timed.decode_ms,
                    timed.text.len()
                );
            }
            let mean = mean(&decode_ms);
            let min = decode_ms.iter().copied().fold(f64::INFINITY, f64::min);
            let max = decode_ms.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            clips.push(json!({
                "audio_secs": secs,
                "runs": runs,
                "decode_ms_mean": round1(mean),
                "decode_ms_min": round1(min),
                "decode_ms_max": round1(max),
                "realtime_factor": round2(secs as f64 / (mean / 1000.0)),
            }));
        }

        model_reports.push(json!({
            "model": key.filename(),
            "label": key.label(),
            "path": path.display().to_string(),
            "load_ms": round1(load_ms),
            "warm_ms": round1(warm_ms),
            "clips": clips,
        }));
    }

    Ok(json!({
        "backend": whisper_models::whisper_backend_label(),
        "note": "decode_ms is VAD + whisper full on synthetic speech-like audio (warm model). Host language (Rust vs Swift) is not in this path.",
        "warm_worker": "Production path loads the model once in the dictation worker and reuses it; bench load_ms is cold start only.",
        "models": model_reports,
    }))
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
