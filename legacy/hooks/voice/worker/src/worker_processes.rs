//! Pid and lock files, the stop flag, and killing voice processes for `start`, `stop`, and `reset`.

use crate::inbox::remove_inbox_files;
use crate::state_home::{ensure_state_home, voice_state_home};
use std::fs;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

pub const WORKER_PID: &str = "worker.pid";
const WORKER_LOCK: &str = "worker.lock";
pub const NARRATION_PID: &str = "narration.pid";
pub const NARRATION_LOCK: &str = "narration.lock";
pub const OVERLAY_PID: &str = "overlay.pid";
pub const TTS_PID: &str = "tts.pid";

pub fn read_pid_file(name: &str) -> Option<u32> {
    let text = fs::read_to_string(voice_state_home().join(name)).ok()?;
    text.trim().parse().ok().filter(|pid| *pid > 0)
}

pub fn write_pid_file(name: &str, pid: u32) -> std::io::Result<()> {
    fs::write(ensure_state_home()?.join(name), pid.to_string())
}

pub fn remove_state_file(name: &str) {
    let _ = fs::remove_file(voice_state_home().join(name));
}

/// kill(2): a negative `pid` signals the whole process group, signal 0 only probes. True when delivered.
fn send_signal(pid: i32, signal: i32) -> bool {
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(pid, signal) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
        false
    }
}

pub fn process_running(pid: Option<u32>) -> bool {
    let Some(pid) = pid else {
        return false;
    };
    // Zombies still answer signal 0 until reaped — treat them as not running so
    // overlay.pid / worker.pid never block respawn after SIGKILL of a child.
    send_signal(pid as i32, 0) && !process_is_zombie(pid)
}

fn process_is_zombie(pid: u32) -> bool {
    Command::new("ps")
        .args(["-o", "state=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim().starts_with('Z'))
}

/// Reap exited children (overlay / narration worker spawns) so they do not linger as
/// zombies that still pass `kill(pid, 0)`.
pub fn reap_child_processes() {
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
        }
        const WNOHANG: i32 = 1;
        let mut status = 0;
        while waitpid(-1, &mut status, WNOHANG) > 0 {}
    }
}

fn process_group_id(pid: u32) -> Option<i32> {
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn getpgid(pid: i32) -> i32;
        }
        let pgid = getpgid(pid as i32);
        (pgid > 1).then_some(pgid)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// Start `dufflebag-voice <args>` detached in its own process group, so `kill(-pid)` also
/// reaps its children (the Swift HUD, the TTS server).
pub fn spawn_worker_process(args: &[&str]) -> std::io::Result<Child> {
    let mut command = Command::new(std::env::current_exe()?);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn()
}

pub fn worker_already_running() -> bool {
    process_running(read_pid_file(WORKER_PID))
}

/// Exclusive create of `lock_name` is the mutex across spawn races; a lock left by a dead
/// owner is reclaimed. Returns `false` when another live process already owns `pid_name`.
pub fn claim_pid_lock(pid_name: &str, lock_name: &str, pid: u32) -> Result<bool, String> {
    let home = ensure_state_home().map_err(|e| e.to_string())?;
    let owner_alive = || process_running(read_pid_file(pid_name));
    if read_pid_file(pid_name).is_some_and(|owner| owner != pid) && owner_alive() {
        return Ok(false);
    }
    let lock_path = home.join(lock_name);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let lock_error = |error: std::io::Error| format!("{} lock: {error}", pid_name.trim_end_matches(".pid"));
        let create_lock = || fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&lock_path);
        match create_lock() {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if owner_alive() {
                    return Ok(false);
                }
                let _ = fs::remove_file(&lock_path);
                create_lock().map_err(lock_error)?;
            }
            Err(error) => return Err(lock_error(error)),
        }
    }
    #[cfg(not(unix))]
    {
        if owner_alive() {
            return Ok(false);
        }
        let _ = fs::write(&lock_path, b"");
    }
    fs::write(home.join(pid_name), pid.to_string()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Drop `pid_name` only when this process owns it; always drop `lock_name`.
pub fn release_pid_lock(pid_name: &str, lock_name: &str) {
    if read_pid_file(pid_name) == Some(std::process::id()) {
        remove_state_file(pid_name);
    }
    remove_state_file(lock_name);
}

pub fn acquire_worker_pid(pid: u32) -> Result<bool, String> {
    claim_pid_lock(WORKER_PID, WORKER_LOCK, pid)
}

pub fn release_worker_pid() {
    release_pid_lock(WORKER_PID, WORKER_LOCK);
}

/// Never signal pid 0/1 (kill(-1) broadcasts to every process we own) or ourselves.
fn is_unsafe_target(pid: u32) -> bool {
    pid <= 1 || pid == std::process::id()
}

pub fn force_kill_pid(pid: u32) {
    if is_unsafe_target(pid) {
        return;
    }
    send_signal(pid as i32, 15);
    thread::sleep(Duration::from_millis(40));
    send_signal(pid as i32, 9);
}

/// SIGTERM, then SIGKILL if the process is still up after `grace`.
pub fn terminate_pid(pid: u32, grace: Duration) {
    if is_unsafe_target(pid) {
        return;
    }
    send_signal(pid as i32, 15);
    thread::sleep(grace);
    if process_running(Some(pid)) {
        send_signal(pid as i32, 9);
    }
}

/// Kill `pid` and its process group (warm uv + python TTS, overlay wrapper + Swift HUD).
pub fn force_kill_process_group(pid: u32) {
    if is_unsafe_target(pid) {
        return;
    }
    // Never kill(-our_pgid) — that terminates the CLI and its parent shell.
    if process_group_id(std::process::id()) == Some(pid as i32) {
        force_kill_pid(pid);
        return;
    }
    send_signal(-(pid as i32), 15);
    thread::sleep(Duration::from_millis(40));
    send_signal(-(pid as i32), 9);
    send_signal(pid as i32, 9);
}

/// `ps -ax -o <columns>` rows, trimmed; empty when `ps` fails.
pub fn ps_rows(columns: &str) -> Vec<String> {
    let Ok(output) = Command::new("ps").args(["-ax", "-o", columns]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|row| !row.is_empty())
        .map(str::to_string)
        .collect()
}

/// Split a `ps` row into its leading number column and the rest.
pub fn split_leading_pid(row: &str) -> Option<(u32, &str)> {
    let (pid, rest) = row.split_once(char::is_whitespace).unwrap_or((row, ""));
    Some((pid.parse().ok()?, rest.trim_start()))
}

/// SIGTERM every row `pick` selects, then SIGKILL whatever is still listed after `grace`.
/// Skips pid 0/1, this process, and this process group (the CLI and its parent shell).
fn term_then_kill_rows(columns: &str, grace: Duration, pick: impl Fn(&str) -> Option<u32>) {
    let self_pgid = process_group_id(std::process::id());
    let signal_rows = |signal: i32| {
        for row in ps_rows(columns) {
            let Some(pid) = pick(&row) else {
                continue;
            };
            if is_unsafe_target(pid) || (self_pgid.is_some() && process_group_id(pid) == self_pgid) {
                continue;
            }
            send_signal(pid as i32, signal);
        }
    };
    signal_rows(15);
    thread::sleep(grace);
    signal_rows(9);
}

/// True only for argv shaped like `…/dufflebag-voice dictation-worker|narration-worker|overlay …`.
/// Must not match shells whose `-c` script merely *mentions* the binary.
fn is_voice_worker_line(args: &str) -> bool {
    let tokens: Vec<&str> = args.split_whitespace().collect();
    let Some(idx) = tokens.iter().position(|t| t.rsplit('/').next() == Some("dufflebag-voice")) else {
        return false;
    };
    matches!(tokens.get(idx + 1).copied(), Some("dictation-worker" | "narration-worker" | "overlay"))
}

/// True for the Swift HUD interpreter whose argv includes this voice state home.
/// Requires a real interpreter invocation (`swift - <pid> …` or `swift-frontend … -- <pid> …`)
/// so shell scripts that merely *mention* these strings are not matched. The state home
/// often contains spaces (`Application Support`), so the path check is a substring match.
fn is_overlay_hud_line(args: &str, state_home: &str) -> bool {
    if state_home.is_empty() || !args.contains(state_home) {
        return false;
    }
    let tokens: Vec<&str> = args.split_whitespace().collect();
    let Some(idx) = tokens.iter().position(|t| matches!(t.rsplit('/').next(), Some("swift" | "swift-frontend"))) else {
        return false;
    };
    let rest = &tokens[idx + 1..];
    let has_stdin_or_separator = rest.iter().any(|t| *t == "-" || *t == "--");
    let has_worker_pid = rest.iter().any(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()));
    has_stdin_or_separator && has_worker_pid
}

fn kill_stray_voice_processes() {
    term_then_kill_rows("pid=,args=", Duration::from_millis(150), |row| {
        let (pid, args) = split_leading_pid(row)?;
        is_voice_worker_line(args).then_some(pid)
    });
}

/// Killing only the `dufflebag-voice overlay` wrapper orphans its Swift HUD (ppid=1), so
/// HUDs are swept by argv. `orphans_only` leaves HUDs that still have a live wrapper.
fn kill_overlay_huds(orphans_only: bool) {
    let state_home = voice_state_home().to_string_lossy().to_string();
    term_then_kill_rows("pid=,ppid=,args=", Duration::from_millis(80), |row| {
        let (pid, rest) = split_leading_pid(row)?;
        let (ppid, args) = split_leading_pid(rest)?;
        if orphans_only && ppid != 1 {
            return None;
        }
        let args = args.split_whitespace().collect::<Vec<_>>().join(" ");
        is_overlay_hud_line(&args, &state_home).then_some(pid)
    });
}

pub fn kill_stray_overlay_huds() {
    kill_overlay_huds(true);
}

pub fn kill_all_overlay_huds() {
    kill_overlay_huds(false);
}

/// Kill leftover Supertonic TTS servers when pid files are gone or a rewarm raced.
pub fn kill_stray_tts_servers() {
    for row in ps_rows("pid=,args=") {
        if !(row.contains("text_to_speech.py") && row.contains("serve")) {
            continue;
        }
        if let Some((pid, _)) = split_leading_pid(&row) {
            force_kill_process_group(pid);
        }
    }
}

/// Full clean slate: workers, overlays, TTS server, locks, stop flags.
pub fn reset_voice_runtime() {
    // Recorded pids first (most reliable), then argv sweeps for anything left.
    if let Some(pid) = read_pid_file(WORKER_PID) {
        force_kill_pid(pid);
    }
    if let Some(pid) = read_pid_file(OVERLAY_PID) {
        force_kill_process_group(pid);
    }
    if let Some(pid) = read_pid_file(NARRATION_PID) {
        force_kill_pid(pid);
    }
    if let Some(pid) = read_pid_file(TTS_PID) {
        force_kill_process_group(pid);
    }
    kill_stray_voice_processes();
    kill_all_overlay_huds();
    kill_stray_tts_servers();
    for name in [
        WORKER_PID,
        WORKER_LOCK,
        NARRATION_PID,
        NARRATION_LOCK,
        OVERLAY_PID,
        "overlay.lock",
        TTS_PID,
        "tts-stop",
        "speaking.lock",
        "stop",
        // Reset unmutes, so muting is always a deliberate double-tap.
        "narration-muted",
    ] {
        remove_state_file(name);
    }
    remove_inbox_files(&["speaking"]);
}

pub fn clear_stop_flag() {
    remove_state_file("stop");
}

pub fn request_stop() {
    let home = voice_state_home();
    let _ = fs::create_dir_all(&home);
    let _ = fs::write(home.join("stop"), b"");
}

pub fn stop_requested() -> bool {
    voice_state_home().join("stop").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/me/Library/Application Support/dufflebag/voice";

    #[test]
    fn matches_only_real_overlay_hud_interpreters() {
        let cases = [
            (format!("swift - 3452 {HOME}"), true),
            (format!("/Applications/Xcode.app/.../swift-frontend -frontend -interpret - -- 3452 {HOME}"), true),
            ("swift build".to_string(), false),
            ("swift - 1 /tmp/other".to_string(), false),
            (
                format!("/bin/zsh -c awk index($0,\"swift-frontend\") && index($0,\"dufflebag/voice\") STATE={HOME}"),
                false,
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(is_overlay_hud_line(&line, HOME), expected, "{line}");
        }
    }

    #[test]
    fn matches_only_voice_worker_argv() {
        assert!(is_voice_worker_line("/x/dufflebag-voice dictation-worker"));
        assert!(is_voice_worker_line("dufflebag-voice overlay --worker-pid 12"));
        assert!(!is_voice_worker_line("/bin/zsh -c 'dufflebag-voice start'"));
    }

    #[test]
    fn splits_leading_pid_column() {
        assert_eq!(split_leading_pid("123   swift - 4"), Some((123, "swift - 4")));
        assert_eq!(split_leading_pid("abc swift"), None);
    }
}
