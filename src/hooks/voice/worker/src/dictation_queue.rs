//! Serial dictation queue: release only enqueues a clip; one thread decodes, refines, and types in order.

use crate::cmux_delivery::{deliver_text, is_cmux_delivery};
use crate::config::{voice_preferences, VoicePreferences};
use crate::dictation_format::format_dictation;
use crate::microphone::SAMPLE_RATE;
use crate::refine::refine_with_prefs;
use crate::state_home::append_dictation_log;
use crate::stt::{clean_transcript, SttEngine};
use crate::typing::{press_enter, type_text};
use crate::worker_status::StatusWriter;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

/// Below this many words there is nothing to rewrite, and models answer a short phrase with
/// commentary instead of a prompt.
const MIN_REFINE_WORDS: usize = 5;
/// Typing waits this long for the refined prompt, then types the raw transcript instead.
const REFINE_WAIT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct DictationJob {
    pub samples: Vec<f32>,
    pub replacements: HashMap<String, String>,
    /// Live-preview text, used when offline STT returns nothing (short clips).
    pub streamed_fallback: String,
    pub generation: u64,
}

pub struct DictationQueue {
    jobs: Mutex<VecDeque<DictationJob>>,
    pending: AtomicU64,
    in_flight: AtomicBool,
    running: AtomicBool,
}

impl DictationQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            jobs: Mutex::new(VecDeque::new()),
            pending: AtomicU64::new(0),
            in_flight: AtomicBool::new(false),
            running: AtomicBool::new(true),
        })
    }

    fn pending_count(&self) -> u64 {
        self.pending.load(Ordering::SeqCst) + u64::from(self.in_flight.load(Ordering::SeqCst))
    }

    pub fn enqueue(&self, job: DictationJob) {
        append_dictation_log(&format!(
            "enqueue gen={} samples={} fallback_chars={}",
            job.generation,
            job.samples.len(),
            job.streamed_fallback.len()
        ));
        self.jobs.lock().push_back(job);
        self.pending.fetch_add(1, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// Spawn the serial STT + type thread. Call once per dictation worker.
    pub fn spawn_worker(self: &Arc<Self>, engine: Arc<SttEngine>, status: StatusWriter) {
        let queue = Arc::clone(self);
        thread::spawn(move || {
            while queue.running.load(Ordering::SeqCst) {
                let job = queue.jobs.lock().pop_front();
                let Some(job) = job else {
                    thread::sleep(Duration::from_millis(15));
                    continue;
                };
                queue.pending.fetch_sub(1, Ordering::SeqCst);
                queue.in_flight.store(true, Ordering::SeqCst);
                transcribe_and_deliver(&engine, &status, &job);
                queue.in_flight.store(false, Ordering::SeqCst);
                if queue.pending_count() == 0 {
                    // Keep the last detail on screen briefly before clearing the stage.
                    thread::sleep(Duration::from_millis(800));
                    if queue.pending_count() == 0 {
                        status.write("inactive", "");
                    }
                }
            }
        });
    }
}

fn transcribe_and_deliver(engine: &SttEngine, status: &StatusWriter, job: &DictationJob) {
    status.write("finishing", &format!("Decoding {} samples…", job.samples.len()));
    let boost = prompt_boost_from_replacements(&job.replacements);
    let secs = job.samples.len() as f32 / SAMPLE_RATE as f32;
    let job_started = Instant::now();
    let language = voice_preferences().dictation_language;
    let timed = match engine.transcribe_timed(&job.samples, &language, boost.as_deref()) {
        Ok(timed) => timed,
        Err(error) => {
            append_dictation_log(&format!("stt error: {error}"));
            eprintln!("dictation stt: {error}");
            status.write("unavailable", &error);
            thread::sleep(Duration::from_millis(200));
            return;
        }
    };
    let decode_ms = timed.decode_ms;
    let mut text = clean_transcript(&timed.text);
    if text.is_empty() {
        text = clean_transcript(&job.streamed_fallback);
    }
    append_dictation_log(&format!(
        "stt gen={} secs={secs:.2} decode_ms={decode_ms:.1} rms={:.4} whisper={} raw={:?} clean={:?}",
        job.generation,
        timed.input_rms,
        u8::from(timed.ran_whisper),
        timed.text,
        text
    ));
    if text.is_empty() {
        let why = if timed.ran_whisper {
            format!("No speech ({secs:.1}s audio, {decode_ms:.0}ms decode)")
        } else {
            format!("No speech ({secs:.1}s, rms={:.4}, VAD skip)", timed.input_rms)
        };
        status.write("inactive", &why);
        return;
    }

    let prefs = voice_preferences();
    let refine = prefs.stt_refine_enabled();
    // Text is typed once. Typed text is never erased and retyped: by the time a model answers,
    // the caret may have moved and backspacing would delete other text.
    if refine {
        text = refined_or_raw(text, &prefs, status, job.generation);
    }

    let type_started = Instant::now();
    let caret = || deliver_to_caret(&text, &job.replacements, prefs.refine_press_enter);
    let delivered = if refine && is_cmux_delivery(&prefs.refine_send_to) {
        deliver_text(&text, &prefs).or_else(|error| {
            append_dictation_log(&format!(
                "cmux deliver failed gen={}: {error}; falling back to caret",
                job.generation
            ));
            caret()
        })
    } else {
        caret()
    };

    match delivered {
        Ok(out) => {
            let type_ms = type_started.elapsed().as_secs_f64() * 1000.0;
            let total_ms = job_started.elapsed().as_secs_f64() * 1000.0;
            append_dictation_log(&format!(
                "delivered gen={} decode_ms={decode_ms:.1} type_ms={type_ms:.1} total_ms={total_ms:.1} text={out:?}",
                job.generation
            ));
            // Always clear the pill when work is done; never leave dictation=refining after paste.
            status.write("inactive", "");
        }
        Err(error) => {
            append_dictation_log(&format!("deliver error: {error}"));
            status.write("unavailable", &error);
        }
    }
}

fn is_short_phrase(transcript: &str) -> bool {
    transcript.split_whitespace().count() < MIN_REFINE_WORDS
}

/// The refined prompt, or the raw transcript when the phrase is short or the model fails, answers
/// empty, or takes longer than `REFINE_WAIT`.
fn refined_or_raw(raw: String, prefs: &VoicePreferences, status: &StatusWriter, generation: u64) -> String {
    if is_short_phrase(&raw) {
        append_dictation_log(&format!("stt refine skipped gen={generation}: short phrase"));
        return raw;
    }
    let effort = if prefs.refine_effort.is_empty() { String::new() } else { format!("/{}", prefs.refine_effort) };
    status.write("refining", &format!("Refining ({}/{}{effort})…", prefs.refine_provider, prefs.refine_model));
    let refine_started = Instant::now();
    let (sender, receiver) = mpsc::channel();
    let (text, thread_prefs) = (raw.clone(), prefs.clone());
    // A model slower than REFINE_WAIT finishes in the background and its answer is dropped.
    thread::spawn(move || {
        let _ = sender.send(refine_with_prefs(&text, &thread_prefs));
    });
    match receiver.recv_timeout(REFINE_WAIT) {
        Ok(Ok(refined)) if !refined.trim().is_empty() => {
            let refine_ms = refine_started.elapsed().as_secs_f64() * 1000.0;
            append_dictation_log(&format!(
                "stt refine gen={generation} backend={} model={} effort={} refine_ms={refine_ms:.1} raw={raw:?} refined={refined:?}",
                prefs.refine_provider, prefs.refine_model, prefs.refine_effort
            ));
            refined
        }
        Ok(Ok(_)) => {
            append_dictation_log(&format!("stt refine empty gen={generation}; keeping raw transcript"));
            raw
        }
        Ok(Err(error)) => {
            append_dictation_log(&format!("stt refine failed gen={generation}: {error}; keeping raw transcript"));
            raw
        }
        Err(_) => {
            append_dictation_log(&format!(
                "stt refine timed out gen={generation} after {}s; keeping raw transcript",
                REFINE_WAIT.as_secs()
            ));
            raw
        }
    }
}

/// Whisper `initial_prompt` from the replacement terms (both sides), so names are spelled right.
fn prompt_boost_from_replacements(replacements: &HashMap<String, String>) -> Option<String> {
    let mut terms: Vec<&String> = replacements.iter().flat_map(|(heard, written)| [heard, written]).collect();
    terms.sort();
    terms.dedup();
    let joined = terms.iter().map(|term| term.as_str()).collect::<Vec<_>>().join(", ");
    (!joined.is_empty()).then_some(joined)
}

/// Type the final text at the caret, then press Enter when auto-submit is on.
fn deliver_to_caret(
    transcript: &str,
    replacements: &HashMap<String, String>,
    auto_submit: bool,
) -> Result<String, String> {
    let mut out = format_dictation(transcript, replacements);
    if out.is_empty() {
        return Ok(out);
    }
    type_text(&out)?;
    if auto_submit {
        press_enter()?;
        out.push_str(" [Enter]");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boost_includes_dictionary_terms() {
        let map = HashMap::from([
            ("type script".to_string(), "TypeScript".to_string()),
            ("joseph".to_string(), "Yosef".to_string()),
        ]);
        let boost = prompt_boost_from_replacements(&map).unwrap();
        assert!(boost.contains("TypeScript"));
        assert!(boost.contains("Yosef"));
        assert!(prompt_boost_from_replacements(&HashMap::new()).is_none());
    }

    #[test]
    fn short_phrases_skip_refine() {
        assert!(is_short_phrase("Thank you."));
        assert!(is_short_phrase("I'm going to go."));
        assert!(!is_short_phrase("Check the worktrees folder and push every branch."));
    }
}
