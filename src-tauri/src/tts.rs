//! Native text-to-speech: synthesize a line to an in-memory WAV byte buffer.
//!
//! On Windows this drives SAPI (`ISpVoice` -> `ISpStream` over an HGLOBAL-backed
//! `IStream`) entirely in-process, with NO `powershell.exe` child. The earlier
//! browser-overlay route shelled out to PowerShell `System.Speech`, which tripped
//! BitDefender's behavioral engine (see the project memory); doing it in-process
//! removes that whole class of antivirus/update friction.
//!
//! The resulting WAV bytes are handed to the webview's existing `MediaTts`, which
//! decodes them through Web Audio and drives the Speaking animation from the real
//! amplitude envelope (the spec's "capture the TTS output stream", finally
//! feasible here).
//!
//! The command is `async` so it never blocks the Tauri main thread; the blocking
//! COM/SAPI work runs on a `spawn_blocking` task that owns its own COM apartment.

use tauri::ipc::Response;

/// List the names of all installed SAPI voices on this system.
#[tauri::command]
pub async fn tts_list_voices() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(list_voices)
        .await
        .map_err(|e| format!("TTS list voices join: {e}"))?
}

/// Synthesize `text` to a WAV byte buffer. `rate` is the SAPI rate, clamped to
/// `-10..=10` (0 = normal). `pitch` is the SAPI pitch offset, clamped to
/// `-10..=10` (0 = normal). `voice` selects a specific voice by name (None =
/// system default). Returns the raw WAV bytes as a binary IPC `Response`
/// (an `ArrayBuffer` on the JS side), or an error string the frontend falls back
/// on (so a synthesis failure degrades gracefully rather than throwing).
#[tauri::command]
pub async fn tts_synthesize(text: String, rate: Option<i32>, pitch: Option<i32>, voice: Option<String>) -> Result<Response, String> {
    if text.trim().is_empty() {
        return Err("text is empty".into());
    }
    // Bound the worst case: cap utterance length so one call can never allocate an
    // unbounded multi-MB WAV (and the RIFF u32 size fields can never wrap). A real
    // utterance is far under this; Phase 3 sentence-chunks long replies anyway.
    const MAX_CHARS: usize = 5000;
    let char_count = text.chars().count();
    if char_count > MAX_CHARS {
        return Err(format!("text too long ({char_count} chars; max {MAX_CHARS})"));
    }
    let rate = rate.unwrap_or(0).clamp(-10, 10);
    let pitch = pitch.unwrap_or(0).clamp(-10, 10);
    let wav = tauri::async_runtime::spawn_blocking(move || synth_to_wav(&text, rate, pitch, voice.as_deref()))
        .await
        .map_err(|e| format!("TTS task failed to join: {e}"))??;
    Ok(Response::new(wav))
}

/// Wrap raw little-endian PCM in a canonical 44-byte RIFF/WAVE header. If `pcm`
/// already begins with `RIFF` (a full WAV), it is returned unchanged so we never
/// double-wrap. Gated to the targets that use it (the Windows synth path and the
/// tests) so a non-Windows build emits no dead-code warning.
#[cfg(any(windows, test))]
fn build_wav(pcm: &[u8], channels: u16, sample_rate: u32, bits_per_sample: u16) -> Vec<u8> {
    if pcm.len() >= 4 && &pcm[..4] == b"RIFF" {
        return pcm.to_vec();
    }
    let block_align: u16 = channels * (bits_per_sample / 8);
    let byte_rate: u32 = sample_rate * block_align as u32;
    let data_len: u32 = pcm.len() as u32;

    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36u32 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

#[cfg(windows)]
fn synth_to_wav(text: &str, rate: i32, pitch: i32, voice_name: Option<&str>) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    // Balances a successful CoInitializeEx via Drop, so the apartment is released
    // even if synthesis unwinds (panics). spawn_blocking reuses pool threads, so a
    // skipped CoUninitialize would otherwise leak the apartment onto the next call.
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // RPC_E_CHANGED_MODE: COM is already initialized on this thread in a
        // different apartment mode. It is still usable, but we must NOT balance
        // it (we did not add a reference), so no guard in that case.
        let _guard = if hr == RPC_E_CHANGED_MODE {
            None
        } else {
            hr.ok().map_err(|e| format!("CoInitializeEx failed: {e}"))?;
            Some(ComGuard)
        };

        // Every COM interface is created and dropped inside synth_inner, so all
        // are released before _guard runs CoUninitialize at scope end (releasing
        // after uninit is UB). The guard also runs on unwind.
        synth_inner(text, rate, pitch, voice_name)
    }
}

#[cfg(windows)]
unsafe fn synth_inner(text: &str, rate: i32, pitch: i32, voice_name: Option<&str>) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    use std::ptr;
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::Media::Audio::{WAVEFORMATEX, WAVE_FORMAT_PCM};
    use windows::Win32::Media::Speech::{
        ISpStream, ISpVoice, SpStream, SpVoice, SPF_DEFAULT, SPF_IS_NOT_XML,
    };
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL, STREAM_SEEK_SET};

    // SAPI's wave-stream format GUID. The 0.61 `windows` crate does not export
    // SPDFID_WaveFormatEx, so we define SAPI's documented constant ourselves.
    const SPDFID_WAVEFORMATEX: GUID = GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);

    // 22.05 kHz, 16-bit, mono: SAPI's standard PCM format (good quality, small).
    const CHANNELS: u16 = 1;
    const SAMPLE_RATE: u32 = 22_050;
    const BITS: u16 = 16;
    let block_align: u16 = CHANNELS * (BITS / 8);

    let voice: ISpVoice =
        CoCreateInstance(&SpVoice, None, CLSCTX_ALL).map_err(|e| format!("create SpVoice: {e}"))?;
    let base = CreateStreamOnHGlobal(HGLOBAL(ptr::null_mut()), true)
        .map_err(|e| format!("create stream: {e}"))?;
    let sp_stream: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL)
        .map_err(|e| format!("create SpStream: {e}"))?;

    let wfx = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: BITS,
        cbSize: 0,
    };

    sp_stream
        .SetBaseStream(&base, &SPDFID_WAVEFORMATEX, &wfx)
        .map_err(|e| format!("SetBaseStream: {e}"))?;
    voice
        .SetOutput(&sp_stream, false)
        .map_err(|e| format!("SetOutput: {e}"))?;
    if let Some(name) = voice_name {
        select_voice_by_name(&voice, name)?;
    }
    voice.SetRate(rate).map_err(|e| format!("SetRate: {e}"))?;

    let (speak_text, flags) = if pitch != 0 {
        // Wrap in SAPI XML pitch tag; escape user text so '<' is not parsed.
        let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        let xml = format!("<pitch absmiddle=\"{pitch}\"/>{escaped}");
        (xml, SPF_DEFAULT.0 as u32)
    } else {
        (text.to_string(), (SPF_DEFAULT.0 | SPF_IS_NOT_XML.0) as u32)
    };
    let mut wide: Vec<u16> = speak_text.encode_utf16().collect();
    wide.push(0);
    voice
        .Speak(PCWSTR(wide.as_ptr()), flags, None)
        .map_err(|e| format!("Speak: {e}"))?;

    // Speak was synchronous, so the PCM is fully written; read it back from the
    // base stream (logical EOF stops the loop at exactly the written length).
    base.Seek(0, STREAM_SEEK_SET, None)
        .map_err(|e| format!("Seek: {e}"))?;
    let mut pcm: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let mut read: u32 = 0;
        base.Read(
            buf.as_mut_ptr() as *mut c_void,
            buf.len() as u32,
            Some(&mut read),
        )
        .ok()
        .map_err(|e| format!("stream Read: {e}"))?;
        if read == 0 {
            break;
        }
        // Clamp defensively: a correct IStream never reports more than `cb`, but
        // this guarantees the slice can never panic regardless of the stream impl.
        let n = (read as usize).min(buf.len());
        pcm.extend_from_slice(&buf[..n]);
    }

    Ok(build_wav(&pcm, CHANNELS, SAMPLE_RATE, BITS))
}

/// Registry categories SAPI exposes installed voices under. SAPI5 (`Speech\Voices`)
/// holds the classic "Desktop" voices; `Speech_OneCore\Voices` holds the more natural
/// modern voices (and male voices like Mark) the SAPI5 category never lists. ISpVoice
/// can both enumerate and bind tokens from either, so we scan both - SAPI5 first so its
/// names keep their historical order, then any OneCore extras.
#[cfg(windows)]
const VOICE_CATEGORIES: [&str; 2] = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices",
];

/// A registry category path as a null-terminated UTF-16 string for SAPI's `SetId`.
#[cfg(windows)]
fn category_id_utf16(path: &str) -> Vec<u16> {
    path.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Remove case-insensitive duplicate names, preserving first-seen order. A voice that
/// somehow appears in both categories is listed once (the SAPI5 occurrence wins).
#[cfg(any(windows, test))]
fn dedupe_preserving_order(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        if seen.insert(name.to_lowercase()) {
            out.push(name);
        }
    }
    out
}

/// Collect the friendly names of every voice token in one SAPI registry category.
/// A category that cannot be opened (e.g. `Speech_OneCore` absent on older Windows)
/// yields an empty list rather than failing, so a missing category never breaks the
/// whole enumeration. Must run inside an initialized COM apartment.
#[cfg(windows)]
unsafe fn names_in_category(category_path: &str) -> Vec<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Speech::{ISpObjectTokenCategory, SpObjectTokenCategory};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    let mut names = Vec::new();
    let cat: ISpObjectTokenCategory =
        match CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL) {
            Ok(c) => c,
            Err(_) => return names,
        };
    let cat_id = category_id_utf16(category_path);
    if cat.SetId(PCWSTR(cat_id.as_ptr()), false).is_err() {
        return names;
    }
    let tokens = match cat.EnumTokens(None, None) {
        Ok(t) => t,
        Err(_) => return names,
    };
    let mut count: u32 = 0;
    if tokens.GetCount(&mut count).is_err() {
        return names;
    }
    for i in 0..count {
        if let Ok(token) = tokens.Item(i) {
            // The token's friendly name is its OWN default value (an ISpObjectToken is
            // an ISpDataKey); read it directly. The earlier OpenKey(null) opened an
            // empty-named subkey, which failed on every token and silently yielded an
            // empty list (an empty voice dropdown + selection always falling to default).
            if let Ok(pw) = token.GetStringValue(PCWSTR::null()) {
                if let Ok(name) = pw.to_string() {
                    if !name.is_empty() {
                        names.push(name);
                    }
                }
            }
        }
    }
    names
}

#[cfg(windows)]
fn list_voices() -> Result<Vec<String>, String> {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    struct ComGuard;
    impl Drop for ComGuard { fn drop(&mut self) { unsafe { CoUninitialize() }; } }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _guard = if hr == RPC_E_CHANGED_MODE { None } else {
            hr.ok().map_err(|e| format!("CoInitializeEx: {e}"))?;
            Some(ComGuard)
        };

        // One apartment, both categories. Each category degrades to empty on error,
        // so a system missing OneCore still returns its SAPI5 voices.
        let mut names = Vec::new();
        for path in VOICE_CATEGORIES {
            names.extend(names_in_category(path));
        }
        Ok(dedupe_preserving_order(names))
    }
}

#[cfg(windows)]
unsafe fn select_voice_by_name(voice: &windows::Win32::Media::Speech::ISpVoice, name: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Speech::{ISpObjectTokenCategory, SpObjectTokenCategory};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    // Search both categories in the same order `list_voices` presents them. A category
    // that fails to open is skipped (continue), matching the tolerant enumeration; only
    // a real SetVoice failure on a matched token is surfaced. Not found stays a silent
    // Ok so an uninstalled saved voice just falls back to the system default.
    for category_path in VOICE_CATEGORIES {
        let cat: ISpObjectTokenCategory =
            match CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL) {
                Ok(c) => c,
                Err(_) => continue,
            };
        let cat_id = category_id_utf16(category_path);
        if cat.SetId(PCWSTR(cat_id.as_ptr()), false).is_err() {
            continue;
        }
        let tokens = match cat.EnumTokens(None, None) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mut count: u32 = 0;
        if tokens.GetCount(&mut count).is_err() {
            continue;
        }
        for i in 0..count {
            if let Ok(token) = tokens.Item(i) {
                // Match on the token's own default value (its friendly name); see the
                // note in names_in_category on why OpenKey(null) was wrong here.
                if let Ok(pw) = token.GetStringValue(PCWSTR::null()) {
                    if pw.to_string().unwrap_or_default() == name {
                        voice.SetVoice(&token).map_err(|e| format!("SetVoice: {e}"))?;
                        return Ok(());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn list_voices() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[cfg(not(windows))]
fn synth_to_wav(_text: &str, _rate: i32, _pitch: i32, _voice_name: Option<&str>) -> Result<Vec<u8>, String> {
    Err("native TTS is only implemented on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::{build_wav, dedupe_preserving_order};

    #[test]
    fn dedupe_keeps_first_seen_order_and_drops_case_insensitive_dups() {
        let input = vec![
            "Microsoft David Desktop".to_string(),
            "Microsoft Zira Desktop".to_string(),
            "Microsoft David".to_string(), // OneCore "David" is distinct from "David Desktop"
            "microsoft david desktop".to_string(), // case-insensitive dup of the first
            "Microsoft Mark".to_string(),
        ];
        let out = dedupe_preserving_order(input);
        assert_eq!(
            out,
            vec![
                "Microsoft David Desktop".to_string(),
                "Microsoft Zira Desktop".to_string(),
                "Microsoft David".to_string(),
                "Microsoft Mark".to_string(),
            ]
        );
    }

    #[test]
    fn dedupe_handles_empty_input() {
        assert!(dedupe_preserving_order(Vec::new()).is_empty());
    }

    #[test]
    fn wraps_pcm_with_a_44_byte_header() {
        let pcm = [0u8, 1, 2, 3, 4, 5, 6, 7]; // 8 bytes
        let wav = build_wav(&pcm, 1, 22_050, 16);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // RIFF chunk size = 36 + data_len; data_len = pcm.len()
        assert_eq!(u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]), 36 + 8);
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 8);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[44..], &pcm);
        // 22050 Hz, 16-bit mono -> blockAlign 2, byteRate 44100
        assert_eq!(u16::from_le_bytes([wav[32], wav[33]]), 2);
        assert_eq!(u32::from_le_bytes([wav[28], wav[29], wav[30], wav[31]]), 44_100);
    }

    #[test]
    fn passes_through_an_existing_riff_wav() {
        let mut already = b"RIFF".to_vec();
        already.extend_from_slice(&[0xAA; 20]);
        assert_eq!(build_wav(&already, 1, 22_050, 16), already);
    }

    // Spike F: exercises the REAL SAPI engine end to end (no audio device needed;
    // output goes to the in-memory stream). Ignored so the default suite stays
    // hermetic; run explicitly: `cargo test -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore = "drives the real SAPI engine; run with --ignored"]
    fn synthesizes_a_real_wav() {
        let wav = super::synth_to_wav("Testing native speech synthesis, sir.", 0, 0, None)
            .expect("synthesis should succeed");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let sample_rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        let bits = u16::from_le_bytes([wav[34], wav[35]]);
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert_eq!(sample_rate, 22_050);
        assert_eq!(bits, 16);
        assert!(data_len > 2000, "expected real audio, only got {data_len} PCM bytes");
        assert_eq!(wav.len(), 44 + data_len);

        // Drop it where the owner can audition it if they want.
        let out = std::env::temp_dir().join("q-tts-test.wav");
        std::fs::write(&out, &wav).expect("write wav");
        eprintln!("wrote {} bytes to {}", wav.len(), out.display());
    }

    // Diagnostic: print what list_voices() actually returns against the real
    // registry on this machine. Run with --ignored --nocapture.
    #[cfg(windows)]
    #[test]
    #[ignore = "queries the real SAPI registry; run with --ignored --nocapture"]
    fn lists_real_voices() {
        let voices = super::list_voices().expect("list_voices should succeed");
        eprintln!("list_voices returned {} voice(s):", voices.len());
        for v in &voices {
            eprintln!("  - {v}");
        }
        assert!(!voices.is_empty(), "expected at least one installed voice");
    }

    // Proves an OneCore voice token both binds to the legacy ISpVoice and produces
    // real PCM (not just that it lists) - the one technical risk in widening voice
    // enumeration to the Speech_OneCore category. "Microsoft Mark" is a male voice
    // that exists only under OneCore on this class of machine. Ignored (drives the
    // real engine; the named voice must be installed): run with --ignored.
    #[cfg(windows)]
    #[test]
    #[ignore = "drives the real SAPI engine and needs an OneCore Mark voice installed; run with --ignored"]
    fn synthesizes_with_a_onecore_voice() {
        // Select by the real enumerated friendly name (which carries a language suffix),
        // so this genuinely exercises selection instead of silently falling back to the
        // default voice. "Mark" exists only under OneCore on this class of machine.
        let voices = super::list_voices().expect("list_voices should succeed");
        let mark = voices
            .iter()
            .find(|v| v.to_lowercase().contains("mark"))
            .unwrap_or_else(|| panic!("no Mark voice installed; have: {voices:?}"));
        eprintln!("synthesizing with: {mark}");

        let wav = super::synth_to_wav("Testing the OneCore voice, sir.", 0, 0, Some(mark))
            .expect("synthesis with an OneCore voice should succeed");
        assert_eq!(&wav[0..4], b"RIFF");
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert!(data_len > 2000, "expected real audio from OneCore voice, only got {data_len} PCM bytes");

        let out = std::env::temp_dir().join("q-tts-onecore-test.wav");
        std::fs::write(&out, &wav).expect("write wav");
        eprintln!("wrote {} bytes to {}", wav.len(), out.display());
    }
}
