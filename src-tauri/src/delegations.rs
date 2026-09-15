//! Delegations IPC — list and read subagent live transcripts.

use crate::paths::helix_data_dir;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

pub fn delegation_live_root() -> PathBuf {
    helix_data_dir()
        .join("cache")
        .join("delegation")
        .join("live")
}

/// Ensure the live/delegation directory for `delegation_id` exists and carries
/// a manifest.json carrying `session_id` + a single task entry (goal/status).
///
/// The pi `Agent` tool (pi-subagents extension) is the live writer; this
/// mirrors the on-disk contract the legacy `delegate_task` flow produced so
/// the read side (`delegations_list`) keeps working unchanged: one directory
/// per subagent, a `task-0.log` streamed line by line, and a manifest the
/// session filter + goal/status match rely on.
///
/// `delegation_id` is the pi `toolCallId` (a stable, unique anchor that the
/// front-end `AgentWorkPanel` already matches against `agent.id`).
pub fn ensure_delegation_dir(delegation_id: &str, session_id: &str, goal: &str) -> Option<PathBuf> {
    let root = delegation_live_root();
    let dir = root.join(delegation_id);
    if std::fs::create_dir_all(&dir).is_err() {
        eprintln!(
            "[delegations] create_dir_all failed for {}: {:?}",
            delegation_id, dir
        );
        return None;
    }
    let manifest_path = dir.join("manifest.json");
    // Only write the manifest when absent so a completion/status update below
    // is the sole re-writer and we never clobber a finished entry mid-read.
    if !manifest_path.exists() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| (d.as_secs_f64() * 1000.0) as i128)
            .map(|ms| json!(ms))
            .unwrap_or(json!(0));
        let manifest = json!({
            "delegation_id": delegation_id,
            "session_id": session_id,
            "started": now,
            "task_count": 1,
            "tasks": [
                {
                    "index": 0,
                    "goal": goal,
                    "status": "running",
                }
            ],
        });
        let data = match serde_json::to_string_pretty(&manifest) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[delegations] manifest serialize failed: {e}");
                return None;
            }
        };
        if std::fs::write(&manifest_path, data).is_err() {
            eprintln!("[delegations] manifest write failed for {delegation_id}");
            return None;
        }
    }
    Some(dir)
}

/// Persist the full `prompt` actually sent to the child into the manifest's
/// first task entry. The pi Agent tool's terminal `subagents:record` carries
/// no prompt, so this disk copy is what survives a gateway restart: without
/// it, a rehydrated card can only ever show the short `goal` label.
///
/// Best-effort, idempotent (skips when already stored), and never blocks the
/// spawn path — any IO/parse failure is logged and swallowed.
pub fn persist_delegation_prompt(dir: &PathBuf, prompt: &str) {
    if prompt.is_empty() {
        return;
    }
    let manifest_path = dir.join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return; // No manifest yet (spawn is still creating it) — nothing to update.
    };
    let Ok(mut manifest) = serde_json::from_str::<Value>(&raw) else {
        eprintln!("[delegations] persist_prompt: parse failed for {manifest_path:?}");
        return;
    };
    if manifest
        .pointer("/tasks/0/prompt")
        .and_then(Value::as_str)
        == Some(prompt)
    {
        return; // Already persisted.
    }
    if let Some(task) = manifest
        .get_mut("tasks")
        .and_then(Value::as_array_mut)
        .and_then(|t| t.first_mut())
    {
        if let Some(obj) = task.as_object_mut() {
            obj.insert("prompt".to_string(), json!(prompt));
        }
    }
    if let Ok(data) = serde_json::to_string_pretty(&manifest) {
        if std::fs::write(&manifest_path, data).is_err() {
            eprintln!("[delegations] persist_prompt: write failed for {manifest_path:?}");
        }
    }
}

/// First task's prompt (the full instruction actually executed by the child),
/// if persisted. Empty on pre-prompt manifests — callers fall back to `goal`.
fn delegation_prompt(deleg_dir: &PathBuf) -> Option<String> {
    read_manifest_tasks(deleg_dir)
        .first()
        .and_then(|t| t.get("prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Append one human-readable progress line to `<dir>/task-0.log`.
///
/// The log is streamed line by line as the subagent runs; `delegations_list`
/// read-tails it for the preview and the front-end log viewer renders it, so
/// a `HH:MM:SS text` compact line is what the UI expects.
pub fn append_delegation_log(dir: &PathBuf, line: &str) {
    let log_path = dir.join("task-0.log");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = ts / 3600 % 24;
    let m = ts / 60 % 60;
    let s = ts % 60;
    let buf = format!("{h:02}:{m:02}:{s:02} {line}\n");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        if f.write_all(buf.as_bytes()).is_err() {
            eprintln!("[delegations] log append failed for {:?}", log_path);
        }
    } else {
        eprintln!("[delegations] log open failed for {:?}", log_path);
    }
}

/// Persist the pi-subagents extension's own agent id into the delegation
/// manifest. `.output` transcripts are named by that id, so it is the only
/// key that can re-locate a child's timeline after a gateway restart (both
/// in-memory routes — the card-bound agentId and subagent_map — die with the
/// process). Called when the id first becomes known (background-start
/// acknowledgement or the terminal subagents:record).
pub fn record_delegation_agent_id(delegation_id: &str, agent_id: &str) {
    if agent_id.is_empty() || agent_id == delegation_id {
        return;
    }
    let manifest_path = delegation_live_root().join(delegation_id).join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return; // No manifest (never spawned through this path) — nothing to record.
    };
    let Ok(mut manifest) = serde_json::from_str::<Value>(&raw) else {
        eprintln!("[delegations] record_agent_id: parse failed for {manifest_path:?}");
        return;
    };
    // Idempotent: skip the rewrite when the id is already there.
    if manifest.get("agent_id").and_then(Value::as_str) == Some(agent_id) {
        return;
    }
    manifest["agent_id"] = json!(agent_id);
    if let Ok(data) = serde_json::to_string_pretty(&manifest) {
        if std::fs::write(&manifest_path, data).is_err() {
            eprintln!("[delegations] record_agent_id: write failed for {manifest_path:?}");
        }
    }
}

/// Flip the single task entry in the manifest to a terminal status
/// (`completed` / `failed` / …) and stamp a `completed` timestamp.
///
/// Best-effort: any IO / parse failure is logged to stderr and swallowed so a
/// broken manifest never blocks the agent's normal completion path.
pub fn mark_delegation_finished(dir: &PathBuf, status: &str, summary: &str) {
    let manifest_path = dir.join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        eprintln!("[delegations] mark_finished: read failed for {manifest_path:?}");
        return;
    };
    let Ok(mut manifest) = serde_json::from_str::<Value>(&raw) else {
        eprintln!("[delegations] mark_finished: parse failed for {manifest_path:?}");
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| (d.as_secs_f64() * 1000.0) as i128)
        .map(|ms| json!(ms))
        .unwrap_or(json!(0));
    if let Some(tasks) = manifest.get_mut("tasks").and_then(|t| t.as_array_mut()) {
        if let Some(first) = tasks.first_mut() {
            if let Some(obj) = first.as_object_mut() {
                obj.insert("status".to_string(), json!(status));
                if !summary.is_empty() {
                    obj.insert("summary".to_string(), json!(summary));
                }
            }
        }
    }
    manifest["completed"] = ts;
    let Ok(data) = serde_json::to_string_pretty(&manifest) else {
        eprintln!("[delegations] mark_finished: serialize failed");
        return;
    };
    if std::fs::write(&manifest_path, data).is_err() {
        eprintln!("[delegations] mark_finished: write failed for {manifest_path:?}");
    }
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

/// Manifest top-level `agent_id` (pi-subagents extension child id), if recorded.
fn manifest_agent_id(deleg_dir: &PathBuf) -> Option<String> {
    let manifest_path = deleg_dir.join("manifest.json");
    let content = std::fs::read_to_string(&manifest_path).ok()?;
    let manifest: Value = serde_json::from_str(&content).ok()?;
    manifest
        .get("agent_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// First task's goal — the sub-agent card description when rebuilding from disk.
fn delegation_goal(deleg_dir: &PathBuf) -> Option<String> {
    read_manifest_tasks(deleg_dir)
        .first()
        .and_then(|t| t.get("goal"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// First task's terminal status (running while the child still executes).
fn delegation_status(deleg_dir: &PathBuf) -> Option<String> {
    read_manifest_tasks(deleg_dir)
        .first()
        .and_then(|t| t.get("status"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// First task's summary (written by mark_delegation_finished).
fn delegation_summary(deleg_dir: &PathBuf) -> Option<String> {
    read_manifest_tasks(deleg_dir)
        .first()
        .and_then(|t| t.get("summary"))
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
pub fn delegations_list(session_id: Option<Value>) -> Value {
    let root = delegation_live_root();
    if !root.exists() {
        return json!({ "ok": true, "delegations": [] });
    }
    // Filter key(s): one sid string, or an array of sids — a conversation can
    // own delegations across several backend sessions (session/new after
    // /clear, resume-recreate after a restart), so the frontend passes every
    // sid the conversation has ever used.
    let wanted_sids: Vec<String> = match &session_id {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    let filter = !wanted_sids.is_empty();

    let mut delegations = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            // Filter by session if requested — read manifest.json.
            if filter
                && !wanted_sids.contains(&delegation_session_id(&path).unwrap_or_default())
            {
                continue;
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
                    if tp.extension().is_some_and(|e| e == "log") {
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
                // Extension-side child id (.output transcript name) — lets the
                // frontend locate the timeline across gateway restarts.
                "agent_id": manifest_agent_id(&path),
                "session_id": delegation_session_id(&path),
            // Top-level `prompt` — the full instruction actually executed by
            // the child (persisted by persist_delegation_prompt). Absent on
            // old manifests; the frontend falls back to `goal`.
            "prompt": delegation_prompt(&path),
            "status": delegation_status(&path),
            "goal": delegation_goal(&path),
            "summary": delegation_summary(&path),
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

// ── pi-subagents .output transcripts ─────────────────────────────────────────
//
// The pi-subagents extension streams each child's conversation to
//   ~/.pi/agent/subagent-tasks/<encoded-cwd>/<pi session id>/tasks/<agent id>.output
// as JSONL (matching Claude Code's task output format). Background children
// report nothing back to the parent session (their onUpdate stream ends when
// the Agent tool returns), so this file is the only live record of what a
// running sub-agent is doing. The command below turns it into a compact
// tool-call timeline the sidebar can poll.

/// Mirror of output-file.ts `encodeCwd`: separators → '-', strip the Windows
/// DRIVE prefix ("D:-") and then leading dashes. The old implementation used a
/// trim_start_matches character CLASS (alphabetic || ':' || '-'), which for
/// "D:-Project-Helix" consumed the entire string — every Windows path encoded
/// to "" and the direct transcript lookup could never hit.
fn encode_cwd(cwd: &str) -> String {
    let mut s: String = cwd.replace(['/', '\\'], "-");
    // Strip a drive prefix: exactly one [A-Za-z] + ':' + '-' run, not a class.
    let bytes: Vec<char> = s.chars().collect();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == ':' && bytes[2] == '-'
    {
        s = s.chars().skip(3).collect();
    }
    s.trim_start_matches('-').to_string()
}

/// The extension's transcript roots, newest first. The current root is
/// ~/.pi/agent/subagent-tasks (moved out of the OS tmp dir so transcripts
/// survive restarts — the tmp copy only exists for pre-move versions).
fn subagent_task_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".pi").join("agent").join("subagent-tasks"));
    }
    roots.push(std::env::temp_dir().join("pi-subagents-0"));
    roots
}

/// Best-effort `.output` path for a pi-subagents child. Direct layout first;
/// unknown cwd/session falls back to scanning every encoded dir for the id.
fn find_output_file(
    agent_id: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
) -> Option<PathBuf> {
    let file_name = format!("{agent_id}.output");
    for root in subagent_task_roots() {
        if let (Some(cwd), Some(sid)) = (cwd, session_id) {
            let direct = root
                .join(encode_cwd(cwd))
                .join(sid)
                .join("tasks")
                .join(&file_name);
            if direct.is_file() {
                return Some(direct);
            }
        }
        // Fallback: search every project dir for this agent's transcript.
        let entries = std::fs::read_dir(&root).ok()?;
        for proj in entries.flatten() {
            let Ok(sessions) = std::fs::read_dir(proj.path()) else {
                continue;
            };
            for sess in sessions.flatten() {
                let candidate = sess.path().join("tasks").join(&file_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// One line of the compact timeline returned to the sidebar.
#[derive(serde::Serialize)]
pub struct SubagentTimelineEntry {
    /// assistant (tool call) | toolResult
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// running (call seen, no result yet) | success | error
    pub status: String,
    pub timestamp: Option<String>,
}

/// Shorten a preview to ~120 chars.
fn clip(s: &str) -> String {
    let mut out: String = s.chars().take(120).collect();
    if s.chars().count() > 120 {
        out.push('…');
    }
    out
}

/// Short human preview of a toolResult message: first text line.
fn preview_of(message: &Value) -> Option<String> {
    let blocks = message.get("content").and_then(Value::as_array)?;
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = block.get("text").and_then(Value::as_str) {
                let first = t.lines().next().unwrap_or("");
                if !first.is_empty() {
                    return Some(clip(first));
                }
            }
        }
    }
    None
}

/// First string value of a toolCall arguments object (command / prompt / path…).
fn arg_preview(args: Option<&Value>) -> Option<String> {
    let Value::Object(map) = args? else {
        return None;
    };
    for v in map.values() {
        if let Value::String(s) = v {
            if !s.is_empty() {
                return Some(clip(s));
            }
        }
    }
    None
}

#[tauri::command]
pub fn subagent_timeline(
    agent_id: String,
    cwd: Option<String>,
    session_id: Option<String>,
    tail: Option<usize>,
) -> Value {
    let Some(path) = find_output_file(&agent_id, cwd.as_deref(), session_id.as_deref()) else {
        return json!({ "ok": true, "found": false, "entries": [] });
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return json!({ "ok": true, "found": false, "entries": [] });
    };
    let tail = tail.unwrap_or(80);

    let mut timeline: Vec<SubagentTimelineEntry> = Vec::new();
    // toolCallId → index in `timeline`, so a toolResult closes its open call.
    let mut open_calls: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for line in content.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Skip the initial prompt entry (the raw user prompt) and compaction
        // artifacts — the timeline is tool activity.
        let Some(message) = entry.get("message") else {
            continue;
        };
        let ts = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                let Some(blocks) = message.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("toolCall") {
                        continue;
                    }
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let preview = arg_preview(block.get("arguments"));
                    open_calls.insert(call_id, timeline.len());
                    timeline.push(SubagentTimelineEntry {
                        kind: "assistant".into(),
                        tool_name: Some(name),
                        preview,
                        status: "running".into(),
                        timestamp: ts.clone(),
                    });
                }
            }
            Some("toolResult") => {
                let call_id = message
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let is_error = message
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let preview = preview_of(message);
                if let Some(idx) = open_calls.remove(&call_id) {
                    let e = &mut timeline[idx];
                    e.status = if is_error {
                        "error".into()
                    } else {
                        "success".into()
                    };
                    if preview.is_some() {
                        e.preview = preview;
                    }
                    continue;
                }
                // Result without its call (compaction trimmed it) — standalone
                // line so nothing is silently lost.
                timeline.push(SubagentTimelineEntry {
                    kind: "toolResult".into(),
                    tool_name: message
                        .get("toolName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    preview,
                    status: if is_error {
                        "error".into()
                    } else {
                        "success".into()
                    },
                    timestamp: ts,
                });
            }
            _ => {}
        }
    }

    let total = timeline.len();
    let start = total.saturating_sub(tail);
    json!({
        "ok": true,
        "found": true,
        "path": path.to_string_lossy(),
        "total": total,
        "entries": &timeline[start..],
    })
}

#[cfg(test)]
mod tests {
    use super::encode_cwd;

    #[test]
    fn encode_cwd_matches_extension_layout() {
        // Mirror of output-file.ts: separators → '-', strip "D:-" drive prefix,
        // strip leading dashes. The old char-class trim turned these into "".
        assert_eq!(encode_cwd(r"D:\Project\Helix"), "Project-Helix");
        assert_eq!(encode_cwd("D:/Project/Helix"), "Project-Helix");
        assert_eq!(
            encode_cwd(r"C:\Users\hyt\.pi\agent\sessions"),
            "Users-hyt-.pi-agent-sessions"
        );
        // POSIX paths: no drive prefix, keep the whole path.
        assert_eq!(encode_cwd("/home/user/proj"), "home-user-proj");
        // No separators at all.
        assert_eq!(encode_cwd("proj"), "proj");
    }
}
