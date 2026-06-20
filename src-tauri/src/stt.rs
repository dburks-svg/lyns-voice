//! Local speech-to-text: mic frames -> VAD endpointing -> whisper transcription.
//!
//! The webview captures the mic, decimates to 16 kHz mono Int16, and pushes
//! ~30 ms frames into `stt_push_frame` (raw binary IPC). A `webrtc-vad` state
//! machine buffers each utterance and finalizes it on a trailing pause (the
//! auto-send-on-pause behaviour). The finalized audio is transcribed off-thread
//! with whisper-rs (CPU) and emitted as `stt://final`.
//!
//! Events (Rust -> webview):
//! - `stt://listening` `{active}`  -> drives Listening state + the mic visual
//! - `stt://final` `{text}`        -> the recognized utterance
//! - `stt://error` `{text}`        -> a transcription/model error
//! - `stt://model` `{state, downloaded, total}` -> first-run model download
//!
//! whisper requires f32 mono 16 kHz in [-1, 1]; the VAD pipeline is already
//! 16 kHz mono i16, so we only integer->float convert.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{
    convert_integer_to_float_audio, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters,
};

// --- Model ------------------------------------------------------------------

const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const MODEL_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";

// --- Endpointing tunables (16 kHz, 30 ms frames) ----------------------------

const SAMPLE_RATE: usize = 16_000;
const FRAME: usize = 480; // 30 ms @ 16 kHz (a valid webrtc-vad frame length)
const ONSET_FRAMES: u32 = 3; // ~90 ms of voiced frames opens an utterance
const DEFAULT_HANGOVER_FRAMES: u32 = 27; // ~810 ms of trailing silence ends it
const PREROLL_SAMPLES: usize = FRAME * 10; // ~300 ms kept before onset
const MAX_UTTERANCE_SAMPLES: usize = SAMPLE_RATE * 15; // hard cap (~15 s)
const MIN_UTTERANCE_SAMPLES: usize = SAMPLE_RATE / 4; // discard < ~250 ms as noise

// --- Transcriber ------------------------------------------------------------

/// A loaded whisper model ready to transcribe utterances. Reuse one per app run
/// (model load is the expensive part); make a fresh state per utterance.
pub struct Transcriber {
    ctx: WhisperContext,
    n_threads: i32,
    // Serializes inference: each transcribe uses ~all cores, so overlapping
    // utterances must run one at a time or they oversubscribe the CPU and both
    // slow down. The worker stays responsive (frames keep queueing) meanwhile.
    infer_lock: Mutex<()>,
}

impl Transcriber {
    pub fn load(model_path: &str) -> Result<Self, String> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| format!("load whisper model '{model_path}': {e}"))?;
        let n_threads = std::thread::available_parallelism()
            .map(|n| (n.get() as i32 - 1).max(1))
            .unwrap_or(4);
        Ok(Self { ctx, n_threads, infer_lock: Mutex::new(()) })
    }

    /// Transcribe mono 16 kHz f32 samples in [-1, 1].
    pub fn transcribe_f32(&self, samples: &[f32]) -> Result<String, String> {
        let _serialize = self.infer_lock.lock().map_err(|_| "infer lock poisoned")?;
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| format!("whisper create_state: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.n_threads);
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state
            .full(params, samples)
            .map_err(|e| format!("whisper full: {e}"))?;

        let n = state.full_n_segments();
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = state.get_segment(i) {
                let part = seg
                    .to_str_lossy()
                    .map_err(|e| format!("whisper segment {i}: {e}"))?;
                text.push_str(part.as_ref());
            }
        }
        Ok(text.trim().to_string())
    }

    /// Transcribe mono 16 kHz i16 PCM (the VAD pipeline's native format).
    pub fn transcribe_i16(&self, pcm: &[i16]) -> Result<String, String> {
        let mut samples = vec![0.0f32; pcm.len()];
        convert_integer_to_float_audio(pcm, &mut samples)
            .map_err(|e| format!("whisper i16->f32: {e}"))?;
        self.transcribe_f32(&samples)
    }
}

// --- Event payloads ---------------------------------------------------------

#[derive(Clone, Serialize)]
struct Active {
    active: bool,
}

#[derive(Clone, Serialize)]
struct TextEvent {
    text: String,
}

#[derive(Clone, Serialize)]
struct ModelStatus {
    state: &'static str,
    downloaded: u64,
    total: u64,
}

// --- Endpointing (pure: VAD classification in, utterance out) ----------------

/// What a frame did to the endpointing state machine.
enum Outcome {
    None,
    SpeechStarted,
    Utterance(Vec<i16>),
}

/// Pure utterance endpointing: fed one exact-length frame + its voiced/unvoiced
/// classification at a time, it opens an utterance after a short voiced onset and
/// closes it after a trailing-silence hangover (or a max-length cap). No VAD and
/// no Tauri here, so the onset/hangover/preroll logic is unit-testable.
struct Endpointer {
    preroll: VecDeque<i16>,
    speech: Vec<i16>,
    in_speech: bool,
    voiced_run: u32,
    silence_run: u32,
    hangover: Arc<AtomicU32>,
}

impl Default for Endpointer {
    fn default() -> Self {
        Self {
            preroll: VecDeque::new(),
            speech: Vec::new(),
            in_speech: false,
            voiced_run: 0,
            silence_run: 0,
            hangover: Arc::new(AtomicU32::new(DEFAULT_HANGOVER_FRAMES)),
        }
    }
}

impl Endpointer {
    fn push(&mut self, voiced: bool, frame: &[i16]) -> Outcome {
        if !self.in_speech {
            self.preroll.extend(frame.iter().copied());
            while self.preroll.len() > PREROLL_SAMPLES {
                self.preroll.pop_front();
            }
            self.voiced_run = if voiced { self.voiced_run + 1 } else { 0 };
            if self.voiced_run >= ONSET_FRAMES {
                self.in_speech = true;
                self.silence_run = 0;
                self.speech.clear();
                self.speech.extend(self.preroll.iter().copied());
                self.preroll.clear();
                return Outcome::SpeechStarted;
            }
            Outcome::None
        } else {
            self.speech.extend_from_slice(frame);
            self.silence_run = if voiced { 0 } else { self.silence_run + 1 };
            let hangover = self.hangover.load(Ordering::Relaxed);
            if self.silence_run >= hangover || self.speech.len() >= MAX_UTTERANCE_SAMPLES {
                Outcome::Utterance(self.take())
            } else {
                Outcome::None
            }
        }
    }

    /// Force-close the current utterance (push-to-talk). None if not in speech.
    fn force(&mut self) -> Option<Vec<i16>> {
        if self.in_speech {
            Some(self.take())
        } else {
            None
        }
    }

    fn take(&mut self) -> Vec<i16> {
        let audio = std::mem::take(&mut self.speech);
        self.in_speech = false;
        self.voiced_run = 0;
        self.silence_run = 0;
        self.preroll.clear();
        audio
    }
}

// --- VAD-driven session (owns the !Send VAD on the worker thread) ------------

struct SttSession {
    vad: webrtc_vad::Vad,
    carry: Vec<i16>, // leftover samples (< FRAME) between pushes
    ep: Endpointer,
}

impl SttSession {
    fn new(hangover: Arc<AtomicU32>) -> Self {
        use webrtc_vad::{SampleRate, Vad, VadMode};
        let vad = Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, VadMode::Quality);
        let mut ep = Endpointer::default();
        ep.hangover = hangover;
        Self { vad, carry: Vec::with_capacity(FRAME * 4), ep }
    }

    /// Re-chunk arrivals into exact VAD frames, classify, and drive endpointing;
    /// emit Listening transitions and spawn a transcription on each endpoint.
    fn push(&mut self, incoming: &[i16], app: &AppHandle, tr: &Arc<Transcriber>) {
        self.carry.extend_from_slice(incoming);
        while self.carry.len() >= FRAME {
            let frame: Vec<i16> = self.carry.drain(..FRAME).collect();
            // webrtc-vad needs an exact-length frame; treat an error as unvoiced.
            let voiced = self.vad.is_voice_segment(&frame).unwrap_or(false);
            match self.ep.push(voiced, &frame) {
                Outcome::SpeechStarted => {
                    let _ = app.emit("stt://listening", Active { active: true });
                }
                Outcome::Utterance(audio) => {
                    let _ = app.emit("stt://listening", Active { active: false });
                    spawn_transcribe(audio, app, tr);
                }
                Outcome::None => {}
            }
        }
    }

    /// Force-finalize the current utterance now (push-to-talk release).
    fn finalize(&mut self, app: &AppHandle, tr: &Arc<Transcriber>) {
        if let Some(audio) = self.ep.force() {
            let _ = app.emit("stt://listening", Active { active: false });
            spawn_transcribe(audio, app, tr);
        }
    }
}

/// Transcribe a finalized utterance off-thread and emit `stt://final`. Drops
/// utterances below the minimum length (almost certainly noise).
fn spawn_transcribe(audio: Vec<i16>, app: &AppHandle, tr: &Arc<Transcriber>) {
    if audio.len() < MIN_UTTERANCE_SAMPLES {
        return;
    }
    let app = app.clone();
    let tr = Arc::clone(tr);
    // Transcription (~1 s) must never run on the IPC/main/worker thread.
    tauri::async_runtime::spawn_blocking(move || match tr.transcribe_i16(&audio) {
        Ok(text) if !text.is_empty() => {
            let _ = app.emit("stt://final", TextEvent { text });
        }
        Ok(_) => {}
        Err(e) => {
            let _ = app.emit("stt://error", TextEvent { text: e });
        }
    });
}

// --- Managed state ----------------------------------------------------------

/// A message to the STT worker thread. The worker owns the VAD + session, which
/// wrap a raw pointer (`!Send`) and so cannot live in shared `State`.
enum WorkerMsg {
    Frames(Vec<i16>),
    Finalize,
}

pub struct SttState {
    transcriber: Mutex<Option<Arc<Transcriber>>>,
    worker: Mutex<Option<std::sync::mpsc::Sender<WorkerMsg>>>,
    hangover: Arc<AtomicU32>,
}

impl Default for SttState {
    fn default() -> Self {
        Self {
            transcriber: Mutex::new(None),
            worker: Mutex::new(None),
            hangover: Arc::new(AtomicU32::new(DEFAULT_HANGOVER_FRAMES)),
        }
    }
}

// --- Commands ---------------------------------------------------------------

/// Load the model (downloading on first run) and start the capture worker. Safe
/// to call repeatedly; the model loads once and the worker is (re)started.
#[tauri::command]
pub async fn stt_start(app: AppHandle) -> Result<(), String> {
    // Load (or reuse) the model race-free: the whole check-and-load runs inside one
    // blocking task while holding the std Mutex, so two concurrent stt_start calls
    // (e.g. a fast double tap-to-talk) serialize on it instead of both downloading.
    // The std lock is never held across an .await, only inside this sync closure.
    let app2 = app.clone();
    let transcriber = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<Transcriber>, String> {
        let state = app2.state::<SttState>();
        let mut guard = state.transcriber.lock().map_err(lock_err)?;
        if let Some(t) = guard.as_ref() {
            return Ok(Arc::clone(t));
        }
        let tr = Arc::new(ensure_and_load(&app2)?);
        *guard = Some(Arc::clone(&tr));
        Ok(tr)
    })
    .await
    .map_err(|e| format!("stt load join: {e}"))?
    .map_err(|e| {
        // Surface the failure so the webview can reset its "Downloading…" caption
        // instead of hanging there forever.
        let _ = app.emit("stt://model", ModelStatus { state: "error", downloaded: 0, total: 0 });
        e
    })?;

    // Spawn (or replace) the worker that owns the VAD + endpointing state. The VAD
    // wraps a raw pointer and is !Send, so it must stay on one thread; the
    // webview's frames reach it only through this channel (non-blocking enqueue).
    let (tx, rx) = std::sync::mpsc::channel::<WorkerMsg>();
    let state = app.state::<SttState>();
    *state.worker.lock().map_err(lock_err)? = Some(tx);
    let hangover = Arc::clone(&state.hangover);
    let app_worker = app.clone();
    std::thread::spawn(move || {
        let mut session = SttSession::new(hangover);
        while let Ok(msg) = rx.recv() {
            match msg {
                WorkerMsg::Frames(pcm) => session.push(&pcm, &app_worker, &transcriber),
                WorkerMsg::Finalize => session.finalize(&app_worker, &transcriber),
            }
        }
    });

    let _ = app.emit("stt://listening", Active { active: false });
    Ok(())
}

/// Push a batch of raw 16 kHz mono Int16 LE audio (the AudioWorklet's frames).
/// Non-blocking: decode and enqueue to the worker.
#[tauri::command]
pub fn stt_push_frame(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("stt_push_frame expects a raw binary body".into()),
    };
    // A real frame batch is < 1 KB; reject anything absurd before allocating.
    if bytes.len() > 64 * 1024 {
        return Err("stt_push_frame body too large".into());
    }
    let pcm: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    if let Some(tx) = app.state::<SttState>().worker.lock().map_err(lock_err)?.as_ref() {
        let _ = tx.send(WorkerMsg::Frames(pcm)); // worker gone => drop frames
    }
    Ok(())
}

/// Force-finalize the current utterance now (push-to-talk release).
#[tauri::command]
pub fn stt_finalize(app: AppHandle) -> Result<(), String> {
    if let Some(tx) = app.state::<SttState>().worker.lock().map_err(lock_err)?.as_ref() {
        let _ = tx.send(WorkerMsg::Finalize);
    }
    Ok(())
}

/// Set the VAD trailing-silence hangover in milliseconds (clamped to 300..2000).
/// Takes effect immediately, even mid-utterance.
#[tauri::command]
pub fn stt_set_vad_hangover(app: AppHandle, ms: u32) -> Result<(), String> {
    let ms = ms.clamp(300, 2000);
    let frames = (ms as f64 / 30.0).round() as u32;
    app.state::<SttState>().hangover.store(frames, Ordering::Relaxed);
    Ok(())
}

/// Stop capturing (end the worker). The model stays loaded for the next start.
/// Flushes any in-progress utterance first, so tapping "stop" mid-sentence still
/// transcribes what was said (mpsc delivers the queued Finalize before the worker
/// sees the Sender drop and exits).
#[tauri::command]
pub fn stt_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SttState>();
    let mut guard = state.worker.lock().map_err(lock_err)?;
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(WorkerMsg::Finalize);
    }
    *guard = None;
    drop(guard);
    let _ = app.emit("stt://listening", Active { active: false });
    Ok(())
}

// --- Model resolution + download --------------------------------------------

fn ensure_and_load(app: &AppHandle) -> Result<Transcriber, String> {
    let path = model_path(app)?;
    if !path.exists() {
        download_model(app, &path)?;
    }
    let path_str = path.to_str().ok_or("model path is not valid UTF-8")?;
    Transcriber::load(path_str)
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create models dir: {e}"))?;
    Ok(dir.join(MODEL_FILE))
}

fn download_model(app: &AppHandle, dest: &Path) -> Result<(), String> {
    let _ = app.emit(
        "stt://model",
        ModelStatus { state: "downloading", downloaded: 0, total: 0 },
    );
    // Explicit timeouts so a stalled/half-open socket cannot park the load thread
    // forever (the first tap-to-talk awaits this). 15 min is a generous overall cap
    // for the ~140 MB download while still bounding a true hang.
    let resp = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| format!("http client: {e}"))?
        .get(MODEL_URL)
        .send()
        .map_err(|e| format!("model download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("model download HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    // Sanity cap: the known model is ~142 MB. Reject an absurd body (hijacked URL)
    // before it can fill the disk, even though the checksum would reject it later.
    const MAX_MODEL_BYTES: u64 = 512 * 1024 * 1024;
    if total > MAX_MODEL_BYTES {
        return Err(format!("model too large: {total} bytes"));
    }

    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create temp model: {e}"))?;
    let mut hasher = Sha256::new();
    let mut reader = resp;
    let mut buf = vec![0u8; 1 << 16];
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    // Remove the partial file on any early exit (read/write error or size cap), so
    // an interrupted download never leaves a stale .part behind.
    let fail = |tmp: &Path, msg: String| -> String {
        let _ = std::fs::remove_file(tmp);
        msg
    };
    loop {
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) => return Err(fail(&tmp, format!("model read: {e}"))),
        };
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        if let Err(e) = file.write_all(&buf[..n]) {
            return Err(fail(&tmp, format!("model write: {e}")));
        }
        downloaded += n as u64;
        if downloaded > MAX_MODEL_BYTES {
            return Err(fail(&tmp, "model exceeded size cap".into()));
        }
        if downloaded - last_emit >= 4_000_000 {
            last_emit = downloaded;
            let _ = app.emit(
                "stt://model",
                ModelStatus { state: "downloading", downloaded, total },
            );
        }
    }
    file.flush().ok();
    drop(file);

    let digest = format!("{:x}", hasher.finalize());
    if digest != MODEL_SHA256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("model checksum mismatch (got {digest})"));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("finalize model: {e}"))?;
    let _ = app.emit(
        "stt://model",
        ModelStatus { state: "ready", downloaded, total },
    );
    Ok(())
}

fn lock_err<T>(_: std::sync::PoisonError<T>) -> String {
    "stt state lock poisoned".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> Vec<i16> {
        vec![0i16; FRAME]
    }

    #[test]
    fn endpointer_opens_after_onset_closes_after_hangover() {
        let mut ep = Endpointer::default();
        let f = frame();

        // A lone voiced blip then silence must NOT open an utterance.
        assert!(matches!(ep.push(true, &f), Outcome::None));
        assert!(matches!(ep.push(false, &f), Outcome::None));

        // ONSET_FRAMES consecutive voiced frames opens it (on the Nth).
        for _ in 0..ONSET_FRAMES - 1 {
            assert!(matches!(ep.push(true, &f), Outcome::None));
        }
        assert!(matches!(ep.push(true, &f), Outcome::SpeechStarted));

        // Some speech, then a trailing-silence hangover closes it (on the last).
        for _ in 0..5 {
            assert!(matches!(ep.push(true, &f), Outcome::None));
        }
        for _ in 0..DEFAULT_HANGOVER_FRAMES - 1 {
            assert!(matches!(ep.push(false, &f), Outcome::None));
        }
        match ep.push(false, &f) {
            Outcome::Utterance(audio) => assert!(!audio.is_empty()),
            _ => panic!("expected an utterance once the hangover elapsed"),
        }
    }

    #[test]
    fn endpointer_force_finalizes_only_while_in_speech() {
        let mut ep = Endpointer::default();
        let f = vec![100i16; FRAME];
        assert!(ep.force().is_none()); // idle -> nothing

        for _ in 0..ONSET_FRAMES {
            ep.push(true, &f);
        }
        let audio = ep.force().expect("in speech -> some audio");
        assert!(!audio.is_empty());
        assert!(ep.force().is_none()); // already finalized -> idempotent
    }

    #[test]
    fn endpointer_includes_preroll_before_onset() {
        let mut ep = Endpointer::default();
        let f = frame();
        // One pre-onset (unvoiced) frame should be retained as pre-roll, so the
        // captured utterance is longer than just the onset frames themselves.
        ep.push(false, &f);
        for _ in 0..ONSET_FRAMES {
            ep.push(true, &f);
        }
        let audio = ep.force().expect("in speech");
        assert!(audio.len() > FRAME * ONSET_FRAMES as usize);
    }

    /// Read a 16-bit mono WAV into i16 samples by locating the `data` chunk.
    fn read_wav_i16(path: &str) -> Result<Vec<i16>, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let pos = bytes
            .windows(4)
            .position(|w| w == b"data")
            .ok_or("no data chunk in WAV")?;
        let data = &bytes[pos + 8..]; // skip "data" + u32 length
        Ok(data
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect())
    }

    // Spike C: proves whisper-rs builds + measures latency on the real CPU.
    // Run: set Q_MODEL + Q_WAV, then `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore = "loads a whisper model; set Q_MODEL + Q_WAV, run with --ignored"]
    fn transcribe_sample() {
        let model = std::env::var("Q_MODEL").expect("set Q_MODEL");
        let wav = std::env::var("Q_WAV").expect("set Q_WAV");
        let pcm = read_wav_i16(&wav).expect("read wav");
        eprintln!(
            "audio: {} samples (~{:.1}s @16kHz)",
            pcm.len(),
            pcm.len() as f32 / 16000.0
        );

        let t0 = std::time::Instant::now();
        let tr = Transcriber::load(&model).expect("load model");
        let load_ms = t0.elapsed().as_millis();

        let t1 = std::time::Instant::now();
        let text = tr.transcribe_i16(&pcm).expect("transcribe");
        let infer_ms = t1.elapsed().as_millis();

        eprintln!("=== SPIKE C RESULT ===");
        eprintln!("model    = {model}");
        eprintln!("load_ms  = {load_ms}");
        eprintln!("infer_ms = {infer_ms}");
        eprintln!("text     = {text}");
        assert!(!text.is_empty(), "expected a non-empty transcript");
    }
}
