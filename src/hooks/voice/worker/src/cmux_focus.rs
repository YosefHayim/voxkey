//! Which Cmux surface is in front of the user, asked over the socket a Cmux reply records.

use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum CmuxFocus {
    /// This `workspace:surface` is focused and Cmux is the frontmost app.
    Surface(String),
    /// Cmux is running but another app is in front, or no surface is focused.
    Away,
    /// Cmux did not answer (closed, or its socket asks for a password).
    Unknown,
}

pub fn cmux_focus(socket_path: &str) -> CmuxFocus {
    match (rpc(socket_path, "window.list"), rpc(socket_path, "system.identify")) {
        (Some(windows), Some(identity)) => focus_from(&windows, &identity),
        _ => CmuxFocus::Unknown,
    }
}

/// A Cmux window is `key` only while Cmux is the frontmost app.
fn focus_from(windows: &Value, identity: &Value) -> CmuxFocus {
    let frontmost = windows["windows"].as_array().is_some_and(|all| all.iter().any(|window| window["key"] == true));
    let focused = |key: &str| identity["focused"][key].as_str().filter(|id| !id.is_empty());
    match (frontmost, focused("workspace_id"), focused("surface_id")) {
        (true, Some(workspace), Some(surface)) => CmuxFocus::Surface(format!("{workspace}:{surface}")),
        _ => CmuxFocus::Away,
    }
}

/// One JSON-lines request on the Cmux socket; the `result` of an `ok` reply.
#[cfg(unix)]
fn rpc(socket_path: &str, method: &str) -> Option<Value> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let mut stream = UnixStream::connect(socket_path).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(500))).ok()?;
    writeln!(stream, r#"{{"id":"dufflebag-voice","method":"{method}","params":{{}}}}"#).ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    let reply: Value = serde_json::from_str(&line).ok()?;
    (reply["ok"] == true).then(|| reply["result"].clone())
}

// Cmux is a macOS app, so no reply from another platform carries a Cmux origin.
#[cfg(not(unix))]
fn rpc(_socket_path: &str, _method: &str) -> Option<Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn focused_surface_counts_only_while_cmux_is_in_front() {
        let identity = json!({"focused": {"workspace_id": "W1", "surface_id": "S1"}});
        let front = json!({"windows": [{"key": false}, {"key": true}]});
        let behind = json!({"windows": [{"key": false}]});
        assert_eq!(focus_from(&front, &identity), CmuxFocus::Surface("W1:S1".into()));
        assert_eq!(focus_from(&behind, &identity), CmuxFocus::Away);
        assert_eq!(focus_from(&front, &json!({"focused": null})), CmuxFocus::Away);
    }

    #[test]
    fn a_missing_socket_is_unknown() {
        assert_eq!(cmux_focus("/nonexistent/cmux.sock"), CmuxFocus::Unknown);
    }
}
