use serde::Serialize;
use std::process::Command;

#[derive(Clone, Serialize)]
pub struct CiStatus {
    pub state: String,
}

#[tauri::command]
pub async fn ci_status() -> Result<CiStatus, String> {
    let output = Command::new("gh")
        .args(["run", "list", "--limit", "1", "--json", "status,conclusion"])
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let runs: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("parse error: {e}"))?;

    let state = match runs.first() {
        None => "unknown".to_string(),
        Some(run) => {
            let status = run.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let conclusion = run.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
            match status {
                "completed" => match conclusion {
                    "success" => "green",
                    _ => "red",
                }
                .to_string(),
                "in_progress" | "queued" | "waiting" | "pending" | "requested" => {
                    "yellow".to_string()
                }
                _ => "unknown".to_string(),
            }
        }
    };

    Ok(CiStatus { state })
}
