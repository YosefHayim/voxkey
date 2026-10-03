//! Voice preferences from the installed config.json (read fresh on every call).

use crate::state_home::home_dir;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct VoicePreferences {
    /// off | clipboard | dictation | both
    pub refine_mode: String,
    /// codex | local | auto | grok | ollama | …
    pub refine_provider: String,
    pub refine_model: String,
    /// low | medium | high | xhigh | minimal (low by default so refine after release stays fast)
    pub refine_effort: String,
    /// Press Enter after the refined text is typed at the caret.
    pub refine_press_enter: bool,
    /// caret | cmux-new | cmux-resume
    pub refine_send_to: String,
    /// Optional cmux-new shell template ({{prompt_file}}, {{prompt}}, {{cwd}}).
    pub refine_cmux_command: String,
    pub refine_cmux_press_enter: bool,
    /// auto | immediate | off (from `speechMode`)
    pub narration_mode: String,
    pub speech_voice: String,
    pub speech_speed: f64,
    pub dictation_replacements: String,
    /// Keep the mic open this long after Shift release (trailing-word tail).
    pub dictation_keep_listening_ms: u64,
    /// Whisper language: `en` or `he` (ivrit.ai Hebrew model).
    pub dictation_language: String,
}

impl Default for VoicePreferences {
    fn default() -> Self {
        preferences_from(&Value::Null)
    }
}

impl VoicePreferences {
    pub fn narration_enabled(&self) -> bool {
        self.narration_mode != "off"
    }

    pub fn stt_refine_enabled(&self) -> bool {
        matches!(self.refine_mode.as_str(), "dictation" | "both")
    }

    pub fn review_refine_enabled(&self) -> bool {
        matches!(self.refine_mode.as_str(), "clipboard" | "both")
    }

    /// `dictationReplacements` (`heard=written;…`) as a map.
    pub fn replacements(&self) -> HashMap<String, String> {
        parse_dictation_replacements(&self.dictation_replacements)
    }
}

fn installed_config() -> Value {
    config_candidates()
        .into_iter()
        .filter_map(|path| fs::read(path).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .find(Value::is_object)
        .unwrap_or(Value::Null)
}

fn config_candidates() -> Vec<PathBuf> {
    // Explicit override wins alone (tests + alternate installs).
    if let Ok(override_path) = std::env::var("DUFFLEBAG_VOICE_CONFIG_FILE") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed)];
        }
    }
    let mut paths = Vec::new();
    // <installRoot>/hooks/voice/dufflebag-voice → <installRoot>/config.json
    if let Some(voice_dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from)) {
        if let Some(root) = voice_dir.parent().and_then(|hooks| hooks.parent()) {
            paths.push(root.join("config.json"));
        }
        paths.push(voice_dir.join("config.json"));
    }
    // Source-tree / ad-hoc binaries do not sit under ~/.claude/dufflebag/hooks, so without the
    // global config they would miss speechMode=off and narrate.
    paths.push(home_dir().join(".claude/dufflebag/config.json"));
    paths
}

pub fn voice_preferences() -> VoicePreferences {
    preferences_from(&installed_config())
}

/// `value` when it is one of `allowed`, else `fallback`.
fn one_of(value: Option<&str>, allowed: &[&str], fallback: &str) -> String {
    value.filter(|value| allowed.contains(value)).unwrap_or(fallback).to_string()
}

fn preferences_from(values: &Value) -> VoicePreferences {
    let text = |key: &str| values.get(key).and_then(Value::as_str);
    let trimmed_or =
        |key: &str, fallback: &'static str| text(key).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback);
    let flag = |key: &str| values.get(key).and_then(Value::as_bool).unwrap_or(false);

    let refine_effort = text("refineEffort").map(str::trim).unwrap_or("low").to_ascii_lowercase();
    let voice = text("speechVoice").unwrap_or("F4");
    let words_per_minute = values.get("speechWordsPerMinute").and_then(Value::as_f64).unwrap_or(230.0);
    let dictation_language = match text("dictationLanguage").unwrap_or("en").trim().to_ascii_lowercase().as_str() {
        "he" | "he-il" | "he_il" | "hebrew" | "ivrit" | "iw" => "he",
        _ => "en",
    };
    VoicePreferences {
        refine_mode: one_of(text("refineMode"), &["off", "clipboard", "dictation", "both"], "off"),
        refine_provider: trimmed_or("refineProvider", "codex").to_ascii_lowercase(),
        refine_model: trimmed_or("refineModel", "gpt-5.3-codex-spark").to_string(),
        refine_effort: one_of(Some(&refine_effort), &["low", "medium", "high", "xhigh", "minimal"], "low"),
        refine_press_enter: flag("refinePressEnter"),
        refine_send_to: one_of(text("refineSendTo"), &["caret", "cmux-new", "cmux-resume"], "caret"),
        refine_cmux_command: text("refineCmuxCommand").unwrap_or("").to_string(),
        refine_cmux_press_enter: flag("refineCmuxPressEnter"),
        narration_mode: one_of(text("speechMode"), &["auto", "immediate", "off"], "auto"),
        speech_voice: if is_supertonic_voice(voice) { voice.to_ascii_uppercase() } else { "F4".into() },
        speech_speed: (words_per_minute / 200.0).clamp(0.7, 2.0),
        dictation_replacements: text("dictationReplacements").unwrap_or("").to_string(),
        dictation_keep_listening_ms: values
            .get("dictationKeepListeningSeconds")
            .and_then(Value::as_f64)
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
            .map(|seconds| (seconds * 1000.0).round() as u64)
            .unwrap_or(200)
            .min(2000),
        dictation_language: dictation_language.to_string(),
    }
}

/// Supertonic voice ids: F1–F5 and M1–M5 (either case).
fn is_supertonic_voice(voice: &str) -> bool {
    let bytes = voice.as_bytes();
    bytes.len() == 2 && matches!(bytes[0].to_ascii_uppercase(), b'M' | b'F') && matches!(bytes[1], b'1'..=b'5')
}

fn parse_dictation_replacements(replacement_text: &str) -> HashMap<String, String> {
    replacement_text
        .split(';')
        .filter_map(|entry| entry.split_once('='))
        .map(|(heard, written)| (heard.trim(), written.trim()))
        .filter(|(heard, written)| !heard.is_empty() && !written.is_empty())
        .map(|(heard, written)| (heard.to_string(), written.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replacements() {
        let map = parse_dictation_replacements(" Joseph = Yosef ; type script = TypeScript ; broken ; =bad ; empty= ");
        assert_eq!(map.get("Joseph").map(String::as_str), Some("Yosef"));
        assert_eq!(map.get("type script").map(String::as_str), Some("TypeScript"));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn defaults_match_an_empty_config() {
        let p = VoicePreferences::default();
        assert_eq!(
            (p.refine_mode.as_str(), p.refine_provider.as_str(), p.refine_model.as_str()),
            ("off", "codex", "gpt-5.3-codex-spark")
        );
        assert_eq!((p.refine_effort.as_str(), p.refine_send_to.as_str()), ("low", "caret"));
        assert_eq!((p.narration_mode.as_str(), p.speech_voice.as_str()), ("auto", "F4"));
        assert_eq!((p.speech_speed, p.dictation_keep_listening_ms), (1.15, 200));
        assert_eq!(p.dictation_language, "en");
    }

    #[test]
    fn falls_back_on_unknown_values() {
        let p = preferences_from(&serde_json::json!({
            "speechMode": "loud",
            "refineMode": "always",
            "refineEffort": " HIGH ",
            "refineProvider": " Grok ",
            "speechVoice": "m3",
            "dictationLanguage": "Hebrew",
            "dictationKeepListeningSeconds": 9,
        }));
        assert_eq!((p.narration_mode.as_str(), p.refine_mode.as_str()), ("auto", "off"));
        assert_eq!((p.refine_effort.as_str(), p.refine_provider.as_str()), ("high", "grok"));
        assert_eq!((p.speech_voice.as_str(), p.dictation_language.as_str()), ("M3", "he"));
        assert_eq!(p.dictation_keep_listening_ms, 2000);
    }

    #[test]
    fn mode_helpers() {
        let with = |narration: &str, refine: &str| {
            preferences_from(&serde_json::json!({ "speechMode": narration, "refineMode": refine }))
        };
        let cases = [
            ("auto", "off", true, false, false),
            ("off", "dictation", false, true, false),
            ("auto", "both", true, true, true),
            ("immediate", "clipboard", true, false, true),
        ];
        for (narration, refine, narrates, stt, review) in cases {
            let p = with(narration, refine);
            assert_eq!(
                (p.narration_enabled(), p.stt_refine_enabled(), p.review_refine_enabled()),
                (narrates, stt, review),
                "{narration} {refine}"
            );
        }
    }
}
