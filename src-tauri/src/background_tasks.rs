//! Background tasks IPC — read the pi-background-tasks extension's shared
//! registry (~/.pi/agent/tasks.json) and manage detached tasks.
//!
//! The registry is written exclusively by the extension (each pi instance
//! does read-modify-write). Helix only reads it here; `tasks_kill` is the
//! single mutating command, mirroring the extension's kill logic (main PID
//! terminate + registry status flip).

use crate::ssh::{apply_auth_env, detach_window, ssh_opts_for, SshAuth};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

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

/// List background tasks from a **remote** machine's `~/.pi/agent/tasks.json`
/// via SSH. Remote projects run pi on the remote host, so their background
/// tasks are registered there — the local `tasks_list` can't see them.
#[tauri::command]
pub fn remote_tasks_list(
    host: String,
    port: u32,
    username: String,
    auth_type: Option<String>,
    secret: Option<String>,
) -> Result<Value, String> {
    let port = if port == 0 { 22 } else { port };
    let host = host.trim().to_string();
    let username = username.trim().to_string();
    if host.is_empty() || username.is_empty() {
        return Err("host / username 不能为空".to_string());
    }
    let auth = SshAuth::new(auth_type, secret);
    let opts = ssh_opts_for(&auth);
    // 一次往返拿两样：tasks.json + 远端存活 pid 清单（`ps` 输出，跟在哨兵行
    // 之后）。`cat` 不存在 / 没权限时用 `|| echo '[]'` 兜住，返回空数组而不是
    // 错误；远端没有 `ps`（如 Windows OpenSSH）时哨兵后跟特殊标记，Rust 侧
    // 就跳过对账（宁可保持 running，也不能把全部任务误判 failed）。
    let script = concat!(
        "(cat ~/.pi/agent/tasks.json 2>/dev/null || echo '[]');",
        " echo;",
        " echo '__HX_PIDS_7c2e__';",
        " (ps -A -o pid= 2>/dev/null || echo '__HX_NO_PIDS__')",
    );
    let out = {
        let mut c = Command::new("ssh");
        c.args(&opts)
            .arg("-p")
            .arg(port.to_string())
            .arg(format!("{username}@{host}"))
            .arg(script);
        apply_auth_env(&mut c, &auth);
        detach_window(&mut c);
        c.output()
    }
    .map_err(|e| format!("执行 ssh 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (json_part, pids_part) = match stdout.split_once("__HX_PIDS_7c2e__") {
        Some((a, b)) => (a, Some(b)),
        None => (stdout.as_ref(), None),
    };
    let mut tasks: Vec<Value> = serde_json::from_str(json_part.trim()).unwrap_or_default();
    // 对账（与本地 tasks_list 同语义）：标记 running 但远端 pid 已消失的
    // 就地改判 failed —— 否则远端任务结束后 status 永远停在 running，
    // 前端「有运行中任务」的判断会永久撑开工作面板按钮。
    if let Some(pids_raw) = pids_part {
        let body = pids_raw.trim();
        if !body.is_empty() && !body.starts_with("__HX_NO_PIDS__") {
            let alive: std::collections::HashSet<i64> = body
                .lines()
                .filter_map(|l| l.trim().parse::<i64>().ok())
                .collect();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            for t in tasks.iter_mut() {
                if t.get("status").and_then(Value::as_str) == Some("running") {
                    let pid = t.get("pid").and_then(Value::as_i64).unwrap_or(-1);
                    if pid > 0 && !alive.contains(&pid) {
                        t["status"] = json!("failed");
                        t["finished_at"] = json!(now);
                    }
                }
            }
        }
    }
    Ok(json!({ "ok": true, "tasks": tasks }))
}

fn process_alive(pid: i64) -> bool {
    // OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION: succeeds only
    // for an existing process. Err = gone.
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32).is_ok() }
}

fn kill_pid(pid: i64) -> bool {
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
