//! Floating recording pill (macOS): one overlay process, tracked via overlay.pid.
//! The visible pill is a `swift` child; killing only the `dufflebag-voice overlay` wrapper
//! orphans it (ppid=1) and every later respawn would stack another HUD.

use crate::worker_processes::{
    force_kill_pid, force_kill_process_group, kill_all_overlay_huds, process_running, ps_rows, read_pid_file,
    remove_state_file, split_leading_pid, write_pid_file, OVERLAY_PID,
};
#[cfg(not(target_os = "macos"))]
use std::{thread, time::Duration};

/// Kill any previous HUD so the hotkey never shows stacked pills.
pub fn kill_existing_overlay() {
    if let Some(pid) = read_pid_file(OVERLAY_PID) {
        if process_running(Some(pid)) {
            force_kill_process_group(pid);
        } else {
            force_kill_pid(pid);
        }
        remove_state_file(OVERLAY_PID);
    }
    // Leftover `dufflebag-voice overlay` wrappers, then every Swift pill for this state home.
    for row in ps_rows("pid=,args=") {
        if row.contains("dufflebag-voice") && row.contains("overlay") {
            if let Some((pid, _)) = split_leading_pid(&row) {
                force_kill_process_group(pid);
            }
        }
    }
    kill_all_overlay_huds();
    remove_state_file("overlay.lock");
}

pub fn run_overlay_process(worker_pid: u32) -> i32 {
    // Single instance: exit when another overlay already serves this worker.
    if let Some(existing) = read_pid_file(OVERLAY_PID) {
        if process_running(Some(existing)) && existing != std::process::id() {
            return 0;
        }
    }
    let _ = write_pid_file(OVERLAY_PID, std::process::id());

    #[cfg(target_os = "macos")]
    let code = match macos::run(worker_pid) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("overlay: {error}");
            1
        }
    };
    #[cfg(not(target_os = "macos"))]
    let code = {
        while process_running(Some(worker_pid)) {
            thread::sleep(Duration::from_millis(250));
        }
        0
    };
    remove_state_file(OVERLAY_PID);
    code
}

#[cfg(target_os = "macos")]
mod macos {
    use crate::state_home::voice_state_home;
    use std::io::Write;
    use std::process::{Command, Stdio};

    pub fn run(worker_pid: u32) -> Result<(), String> {
        let script = include_str!("overlay_hud.swift");
        // Child stays in this overlay wrapper's process group by default so
        // kill(-overlay.pid) from kill_existing_overlay reaps the Swift HUD too.
        let mut child = Command::new("swift")
            .arg("-")
            .arg(worker_pid.to_string())
            .arg(voice_state_home().to_string_lossy().as_ref())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn swift overlay: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(script.as_bytes()).map_err(|e| format!("write swift: {e}"))?;
        }
        // Block until the HUD exits (worker died) so overlay.pid stays accurate.
        let status = child.wait().map_err(|e| format!("wait overlay: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("swift overlay exited with {status}"))
        }
    }
}
