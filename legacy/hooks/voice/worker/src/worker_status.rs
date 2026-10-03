//! Worker status: the `status.json` snapshot the TS CLI and HUD read.

use crate::state_home::{atomic_json, now_secs, voice_state_home};
use crate::worker_processes::{process_running, read_pid_file, WORKER_PID};
use serde::Serialize;
use serde_json::Value;
use std::fs;

pub const HOTKEY_LABEL: &str = "hold-shift";

#[derive(Debug, Clone, Serialize)]
pub struct WorkerStatus {
    pub dictation: String,
    pub hotkey: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

impl WorkerStatus {
    pub fn snapshot() -> Self {
        let running = process_running(read_pid_file(WORKER_PID));
        let mut status = Self {
            dictation: "inactive".into(),
            hotkey: HOTKEY_LABEL.into(),
            running,
            detail: None,
            model: None,
            backend: None,
        };
        if !running {
            return status;
        }
        let Some(saved) = read_saved_status() else {
            return status;
        };
        let field = |key: &str| saved.get(key).and_then(Value::as_str).map(str::to_string);
        if let Some(dictation) = field("dictation") {
            status.dictation = dictation;
        }
        status.detail = field("detail").filter(|detail| !detail.is_empty());
        status.model = field("model");
        status.backend = field("backend");
        status
    }
}

pub fn read_saved_status() -> Option<Value> {
    let bytes = fs::read(voice_state_home().join("status.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Write worker status. `preview` is the live HUD caption only (never typed).
pub fn write_worker_status(
    dictation: &str,
    detail: &str,
    model: Option<&str>,
    backend: Option<&str>,
    preview: Option<&str>,
) {
    let value = serde_json::json!({
        "dictation": dictation,
        "detail": detail,
        "hotkey": HOTKEY_LABEL,
        "running": true,
        "model": model,
        "backend": backend,
        "preview": preview.unwrap_or(""),
        "updated_at": now_secs(),
    });
    let _ = atomic_json(&voice_state_home().join("status.json"), &value);
}

/// Status writes for the loaded Whisper model, so callers pass only the stage and detail.
#[derive(Debug, Clone)]
pub struct StatusWriter {
    model: String,
    backend: String,
}

impl StatusWriter {
    pub fn new(model: &str, backend: &str) -> Self {
        Self { model: model.to_string(), backend: backend.to_string() }
    }

    pub fn write(&self, dictation: &str, detail: &str) {
        write_worker_status(dictation, detail, Some(&self.model), Some(&self.backend), None);
    }

    pub fn write_preview(&self, caption: &str) {
        write_worker_status("listening", "", Some(&self.model), Some(&self.backend), Some(caption));
    }
}
