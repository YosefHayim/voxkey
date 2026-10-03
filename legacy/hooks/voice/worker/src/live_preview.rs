//! Live HUD caption while Shift is held: a cheap Whisper pass over the tail of the capture,
//! written to status.json only (never typed). The final text always comes from the dictation queue.
//! `DUFFLEBAG_DICTATION_LIVE_PREVIEW=off` (or 0/false/no) turns it off.

use crate::config::voice_preferences;
use crate::microphone::SharedCapture;
use crate::stt::{clean_transcript, SttEngine};
use crate::worker_status::StatusWriter;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Short enough that the HUD shows words while the key is still held.
const PREVIEW_INTERVAL: Duration = Duration::from_millis(700);
/// Wide tail so the release fallback is not only the last few words of a long hold.
const PREVIEW_TAIL_SECONDS: f32 = 8.0;
/// About 0.4 s of audio before the first preview.
const MIN_PREVIEW_SAMPLES: usize = 6_400;

fn live_preview_enabled() -> bool {
    std::env::var("DUFFLEBAG_DICTATION_LIVE_PREVIEW")
        .map(|value| !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(true)
}

/// Last live caption, typed on release when offline STT returns nothing (short clips).
#[derive(Default)]
pub struct LiveCaption {
    text: Mutex<String>,
}

impl LiveCaption {
    /// Keep the longer caption so a later short tail does not replace a better mid-hold decode.
    fn set_if_better(&self, text: &str) {
        let mut slot = self.text.lock();
        if text.len() >= slot.len() {
            *slot = text.to_string();
        }
    }

    pub fn take(&self) -> String {
        std::mem::take(&mut *self.text.lock())
    }

    pub fn clear(&self) {
        self.text.lock().clear();
    }
}

pub fn spawn_preview_loop(
    capture: SharedCapture,
    engine: Arc<SttEngine>,
    caption: Arc<LiveCaption>,
    status: StatusWriter,
    running: Arc<AtomicBool>,
) {
    if !live_preview_enabled() {
        return;
    }
    thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            if !capture.is_recording() {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            let samples = capture.snapshot_tail(PREVIEW_TAIL_SECONDS);
            if samples.len() >= MIN_PREVIEW_SAMPLES {
                match engine.transcribe_preview(&samples, &voice_preferences().dictation_language) {
                    Ok(raw) => {
                        let text = clean_transcript(&raw);
                        if !text.is_empty() && capture.is_recording() {
                            caption.set_if_better(&text);
                            status.write_preview(&text);
                        }
                    }
                    Err(error) => eprintln!("live preview: {error}"),
                }
            }
            thread::sleep(PREVIEW_INTERVAL);
        }
    });
}
