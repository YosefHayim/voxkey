//! Insert text at the active caret: direct key injection for dictation-length text (a failed ⌘V
//! types a bare `v`), clipboard paste only for long payloads.

use crate::state_home::append_dictation_log;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::io::Write;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

/// macOS virtual key code for ANSI `V` (kVK_ANSI_V). Unicode('v') often drops the
/// Command modifier and types a bare `v` into the focused field.
#[cfg(target_os = "macos")]
const MAC_KEYCODE_V: u32 = 0x09;

/// Above this length, prefer clipboard paste (faster for long refined prompts).
const CLIPBOARD_PREFERS_CHARS: usize = 800;

/// Insert `text` into the focused field.
pub fn type_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    // Wait for the dictation hotkey to fully release so it does not corrupt injection.
    ensure_shift_released(900);

    let char_len = text.chars().count();
    let shift_down = crate::hotkey::shift_key_down();

    // Short/medium STT text: type characters directly. This avoids the classic
    // hotkey-hold bug where paste can race and only `v` appears in the caret
    // while the HUD shows the full transcript.
    if char_len <= CLIPBOARD_PREFERS_CHARS || shift_down {
        match type_via_enigo_text(text) {
            Ok(()) => {
                log_type_path("enigo.text", char_len);
                return Ok(());
            }
            Err(error) => {
                log_type_path(&format!("enigo.text failed: {error}"), char_len);
                eprintln!("enigo.text failed: {error}; trying clipboard paste");
            }
        }
    }

    // Long text (or enigo.text failed): clipboard + ⌘V.
    if !crate::hotkey::shift_key_down() {
        match paste_via_clipboard(text) {
            Ok(()) => {
                log_type_path("clipboard", char_len);
                return Ok(());
            }
            Err(error) => {
                log_type_path(&format!("clipboard failed: {error}"), char_len);
                eprintln!("clipboard paste failed: {error}; last-resort enigo.text");
            }
        }
    } else {
        log_type_path("skip clipboard (shift held)", char_len);
    }

    // Last resort.
    type_via_enigo_text(text).map_err(|e| {
        format!(
            "type failed ({e}). Grant Accessibility (+ Input Monitoring) to dufflebag-voice in \
             System Settings → Privacy & Security"
        )
    })?;
    log_type_path("enigo.text last-resort", char_len);
    Ok(())
}

fn type_via_enigo_text(text: &str) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))?;
    // Small settle so the focused app accepts key events after hotkey release.
    thread::sleep(Duration::from_millis(25));
    enigo.text(text).map_err(|e| format!("enigo.text: {e}"))
}

fn log_type_path(detail: &str, char_len: usize) {
    append_dictation_log(&format!("type_path chars={char_len} {detail}"));
}

pub fn press_enter() -> Result<(), String> {
    ensure_shift_released(400);
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))?;
    enigo.key(Key::Return, Direction::Click).map_err(|e| format!("return: {e}"))?;
    Ok(())
}

fn wait_shift_up(max_ms: u64) {
    let steps = max_ms / 10;
    for _ in 0..steps {
        if !crate::hotkey::shift_key_down() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Release Shift and wait until the OS reports it up, so it cannot capitalize or corrupt typed text.
fn ensure_shift_released(max_ms: u64) {
    wait_shift_up(max_ms / 2);
    release_shift_key();
    thread::sleep(Duration::from_millis(40));
    wait_shift_up(max_ms / 2);
    if crate::hotkey::shift_key_down() {
        // One more hard release pulse.
        release_shift_key();
        thread::sleep(Duration::from_millis(60));
        wait_shift_up(200);
    }
}

fn paste_via_clipboard(text: &str) -> Result<(), String> {
    // Save previous clipboard (best-effort).
    let previous = Command::new("pbpaste").output().ok().and_then(|o| String::from_utf8(o.stdout).ok());

    write_clipboard(text)?;

    // Confirm the pasteboard holds our text before sending ⌘V: a failed/raced pbcopy
    // would otherwise press V and type a lone letter.
    let on_board = read_clipboard()?;
    if on_board != text {
        return Err(format!("clipboard round-trip mismatch (got {} bytes, want {})", on_board.len(), text.len()));
    }

    // Prefer System Events keystroke — more reliable than enigo Meta+Unicode('v'),
    // which frequently drops the Command modifier and types a bare `v`.
    if let Err(error) = paste_cmd_v_system_events() {
        eprintln!("System Events ⌘V failed: {error}; trying enigo keycode path");
        paste_cmd_v_enigo()?;
    }

    // Restore previous clipboard shortly after paste lands.
    if let Some(prev) = previous {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            let _ = write_clipboard(&prev);
        });
    }
    Ok(())
}

pub fn read_clipboard() -> Result<String, String> {
    let output = Command::new("pbpaste").output().map_err(|e| format!("pbpaste: {e}"))?;
    if !output.status.success() {
        return Err("pbpaste failed".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn write_clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn().map_err(|e| format!("pbcopy: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("pbcopy write: {e}"))?;
    }
    let status = child.wait().map_err(|e| format!("pbcopy wait: {e}"))?;
    if !status.success() {
        return Err("pbcopy failed".into());
    }
    Ok(())
}

/// ⌘V via AppleScript System Events (needs Accessibility for the worker process).
fn paste_cmd_v_system_events() -> Result<(), String> {
    let status = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
        .status()
        .map_err(|e| format!("osascript: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("osascript keystroke exit {status}"))
    }
}

/// ⌘V via enigo using the ANSI V virtual key code (not Unicode 'v').
fn paste_cmd_v_enigo() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("enigo: {e}"))?;
    enigo.key(Key::Meta, Direction::Press).map_err(|e| format!("meta down: {e}"))?;
    // Hold Command long enough for the OS to register the chord.
    thread::sleep(Duration::from_millis(35));
    #[cfg(target_os = "macos")]
    {
        enigo.key(Key::Other(MAC_KEYCODE_V), Direction::Press).map_err(|e| format!("v down: {e}"))?;
        thread::sleep(Duration::from_millis(20));
        enigo.key(Key::Other(MAC_KEYCODE_V), Direction::Release).map_err(|e| format!("v up: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| format!("v: {e}"))?;
    }
    thread::sleep(Duration::from_millis(20));
    enigo.key(Key::Meta, Direction::Release).map_err(|e| format!("meta up: {e}"))?;
    Ok(())
}

fn release_shift_key() {
    if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
        let _ = enigo.key(Key::Shift, Direction::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "overwrites the real macOS clipboard; run with `cargo test -- --ignored` when that is fine"]
    fn clipboard_roundtrip_helper_writes() {
        // Only assert the write/read helpers; full Cmd+V needs Accessibility + focus.
        let marker = format!("dufflebag-paste-test-{}", std::process::id());
        write_clipboard(&marker).expect("pbcopy");
        assert_eq!(read_clipboard().expect("pbpaste"), marker);
    }
}
