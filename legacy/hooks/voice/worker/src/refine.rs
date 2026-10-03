//! Route-aware prompt refinement through `refine_prompt.py` (multi-provider).

use crate::config::VoicePreferences;
use crate::state_home::script_beside_worker;
use std::process::Command;

pub fn refine_with_prefs(text: &str, prefs: &VoicePreferences) -> Result<String, String> {
    refine_prompt(text, &prefs.refine_provider, &prefs.refine_model, &prefs.refine_effort)
}

/// Run `refine_prompt.py` once and return its stdout. It rotates Codex models itself when
/// the preferred id is missing or not allowed for the signed-in account.
pub fn refine_prompt(text: &str, backend: &str, model: &str, reasoning_effort: &str) -> Result<String, String> {
    let script = script_beside_worker("refine_prompt.py")?;
    let script = script.to_str().ok_or_else(|| "refine_prompt path not utf-8".to_string())?;
    let backend = if backend.is_empty() { "codex" } else { backend };
    let model = if model.is_empty() { "gpt-5.3-codex-spark" } else { model };
    // -B: refine_prompt.py imports its sibling modules, and a __pycache__ folder beside
    // the installed script would be a file no receipt owns.
    let mut args = vec!["-B", script, "--backend", backend, "--model", model, "--text", text];
    if !reasoning_effort.is_empty() {
        args.extend(["--reasoning-effort", reasoning_effort]);
    }
    // local/auto may use Apple Foundation Models, which needs apple-fm-sdk through uv.
    let output = if matches!(backend, "local" | "auto") {
        Command::new("uv")
            .args(["run", "--with", "apple-fm-sdk==0.2.1", "python"])
            .args(&args)
            .output()
            .map_err(|e| format!("spawn refinement (uv): {e}"))?
    } else {
        Command::new(python_command()).args(&args).output().map_err(|e| format!("spawn refinement: {e}"))?
    };
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err([stderr, stdout]
        .into_iter()
        .find(|message| !message.is_empty())
        .unwrap_or_else(|| "prompt refinement failed".into()))
}

fn python_command() -> &'static str {
    let has_python3 = Command::new("python3").arg("--version").output().is_ok_and(|output| output.status.success());
    if has_python3 {
        "python3"
    } else {
        "python"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_script_in_source_tree() {
        let path = script_beside_worker("refine_prompt.py");
        assert!(path.as_ref().is_ok_and(|path| path.is_file()), "{path:?}");
    }
}
