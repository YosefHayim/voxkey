//! Warm Supertonic TTS via long-lived `text_to_speech.py serve` (streamed chunks).

use crate::config::voice_preferences;
use crate::markdown_to_speech::markdown_to_speech;
use crate::state_home::{ensure_state_home, script_beside_worker, voice_state_home};
use crate::worker_processes::{
    force_kill_process_group, kill_stray_tts_servers, read_pid_file, remove_state_file, write_pid_file, TTS_PID,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static NARRATING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

struct TtsServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    pid: u32,
}

static WARM: Mutex<Option<TtsServer>> = Mutex::new(None);

/// `prepare`: warm the long-lived server; returns the voice it loaded.
pub fn prepare_tts() -> Result<String, String> {
    let prefs = voice_preferences();
    start_tts_server(&prefs.speech_voice)?;
    Ok(prefs.speech_voice)
}

pub fn narration_busy() -> bool {
    NARRATING.load(Ordering::SeqCst)
}

/// Soft cancel: ask the warm server to stop playback (keeps process warm). True if it was speaking.
pub fn cancel_narration() -> bool {
    let was = NARRATING.swap(false, Ordering::SeqCst);
    CANCEL.store(true, Ordering::SeqCst);
    let _ = send_raw(r#"{"cmd":"stop"}"#);
    let _ = std::fs::write(voice_state_home().join("tts-stop"), b"");
    was
}

/// Kill the TTS server's process group from its pid file (the CLI has no WARM handle of its own).
fn kill_recorded_tts_server() {
    if let Some(pid) = read_pid_file(TTS_PID) {
        force_kill_process_group(pid);
    }
    stop_tts_server();
}

/// Hard cancel (double-tap Shift): stop + kill the audio process group + rewarm in the background.
pub fn hard_cancel_narration() -> bool {
    let was = cancel_narration();
    kill_recorded_tts_server();
    let voice = voice_preferences().speech_voice;
    thread::spawn(move || {
        let _ = start_tts_server(&voice);
    });
    was
}

/// Tear down TTS completely (CLI stop/reset). Never rewarms.
pub fn kill_tts_process() {
    cancel_narration();
    kill_recorded_tts_server();
    kill_stray_tts_servers();
}

fn send_raw(line: &str) -> Result<(), String> {
    let mut guard = WARM.lock();
    let server = guard.as_mut().ok_or_else(|| "tts server not running".to_string())?;
    writeln!(server.stdin, "{line}").map_err(|e| format!("tts write: {e}"))?;
    server.stdin.flush().map_err(|e| format!("tts flush: {e}"))?;
    Ok(())
}

/// Next JSON event line from the server, skipping blank and non-JSON lines.
fn read_event(server: &mut TtsServer, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            return Err("tts event timeout".into());
        }
        // Blocking readline — serve always emits promptly between chunks.
        let mut line = String::new();
        let n = server.stdout.read_line(&mut line).map_err(|e| format!("tts read: {e}"))?;
        if n == 0 {
            return Err("tts server closed".into());
        }
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            return Ok(value);
        }
    }
}

fn event_name(event: &Value) -> Option<&str> {
    event.get("event").and_then(|v| v.as_str())
}

/// Start (or reuse) the long-lived Supertonic server.
pub fn start_tts_server(voice: &str) -> Result<(), String> {
    ensure_state_home().map_err(|e| e.to_string())?;
    {
        let mut guard = WARM.lock();
        if let Some(server) = guard.as_mut() {
            let alive = writeln!(server.stdin, r#"{{"cmd":"ping"}}"#).is_ok()
                && server.stdin.flush().is_ok()
                && read_event(server, Duration::from_secs(3)).is_ok_and(|event| event_name(&event) == Some("pong"));
            if alive {
                return Ok(());
            }
        }
        // Dead — drop and respawn.
        if let Some(mut dead) = guard.take() {
            let _ = dead.child.kill();
            let _ = dead.child.wait();
            remove_state_file(TTS_PID);
        }
    }

    let script = script_beside_worker("text_to_speech.py")?;
    let mut command = Command::new("uv");
    command
        .args(["run", "--script", script.to_str().unwrap_or_default(), "serve", "--voice", voice])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("spawn tts serve: {e}"))?;
    let pid = child.id();
    let _ = write_pid_file(TTS_PID, pid);
    let stdin = child.stdin.take().ok_or_else(|| "tts stdin missing".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "tts stdout missing".to_string())?;
    let mut server = TtsServer { child, stdin, stdout: BufReader::new(stdout), pid };

    // Wait for ready (model load can take a while first time).
    let ready = read_event(&mut server, Duration::from_secs(180))?;
    if event_name(&ready) != Some("ready") {
        let _ = server.child.kill();
        remove_state_file(TTS_PID);
        return Err(format!("tts serve not ready: {ready}"));
    }
    *WARM.lock() = Some(server);
    Ok(())
}

pub fn stop_tts_server() {
    if let Some(mut server) = WARM.lock().take() {
        let _ = writeln!(server.stdin, r#"{{"cmd":"quit"}}"#);
        let _ = server.stdin.flush();
        let _ = server.child.wait();
        force_kill_process_group(server.pid);
    }
    remove_state_file(TTS_PID);
}

pub fn speak_markdown(markdown: &str) -> Result<String, String> {
    let speech = markdown_to_speech(markdown);
    if speech.trim().is_empty() {
        return Ok("completed".into());
    }
    if NARRATING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Ok("busy".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let prefs = voice_preferences();
    let result = (|| {
        start_tts_server(&prefs.speech_voice)?;
        let payload = serde_json::json!({
            "cmd": "speak",
            "text": speech,
            "voice": prefs.speech_voice,
            "speed": prefs.speech_speed,
        });
        send_raw(&payload.to_string())?;
        // Drain streamed events until done.
        let deadline = Instant::now() + Duration::from_secs(60 * 30);
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                return Ok("stopped".into());
            }
            if Instant::now() > deadline {
                return Err("tts speak timed out".into());
            }
            let event = {
                let mut guard = WARM.lock();
                let server = guard.as_mut().ok_or_else(|| "tts server died mid-speak".to_string())?;
                read_event(server, Duration::from_secs(120))?
            };
            let field = |key: &str| event.get(key).and_then(|v| v.as_str()).map(str::to_string);
            // Anything else ("chunk" progress) keeps draining.
            match event_name(&event) {
                Some("done") => return Ok(field("status").unwrap_or_else(|| "completed".into())),
                Some("error") => return Err(field("message").unwrap_or_else(|| "tts error".into())),
                _ => {}
            }
        }
    })();
    NARRATING.store(false, Ordering::SeqCst);
    let _ = std::fs::remove_file(voice_state_home().join("speaking.lock"));
    result
}
