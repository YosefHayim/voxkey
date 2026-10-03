//! Dictation worker: open mic + hold Shift + serial STT queue.
//! Narration runs in a separate process (`narration-worker`).

use crate::config::voice_preferences;
use crate::dictation_queue::{DictationJob, DictationQueue};
use crate::hotkey::{
    newly_pressed, other_keys_down, shift_hold_transition, shift_key_down, HoldAction, HoldEvent, HoldState,
    SHIFT_DOUBLE_TAP_SECONDS, SHIFT_HOLD_SECONDS, SHIFT_POLL_MS,
};
use crate::live_preview::{self, LiveCaption};
use crate::microphone::{OpenMicrophone, SharedCapture};
use crate::narration_mute::toggle_narration_muted;
use crate::narration_worker;
use crate::overlay;
use crate::refine::refine_with_prefs;
use crate::state_home::{append_dictation_log, atomic_json, ensure_state_home, now_secs, voice_state_home};
use crate::stt::SttEngine;
use crate::tts;
use crate::typing::{read_clipboard, write_clipboard};
use crate::whisper_models::{self, selected_model_key};
use crate::worker_processes::{
    acquire_worker_pid, clear_stop_flag, kill_stray_overlay_huds, process_running, read_pid_file, reap_child_processes,
    release_worker_pid, request_stop, reset_voice_runtime, spawn_worker_process, stop_requested, terminate_pid,
    worker_already_running, OVERLAY_PID, WORKER_PID,
};
use crate::worker_status::{write_worker_status, StatusWriter, WorkerStatus, HOTKEY_LABEL};
use parking_lot::Mutex;
use rdev::{listen, EventType, Key};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

struct HoldTimer {
    state: HoldState,
    deadline: Option<Instant>,
    /// Bumped on every Shift down, so a release only finishes the hold it belongs to.
    generation: u64,
    stop_request: Option<u64>,
    last_tap_at: Option<Instant>,
}

/// Hold state shared by the Shift poller, the key listener, and the capture loop.
/// The loops never touch the mic directly; they raise these flags for the capture thread.
struct Hotkey {
    timer: Mutex<HoldTimer>,
    /// Shift went down: open the buffer so the first word is not clipped.
    prepare: AtomicBool,
    /// The hold lasted SHIFT_HOLD_SECONDS: this is dictation.
    start: AtomicBool,
    /// Tap, capital letter, or shortcut: drop the buffer.
    cancel: AtomicBool,
    status: StatusWriter,
}

pub fn run_dictation_worker() -> i32 {
    if let Err(error) = ensure_state_home() {
        eprintln!("state home: {error}");
        return 1;
    }
    clear_stop_flag();
    let pid = std::process::id();
    match acquire_worker_pid(pid) {
        Ok(true) => {}
        Ok(false) => return 0,
        Err(error) => {
            eprintln!("pid lock: {error}");
            return 1;
        }
    }

    let key = selected_model_key();
    let unavailable = |error: String, label: &str| {
        eprintln!("{label}: {error}");
        write_worker_status("unavailable", &error, None, None, None);
        release_worker_pid();
        1
    };
    let model_path = match whisper_models::ensure_model(key) {
        Ok(path) => path,
        Err(error) => return unavailable(error, "model"),
    };
    // Load once per worker lifetime — hold-to-talk never reloads weights.
    let load_started = Instant::now();
    let engine = match SttEngine::load(&model_path) {
        Ok(engine) => Arc::new(engine),
        Err(error) => return unavailable(error, "stt load"),
    };
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "dufflebag-voice dictation-worker pid={pid} model={} load_ms={load_ms:.0} (warm; not per utterance)",
        key.filename()
    );
    let status = StatusWriter::new(engine.model_name(), whisper_models::whisper_backend_label());
    status.write("inactive", &format!("Ready (model load {load_ms:.0}ms once)"));

    overlay::kill_existing_overlay();
    spawn_overlay(pid);
    // Narration is a sibling process, off this critical path (skipped when speechMode is off).
    if let Err(error) = narration_worker::start_narration_worker_detached() {
        eprintln!("narration worker start: {error}");
    }
    // Warm STT only; TTS warms inside the narration worker.
    {
        let engine = engine.clone();
        thread::spawn(move || engine.warmup());
    }

    let queue = DictationQueue::new();
    queue.spawn_worker(engine.clone(), status.clone());
    let hotkey = Arc::new(Hotkey {
        timer: Mutex::new(HoldTimer {
            state: HoldState::Idle,
            deadline: None,
            generation: 0,
            stop_request: None,
            last_tap_at: None,
        }),
        prepare: AtomicBool::new(false),
        start: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        status,
    });
    let running = Arc::new(AtomicBool::new(true));
    {
        let (hotkey, running, queue) = (hotkey.clone(), running.clone(), queue.clone());
        thread::spawn(move || run_capture_loop(&hotkey, &running, &queue, engine));
    }
    {
        let (hotkey, running) = (hotkey.clone(), running.clone());
        thread::spawn(move || poll_shift(&hotkey, &running));
    }
    {
        let (hotkey, running) = (hotkey.clone(), running.clone());
        thread::spawn(move || listen_for_other_keys(hotkey, running));
    }

    while running.load(Ordering::SeqCst) && !stop_requested() {
        // Reap overlay/narration children so SIGKILL'd wrappers do not linger as
        // zombies that still pass kill(pid, 0) and block HUD respawn.
        reap_child_processes();
        thread::sleep(Duration::from_millis(100));
    }
    running.store(false, Ordering::SeqCst);
    queue.stop();
    overlay::kill_existing_overlay();
    release_worker_pid();
    0
}

/// Owns the mic (the cpal stream is !Send) and turns the hotkey flags into capture actions.
fn run_capture_loop(hotkey: &Hotkey, running: &Arc<AtomicBool>, queue: &DictationQueue, engine: Arc<SttEngine>) {
    // Prime once here, so the hotkey never pays device-open latency.
    let mic = match OpenMicrophone::prime() {
        Ok(mic) => mic,
        Err(error) => {
            eprintln!("mic prime: {error}");
            hotkey.status.write("unavailable", &error);
            return;
        }
    };
    let capture = mic.shared();
    let live_caption = Arc::new(LiveCaption::default());
    live_preview::spawn_preview_loop(
        capture.clone(),
        engine,
        live_caption.clone(),
        hotkey.status.clone(),
        running.clone(),
    );

    // True once the HUD says "listening" for the current hold.
    let mut announced_listening = false;
    while running.load(Ordering::SeqCst) {
        if stop_requested() {
            running.store(false, Ordering::SeqCst);
            break;
        }
        hotkey.fire_hold_timer();

        // Shift is also pressed for every capital letter, so this only buffers; stopping TTS
        // and showing the HUD wait until the hold is confirmed (start). Never inject a key-up
        // here: the poller would see a fake release (tap → HUD flash), and enigo key events
        // can glitch system audio under other music apps.
        // A cancel raised in the same instant as this prepare must still run below,
        // or the mic keeps recording with no hold to stop it.
        if hotkey.prepare.swap(false, Ordering::SeqCst) && !capture.is_recording() {
            capture.begin_capture();
            live_caption.clear();
        }
        if hotkey.start.swap(false, Ordering::SeqCst) {
            if tts::narration_busy() {
                let _ = tts::cancel_narration();
            }
            if !capture.is_recording() {
                capture.begin_capture();
                live_caption.clear();
            }
            hotkey.status.write("listening", "Recording");
            append_dictation_log("hold start");
            announced_listening = true;
        }
        if hotkey.cancel.swap(false, Ordering::SeqCst) {
            capture.cancel_capture();
            live_caption.clear();
            // Only clear the HUD we showed; typing must not wipe other HUD messages.
            if announced_listening {
                hotkey.status.write("inactive", "");
                announced_listening = false;
            }
        }
        let (stop_request, state) = {
            let mut timer = hotkey.timer.lock();
            (timer.stop_request.take(), timer.state)
        };
        if let Some(generation) = stop_request {
            announced_listening = false;
            append_dictation_log(&format!("hold stop gen={generation}"));
            finish_clip(hotkey, &capture, &live_caption, queue, generation);
        } else if capture.is_recording() && matches!(state, HoldState::Idle | HoldState::Shortcut) {
            // Safety net: recording with no Shift hold means a signal was lost; never leave the mic on.
            append_dictation_log("recording stopped: no Shift hold");
            capture.cancel_capture();
            live_caption.clear();
            hotkey.status.write("inactive", "");
            announced_listening = false;
        }
        thread::sleep(Duration::from_millis(5));
    }
    queue.stop();
}

/// Release: keep listening for the release tail, freeze the samples, and enqueue them
/// (never block on STT).
fn finish_clip(
    hotkey: &Hotkey,
    capture: &SharedCapture,
    live_caption: &LiveCaption,
    queue: &DictationQueue,
    generation: u64,
) {
    // Give the prepare step a moment to open the buffer.
    for _ in 0..30 {
        if capture.is_recording() || hotkey.cancel.load(Ordering::SeqCst) {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    // Keep capturing after Shift up so the last word is not clipped.
    let tail_ms = voice_preferences().dictation_keep_listening_ms;
    if tail_ms > 0 {
        thread::sleep(Duration::from_millis(tail_ms));
    }
    // A generation mismatch means a newer hold already replaced this one.
    if hotkey.timer.lock().generation != generation {
        capture.cancel_capture();
        live_caption.clear();
        return;
    }
    if !capture.is_recording() {
        capture.cancel_capture();
        live_caption.clear();
        hotkey.status.write("inactive", "Mic did not start — try hold longer");
        return;
    }
    let samples = capture.end_capture();
    let fallback = live_caption.take();
    hotkey.status.write("finishing", &format!("{} samples", samples.len()));
    if samples.is_empty() && fallback.is_empty() {
        hotkey.status.write("inactive", "No audio captured");
        return;
    }
    queue.enqueue(DictationJob {
        samples,
        replacements: voice_preferences().replacements(),
        streamed_fallback: fallback,
        generation,
    });
}

/// Primary Shift path: poll HID key state (works without Input Monitoring). rdev's
/// CGEventTap often never delivers keys when TCC isn't granted to this exact binary path.
fn poll_shift(hotkey: &Hotkey, running: &AtomicBool) {
    let mut was_down = false;
    let mut held_at_shift_down = 0u128;
    // Debounce both edges (~16 ms down, ~32 ms up) so HID blips or other apps probing
    // modifiers don't end a real hold mid-recording.
    let (mut down_streak, mut up_streak) = (0u8, 0u8);
    while running.load(Ordering::SeqCst) && !stop_requested() {
        if shift_key_down() {
            down_streak = down_streak.saturating_add(1);
            up_streak = 0;
        } else {
            up_streak = up_streak.saturating_add(1);
            down_streak = 0;
        }
        if down_streak >= 2 && !was_down {
            held_at_shift_down = other_keys_down();
            hotkey.apply(HoldEvent::ShiftDown);
            was_down = true;
        } else if up_streak >= 4 && was_down {
            hotkey.apply(HoldEvent::ShiftUp);
            was_down = false;
        }
        // Shift + another key is typing or a shortcut, not a hold.
        if was_down {
            let held = other_keys_down();
            if newly_pressed(held_at_shift_down, held) {
                hotkey.apply(HoldEvent::OtherDown);
            }
            // A key released during the hold counts again if it is pressed again.
            held_at_shift_down &= held;
        }
        thread::sleep(Duration::from_millis(SHIFT_POLL_MS));
    }
}

/// Best-effort second path for "another key while Shift is held"; without Input
/// Monitoring the poller still sees other keys.
fn listen_for_other_keys(hotkey: Arc<Hotkey>, running: Arc<AtomicBool>) {
    let callback = move |event: rdev::Event| {
        if !running.load(Ordering::SeqCst) {
            return;
        }
        // Shift itself is the hotkey; the poller owns its edges.
        if let EventType::KeyPress(key) = event.event_type {
            if !matches!(key, Key::ShiftLeft | Key::ShiftRight) {
                hotkey.apply(HoldEvent::OtherDown);
            }
        }
    };
    if let Err(error) = listen(callback) {
        eprintln!("rdev listen (optional): {error:?}");
    }
}

impl Hotkey {
    /// Turn a hold that outlasted SHIFT_HOLD_SECONDS into dictation.
    fn fire_hold_timer(&self) {
        let mut timer = self.timer.lock();
        let Some(deadline) = timer.deadline else {
            return;
        };
        if Instant::now() < deadline || timer.state != HoldState::Waiting {
            return;
        }
        let (next, action) = shift_hold_transition(timer.state, HoldEvent::HoldElapsed);
        timer.state = next;
        timer.deadline = None;
        if action == HoldAction::Start {
            self.start.store(true, Ordering::SeqCst);
        }
    }

    fn apply(&self, event: HoldEvent) {
        let action = {
            let mut timer = self.timer.lock();
            let (next, action) = shift_hold_transition(timer.state, event);
            timer.state = next;
            match action {
                HoldAction::Schedule => {
                    timer.deadline = Some(Instant::now() + Duration::from_secs_f64(SHIFT_HOLD_SECONDS));
                    timer.generation = timer.generation.wrapping_add(1);
                }
                HoldAction::Cancel | HoldAction::Tap | HoldAction::Start => timer.deadline = None,
                HoldAction::Stop => timer.stop_request = Some(timer.generation),
                HoldAction::None => {}
            }
            action
        };
        match action {
            HoldAction::Schedule => self.prepare.store(true, Ordering::SeqCst),
            HoldAction::Start => {
                self.start.store(true, Ordering::SeqCst);
                self.status.write("listening", "Recording");
            }
            HoldAction::Cancel => self.cancel.store(true, Ordering::SeqCst),
            HoldAction::Tap => {
                self.cancel.store(true, Ordering::SeqCst);
                self.on_shift_tap();
            }
            HoldAction::Stop => self.status.write("finishing", "Decoding…"),
            HoldAction::None => {}
        }
    }

    /// Tap stops narration. Double-tap hard-stops narration, else refines the clipboard
    /// (clipboard refine mode), else toggles the narration mute.
    fn on_shift_tap(&self) {
        let now = Instant::now();
        let is_double = {
            let mut timer = self.timer.lock();
            let is_double = timer
                .last_tap_at
                .is_some_and(|last| now.duration_since(last).as_secs_f64() <= SHIFT_DOUBLE_TAP_SECONDS);
            timer.last_tap_at = if is_double { None } else { Some(now) };
            is_double
        };
        if !is_double {
            if tts::cancel_narration() {
                self.status.write("inactive", "Narration stopped");
            }
            return;
        }
        if tts::hard_cancel_narration() {
            self.status.write("inactive", "Narration stopped");
            return;
        }
        if voice_preferences().review_refine_enabled() {
            thread::spawn(|| {
                if let Err(error) = refine_clipboard_prompt() {
                    eprintln!("prompt refine: {error}");
                }
            });
            return;
        }
        let detail =
            if toggle_narration_muted() { "Narration muted (double-tap Shift to unmute)" } else { "Narration unmuted" };
        self.status.write("inactive", detail);
    }
}

fn refine_clipboard_prompt() -> Result<(), String> {
    let prefs = voice_preferences();
    write_refinement_status(
        "refining",
        &format!("Refining copied prompt ({}/{})…", prefs.refine_provider, prefs.refine_model),
        0.0,
    );
    let refined = refine_with_prefs(&read_clipboard()?, &prefs)?;
    write_clipboard(&refined)?;
    write_refinement_status("ready", "Refined prompt copied — press ⌘V to paste", 10.0);
    let _ = tts::speak_markdown(&refined);
    Ok(())
}

/// `refinement.json` drives the HUD message for clipboard refine.
fn write_refinement_status(stage: &str, message: &str, lifetime: f64) {
    let value = serde_json::json!({
        "stage": stage,
        "message": message,
        "lifetime": lifetime,
        "updated_at": now_secs(),
    });
    let _ = atomic_json(&voice_state_home().join("refinement.json"), &value);
}

fn spawn_overlay(worker_pid: u32) {
    let _ = spawn_worker_process(&["overlay", "--worker-pid", &worker_pid.to_string()]);
}

pub fn start_worker_detached() -> Result<serde_json::Value, String> {
    ensure_state_home().map_err(|e| e.to_string())?;
    if worker_already_running() {
        // Keep a healthy overlay; rebuild only when the wrapper is gone. Always reap
        // orphaned Swift pills left by older kills.
        kill_stray_overlay_huds();
        if !process_running(read_pid_file(OVERLAY_PID)) {
            overlay::kill_existing_overlay();
            if let Some(pid) = read_pid_file(WORKER_PID) {
                spawn_overlay(pid);
            }
        }
        let _ = narration_worker::start_narration_worker_detached();
        return Ok(serde_json::to_value(WorkerStatus::snapshot()).unwrap_or_default());
    }
    reset_voice_runtime();
    clear_stop_flag();
    spawn_worker_process(&["dictation-worker"]).map_err(|e| format!("spawn dictation worker: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        let status = WorkerStatus::snapshot();
        if status.running {
            // Give the narration worker (spawned by the dictation worker) a moment to claim its pid.
            let narration_deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < narration_deadline && !narration_worker::narration_worker_running() {
                thread::sleep(Duration::from_millis(50));
            }
            if !narration_worker::narration_worker_running() {
                let _ = narration_worker::start_narration_worker_detached();
            }
            return Ok(serde_json::to_value(status).unwrap_or_default());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("Voice worker did not start".into())
}

pub fn stop_worker() -> serde_json::Value {
    tts::kill_tts_process();
    request_stop();
    narration_worker::stop_narration_worker();
    if let Some(pid) = read_pid_file(WORKER_PID) {
        let deadline = Instant::now() + Duration::from_secs(4);
        while process_running(Some(pid)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        if process_running(Some(pid)) {
            terminate_pid(pid, Duration::from_millis(100));
        }
    }
    overlay::kill_existing_overlay();
    reset_voice_runtime();
    serde_json::json!({
        "dictation": "inactive",
        "hotkey": HOTKEY_LABEL,
        "running": false,
    })
}
