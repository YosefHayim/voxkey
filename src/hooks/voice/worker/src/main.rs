//! dufflebag-voice — local STT/TTS worker. The dictation worker owns the hotkey, mic, and STT
//! queue; the narration worker (a separate process) speaks queued agent replies.

mod cmux_delivery;
mod cmux_focus;
mod config;
mod devin_export_watcher;
mod dictation_format;
mod dictation_queue;
mod dictation_worker;
mod hotkey;
mod inbox;
mod live_preview;
mod markdown_to_speech;
mod microphone;
mod narration_mute;
mod narration_worker;
mod overlay;
mod refine;
mod state_home;
mod stt;
mod stt_benchmark;
mod tts;
mod typing;
mod whisper_models;
mod worker_processes;
mod worker_status;

use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "dufflebag-voice", about = "Dufflebag local voice worker")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Render Markdown as a speech document
    Render {
        #[arg(long)]
        text: String,
    },
    /// Play one complete narration through Supertonic (via text_to_speech.py)
    Speak {
        #[arg(long)]
        text: String,
    },
    /// Download and verify Whisper turbo + warm Supertonic
    Prepare,
    /// Start the local narration and dictation worker
    Start,
    /// Internal dictation worker entry (hotkey + mic + STT queue)
    DictationWorker,
    /// Internal narration worker entry (inbox + TTS only)
    NarrationWorker,
    /// Floating indicator process
    Overlay {
        #[arg(long)]
        worker_pid: u32,
    },
    /// Stop the local worker
    Stop,
    /// Stop reply narration / TTS only (keep the dictation worker running)
    StopNarration,
    /// Kill every voice worker/overlay/TTS process and clear locks (fresh slate)
    Reset,
    /// Print local worker status
    Status,
    /// Watch a Devin ATIF export for complete responses
    WatchDevin {
        #[arg(long)]
        path: PathBuf,
    },
    /// Refine a prompt (route-aware; multi-provider via refine_prompt.py)
    Refine(RefineArgs),
    /// Debug: poll HID Shift for N seconds (hold Shift to verify detection)
    HotkeyCheck {
        #[arg(long, default_value_t = 8)]
        seconds: u64,
    },
    /// Offline latency bench: load + warm + decode timing across models
    Bench {
        /// Comma-separated model keys: tiny, base, small, turbo-q5 (default: all of those)
        #[arg(long, default_value = "tiny,base,small,turbo-q5")]
        models: String,
        /// Comma-separated clip lengths in seconds
        #[arg(long, default_value = "1,2,4")]
        seconds: String,
        /// Timed runs per clip after warm-up
        #[arg(long, default_value_t = 3)]
        runs: u32,
    },
}

#[derive(Args, Debug)]
struct RefineArgs {
    #[arg(long)]
    text: String,
    #[arg(long, default_value_t = false)]
    speak: bool,
    /// Provider: codex|local|auto|grok|ollama|opencode|claude|gemini
    #[arg(long)]
    backend: Option<String>,
    /// Model id for the provider (e.g. gpt-5.3-codex-spark, grok-4.5, llama3.2)
    #[arg(long)]
    model: Option<String>,
    /// Reasoning effort for providers that support it (low|medium|high|…)
    #[arg(long)]
    reasoning_effort: Option<String>,
    /// caret | cmux-new | cmux-resume (default: config.json / caret)
    #[arg(long)]
    delivery: Option<String>,
    /// cmux-new shell template; {{prompt_file}} {{prompt}} {{cwd}}
    #[arg(long)]
    cmux_command: Option<String>,
    /// Send Enter after caret/cmux inject
    #[arg(long, default_value_t = false)]
    auto_submit: bool,
}

fn main() {
    let code = match Cli::parse().command {
        Commands::Render { text } => {
            println!("{}", markdown_to_speech::markdown_to_speech(&text));
            0
        }
        Commands::Speak { text } => match tts::speak_markdown(&text) {
            Ok(status) => {
                if status != "completed" {
                    eprintln!("{status}");
                }
                0
            }
            Err(error) => fail(error),
        },
        Commands::Prepare => print_json_or_fail(prepare(), false),
        Commands::Start => print_json_or_fail(dictation_worker::start_worker_detached(), false),
        Commands::DictationWorker => dictation_worker::run_dictation_worker(),
        Commands::NarrationWorker => narration_worker::run_narration_worker(),
        Commands::Overlay { worker_pid } => overlay::run_overlay_process(worker_pid),
        Commands::Stop => print_json(&dictation_worker::stop_worker()),
        Commands::StopNarration => {
            narration_worker::stop_narration_worker();
            print_json(&serde_json::json!({ "narration": "off", "stopped": true }))
        }
        Commands::Reset => {
            tts::stop_tts_server();
            worker_processes::reset_voice_runtime();
            print_json(&serde_json::json!({
                "dictation": "inactive",
                "hotkey": worker_status::HOTKEY_LABEL,
                "running": false,
                "reset": true,
            }))
        }
        Commands::Status => print_json(&worker_status::WorkerStatus::snapshot()),
        Commands::WatchDevin { path } => devin_export_watcher::watch_devin(&path),
        Commands::Refine(args) => match refine_prompt_cli(args) {
            Ok(refined) => {
                println!("{refined}");
                0
            }
            Err(error) => fail(error),
        },
        Commands::HotkeyCheck { seconds } => hotkey::run_hotkey_check(seconds),
        Commands::Bench { models, seconds, runs } => {
            print_json_or_fail(stt_benchmark::run_bench_command(&models, &seconds, runs), true)
        }
    };
    std::process::exit(code);
}

fn print_json(value: &impl Serialize) -> i32 {
    println!("{}", serde_json::to_string(value).unwrap_or_default());
    0
}

fn fail(error: String) -> i32 {
    eprintln!("{error}");
    1
}

fn print_json_or_fail(result: Result<impl Serialize, String>, pretty: bool) -> i32 {
    match result {
        Ok(value) if pretty => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
            0
        }
        Ok(value) => print_json(&value),
        Err(error) => fail(error),
    }
}

fn prepare() -> Result<serde_json::Value, String> {
    let path = whisper_models::ensure_model(whisper_models::selected_model_key())?;
    let engine = stt::SttEngine::load(&path)?;
    let mut report =
        serde_json::to_value(whisper_models::prepare_report(&path, engine.model_name())).unwrap_or_default();
    let narration = if !config::voice_preferences().narration_enabled() {
        serde_json::json!("off")
    } else {
        match tts::prepare_tts() {
            Ok(voice) => {
                report["tts_voice"] = serde_json::json!(voice);
                serde_json::json!("ready")
            }
            Err(error) => serde_json::json!(format!("unavailable: {error}")),
        }
    };
    report["narration"] = narration;
    Ok(report)
}

fn refine_prompt_cli(args: RefineArgs) -> Result<String, String> {
    let mut prefs = config::voice_preferences();
    let refined = refine::refine_prompt(
        &args.text,
        args.backend.as_deref().unwrap_or(&prefs.refine_provider),
        args.model.as_deref().unwrap_or(&prefs.refine_model),
        args.reasoning_effort.as_deref().unwrap_or(&prefs.refine_effort),
    )?;
    if args.speak {
        let _ = tts::speak_markdown(&refined);
    }
    if let Some(delivery) = args.delivery {
        prefs.refine_send_to = delivery;
    }
    if let Some(command) = args.cmux_command {
        prefs.refine_cmux_command = command;
    }
    if args.auto_submit {
        prefs.refine_cmux_press_enter = true;
        prefs.refine_press_enter = true;
    }
    if cmux_delivery::is_cmux_delivery(&prefs.refine_send_to) {
        match cmux_delivery::deliver_text(&refined, &prefs) {
            Ok(summary) => eprintln!("delivery: {summary}"),
            Err(error) => eprintln!("delivery failed: {error}"),
        }
    }
    Ok(refined)
}
