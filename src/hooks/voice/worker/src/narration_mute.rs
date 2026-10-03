//! Session mute: while `narration-muted` exists the inbox is kept but nothing is spoken.

use crate::state_home::voice_state_home;
use std::fs;

pub fn narration_muted() -> bool {
    voice_state_home().join("narration-muted").exists()
}

/// Flip the mute flag; returns the new state.
pub fn toggle_narration_muted() -> bool {
    let path = voice_state_home().join("narration-muted");
    let muted = !path.exists();
    if muted {
        let _ = fs::create_dir_all(voice_state_home());
        let _ = fs::write(&path, b"1");
    } else {
        let _ = fs::remove_file(path);
    }
    muted
}
