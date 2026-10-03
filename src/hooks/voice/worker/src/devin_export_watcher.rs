//! `watch-devin`: queue each finished Devin turn from an ATIF export for narration.

use crate::inbox::enqueue_narration;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DevinNarration {
    markdown: String,
    turn_id: String,
}

/// Agent messages after the latest user step, joined; `turn_id` is the last agent step's id.
fn select_devin_narration(document: &Value) -> DevinNarration {
    let Some(steps) = document.get("steps").and_then(|v| v.as_array()) else {
        return DevinNarration::default();
    };
    let start = steps
        .iter()
        .rposition(|step| step.get("source").and_then(|v| v.as_str()) == Some("user"))
        .map_or(0, |index| index + 1);
    let mut messages = Vec::new();
    let mut turn_id = String::new();
    for step in &steps[start..] {
        if step.get("source").and_then(|v| v.as_str()) != Some("agent") {
            continue;
        }
        let Some(message) = step.get("message").and_then(|v| v.as_str()) else {
            continue;
        };
        let message = message.trim();
        if message.is_empty() {
            continue;
        }
        messages.push(message.to_string());
        if let Some(id) = step.get("step_id").and_then(|v| v.as_str()) {
            turn_id = id.to_string();
        }
    }
    DevinNarration { markdown: messages.join("\n\n"), turn_id }
}

fn read_devin_narration(path: &Path) -> DevinNarration {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|document| select_devin_narration(&document))
        .unwrap_or_default()
}

/// Debounce: a turn is queued only once its id has been stable for 800 ms.
pub fn watch_devin(path: &Path) -> i32 {
    if let Err(error) = crate::dictation_worker::start_worker_detached() {
        eprintln!("start worker: {error}");
        return 1;
    }
    let mut seen_turn_id = read_devin_narration(path).turn_id;
    let mut last_change = Instant::now();
    let mut pending_turn_id = String::new();

    loop {
        let turn_id = read_devin_narration(path).turn_id;
        if !turn_id.is_empty() && turn_id != seen_turn_id && turn_id != pending_turn_id {
            pending_turn_id = turn_id;
            last_change = Instant::now();
        }
        if !pending_turn_id.is_empty() && last_change.elapsed() >= Duration::from_millis(800) {
            let confirmed = read_devin_narration(path);
            if confirmed.turn_id == pending_turn_id && !confirmed.markdown.is_empty() {
                if let Err(error) = enqueue_narration(&confirmed.markdown, "devin", &confirmed.turn_id) {
                    eprintln!("enqueue: {error}");
                }
                seen_turn_id = confirmed.turn_id;
            }
            pending_turn_id.clear();
        }
        thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn joins_agent_messages_after_latest_user() {
        let document = json!({
            "steps": [
                {"step_id": "old-user", "source": "user", "message": "Earlier request"},
                {"step_id": "old-agent", "source": "agent", "message": "Earlier answer"},
                {"step_id": "new-user", "source": "user", "message": "Current request"},
                {"step_id": "new-agent-1", "source": "agent", "message": "First part"},
                {"step_id": "new-agent-2", "source": "agent", "message": "Second part"}
            ]
        });
        let selected = select_devin_narration(&document);
        assert_eq!(selected.markdown, "First part\n\nSecond part");
        assert_eq!(selected.turn_id, "new-agent-2");
    }
}
