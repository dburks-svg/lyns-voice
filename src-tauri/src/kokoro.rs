//! Local neural text-to-speech: Kokoro-82M run in-process via ONNX Runtime (`ort`).
//!
//! Mirrors `stt.rs`: artifacts download once on first use to `app_data_dir`, and a
//! single loaded `Synthesizer` is reused for the whole run (model load is the
//! expensive part). The stack is deliberately permissive so Q stays MIT-shippable:
//! Kokoro ONNX is Apache-2.0, `misaki-rs` (G2P) is MIT with its espeak feature OFF,
//! and `ort`/onnxruntime are MIT. No Python, no child process, no GPL.
//!
//! Pipeline: text --misaki--> IPA phonemes --vocab--> token ids --ort--> 24 kHz f32
//! --> i16 PCM --> WAV (reusing `tts::build_wav`). The output format (24 kHz mono
//! 16-bit) is wrapped exactly like the SAPI path, so the webview's `MediaTts` plays
//! it and drives the Speaking animation from the amplitude envelope unchanged.
//!
//! The phoneme->id vocab is read from the downloaded `config.json` at runtime
//! (rather than embedding a hand-copied table), so it is always exactly Kokoro's.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use misaki_rs::{Language, G2P};
use ort::session::Session;
use ort::value::Tensor;

// --- Artifacts (onnx-community/Kokoro-82M-v1.0-ONNX) -------------------------

const HF_BASE: &str = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";

// fp16 model (~163 MB): loads cleanly in onnxruntime 1.24 on CPU. The int8 / q8f16
// quantized variants SEGFAULT onnxruntime on load on this stack, so do not use them.
// fp32 ("onnx/model.onnx", ~326 MB) is the fallback if fp16 ever misbehaves.
const MODEL_REMOTE: &str = "onnx/model_fp16.onnx";
const MODEL_FILE: &str = "kokoro-fp16.onnx";
// SHA-256 of model_fp16.onnx (the file verified to load + speak). Empty would skip
// the check; pinning restores supply-chain integrity like the STT model. The
// downloader verifies this on every download, including resumed ones (it re-hashes
// the on-disk prefix before appending, mirroring stt.rs).
const MODEL_SHA256: &str = "ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a";

// The phoneme->id vocab lives in the ORIGINAL Kokoro repo's config.json; the
// onnx-community ONNX repo's config.json has only `model_type` (no vocab).
const VOCAB_CONFIG_URL: &str = "https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/config.json";
const CONFIG_FILE: &str = "kokoro-vocab.json";

const DEFAULT_VOICE: &str = "bf_emma";
const SAMPLE_RATE: u32 = 24_000; // Kokoro's native output rate
const CHANNELS: u16 = 1;
const BITS: u16 = 16;
const STYLE_DIM: usize = 256; // each voice style vector is 256-dim
// Kokoro's context is 512 ids; reserve 2 for the start/end pad tokens.
const MAX_PHONEME_TOKENS: usize = 510;

/// The English v1.0 voices Q offers in the dropdown. `af_*` American female,
/// `am_*` American male, `bf_*`/`bm_*` British female/male. Each downloads on
/// demand as a raw little-endian f32 `.bin` shaped `[rows, 256]`.
const VOICES: &[&str] = &[
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam",
    "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
    "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

/// Voice ids for the frontend dropdown (Kokoro engine selected).
pub fn voice_ids() -> Vec<String> {
    VOICES.iter().map(|s| s.to_string()).collect()
}

// --- Progress events (Rust -> webview), parallel to stt's `stt://model` --------

#[derive(Clone, Serialize)]
struct ModelStatus {
    /// "downloading" | "ready" | "error"
    state: &'static str,
    /// which artifact: "model" | "config" | "voice"
    file: String,
    downloaded: u64,
    total: u64,
}

// --- Synthesizer ------------------------------------------------------------

/// A loaded Kokoro model + G2P + vocab, reused for the whole app run. Voice style
/// tables are cached as they are first used. `infer_lock` serializes inference for
/// the same reason STT does: one synth saturates the CPU, so overlapping calls
/// would only oversubscribe and slow each other.
pub struct Synthesizer {
    // `ort::Session::run` takes `&mut self`, so the session lives behind a Mutex;
    // the lock also serializes inference (one synth saturates the CPU, so overlapping
    // calls would only oversubscribe and slow each other).
    session: Mutex<Session>,
    g2p: Mutex<G2P>,
    vocab: HashMap<char, i64>,
    models_dir: PathBuf,
    voices: Mutex<HashMap<String, Vec<f32>>>,
    app: AppHandle,
}

impl Synthesizer {
    /// Synthesize `text` with `voice` at `speed` (1.0 = normal) into WAV bytes.
    fn synthesize(&self, text: &str, voice: &str, speed: f32) -> Result<Vec<u8>, String> {
        // 1. text -> IPA phonemes (misaki; espeak feature is OFF so this is GPL-free).
        let phonemes = {
            let g = self.g2p.lock().unwrap_or_else(|e| e.into_inner());
            g.g2p(text).map_err(|e| format!("g2p: {e}"))?.0
        };

        // 2. phonemes -> Kokoro token ids via the model's own vocab (chars not in the
        //    vocab are simply dropped, matching the reference pipeline).
        let ids: Vec<i64> = phonemes
            .chars()
            .filter_map(|c| self.vocab.get(&c).copied())
            .collect();
        if ids.is_empty() {
            return Err("no pronounceable tokens for input".into());
        }

        // 3. The model's window is MAX_PHONEME_TOKENS. Long inputs are synthesized in
        //    windows split at space tokens and concatenated. This used to be a silent
        //    `truncate(MAX_PHONEME_TOKENS)`: reading a document aloud dropped
        //    everything past ~400 chars of each chunk and trailed off quiet near the
        //    window edge (live-test report: "cuts out on long text").
        let space = self.vocab.get(&' ').copied();
        let mut samples: Vec<f32> = Vec::new();
        for (i, window) in split_token_windows(&ids, space, MAX_PHONEME_TOKENS)
            .into_iter()
            .enumerate()
        {
            // Style vector per window (Kokoro selects style by sequence length), and
            // pad token 0 at start AND end (Kokoro's expected input framing).
            let style = self.voice_style(voice, window.len())?;
            let mut input_ids = Vec::with_capacity(window.len() + 2);
            input_ids.push(0);
            input_ids.extend_from_slice(window);
            input_ids.push(0);
            if i > 0 {
                // A 100 ms breath between windows so the seam reads as a pause, not a cut.
                samples.extend(std::iter::repeat(0.0f32).take(SAMPLE_RATE as usize / 10));
            }
            // run inference -> f32 samples in [-1, 1] at 24 kHz.
            samples.extend(self.infer(&input_ids, &style, speed)?);
        }

        // 4. f32 -> little-endian i16 PCM, then wrap with the shared RIFF header.
        Ok(crate::tts::build_wav(&pcm_f32_to_i16le(&samples), CHANNELS, SAMPLE_RATE, BITS))
    }

    /// Run the ONNX graph. NOTE: the three `ort` calls below (tensor construction,
    /// `inputs!`, output extraction) are the only version-sensitive lines in this
    /// module; verify them against the pinned `ort` release at build time, as the
    /// 2.0 rc API has shifted across releases.
    fn infer(&self, input_ids: &[i64], style: &[f32], speed: f32) -> Result<Vec<f32>, String> {
        let n = input_ids.len();

        let ids_t = Tensor::from_array(([1_usize, n], input_ids.to_vec()))
            .map_err(|e| format!("input_ids tensor: {e}"))?;
        let style_t = Tensor::from_array(([1_usize, STYLE_DIM], style.to_vec()))
            .map_err(|e| format!("style tensor: {e}"))?;
        let speed_t = Tensor::from_array(([1_usize], vec![speed]))
            .map_err(|e| format!("speed tensor: {e}"))?;

        // run() takes &mut self; the lock also serializes inference on the CPU.
        let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let outputs = session
            .run(ort::inputs![
                "input_ids" => ids_t,
                "style" => style_t,
                "speed" => speed_t,
            ])
            .map_err(|e| format!("kokoro inference: {e}"))?;

        // Kokoro emits a single audio output.
        let (_shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("extract audio: {e}"))?;
        Ok(data.to_vec())
    }

    /// The 256-dim style row for `voice` at sequence length `n_tokens` (clamped to
    /// the table's last row). Downloads + caches the voice on first use.
    fn voice_style(&self, voice: &str, n_tokens: usize) -> Result<Vec<f32>, String> {
        let mut cache = self.voices.lock().unwrap_or_else(|e| e.into_inner());
        if !cache.contains_key(voice) {
            ensure_voice(&self.app, &self.models_dir, voice)?;
            let data = load_voice_file(&self.models_dir, voice)?;
            cache.insert(voice.to_string(), data);
        }
        let table = &cache[voice];
        let rows = table.len() / STYLE_DIM;
        if rows == 0 {
            return Err(format!("voice '{voice}' table is empty"));
        }
        let row = n_tokens.min(rows - 1);
        let start = row * STYLE_DIM;
        Ok(table[start..start + STYLE_DIM].to_vec())
    }
}

/// Split `ids` into windows of at most `max` tokens, breaking just after the last
/// `space` token in an over-full window so seams land between words (hard cut only
/// when a window has no space at all). Every token is preserved in order; the old
/// behavior silently truncated at `max`. Pure; unit-tested.
fn split_token_windows<'a>(ids: &'a [i64], space: Option<i64>, max: usize) -> Vec<&'a [i64]> {
    let mut out = Vec::new();
    let mut rest = ids;
    while rest.len() > max {
        let window = &rest[..max];
        let cut = match space {
            Some(sp) => window
                .iter()
                .rposition(|&t| t == sp)
                .map(|p| p + 1)
                .unwrap_or(max),
            None => max,
        };
        out.push(&rest[..cut]);
        rest = &rest[cut..];
    }
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

/// Convert f32 samples in [-1, 1] to little-endian i16 PCM bytes.
fn pcm_f32_to_i16le(samples: &[f32]) -> Vec<u8> {
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        pcm.extend_from_slice(&v.to_le_bytes());
    }
    pcm
}

// --- Managed state + public entry point -------------------------------------

/// App-managed handle to the lazily-loaded synthesizer (registered in `lib.rs`).
#[derive(Default)]
pub struct KokoroState {
    inner: Mutex<Option<Arc<Synthesizer>>>,
}

impl KokoroState {
    /// Get the loaded synthesizer, loading (and downloading on first run) if needed.
    /// The lock is held across the (possibly long) first load so two concurrent
    /// callers cannot both download; subsequent calls are a cheap `Arc` clone.
    fn get_or_load(&self, app: &AppHandle) -> Result<Arc<Synthesizer>, String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let synth = Arc::new(ensure_and_load(app)?);
        *guard = Some(synth.clone());
        crate::mem::log_rss("kokoro_loaded");
        Ok(synth)
    }
}

/// Fire-and-forget warm-up: load the synthesizer (downloading artifacts on first
/// run) off the main thread, so the first spoken reply of a session does not pay
/// the ONNX session cold start as seconds of dead air between turn-end and speech.
/// A no-op once loaded; a failure only logs (the first real synth retries and has
/// its own SAPI fallback).
#[tauri::command]
pub async fn tts_warmup(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KokoroState>();
        if let Err(e) = state.get_or_load(&app) {
            log::warn!("[tts] kokoro warm-up failed (first synth will retry): {e}");
        }
    });
    Ok(())
}

/// Synthesize `text` to WAV bytes using Kokoro. `voice` is a Kokoro voice id (None =
/// the default voice). `speed` is the Kokoro speed multiplier (1.0 = normal).
pub fn synth_to_wav_kokoro(
    app: &AppHandle,
    state: &KokoroState,
    text: &str,
    voice: Option<&str>,
    speed: f32,
) -> Result<Vec<u8>, String> {
    let synth = state.get_or_load(app)?;
    let voice = voice.filter(|v| VOICES.contains(v)).unwrap_or(DEFAULT_VOICE);
    synth.synthesize(text, voice, speed)
}

// --- Model resolution + loading ---------------------------------------------

fn ensure_and_load(app: &AppHandle) -> Result<Synthesizer, String> {
    let dir = models_dir(app)?;

    let model = dir.join(MODEL_FILE);
    if !model.exists() {
        download_file(app, &format!("{HF_BASE}/{MODEL_REMOTE}"), &model, opt_sha(MODEL_SHA256), "model")?;
    }
    let config = dir.join(CONFIG_FILE);
    if !config.exists() {
        download_file(app, VOCAB_CONFIG_URL, &config, None, "config")?;
    }
    let vocab = load_vocab(&config)?;
    // Fetch the default voice up front so the first reply doesn't stall on a download.
    ensure_voice(app, &dir, DEFAULT_VOICE)?;

    // Bound the ONNX Runtime thread pool. By default ort uses one intra-op thread
    // per core and lets them spin-wait between runs, so a single synth saturates the
    // box and the pool keeps cores busy briefly afterward. Cap intra-op threads to
    // ~half the cores (clamped to [1, 4]), keep inter-op at 1, and turn spin-waiting
    // off so synthesis stays responsive and the CPU idles cleanly between replies.
    let intra = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) / 2).clamp(1, 4);
    let session = Session::builder()
        .map_err(|e| format!("ort session builder: {e}"))?
        .with_intra_threads(intra)
        .map_err(|e| format!("ort intra_threads: {e}"))?
        .with_inter_threads(1)
        .map_err(|e| format!("ort inter_threads: {e}"))?
        .with_intra_op_spinning(false)
        .map_err(|e| format!("ort intra spinning: {e}"))?
        .with_inter_op_spinning(false)
        .map_err(|e| format!("ort inter spinning: {e}"))?
        .commit_from_file(&model)
        .map_err(|e| format!("load kokoro model '{}': {e}", model.display()))?;

    Ok(Synthesizer {
        session: Mutex::new(session),
        g2p: Mutex::new(G2P::new(Language::EnglishUS)),
        vocab,
        models_dir: dir,
        voices: Mutex::new(HashMap::new()),
        app: app.clone(),
    })
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("models")
        .join("kokoro");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create kokoro models dir: {e}"))?;
    Ok(dir)
}

fn opt_sha(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Parse Kokoro's phoneme->id map out of the model's `config.json` (`"vocab"`).
fn load_vocab(path: &Path) -> Result<HashMap<char, i64>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read config: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("parse config: {e}"))?;
    let obj = v
        .get("vocab")
        .and_then(|x| x.as_object())
        .ok_or("config.json has no `vocab` object")?;
    let mut map = HashMap::with_capacity(obj.len());
    for (k, val) in obj {
        if let (Some(ch), Some(id)) = (k.chars().next(), val.as_i64()) {
            map.insert(ch, id);
        }
    }
    if map.is_empty() {
        return Err("config.json `vocab` is empty".into());
    }
    Ok(map)
}

/// Download `voices/{voice}.bin` if absent. Size-validated (no published per-voice
/// checksum) to a multiple of the 256-float style width.
fn ensure_voice(app: &AppHandle, dir: &Path, voice: &str) -> Result<(), String> {
    if !VOICES.contains(&voice) {
        return Err(format!("unknown voice '{voice}'"));
    }
    let voices_dir = dir.join("voices");
    std::fs::create_dir_all(&voices_dir).map_err(|e| format!("create voices dir: {e}"))?;
    let path = voices_dir.join(format!("{voice}.bin"));
    if path.exists() {
        return Ok(());
    }
    download_file(app, &format!("{HF_BASE}/voices/{voice}.bin"), &path, None, "voice")?;
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if len == 0 || len % (STYLE_DIM as u64 * 4) != 0 {
        let _ = std::fs::remove_file(&path);
        return Err(format!("voice '{voice}' file has unexpected size {len}"));
    }
    Ok(())
}

/// Read a voice `.bin` as a flat `Vec<f32>` (little-endian, `[rows, 256]`).
fn load_voice_file(dir: &Path, voice: &str) -> Result<Vec<f32>, String> {
    let path = dir.join("voices").join(format!("{voice}.bin"));
    let bytes = std::fs::read(&path).map_err(|e| format!("read voice '{voice}': {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("voice '{voice}' size {} not f32-aligned", bytes.len()));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

// --- Download (mirrors stt.rs: retries, resume, checksum, progress) ----------

fn download_file(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    expected_sha: Option<&str>,
    label: &str,
) -> Result<(), String> {
    let tmp = dest.with_extension("part");
    const MAX_ATTEMPTS: u32 = 4;
    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match try_download(app, url, dest, &tmp, expected_sha, label) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                log::warn!("[tts] {label} download attempt {attempt}/{MAX_ATTEMPTS} failed: {last_err}");
                if attempt < MAX_ATTEMPTS {
                    std::thread::sleep(Duration::from_secs(1u64 << attempt));
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    let _ = app.emit(
        "tts://model",
        ModelStatus { state: "error", file: label.to_string(), downloaded: 0, total: 0 },
    );
    Err(format!("{last_err} (after {MAX_ATTEMPTS} attempts)"))
}

fn try_download(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    tmp: &Path,
    expected_sha: Option<&str>,
    label: &str,
) -> Result<(), String> {
    use reqwest::header::RANGE;
    use reqwest::StatusCode;

    const MAX_BYTES: u64 = 512 * 1024 * 1024;
    let resume_from = std::fs::metadata(tmp).map(|m| m.len()).unwrap_or(0);

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header(RANGE, format!("bytes={resume_from}-"));
    }
    let resp = req.send().map_err(|e| format!("{label} download: {e}"))?;
    let status = resp.status();

    // Resume only when we had a partial AND the server honored the Range (206);
    // a 200 (Range ignored) restarts clean; anything else aborts the attempt.
    let (mut downloaded, total, mut file, mut hasher) = if resume_from > 0 && status == StatusCode::PARTIAL_CONTENT {
        let total = resume_from + resp.content_length().unwrap_or(0);
        // Re-hash the bytes already on disk so the final checksum still covers the whole
        // file (mirrors stt.rs), making a resumed download as trustworthy as a clean one.
        let mut hasher = Sha256::new();
        if expected_sha.is_some() {
            let existing = std::fs::read(tmp).map_err(|e| format!("read partial: {e}"))?;
            hasher.update(&existing);
        }
        let f = std::fs::OpenOptions::new().append(true).open(tmp).map_err(|e| format!("open part: {e}"))?;
        (resume_from, total, f, hasher)
    } else if status.is_success() {
        let total = resp.content_length().unwrap_or(0);
        let f = std::fs::File::create(tmp).map_err(|e| format!("create part: {e}"))?;
        (0u64, total, f, Sha256::new())
    } else {
        return Err(format!("{label} download HTTP {status}"));
    };

    if total > MAX_BYTES {
        return Err(format!("{label} too large ({total} bytes)"));
    }

    // Hash the stream when there is a checksum to verify (always, clean or resumed: a
    // resume pre-hashed the prefix above), or to log a digest for a clean unpinned file.
    let hashing = expected_sha.is_some() || resume_from == 0;
    let mut reader = resp;
    let mut buf = [0u8; 64 * 1024];
    let mut last_emit = downloaded;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("{label} read: {e}"))?;
        if n == 0 {
            break;
        }
        if hashing {
            hasher.update(&buf[..n]);
        }
        file.write_all(&buf[..n]).map_err(|e| format!("{label} write: {e}"))?;
        downloaded += n as u64;
        if downloaded - last_emit >= 2_000_000 {
            last_emit = downloaded;
            let _ = app.emit(
                "tts://model",
                ModelStatus { state: "downloading", file: label.to_string(), downloaded, total },
            );
        }
    }
    drop(file);

    if let Some(expected) = expected_sha {
        // expected_sha set => the whole file was hashed (clean, or resume pre-hashed).
        let digest = format!("{:x}", hasher.finalize());
        if !digest.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(tmp);
            return Err(format!("{label} checksum mismatch (got {digest})"));
        }
    } else if resume_from == 0 {
        // Clean unpinned download: log the digest so this artifact can be pinned later.
        log::info!("[tts] {label} sha256 = {:x}", hasher.finalize());
    }

    std::fs::rename(tmp, dest).map_err(|e| format!("{label} finalize: {e}"))?;
    let _ = app.emit(
        "tts://model",
        ModelStatus { state: "ready", file: label.to_string(), downloaded, total },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f32_to_i16_clamps_and_scales() {
        // 0 -> 0, +1 -> 32767, -1 -> -32767, and out-of-range clamps.
        let pcm = pcm_f32_to_i16le(&[0.0, 1.0, -1.0, 2.0, -2.0]);
        let s: Vec<i16> = pcm
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        assert_eq!(s, vec![0, 32767, -32767, 32767, -32767]);
    }

    #[test]
    fn token_windows_split_after_spaces_and_preserve_every_token() {
        let sp = 99i64;
        let mut ids = Vec::new();
        for _ in 0..100 {
            ids.extend_from_slice(&[1, 2, 3]);
            ids.push(sp);
        }
        let windows = split_token_windows(&ids, Some(sp), 25);
        assert!(windows.iter().all(|w| w.len() <= 25 && !w.is_empty()));
        // Seams land right after a space token (except possibly the final window).
        for w in &windows[..windows.len() - 1] {
            assert_eq!(*w.last().unwrap(), sp);
        }
        // Nothing dropped, order preserved (the old code truncated at max).
        let flat: Vec<i64> = windows.iter().flat_map(|w| w.iter().copied()).collect();
        assert_eq!(flat, ids);
    }

    #[test]
    fn token_windows_hard_cut_without_spaces_and_pass_short_input_through() {
        let ids: Vec<i64> = (0..53).collect();
        let windows = split_token_windows(&ids, None, 25);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].len(), 25);
        assert_eq!(windows[2].len(), 3);
        let flat: Vec<i64> = windows.iter().flat_map(|w| w.iter().copied()).collect();
        assert_eq!(flat, ids);

        let short: Vec<i64> = vec![1, 2, 3];
        assert_eq!(split_token_windows(&short, Some(9), 25), vec![&short[..]]);
    }

    #[test]
    fn vocab_parses_from_config_json() {
        let dir = std::env::temp_dir().join("q-kokoro-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cfg.json");
        std::fs::write(&p, br#"{"vocab":{"a":43,";":1,"$":0}}"#).unwrap();
        let v = load_vocab(&p).unwrap();
        assert_eq!(v.get(&'a'), Some(&43));
        assert_eq!(v.get(&';'), Some(&1));
        assert_eq!(v.get(&'$'), Some(&0));
    }

    #[test]
    fn voice_ids_are_nonempty_and_include_default() {
        let ids = voice_ids();
        assert!(!ids.is_empty());
        assert!(ids.iter().any(|v| v == DEFAULT_VOICE));
    }

    // End-to-end validation against the real model is done out-of-process with the
    // Python onnxruntime smoke test (same onnxruntime version `ort` binds), since a
    // lib unit test has no Tauri AppHandle for the download/app_data path.
}
