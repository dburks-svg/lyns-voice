use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_ENTRIES: usize = 200;
const MAX_TEXT_LEN: usize = 10_000;
const MAX_FILES: usize = 50;
const RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub role: String,
    pub text: String,
    pub timestamp: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct TranscriptFile {
    entries: Vec<TranscriptEntry>,
    /// The project dir the session was connected to when saved. `None` on files
    /// from before this field existed (or nothing was connected): provenance
    /// unknown, so the frontend clears the restored panel on the next connect
    /// rather than show another project's conversation (live-test report).
    #[serde(default)]
    dir: Option<String>,
}

/// What `transcript_load_latest` returns: the entries plus their project-dir
/// provenance, so the frontend can clear the panel when a different dir connects.
#[derive(Clone, Serialize)]
pub struct TranscriptLatest {
    pub dir: Option<String>,
    pub entries: Vec<TranscriptEntry>,
}

fn transcripts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("transcripts"))
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 36 {
        return Err("invalid session id length".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid session id characters".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn transcript_save(
    app: tauri::AppHandle,
    session_id: String,
    entries: Vec<TranscriptEntry>,
    dir: Option<String>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let capped: Vec<TranscriptEntry> = entries
        .into_iter()
        .take(MAX_ENTRIES)
        .map(|mut e| {
            if e.text.len() > MAX_TEXT_LEN {
                e.text.truncate(MAX_TEXT_LEN);
            }
            e
        })
        .collect();

    let out_dir = transcripts_dir(&app)?;
    fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir: {e}"))?;

    let path = out_dir.join(format!("{session_id}.json"));
    let json = serde_json::to_string(&TranscriptFile { entries: capped, dir })
        .map_err(|e| format!("serialize: {e}"))?;

    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn transcript_load_latest(app: tauri::AppHandle) -> Result<TranscriptLatest, String> {
    let dir = transcripts_dir(&app)?;
    if !dir.exists() {
        return Ok(TranscriptLatest { dir: None, entries: vec![] });
    }
    let mut newest: Option<(PathBuf, SystemTime)> = None;
    let entries = fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(meta) = path.metadata() {
            if let Ok(modified) = meta.modified() {
                if newest.as_ref().map_or(true, |(_, t)| modified > *t) {
                    newest = Some((path, modified));
                }
            }
        }
    }
    match newest {
        None => Ok(TranscriptLatest { dir: None, entries: vec![] }),
        Some((path, _)) => {
            let data = fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
            let file: TranscriptFile = serde_json::from_str(&data)
                .unwrap_or(TranscriptFile { entries: vec![], dir: None });
            Ok(TranscriptLatest { dir: file.dir, entries: file.entries })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TranscriptFile;

    #[test]
    fn old_transcript_files_without_a_dir_still_parse() {
        // Files written before the `dir` field existed must load (serde default),
        // reporting provenance-unknown so the frontend clears them on connect.
        let old = r#"{"entries":[{"role":"user","text":"hi","timestamp":1.0}]}"#;
        let file: TranscriptFile = serde_json::from_str(old).expect("parse old format");
        assert_eq!(file.dir, None);
        assert_eq!(file.entries.len(), 1);
    }
}

#[tauri::command]
pub async fn transcript_cleanup(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = transcripts_dir(&app)?;
    if !dir.exists() {
        return Ok(0);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut files: Vec<(PathBuf, u64)> = vec![];
    let entries = fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let modified = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        files.push((path, modified));
    }

    files.sort_by_key(|b| std::cmp::Reverse(b.1));

    let mut removed = 0u32;
    for (i, (path, modified)) in files.iter().enumerate() {
        let expired = now.saturating_sub(*modified) > RETENTION_SECS;
        if i >= MAX_FILES || expired {
            let _ = fs::remove_file(path);
            removed += 1;
        }
    }
    Ok(removed)
}
