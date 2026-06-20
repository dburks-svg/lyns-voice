use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const MAX_ENTRIES: usize = 10;
const MAX_PATH_LEN: usize = 260;
const FILE_NAME: &str = "recent-dirs.json";

#[derive(Clone, Serialize, Deserialize)]
struct DirHistory {
    dirs: Vec<String>,
}

fn history_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

#[tauri::command]
pub async fn history_load(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = history_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let history: DirHistory = serde_json::from_str(&data).unwrap_or(DirHistory { dirs: vec![] });
    Ok(history.dirs)
}

#[tauri::command]
pub async fn history_save(app: tauri::AppHandle, dirs: Vec<String>) -> Result<(), String> {
    let validated: Vec<String> = dirs
        .into_iter()
        .filter(|d| !d.is_empty() && d.len() <= MAX_PATH_LEN)
        .take(MAX_ENTRIES)
        .collect();
    let history = DirHistory { dirs: validated };
    let json = serde_json::to_string_pretty(&history).map_err(|e| format!("serialize: {e}"))?;

    let path = history_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
