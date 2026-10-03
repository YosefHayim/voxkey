//! Deliver refined prompts into cmux: a new focused workspace or the focused (resumable) surface.

use crate::config::VoicePreferences;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn is_cmux_delivery(delivery: &str) -> bool {
    matches!(delivery, "cmux-new" | "cmux-resume")
}

/// Deliver `text` per `refineSendTo`; returns a one-line summary for logs.
pub fn deliver_text(text: &str, prefs: &VoicePreferences) -> Result<String, String> {
    let clean = text.trim();
    if clean.is_empty() {
        return Ok("empty".into());
    }
    match prefs.refine_send_to.as_str() {
        "cmux-new" => deliver_cmux_new(clean, &prefs.refine_cmux_command, prefs.refine_cmux_press_enter),
        "cmux-resume" => deliver_cmux_resume(clean, prefs.refine_cmux_press_enter),
        _ => Err("caret delivery is handled by the typing path".into()),
    }
}

fn deliver_cmux_new(text: &str, command_template: &str, auto_submit: bool) -> Result<String, String> {
    let cwd = resolve_cwd();
    let name = short_title(text);
    let prompt_file = write_prompt_file(text)?;
    let mut args = vec!["workspace", "create", "--name", &name, "--cwd", &cwd, "--focus", "true"];

    if !command_template.trim().is_empty() {
        let command = expand_template(command_template, text, &prompt_file, &cwd)?;
        args.extend(["--command", &command, "--json"]);
        let meta = cmux_json(&args, "workspace create")?;
        let workspace = first_string(&meta, &["workspace_ref", "workspace_id"]).unwrap_or("?");
        return Ok(format!("cmux-new run workspace={workspace} command={}", truncate(&command, 80)));
    }

    // Paste-only: new focused workspace, inject text, optional Enter.
    args.push("--json");
    let meta = cmux_json(&args, "workspace create")?;
    let surface = first_string(&meta, &["surface_id", "surface_ref"])
        .ok_or_else(|| "cmux workspace create returned no surface id".to_string())?;
    let workspace = first_string(&meta, &["workspace_id", "workspace_ref"]).filter(|id| !id.is_empty()).unwrap_or("?");
    // Brief settle so the new PTY is ready for input.
    std::thread::sleep(std::time::Duration::from_millis(350));
    send_text_to_surface(surface, text, auto_submit)?;
    Ok(format!("cmux-new paste workspace={workspace} surface={surface} auto_submit={auto_submit}"))
}

fn deliver_cmux_resume(text: &str, auto_submit: bool) -> Result<String, String> {
    let focus = cmux_identify()?;
    let surface = first_string(&focus, &["surface_id", "surface_ref"])
        .ok_or_else(|| "cmux identify: no focused surface".to_string())?
        .to_string();
    let workspace = first_string(&focus, &["workspace_ref", "workspace_id"]).unwrap_or("?");

    // A resume binding names the agent session on that surface (reported only).
    let resume = rpc("surface.resume.get", &surface_params(&surface, &[])).ok();
    let binding = |key: &str| {
        resume
            .as_ref()
            .and_then(|value| value.pointer(&format!("/resume_binding/{key}")))
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    let (agent, session) = (binding("kind"), binding("checkpoint_id"));

    send_text_to_surface(&surface, text, auto_submit)?;
    Ok(if agent.is_empty() {
        format!("cmux-resume surface={surface} workspace={workspace} auto_submit={auto_submit}")
    } else {
        format!(
            "cmux-resume surface={surface} workspace={workspace} agent={agent} session={session} auto_submit={auto_submit}"
        )
    })
}

/// cmux addresses a surface by `surface_ref` (`surface:N`) or by `surface_id` (UUID).
fn surface_params(surface: &str, fields: &[(&str, &str)]) -> Value {
    let key = if surface.starts_with("surface:") { "surface_ref" } else { "surface_id" };
    let mut params = serde_json::Map::new();
    params.insert(key.into(), surface.into());
    for (name, value) in fields {
        params.insert((*name).into(), (*value).into());
    }
    Value::Object(params)
}

fn send_text_to_surface(surface: &str, text: &str, auto_submit: bool) -> Result<(), String> {
    rpc("surface.send_text", &surface_params(surface, &[("text", text)]))?;
    // Best-effort Enter: some cmux builds want "return" instead of "enter".
    if auto_submit && rpc("surface.send_key", &surface_params(surface, &[("key", "enter")])).is_err() {
        let _ = rpc("surface.send_key", &surface_params(surface, &[("key", "return")]));
    }
    Ok(())
}

/// The focused (else calling) surface from `cmux identify`.
fn cmux_identify() -> Result<Value, String> {
    let value = cmux_json(&["identify", "--json", "--id-format", "both"], "identify")?;
    Ok(value.get("focused").or_else(|| value.get("caller")).cloned().unwrap_or(value))
}

fn rpc(method: &str, params: &Value) -> Result<Value, String> {
    let params_text = serde_json::to_string(params).map_err(|e| e.to_string())?;
    cmux_json(&["rpc", method, &params_text], &format!("rpc {method}"))
}

/// Run cmux and parse its JSON reply (the last JSON object, since cmux may print notices first).
fn cmux_json(args: &[&str], label: &str) -> Result<Value, String> {
    let output = cmux_cmd().args(args).output().map_err(|e| format!("cmux {label}: {e}"))?;
    if !output.status.success() {
        return Err(format_cmux_err(label, &output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Ok(value);
    }
    Ok(text
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .unwrap_or(Value::Null))
}

fn cmux_cmd() -> Command {
    let mut cmd = Command::new(cmux_bin());
    cmd.env("CMUX_QUIET", "1");
    cmd
}

fn cmux_bin() -> PathBuf {
    let on_path = Command::new("which")
        .arg("cmux")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(path) = on_path {
        return PathBuf::from(path);
    }
    ["/Applications/cmux.app/Contents/Resources/bin/cmux", "/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("cmux"))
}

/// The focused workspace's directory, else the first workspace's, else this process's.
fn resolve_cwd() -> String {
    focused_workspace_cwd().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_else(|_| "/".into()))
    })
}

fn focused_workspace_cwd() -> Option<String> {
    let output = cmux_cmd().args(["workspace", "list", "--json"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let listing: Value = serde_json::from_slice(&output.stdout).ok()?;
    let workspaces = listing.get("workspaces")?.as_array()?;
    fn cwd(workspace: &Value) -> Option<&str> {
        workspace.get("current_directory").and_then(Value::as_str)
    }
    let first = workspaces.iter().find_map(cwd)?;
    if let Ok(focus) = cmux_identify() {
        let focus_id = first_string(&focus, &["workspace_id", "workspace_ref"]).unwrap_or("");
        let focused = workspaces.iter().find_map(|workspace| {
            let id = first_string(workspace, &["id", "workspace_id", "ref"]).unwrap_or("");
            let is_focused =
                !focus_id.is_empty() && (id == focus_id || id.ends_with(focus_id) || focus_id.ends_with(id));
            cwd(workspace).filter(|dir| is_focused && !dir.is_empty())
        });
        if let Some(dir) = focused {
            return Some(dir.to_string());
        }
    }
    (!first.is_empty()).then(|| first.to_string())
}

fn write_prompt_file(text: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("dufflebag-refine");
    fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("prompt-{stamp}.txt"));
    fs::write(&path, format!("{text}\n")).map_err(|e| format!("write prompt file: {e}"))?;
    Ok(path)
}

fn expand_template(template: &str, prompt: &str, prompt_file: &Path, cwd: &str) -> Result<String, String> {
    let file = prompt_file.to_str().ok_or_else(|| "prompt file path not utf-8".to_string())?;
    Ok(template
        .replace("{{prompt_file}}", file)
        .replace("{{prompt}}", &shell_single_quote(prompt))
        .replace("{{cwd}}", cwd))
}

/// Safe inside a single-quoted shell string: ' becomes '\''.
fn shell_single_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn short_title(text: &str) -> String {
    let one_line = text.lines().next().unwrap_or(text).trim();
    let clipped: String = one_line.chars().take(40).collect();
    if clipped.is_empty() {
        "refine".into()
    } else {
        format!("refine: {clipped}")
    }
}

/// The first of `keys` that holds a string.
fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| value.get(*key).and_then(Value::as_str))
}

fn format_cmux_err(label: &str, output: &Output) -> String {
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match [err, out].into_iter().find(|message| !message.is_empty()) {
        Some(message) => format!("cmux {label}: {message}"),
        None => format!("cmux {label} failed"),
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{clipped}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quotes_apostrophes() {
        assert_eq!(shell_single_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn expands_placeholders() {
        let out = expand_template(
            r#"cd {{cwd}} && codex --yolo -- "$(cat {{prompt_file}})" {{prompt}}"#,
            "it's",
            &PathBuf::from("/tmp/p.txt"),
            "/cwd",
        )
        .unwrap();
        assert_eq!(out, r#"cd /cwd && codex --yolo -- "$(cat /tmp/p.txt)" 'it'\''s'"#);
    }

    #[test]
    fn cmux_delivery_helpers() {
        assert!(is_cmux_delivery("cmux-new"));
        assert!(is_cmux_delivery("cmux-resume"));
        assert!(!is_cmux_delivery("caret"));
    }

    #[test]
    fn addresses_surfaces_by_ref_or_id() {
        assert_eq!(
            surface_params("surface:3", &[("key", "enter")]),
            serde_json::json!({"surface_ref": "surface:3", "key": "enter"})
        );
        assert_eq!(surface_params("ab-12", &[]), serde_json::json!({"surface_id": "ab-12"}));
    }
}
