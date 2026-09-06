//! Delegations IPC — list and read subagent live transcripts.

use crate::paths::helix_data_dir;
use serde_json::{json, Value};
use std::path::PathBuf;

fn delegation_live_root() -> PathBuf {
    helix_data_dir()
        .join("cache")
        .join("delegation")
        .join("live")
}

/// Read the manifest.json for a delegation directory, returning the
/// `session_id` field if present.
fn delegation_session_id(deleg_dir: &PathBuf) -> Option<String> {
    let manifest_path = deleg_dir.join("manifest.json");
    let content = std::fs::read_to_string(&manifest_path).ok()?;
    let manifest: Value = serde_json::from_str(&content).ok()?;
    manifest
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Read manifest.json `tasks` array for a delegation dir (goal / status per
/// child task, matched by `task-N` index). Best-effort: empty on any failure.
fn read_manifest_tasks(deleg_dir: &PathBuf) -> Vec<Value> {
    let manifest_path = deleg_dir.join("manifest.json");
    let Ok(content) = std::fs::read_to_string(&manifest_path) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    manifest
        .get("tasks")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub fn delegations_list(session_id: Option<String>) -> Value {
    let root = delegation_live_root();
    if !root.exists() {
        return json!({ "ok": true, "delegations": [] });
    }

    let mut delegations = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            // Filter by session if requested — read manifest.json.
            if let Some(ref sid) = session_id {
                if delegation_session_id(&path).as_ref() != Some(sid) {
                    continue;
                }
            }

            let dir_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Read manifest.json tasks (goal/status per task, by index)
            let manifest_tasks = read_manifest_tasks(&path);

            // Read task logs
            let mut tasks = Vec::new();
            if let Ok(task_entries) = std::fs::read_dir(&path) {
                for te in task_entries.flatten() {
                    let tp = te.path();
                    if tp.extension().map_or(false, |e| e == "log") {
                        let task_name = tp
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let meta = std::fs::metadata(&tp).ok();
                        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        let modified = meta
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);

                        // Read last few lines for preview
                        let preview = read_tail(&tp, 5);

                        // Match manifest goal/status by the `task-N` index in
                        // the filename stem (task-0, task-1, …).
                        let idx = task_name
                            .rsplit('-')
                            .next()
                            .and_then(|s| s.parse::<usize>().ok());
                        let (goal, status) = idx
                            .and_then(|i| manifest_tasks.get(i))
                            .map(|t| {
                                (
                                    t.get("goal")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string()),
                                    t.get("status")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string()),
                                )
                            })
                            .unwrap_or((None, None));

                        let mut task_json = json!({
                            "name": task_name,
                            "path": tp.to_string_lossy(),
                            "size": size,
                            "modified": modified,
                            "preview": preview,
                        });
                        if let Some(g) = goal {
                            task_json["goal"] = json!(g);
                        }
                        if let Some(s) = status {
                            task_json["status"] = json!(s);
                        }
                        tasks.push(task_json);
                    }
                }
            }
            tasks.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));

            delegations.push(json!({
                "id": dir_name,
                "path": root.join(&dir_name).to_string_lossy(),
                "tasks": tasks,
            }));
        }
    }
    delegations.sort_by(|a, b| {
        let id_a = a["id"].as_str().unwrap_or("");
        let id_b = b["id"].as_str().unwrap_or("");
        id_b.cmp(id_a)
    });

    json!({ "ok": true, "delegations": delegations })
}

#[tauri::command]
pub fn delegations_read_log(path: String, lines: Option<usize>) -> Value {
    let log_path = PathBuf::from(&path);
    if !log_path.exists() {
        return json!({ "ok": false, "error": "log file not found" });
    }

    let count = lines.unwrap_or(100);
    let content = read_tail(&log_path, count);
    json!({ "ok": true, "content": content })
}

fn read_tail(path: &PathBuf, lines: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let all_lines: Vec<&str> = content.lines().collect();
    let start = all_lines.len().saturating_sub(lines);
    all_lines[start..].join("\n")
}
