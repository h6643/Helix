//! Kanban IPC — runs `hermes kanban <verb> [args...]` and parses JSON.
//! Port of `electron/ipc/kanban.js`. Args are passed as an array (no shell).

use crate::kernel::resolve_hermes_cmd;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;

pub(crate) fn build_clean_env(hermes_bin: &std::path::Path) -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.retain(|k, _| {
        if k == "PATH" || k == "Path" || k == "path" {
            return true;
        }
        !(k.starts_with("npm_")
            || k == "INIT_CWD"
            || k == "NODE"
            || k == "NODE_EXE"
            || k == "NPM_CLI_JS"
            || k == "NPM_PREFIX_JS"
            || k == "NPM_PREFIX_NPM_CLI_JS"
            || k == "npm_command"
            || k == "npm_execpath"
            || k == "npm_node_execpath"
            || k == "npm_lifecycle_event"
            || k == "npm_lifecycle_script"
            || k == "COLOR"
            || k == "FORCE_COLOR"
            || k == "EFC_8920")
    });
    let hermes_bin_dir = hermes_bin
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let path_sep = if cfg!(windows) { ';' } else { ':' };
    let mut clean_path: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(path_sep)
        .filter(|p| !p.is_empty())
        .filter(|p| !p.to_lowercase().contains("node_modules/.bin") && !p.to_lowercase().contains("npm/node_modules"))
        .map(|s| s.to_string())
        .collect();
    if !hermes_bin_dir.is_empty() && !clean_path.contains(&hermes_bin_dir) {
        clean_path.insert(0, hermes_bin_dir);
    }
    env.insert("PATH".to_string(), clean_path.join(&path_sep.to_string()));
    env
}

fn run_cli(hermes_cmd: &std::path::Path, args: &[String], timeout_ms: u64) -> (i32, String, String, Option<String>) {
    let mut child = match {
            let mut _kc = Command::new(hermes_cmd);
            _kc.args(args)
                .envs(build_clean_env(hermes_cmd))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            _kc.creation_flags(0x08000000);
            _kc.spawn()
        }
    {
        Ok(c) => c,
        Err(e) => return (-1, String::new(), String::new(), Some(e.to_string())),
    };
    let timeout = Duration::from_millis(timeout_ms);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let pid = child.id();
    let kill_tx = tx.clone();
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        // best-effort kill after timeout
        let _ = kill_tx.send(());
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });
    let _ = rx.recv_timeout(timeout + Duration::from_millis(100));
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_string(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        use std::io::Read;
        let _ = err.read_to_string(&mut stderr);
    }
    let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    (code, stdout, stderr, None)
}

#[tauri::command]
pub async fn command(params: Option<Value>) -> Value {
    let p = params.unwrap_or(json!({}));
    let verb = p.get("verb").and_then(|v| v.as_str()).unwrap_or("");
    if verb.is_empty() {
        return json!({ "ok": false, "error": "缺少 kanban 子命令" });
    }
    if !verb.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') || verb.starts_with('-') {
        return json!({ "ok": false, "error": format!("非法 kanban 子命令: {verb}") });
    }
    let args: Vec<String> = p
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let json_flag = p.get("json").and_then(|v| v.as_bool()).unwrap_or(false);
    let board = p.get("board").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let hermes_cmd = match resolve_hermes_cmd() {
        Some(c) => c,
        None => return json!({ "ok": false, "error": "找不到 hermes 可执行文件" }),
    };
    let mut full_args = vec!["kanban".to_string()];
    if !board.is_empty() {
        full_args.push("--board".to_string());
        full_args.push(board);
    }
    full_args.push(verb.to_string());
    full_args.extend(args);
    if json_flag {
        full_args.push("--json".to_string());
    }
    // `hermes kanban` can block for up to 30s. A sync #[tauri::command] would run
    // on the main thread (WebKitGTK IPC handlers execute on the GTK loop) and
    // freeze the whole window meanwhile — run it on a worker thread instead.
    let (code, stdout, stderr, err) = tauri::async_runtime::spawn_blocking(move || {
        run_cli(&hermes_cmd, &full_args, 30000)
    })
    .await
    .unwrap_or((-1, String::new(), String::new(), Some("看板命令执行异常".into())));
    if let Some(e) = err {
        return json!({ "ok": false, "error": e });
    }
    if code != 0 {
        let err_text = stderr.trim().to_string();
        let err_text = if err_text.is_empty() { stdout.trim().to_string() } else { err_text };
        let err_text = if err_text.is_empty() {
            format!("hermes kanban {verb} 执行失败")
        } else {
            err_text
        };
        return json!({ "ok": false, "code": code, "stdout": stdout, "stderr": stderr, "error": err_text });
    }
    let mut data: Value = Value::Null;
    if json_flag {
        let trimmed = stdout.trim();
        data = serde_json::from_str(trimmed).ok().unwrap_or_else(|| {
            // fall back to the last JSON block (progress noise before payload)
            let last_open = std::cmp::max(
                trimmed.rfind('[').map(|i| i as i64).unwrap_or(-1),
                trimmed.rfind('{').map(|i| i as i64).unwrap_or(-1),
            );
            if last_open >= 0 {
                serde_json::from_str(&trimmed[last_open as usize..]).unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        });
        if data.is_null() {
            data = Value::String(stdout.clone());
        }
    }
    json!({ "ok": true, "data": data, "stdout": stdout, "stderr": stderr })
}
