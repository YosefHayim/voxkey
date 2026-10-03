//! Narration inbox: JSON replies queued by the Stop hook (and `watch-devin`), claimed one at a time.

use crate::cmux_focus::{cmux_focus, CmuxFocus};
use crate::config::VoicePreferences;
use crate::narration_mute::narration_muted;
use crate::state_home::{atomic_json, now_secs, voice_state_home};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const PENDING_NARRATION_TTL_SECONDS: f64 = 60.0 * 60.0;
const SEEN_NARRATION_TTL_SECONDS: f64 = 24.0 * 60.0 * 60.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedReply {
    pub markdown: String,
    #[serde(default)]
    pub origin: Value,
    #[serde(default)]
    pub received_at: f64,
    #[serde(default)]
    pub agent_reply_id: String,
    #[serde(default)]
    pub source: String,
}

fn inbox_dir() -> PathBuf {
    voice_state_home().join("inbox")
}

/// Delete inbox files with these extensions (`json` = queued, `speaking` = claimed).
pub fn remove_inbox_files(extensions: &[&str]) {
    let Ok(entries) = fs::read_dir(inbox_dir()) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if extensions.contains(&extension) {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn enqueue_narration(markdown: &str, source: &str, agent_reply_id: &str) -> std::io::Result<()> {
    let queued_reply = QueuedReply {
        markdown: markdown.to_string(),
        origin: serde_json::json!({"kind": "terminal"}),
        received_at: now_secs(),
        agent_reply_id: agent_reply_id.to_string(),
        source: source.to_string(),
    };
    // Drop duplicates before they ever reach the speaker.
    if seen_narration_keys().contains_key(&reply_identity(&queued_reply)) {
        return Ok(());
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let name = format!("{nanos}-{}.json", uuid::Uuid::new_v4().simple());
    atomic_json(&inbox_dir().join(name), &queued_reply)
}

/// `workspace:surface` for a Cmux reply, empty otherwise.
fn surface_identity(queued_reply: &QueuedReply) -> String {
    let origin = &queued_reply.origin;
    if origin.get("kind").and_then(Value::as_str) != Some("cmux") {
        return String::new();
    }
    let field = |key: &str| origin.get(key).and_then(Value::as_str).unwrap_or("");
    let (workspace, surface) = (field("workspace_id"), field("surface_id"));
    if workspace.is_empty() || surface.is_empty() {
        String::new()
    } else {
        format!("{workspace}:{surface}")
    }
}

/// Stable FNV-1a over markdown bytes (DefaultHasher is re-seeded per process — never use for seen keys).
/// The Stop hook computes the same token.
fn stable_content_token(markdown: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in markdown.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}:{}", markdown.len())
}

/// `source:surface` of a reply (`terminal` when it has no Cmux surface).
fn reply_place(queued_reply: &QueuedReply) -> String {
    let source = if queued_reply.source.is_empty() { "unknown" } else { &queued_reply.source };
    let surface = surface_identity(queued_reply);
    let surface = if surface.is_empty() { "terminal" } else { &surface };
    format!("{source}:{surface}")
}

/// The same text from the same place is one reply, whatever its id.
fn content_identity(queued_reply: &QueuedReply) -> String {
    format!("{}:{}", reply_place(queued_reply), stable_content_token(&queued_reply.markdown))
}

/// Content-based so the same reply is never spoken twice, even when hooks fire without a
/// stable response id or the worker restarts; the reply id is added when present.
fn reply_identity(queued_reply: &QueuedReply) -> String {
    let reply = queued_reply.agent_reply_id.trim();
    if reply.is_empty() {
        return content_identity(queued_reply);
    }
    let token = stable_content_token(&queued_reply.markdown);
    format!("{}:{reply}:{token}", reply_place(queued_reply))
}

fn seen_narration_keys() -> HashMap<String, f64> {
    let Ok(bytes) = fs::read(voice_state_home().join("seen.json")) else {
        return HashMap::new();
    };
    let Ok(document) = serde_json::from_slice::<HashMap<String, Value>>(&bytes) else {
        return HashMap::new();
    };
    let now = now_secs();
    document
        .into_iter()
        .filter_map(|(key, value)| {
            let stamp = value.as_f64()?;
            (now - stamp <= SEEN_NARRATION_TTL_SECONDS).then_some((key, stamp))
        })
        .collect()
}

fn already_spoken(seen: &HashMap<String, f64>, queued_reply: &QueuedReply) -> bool {
    seen.contains_key(&reply_identity(queued_reply)) || seen.contains_key(&content_identity(queued_reply))
}

/// Remember both keys, so a later hook with a different reply id cannot re-speak the text.
fn remember_spoken(queued_reply: &QueuedReply) {
    let mut seen = seen_narration_keys();
    seen.insert(reply_identity(queued_reply), now_secs());
    seen.insert(content_identity(queued_reply), now_secs());
    let _ = atomic_json(&voice_state_home().join("seen.json"), &seen);
}

/// `immediate` speaks every reply at once. `auto` holds a Cmux reply until its surface is in
/// front of the user, and speaks it when Cmux cannot be asked so it is not stuck until it expires.
fn speaks_now(mode: &str, surface: &str, focus: impl FnOnce() -> CmuxFocus) -> bool {
    if mode == "immediate" || surface.is_empty() {
        return true;
    }
    match focus() {
        CmuxFocus::Surface(focused) => focused == surface,
        CmuxFocus::Away => false,
        CmuxFocus::Unknown => true,
    }
}

/// Readable, non-empty, unexpired queued replies (oldest first); anything else is deleted.
fn pending_replies() -> Vec<(PathBuf, QueuedReply)> {
    let inbox = inbox_dir();
    let _ = fs::create_dir_all(&inbox);
    let Ok(entries) = fs::read_dir(&inbox) else {
        return Vec::new();
    };
    // Only `.json`: skips in-flight `.speaking` claims and temp files.
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            let reply = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<QueuedReply>(&bytes).ok())
                .filter(|reply| !reply.markdown.trim().is_empty())
                .filter(|reply| {
                    reply.received_at <= 0.0 || now_secs() - reply.received_at <= PENDING_NARRATION_TTL_SECONDS
                });
            if reply.is_none() {
                let _ = fs::remove_file(&path);
            }
            Some((path, reply?))
        })
        .collect()
}

/// Claim the next reply to speak by renaming it to `.speaking` so it cannot be picked twice.
/// Older replies with the same identity or from the same Cmux surface are superseded, and a
/// reply still waiting for its Cmux surface stays queued.
pub fn next_queued_reply(preferences: &VoicePreferences) -> Option<(PathBuf, QueuedReply)> {
    let pending = pending_replies();
    if preferences.narration_mode == "off" {
        for (path, _) in &pending {
            let _ = fs::remove_file(path);
        }
        return None;
    }
    let newest_identity: HashMap<String, PathBuf> =
        pending.iter().map(|(path, reply)| (reply_identity(reply), path.clone())).collect();
    let newest_surface: HashMap<String, PathBuf> = pending
        .iter()
        .map(|(path, reply)| (surface_identity(reply), path.clone()))
        .filter(|(surface, _)| !surface.is_empty())
        .collect();
    let seen = seen_narration_keys();
    for (path, reply) in pending {
        let surface = surface_identity(&reply);
        let superseded = newest_identity.get(&reply_identity(&reply)) != Some(&path)
            || (!surface.is_empty() && newest_surface.get(&surface) != Some(&path));
        if superseded || already_spoken(&seen, &reply) {
            let _ = fs::remove_file(&path);
            continue;
        }
        let socket_path = reply.origin.get("socket_path").and_then(Value::as_str).unwrap_or("");
        if narration_muted() || !speaks_now(&preferences.narration_mode, &surface, || cmux_focus(socket_path)) {
            continue;
        }
        // Claim before speaking so a crash mid-playback cannot re-queue forever.
        let claimed = path.with_extension("speaking");
        if fs::rename(&path, &claimed).is_err() {
            continue;
        }
        // Mark seen *before* playback so a restart during TTS won't replay it.
        remember_spoken(&reply);
        return Some((claimed, reply));
    }
    None
}

pub fn complete_queued_reply(path: &Path) {
    let _ = fs::remove_file(path);
}

pub fn fail_queued_reply(path: &Path) {
    let failed = voice_state_home().join("failed");
    let _ = fs::create_dir_all(&failed);
    match path.file_name() {
        Some(name) => {
            let _ = fs::rename(path, failed.join(name));
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(agent_reply_id: &str) -> QueuedReply {
        QueuedReply {
            markdown: "Same reply".into(),
            origin: serde_json::json!({"kind": "terminal"}),
            received_at: 0.0,
            agent_reply_id: agent_reply_id.into(),
            source: "claude-code".into(),
        }
    }

    #[test]
    fn content_token_is_stable() {
        assert_eq!(stable_content_token("hello world"), stable_content_token("hello world"));
        assert_ne!(stable_content_token("hello world"), stable_content_token("hello world!"));
    }

    #[test]
    fn auto_holds_a_cmux_reply_until_its_surface_is_in_front() {
        let cases = [
            (CmuxFocus::Surface("W1:S1".into()), true),
            (CmuxFocus::Surface("W1:S2".into()), false),
            (CmuxFocus::Away, false),
            (CmuxFocus::Unknown, true),
        ];
        for (focus, speaks) in cases {
            let label = format!("{focus:?}");
            assert_eq!(speaks_now("auto", "W1:S1", || focus), speaks, "{label}");
        }
    }

    #[test]
    fn immediate_and_terminal_replies_speak_without_asking_cmux() {
        let never_asked = || -> CmuxFocus { panic!("Cmux focus was asked") };
        assert!(speaks_now("immediate", "W1:S1", never_asked));
        assert!(speaks_now("auto", "", never_asked));
    }

    #[test]
    fn cmux_replies_are_keyed_by_workspace_and_surface() {
        let mut cmux = reply("");
        cmux.origin = serde_json::json!({"kind": "cmux", "workspace_id": "W1", "surface_id": "S1"});
        assert_eq!(surface_identity(&cmux), "W1:S1");
        assert_eq!(surface_identity(&reply("")), "");
    }

    #[test]
    fn reply_ids_split_identity_but_share_the_content_key() {
        let (plain, with_id) = (reply(""), reply("different-id"));
        assert_ne!(reply_identity(&plain), reply_identity(&with_id));
        assert_eq!(content_identity(&plain), content_identity(&with_id));
        assert_eq!(reply_identity(&plain), content_identity(&plain));
        let token = stable_content_token("Same reply");
        assert_eq!(reply_identity(&with_id), format!("claude-code:terminal:different-id:{token}"));
    }
}
