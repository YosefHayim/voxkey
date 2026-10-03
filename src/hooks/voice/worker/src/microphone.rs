//! Open microphone: the stream stays open for the dictation worker's lifetime, so hotkey
//! down only flips a recording flag. `OpenMicrophone` owns the cpal stream (!Send) and must
//! stay on one thread; `SharedCapture` is the Send handle the preview and capture loops use.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample, StreamConfig};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Clone)]
pub struct SharedCapture {
    samples: Arc<Mutex<Vec<f32>>>,
    recording: Arc<AtomicBool>,
}

impl SharedCapture {
    pub fn begin_capture(&self) {
        self.samples.lock().clear();
        self.recording.store(true, Ordering::SeqCst);
    }

    pub fn end_capture(&self) -> Vec<f32> {
        self.recording.store(false, Ordering::SeqCst);
        std::mem::take(&mut *self.samples.lock())
    }

    pub fn cancel_capture(&self) {
        self.recording.store(false, Ordering::SeqCst);
        self.samples.lock().clear();
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }

    /// The last `seconds` of the current capture.
    pub fn snapshot_tail(&self, seconds: f32) -> Vec<f32> {
        let max = ((SAMPLE_RATE as f32) * seconds.max(0.1)) as usize;
        let buf = self.samples.lock();
        buf[buf.len().saturating_sub(max)..].to_vec()
    }
}

pub struct OpenMicrophone {
    shared: SharedCapture,
    alive: Arc<AtomicBool>,
    _stream: cpal::Stream,
}

impl OpenMicrophone {
    /// Open the default input and start streaming; frames are dropped until `begin_capture`.
    pub fn prime() -> Result<Self, String> {
        let device =
            cpal::default_host().default_input_device().ok_or_else(|| "no default input device".to_string())?;
        let config = device.default_input_config().map_err(|e| format!("input config: {e}"))?;
        let shared = SharedCapture {
            samples: Arc::new(Mutex::new(Vec::with_capacity(SAMPLE_RATE as usize * 8))),
            recording: Arc::new(AtomicBool::new(false)),
        };
        let alive = Arc::new(AtomicBool::new(true));
        let stream_config: StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            SampleFormat::F32 => build_stream(&device, &stream_config, &shared, &alive, |s: f32| s)?,
            SampleFormat::I16 => {
                build_stream(&device, &stream_config, &shared, &alive, |s: i16| s as f32 / i16::MAX as f32)?
            }
            other => return Err(format!("unsupported sample format: {other:?}")),
        };
        stream.play().map_err(|e| format!("stream play: {e}"))?;
        Ok(Self { shared, alive, _stream: stream })
    }

    pub fn shared(&self) -> SharedCapture {
        self.shared.clone()
    }
}

impl Drop for OpenMicrophone {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        self.shared.recording.store(false, Ordering::SeqCst);
    }
}

/// Input stream that mixes to mono, resamples to 16 kHz, and appends while recording.
fn build_stream<T: SizedSample + 'static>(
    device: &cpal::Device,
    config: &StreamConfig,
    shared: &SharedCapture,
    alive: &Arc<AtomicBool>,
    to_f32: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let input_rate = config.sample_rate.0;
    let (sink, recording, alive) = (shared.samples.clone(), shared.recording.clone(), alive.clone());
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if !alive.load(Ordering::Relaxed) || !recording.load(Ordering::Relaxed) {
                    return;
                }
                let samples: Vec<f32> = data.iter().map(|s| to_f32(*s)).collect();
                let mono = downsample_channels(&samples, channels);
                sink.lock().extend_from_slice(&resample_linear(&mono, input_rate, SAMPLE_RATE));
            },
            |err| eprintln!("audio input error: {err}"),
            None,
        )
        .map_err(|e| format!("build stream: {e}"))
}

fn downsample_channels(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    data.chunks(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32).collect()
}

fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input[idx.min(input.len() - 1)];
        let b = input[(idx + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}
