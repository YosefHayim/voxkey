//! Narration worker: inbox → TTS in its own process, off the dictation critical path.

use crate::config::voice_preferences;
use crate::inbox::{complete_queued_reply, fail_queued_reply, next_queued_reply, remove_inbox_files};
use crate::narration_mute::narration_muted;
use crate::state_home::ensure_state_home;
use crate::tts;
use crate::worker_processes::{
    claim_pid_lock, process_running, read_pid_file, release_pid_lock, remove_state_file, spawn_worker_process,
    stop_requested, terminate_pid, NARRATION_LOCK, NARRATION_PID,
};
use crate::worker_status::read_saved_status;
use std::thread;
use std::time::{Duration, Instant};

pub fn narration_worker_running() -> bool {
    process_running(read_pid_file(NARRATION_PID))
}

/// Long-lived inbox → TTS loop. Does not own the hotkey or mic.
pub fn run_narration_worker() -> i32 {
    if let Err(error) = ensure_state_home() {
        eprintln!("narration state: {error}");
        return 1;
    }
    match claim_pid_lock(NARRATION_PID, NARRATION_LOCK, std::process::id()) {
        Ok(true) => {}
        Ok(false) => return 0,
        Err(error) => {
            eprintln!("narration pid: {error}");
            return 1;
        }
    }
    // Drop stale claims from a previous crash.
    remove_inbox_files(&["speaking"]);

    let prefs = voice_preferences();
    if !prefs.narration_enabled() {
        // STT-only: do not warm Supertonic or hold a narration process.
        remove_inbox_files(&["json", "speaking"]);
        release_pid_lock(NARRATION_PID, NARRATION_LOCK);
        return 0;
    }
    if let Err(error) = tts::start_tts_server(&prefs.speech_voice) {
        eprintln!("tts warm: {error}");
    }

    while !stop_requested() {
        let prefs = voice_preferences();
        if !prefs.narration_enabled() {
            tts::stop_tts_server();
            remove_inbox_files(&["json", "speaking"]);
            break;
        }
        if dictation_owns_audio() || tts::narration_busy() {
            thread::sleep(Duration::from_millis(80));
            continue;
        }
        if narration_muted() {
            thread::sleep(Duration::from_millis(200));
            continue;
        }
        let Some((path, queued_reply)) = next_queued_reply(&prefs) else {
            thread::sleep(Duration::from_millis(150));
            continue;
        };
        match tts::speak_markdown(&queued_reply.markdown) {
            Ok(_) => complete_queued_reply(&path),
            Err(error) => {
                eprintln!("narration failed: {error}");
                fail_queued_reply(&path);
            }
        }
    }

    tts::stop_tts_server();
    release_pid_lock(NARRATION_PID, NARRATION_LOCK);
    0
}

/// status.json says starting/listening: the mic is open, so narration waits.
fn dictation_owns_audio() -> bool {
    read_saved_status().is_some_and(|status| {
        matches!(status.get("dictation").and_then(|v| v.as_str()), Some("starting" | "listening"))
    })
}

pub fn start_narration_worker_detached() -> Result<(), String> {
    ensure_state_home().map_err(|e| e.to_string())?;
    if !voice_preferences().narration_enabled() {
        stop_narration_worker();
        return Ok(());
    }
    if narration_worker_running() {
        return Ok(());
    }
    spawn_worker_process(&["narration-worker"]).map_err(|e| format!("spawn narration worker: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if narration_worker_running() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    // Soft fail — dictation still works without TTS.
    eprintln!("narration worker did not report ready (continuing without narration)");
    Ok(())
}

pub fn stop_narration_worker() {
    tts::kill_tts_process();
    if let Some(pid) = read_pid_file(NARRATION_PID) {
        terminate_pid(pid, Duration::from_millis(80));
    }
    remove_state_file(NARRATION_PID);
    remove_state_file(NARRATION_LOCK);
    remove_inbox_files(&["json", "speaking"]);
}
