//! Where voice files live (state home, models, scripts beside the worker) and how they are written.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub fn home_dir() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

pub fn voice_state_home() -> PathBuf {
    if let Ok(override_home) = std::env::var("DUFFLEBAG_VOICE_DIR") {
        let trimmed = override_home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    #[cfg(target_os = "windows")]
    let base =
        std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home_dir().join("AppData").join("Local"));
    #[cfg(target_os = "macos")]
    let base = home_dir().join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base =
        std::env::var("XDG_STATE_HOME").map(PathBuf::from).unwrap_or_else(|_| home_dir().join(".local").join("state"));
    base.join("dufflebag").join("voice")
}

pub fn models_dir() -> PathBuf {
    voice_state_home().join("models")
}

pub fn ensure_state_home() -> std::io::Result<PathBuf> {
    let home = voice_state_home();
    fs::create_dir_all(home.join("inbox"))?;
    fs::create_dir_all(models_dir())?;
    Ok(home)
}

/// A Python script installed beside the worker binary, or in the source tree during `cargo run`.
pub fn script_beside_worker(name: &str) -> Result<PathBuf, String> {
    let installed = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(name)));
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(name);
    installed
        .into_iter()
        .chain([source])
        .find(|path| path.is_file())
        .ok_or_else(|| format!("{name} not found beside worker"))
}

/// Write through a temp file + rename so readers (TS CLI, HUD) never see half a file.
pub fn atomic_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("tmp"),
        Uuid::new_v4().simple()
    ));
    let mut file = fs::File::create(&temp)?;
    file.write_all(&serde_json::to_vec(value).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    fs::rename(temp, path)
}

/// Append one timestamped line to `dictation.log` (decode, refine, and typing timings).
pub fn append_dictation_log(line: &str) {
    let path = voice_state_home().join("dictation.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{:.3} {line}", now_secs());
    }
}

pub fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}
