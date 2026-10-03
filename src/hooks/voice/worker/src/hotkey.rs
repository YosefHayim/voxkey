//! Shift hold state machine (tap / hold-to-dictate / release). Shift is read by polling HID key
//! state, so it works without CGEventTap / Input Monitoring (often missing for a rebuilt binary).
//! Shift is also a typing key: any other key pressed while it is held cancels the hold.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldState {
    Idle,
    Waiting,
    Shortcut,
    Listening,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldEvent {
    ShiftDown,
    ShiftUp,
    OtherDown,
    HoldElapsed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldAction {
    None,
    Schedule,
    Cancel,
    Tap,
    Start,
    Stop,
}

pub fn shift_hold_transition(state: HoldState, event: HoldEvent) -> (HoldState, HoldAction) {
    match (state, event) {
        (HoldState::Idle, HoldEvent::ShiftDown) => (HoldState::Waiting, HoldAction::Schedule),
        (HoldState::Waiting, HoldEvent::ShiftUp) => (HoldState::Idle, HoldAction::Tap),
        (HoldState::Waiting, HoldEvent::OtherDown) => (HoldState::Shortcut, HoldAction::Cancel),
        (HoldState::Waiting, HoldEvent::HoldElapsed) => (HoldState::Listening, HoldAction::Start),
        (HoldState::Shortcut, HoldEvent::ShiftUp) => (HoldState::Idle, HoldAction::None),
        // A slow capital letter can outlast the hold threshold: drop the clip.
        (HoldState::Listening, HoldEvent::OtherDown) => (HoldState::Shortcut, HoldAction::Cancel),
        (HoldState::Listening, HoldEvent::ShiftUp) => (HoldState::Idle, HoldAction::Stop),
        _ => (state, HoldAction::None),
    }
}

/// Hold threshold before listening. Longer than a Shift press for a capital
/// letter; the mic buffer already started at Shift down, so no audio is lost.
pub const SHIFT_HOLD_SECONDS: f64 = 0.3;
/// Max gap between taps for double-tap Shift (cancel TTS / mute / refine).
pub const SHIFT_DOUBLE_TAP_SECONDS: f64 = 0.4;
/// How often to sample HID Shift state (edge-detect hold).
pub const SHIFT_POLL_MS: u64 = 8;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceFlagsState(state_id: u32) -> u64;
    fn CGEventSourceKeyState(state_id: u32, key: u16) -> bool;
}

#[cfg(target_os = "macos")]
const HID_SYSTEM_STATE: u32 = 1;
/// kVK_Shift and kVK_RightShift.
#[cfg(target_os = "macos")]
const SHIFT_KEYS: [u16; 2] = [0x38, 0x3C];
/// kVK_CapsLock: its HID state follows the lock light, not a press.
#[cfg(target_os = "macos")]
const CAPS_LOCK_KEY: u16 = 0x39;

/// True while either Shift key is held.
#[cfg(target_os = "macos")]
pub fn shift_key_down() -> bool {
    unsafe {
        let _ = CGEventSourceFlagsState(HID_SYSTEM_STATE);
        SHIFT_KEYS.iter().any(|key| CGEventSourceKeyState(HID_SYSTEM_STATE, *key))
    }
}

/// Bit `n` is set while key code `n` (other than Shift and Caps Lock) is held.
#[cfg(target_os = "macos")]
pub fn other_keys_down() -> u128 {
    (0u16..0x80)
        .filter(|key| !SHIFT_KEYS.contains(key) && *key != CAPS_LOCK_KEY)
        .filter(|key| unsafe { CGEventSourceKeyState(HID_SYSTEM_STATE, *key) })
        .fold(0, |keys, key| keys | (1u128 << key))
}

#[cfg(not(target_os = "macos"))]
pub fn shift_key_down() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn other_keys_down() -> u128 {
    0
}

/// True when a key went down after Shift did. Keys already held at Shift down do not count:
/// macOS can report a key as held forever (seen with key code 0), which would cancel every hold.
pub fn newly_pressed(held_at_shift_down: u128, held_now: u128) -> bool {
    held_now & !held_at_shift_down != 0
}

/// `hotkey-check`: print Shift edges for `seconds` so detection can be verified by hand.
pub fn run_hotkey_check(seconds: u64) -> i32 {
    use std::io::Write;
    use std::time::{Duration, Instant};
    println!("Hold Shift... (polling HID {seconds}s)");
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let (mut was_down, mut saw_down) = (false, false);
    while Instant::now() < deadline {
        let down = shift_key_down();
        if down && !was_down {
            println!("SHIFT DOWN");
            saw_down = true;
        } else if !down && was_down {
            println!("SHIFT UP");
        }
        was_down = down;
        let _ = std::io::stdout().flush();
        std::thread::sleep(Duration::from_millis(20));
    }
    if saw_down {
        println!("ok — Shift detection works");
        0
    } else {
        eprintln!("no Shift edge seen — check Input Monitoring for dufflebag-voice");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use HoldAction as Action;
    use HoldEvent as Event;
    use HoldState as State;

    #[test]
    fn hold_transitions() {
        let cases: [(&str, &[Event], State, Action); 6] = [
            ("Shift down schedules the hold", &[Event::ShiftDown], State::Waiting, Action::Schedule),
            ("a long hold starts listening", &[Event::ShiftDown, Event::HoldElapsed], State::Listening, Action::Start),
            ("a short press is a tap", &[Event::ShiftDown, Event::ShiftUp], State::Idle, Action::Tap),
            ("typing a capital letter cancels", &[Event::ShiftDown, Event::OtherDown], State::Shortcut, Action::Cancel),
            (
                "releasing after a cancel does nothing",
                &[Event::ShiftDown, Event::OtherDown, Event::ShiftUp],
                State::Idle,
                Action::None,
            ),
            (
                "a key pressed while listening drops the clip",
                &[Event::ShiftDown, Event::HoldElapsed, Event::OtherDown],
                State::Shortcut,
                Action::Cancel,
            ),
        ];
        for (name, events, final_state, last_action) in cases {
            let (state, action) = events
                .iter()
                .fold((State::Idle, Action::None), |(state, _), event| shift_hold_transition(state, *event));
            assert_eq!((state, action), (final_state, last_action), "{name}");
        }
    }

    #[test]
    fn only_keys_pressed_after_shift_count() {
        let stuck_key = 1u128;
        let letter = 1u128 << 12;
        assert!(!newly_pressed(stuck_key, stuck_key), "a key held before Shift is not typing");
        assert!(newly_pressed(stuck_key, stuck_key | letter), "a new key while Shift is held is typing");
        assert!(!newly_pressed(0, 0), "no keys, no typing");
    }
}
