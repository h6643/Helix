//! Background tasks IPC — read the pi-background-tasks extension's shared
//! registry (~/.pi/agent/tasks.json) and manage detached tasks.
//!
//! The registry is written exclusively by the extension (each pi instance
//! does read-modify-write). Helix only reads it here; `tasks_kill` is the
//! single mutating command, mirroring the extension's kill logic (main PID
//! terminate + registry status flip).

use serde_json::{json, Value};
use std::path::PathBuf;

fn tasks_file() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".pi").join("agent").join("tasks.json")
}

fn read_registry() -> Vec<Value> {
    let Ok(content) = std::fs::read_to_string(tasks_file()) else {
        return Vec::new();
    };
    serde_json::from_str::<Value>(&content)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// List background tasks, newest first. Optional session_id filter matches
/// the extension's `session_id` field (the pi session that started the task).
/// A task still marked "running" whose PID no longer exists is reported as
/// failed — the extension reconciles the same way, but Helix may poll while
/// no pi instance is alive to do it.
#[tauri::command]
pub fn tasks_list(session_id: Option<String>) -> Value {
    let tasks = read_registry()
        .into_iter()
        .filter(|t| match &session_id {
            Some(sid) => t.get("session_id").and_then(Value::as_str) == Some(sid.as_str()),
            None => true,
        })
        .map(|mut t| {
            if t.get("status").and_then(Value::as_str) == Some("running") {
                let pid = t.get("pid").and_then(Value::as_i64).unwrap_or(-1);
                if pid > 0 && !process_alive(pid) {
                    t["status"] = json!("failed");
                    t["finished_at"] = json!(std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0));
                }
            }
            t
        })
        .collect::<Vec<_>>();

    json!({ "ok": true, "tasks": tasks })
}

/// Read a task's accumulated output (tail). Returns {ok, text, total_bytes}.
#[tauri::command]
pub fn tasks_read(task_id: String, tail_bytes: Option<u64>) -> Value {
    let Some(task) = read_registry()
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(task_id.as_str()))
    else {
        return json!({ "ok": false, "error": "unknown task id" });
    };
    let file = task
        .get("output_file")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if file.is_empty() {
        return json!({ "ok": false, "error": "task has no output file" });
    }
    let Ok(meta) = std::fs::metadata(file) else {
        return json!({ "ok": false, "error": "output file missing" });
    };
    let total = meta.len();
    let tail = tail_bytes.unwrap_or(16 * 1024).min(total);
    let start = total - tail;
    let text = std::fs::File::open(file)
        .and_then(|mut f| {
            use std::io::{Read, Seek, SeekFrom};
            f.seek(SeekFrom::Start(start))?;
            let mut buf = vec![0u8; tail as usize];
            f.read_exact(&mut buf)?;
            Ok(String::from_utf8_lossy(&buf).into_owned())
        })
        .unwrap_or_default();
    json!({ "ok": true, "text": text, "total_bytes": total })
}

/// Kill a background task: terminate its main PID and mark it killed in the
/// registry (read-modify-write, same serialization the extension uses — a
/// lost race only risks a status flip being overwritten later, never data
/// corruption, since the extension never rewrites other fields).
#[tauri::command]
pub fn tasks_kill(task_id: String) -> Value {
    let tasks = read_registry();
    let Some(task) = tasks
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(task_id.as_str()))
    else {
        return json!({ "ok": false, "error": "unknown task id" });
    };
    if task.get("status").and_then(Value::as_str) != Some("running") {
        return json!({ "ok": true, "already_finished": true });
    }
    let pid = task.get("pid").and_then(Value::as_i64).unwrap_or(-1);
    let killed = pid > 0 && kill_pid(pid);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let updated: Vec<Value> = tasks
        .into_iter()
        .map(|mut t| {
            if t.get("id").and_then(Value::as_str) == Some(task_id.as_str()) {
                t["status"] = json!("killed");
                t["finished_at"] = json!(now);
            }
            t
        })
        .collect();
    let tmp = tasks_file().with_extension("json.tmp-helix");
    if let Ok(s) = serde_json::to_string_pretty(&updated) {
        let _ = std::fs::write(&tmp, s).and_then(|_| std::fs::rename(&tmp, tasks_file()));
    }
    if killed || !process_alive(pid) {
        json!({ "ok": true })
    } else {
        json!({ "ok": false, "error": format!("failed to terminate pid {pid}") })
    }
}

fn process_alive(pid: i64) -> bool {
    #[cfg(windows)]
    {
        // OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION: succeeds only
        // for an existing process. Err = gone.
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32).is_ok() }
    }
    #[cfg(not(windows))]
    {
        // kill(pid, 0): ESRCH = gone, EPERM = alive but owned elsewhere.
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(13)
        }
    }
}

fn kill_pid(pid: i64) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid as u32) else {
                return false;
            };
            let ok = TerminateProcess(handle, 1).is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(handle);
            ok
        }
    }
    #[cfg(not(windows))]
    {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) == 0 }
    }
}
