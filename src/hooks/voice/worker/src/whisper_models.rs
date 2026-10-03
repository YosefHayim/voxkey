//! Whisper model catalog: which ggml file to load, where to download it, and `prepare`'s report.

use crate::state_home::{ensure_state_home, models_dir};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKey {
    /// Fastest, English only.
    TinyEn,
    /// Fast, English only.
    BaseEn,
    /// English-only; often 2–4× snappier than turbo-q5 on short holds.
    SmallEn,
    TurboQ5,
    TurboQ8,
    Turbo,
    /// ivrit.ai Hebrew-tuned large-v3-turbo ggml (https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml).
    IvritTurbo,
}

impl ModelKey {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "tiny" | "tiny.en" | "fast" => Self::TinyEn,
            "base" | "base.en" => Self::BaseEn,
            "small" | "small.en" => Self::SmallEn,
            "turbo" | "large" | "turbo-full" => Self::Turbo,
            "turbo-q8" | "q8" | "medium" => Self::TurboQ8,
            "ivrit" | "ivrit-ai" | "hebrew" | "he" | "he-il" => Self::IvritTurbo,
            _ => Self::TurboQ5,
        }
    }

    pub fn filename(self) -> &'static str {
        match self {
            Self::TinyEn => "ggml-tiny.en.bin",
            Self::BaseEn => "ggml-base.en.bin",
            Self::SmallEn => "ggml-small.en.bin",
            Self::TurboQ5 => "ggml-large-v3-turbo-q5_0.bin",
            Self::TurboQ8 => "ggml-large-v3-turbo-q8_0.bin",
            Self::Turbo => "ggml-large-v3-turbo.bin",
            Self::IvritTurbo => "ggml-ivrit-large-v3-turbo.bin",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::TinyEn => "Tiny English (fast)",
            Self::BaseEn => "Base English",
            Self::SmallEn => "Small English",
            Self::TurboQ5 => "Turbo V3 small (q5_0)",
            Self::TurboQ8 => "Turbo V3 medium (q8_0)",
            Self::Turbo => "Turbo V3 large",
            Self::IvritTurbo => "ivrit.ai Hebrew Turbo V3",
        }
    }

    pub fn download_url(self) -> String {
        match self {
            Self::IvritTurbo => {
                "https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin?download=true"
                    .into()
            }
            _ => format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}?download=true", self.filename()),
        }
    }

    /// Approximate size in bytes for progress / free-space hints.
    pub fn expected_bytes(self) -> u64 {
        match self {
            Self::TinyEn => 78_000_000,
            Self::BaseEn => 148_000_000,
            Self::SmallEn => 488_000_000,
            Self::TurboQ5 => 574_000_000,
            Self::TurboQ8 => 874_000_000,
            Self::Turbo => 1_624_000_000,
            Self::IvritTurbo => 1_624_555_275,
        }
    }
}

/// Resolve the STT model: `DUFFLEBAG_DICTATION_MODEL` wins, else config `dictationLanguage=he` → ivrit, else turbo-q5.
pub fn selected_model_key() -> ModelKey {
    if let Ok(raw) = std::env::var("DUFFLEBAG_DICTATION_MODEL") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return ModelKey::parse(trimmed);
        }
    }
    let prefs = crate::config::voice_preferences();
    if prefs.dictation_language == "he" {
        ModelKey::IvritTurbo
    } else {
        ModelKey::TurboQ5
    }
}

/// The model file, downloading it first when missing or truncated.
pub fn ensure_model(key: ModelKey) -> Result<PathBuf, String> {
    ensure_state_home().map_err(|e| e.to_string())?;
    let path = models_dir().join(key.filename());
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if !(path.is_file() && size > 1_000_000) {
        download_model(key, &path)?;
    }
    Ok(path)
}

fn download_model(key: ModelKey, destination: &Path) -> Result<(), String> {
    eprintln!("Downloading {} (~{:.0} MB)…", key.label(), key.expected_bytes() as f64 / 1_000_000.0);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(key.download_url().as_str())
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let total = response.content_length().unwrap_or(key.expected_bytes());
    let temp = destination.with_extension("partial");
    let mut file = File::create(&temp).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 1024 * 256];
    let mut written: u64 = 0;
    let mut last_report = 0u64;

    loop {
        let n = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        written += n as u64;
        if written - last_report > 20_000_000 || written == total {
            let pct = (written as f64 / total as f64 * 100.0).min(100.0);
            eprintln!("  {pct:5.1}%  ({written}/{total} bytes)");
            last_report = written;
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, destination).map_err(|e| e.to_string())?;
    eprintln!("Saved {}", destination.display());
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct PrepareReport {
    pub dictation: String,
    pub narration: String,
    pub model: String,
    pub model_path: String,
    pub backend: String,
}

pub fn prepare_report(path: &Path, model: &str) -> PrepareReport {
    PrepareReport {
        dictation: "ready".into(),
        narration: "pending".into(),
        model: model.into(),
        model_path: path.display().to_string(),
        backend: whisper_backend_label().into(),
    }
}

pub fn whisper_backend_label() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "whisper.cpp+metal"
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        "whisper.cpp"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ivrit_aliases() {
        assert_eq!(ModelKey::parse("ivrit"), ModelKey::IvritTurbo);
        assert_eq!(ModelKey::parse("hebrew"), ModelKey::IvritTurbo);
        assert_eq!(ModelKey::parse("he"), ModelKey::IvritTurbo);
        assert_eq!(ModelKey::parse("turbo-q5"), ModelKey::TurboQ5);
    }

    #[test]
    fn ivrit_points_at_huggingface_ggml() {
        assert!(ModelKey::IvritTurbo.download_url().contains("ivrit-ai/whisper-large-v3-turbo-ggml"));
        assert_eq!(ModelKey::IvritTurbo.filename(), "ggml-ivrit-large-v3-turbo.bin");
    }
}
