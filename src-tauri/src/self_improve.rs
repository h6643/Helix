//! Self-improve health check report IPC — reads the pi self-improve
//! extension's latest report (~/.pi/agent/helix/self-improve/reports/latest.json).
//!
//! The extension writes `latest.json` (always the newest) plus timestamped
//! copies. Helix only reads here; the extension is the sole writer.

use serde_json::Value;
use std::path::PathBuf;

fn report_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".pi")
        .join("agent")
        .join("helix")
        .join("self-improve")
        .join("reports")
}

/// Read the latest self-improve health check report.
/// Returns { ok: true, report: {...} } or { ok: false, error: "..." }.
#[tauri::command]
pub fn self_improve_report() -> Value {
    let path = report_dir().join("latest.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            return serde_json::json!({
                "ok": true,
                "report": null,
                "error": "报告文件不存在，尚无体检记录"
            });
        }
    };

    match serde_json::from_str::<Value>(&content) {
        Ok(v) => serde_json::json!({ "ok": true, "report": v }),
        Err(e) => serde_json::json!({
            "ok": false,
            "error": format!("JSON 解析失败: {e}")
        }),
    }
}
