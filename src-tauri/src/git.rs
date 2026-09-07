//! `git:*` commands — execFile with arg arrays (no shell) to prevent command
//! injection. Port of `electron/ipc/git.js`.

use crate::state::AppState;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::time::Duration;
use tauri::State;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

fn git_cwd(state: &AppState, target_cwd: Option<&str>) -> std::path::PathBuf {
    if let Some(t) = target_cwd {
        if !t.trim().is_empty() {
            return std::path::PathBuf::from(t.trim());
        }
    }
    let wd = state.work_dir.read().unwrap().clone();
    if wd.exists() {
        wd
    } else {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    }
}

fn git_exec<S: AsRef<str>>(
    state: &AppState,
    args: &[S],
    target_cwd: Option<&str>,
) -> Result<(String, String), String> {
    let cwd = git_cwd(state, target_cwd);
    let mut git_cmd = Command::new("git");
    git_cmd.args(args.iter().map(|a| a.as_ref()));
    git_cmd.current_dir(&cwd);
    git_cmd.stdin(Stdio::null());
    git_cmd.stdout(Stdio::piped());
    git_cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    git_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = git_cmd
        .spawn()
        .map_err(|e| format!("git spawn failed: {e}"))?;

    let deadline = std::time::Instant::now() + GIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err("git command timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("git wait failed: {e}")),
        }
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            "git command failed".into()
        };
        return Err(msg);
    }
    Ok((stdout, stderr))
}

#[tauri::command]
pub fn status(state: State<'_, Arc<AppState>>, target_cwd: Option<String>) -> Value {
    match git_exec(
        &state,
        &["status", "--porcelain=v2", "--branch"],
        target_cwd.as_deref(),
    ) {
        Ok((stdout, _)) => json!({ "ok": true, "output": stdout.trim() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn diff(
    state: State<'_, Arc<AppState>>,
    file_path: Option<String>,
    staged: Option<bool>,
) -> Value {
    let mut args: Vec<String> = vec!["diff".to_string()];
    if staged.unwrap_or(false) {
        args.push("--cached".to_string());
    }
    if let Some(fp) = file_path {
        args.push("--".to_string());
        args.push(fp);
    }
    match git_exec(&state, &args, None) {
        Ok((stdout, _)) => json!({ "ok": true, "diff": stdout }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn diff_head(state: State<'_, Arc<AppState>>, file_path: Option<String>) -> Value {
    let mut args: Vec<String> = vec!["diff".to_string(), "HEAD".to_string()];
    if let Some(fp) = file_path {
        args.push("--".to_string());
        args.push(fp);
    }
    match git_exec(&state, &args, None) {
        Ok((stdout, _)) => json!({ "ok": true, "diff": stdout }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn revert(state: State<'_, Arc<AppState>>, file_path: Option<String>) -> Value {
    match file_path {
        Some(fp) => {
            let r1 = git_exec(&state, &["checkout", "HEAD", "--", fp.as_str()], None);
            let r2 = git_exec(&state, &["clean", "-fd", "--", fp.as_str()], None);
            if r1.is_err() && r2.is_err() {
                return json!({ "ok": false, "error": r1.err().unwrap_or_default() });
            }
            json!({ "ok": true })
        }
        None => {
            if git_exec(&state, &["checkout", "HEAD", "--", "."], None).is_err() {
                return json!({ "ok": false, "error": "checkout failed" });
            }
            let _ = git_exec(&state, &["clean", "-fd"], None);
            json!({ "ok": true })
        }
    }
}

#[tauri::command]
pub fn stage(state: State<'_, Arc<AppState>>, file_path: Option<String>) -> Value {
    let target = file_path.as_deref().unwrap_or(".");
    match git_exec(&state, &["add", target], None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn unstage(state: State<'_, Arc<AppState>>, file_path: Option<String>) -> Value {
    let target = file_path.as_deref().unwrap_or(".");
    match git_exec(&state, &["reset", "-q", "HEAD", "--", target], None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn commit(state: State<'_, Arc<AppState>>, message: Option<String>) -> Value {
    let msg = message.unwrap_or_else(|| "chore: auto-commit".to_string());
    match git_exec(&state, &["add", "-A"], None) {
        Ok(_) => {}
        Err(e) => return json!({ "ok": false, "error": e }),
    }
    match git_exec(&state, &["commit", "-m", msg.as_str()], None) {
        Ok((stdout, _)) => json!({ "ok": true, "output": stdout.trim() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn diff_numstat(state: State<'_, Arc<AppState>>, target_cwd: Option<String>) -> Value {
    match git_exec(&state, &["diff", "--numstat"], target_cwd.as_deref()) {
        Ok((stdout, _)) => json!({ "ok": true, "output": stdout.trim() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn branch_list(state: State<'_, Arc<AppState>>, target_cwd: Option<String>) -> Value {
    match git_exec(
        &state,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        target_cwd.as_deref(),
    ) {
        Ok((stdout, _)) => {
            let branches: Vec<&str> = stdout
                .split('\n')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            json!({ "ok": true, "branches": branches })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn branch_switch(
    state: State<'_, Arc<AppState>>,
    branch: String,
    target_cwd: Option<String>,
) -> Value {
    match git_exec(&state, &["switch", branch.as_str()], target_cwd.as_deref()) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn branch_create(
    state: State<'_, Arc<AppState>>,
    branch: String,
    target_cwd: Option<String>,
) -> Value {
    match git_exec(
        &state,
        &["checkout", "-b", branch.as_str()],
        target_cwd.as_deref(),
    ) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn current_branch(state: State<'_, Arc<AppState>>, target_cwd: Option<String>) -> Value {
    match git_exec(
        &state,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        target_cwd.as_deref(),
    ) {
        Ok((stdout, _)) => {
            let b = stdout.trim();
            json!({ "ok": true, "branch": if b.is_empty() { "HEAD" } else { b } })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn log(state: State<'_, Arc<AppState>>, count: Option<u32>) -> Value {
    let n = count.unwrap_or(20).to_string();
    match git_exec(&state, &["log", "--oneline", "-n", n.as_str()], None) {
        Ok((stdout, _)) => json!({ "ok": true, "output": stdout.trim() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ── worktree ───────────────────────────

#[tauri::command]
pub fn worktree_list(state: State<'_, Arc<AppState>>) -> Value {
    match git_exec(&state, &["worktree", "list", "--porcelain"], None) {
        Ok((stdout, _)) => {
            let mut entries: Vec<Value> = Vec::new();
            let mut current: Option<serde_json::Map<String, Value>> = None;
            for line in stdout.split('\n') {
                if let Some(rest) = line.strip_prefix("worktree ") {
                    if let Some(cur) = current.take() {
                        entries.push(Value::Object(cur));
                    }
                    current = Some(serde_json::Map::new());
                    current
                        .as_mut()
                        .unwrap()
                        .insert("path".into(), json!(rest.trim()));
                } else if let Some(rest) = line.strip_prefix("HEAD ") {
                    if let Some(cur) = current.as_mut() {
                        cur.insert("head".into(), json!(rest.trim()));
                    }
                } else if let Some(rest) = line.strip_prefix("branch ") {
                    if let Some(cur) = current.as_mut() {
                        cur.insert(
                            "branch".into(),
                            json!(rest.trim().trim_start_matches("refs/heads/")),
                        );
                    }
                } else if line.trim() == "bare" {
                    if let Some(cur) = current.as_mut() {
                        cur.insert("bare".into(), json!(true));
                    }
                } else if line.trim() == "detached" {
                    if let Some(cur) = current.as_mut() {
                        cur.insert("detached".into(), json!(true));
                    }
                } else if line.trim_start().starts_with("locked") {
                    if let Some(cur) = current.as_mut() {
                        cur.insert("locked".into(), json!(true));
                    }
                } else if line.trim_start().starts_with("prunable") {
                    if let Some(cur) = current.as_mut() {
                        cur.insert("prunable".into(), json!(true));
                    }
                }
            }
            if let Some(cur) = current {
                entries.push(Value::Object(cur));
            }
            if let Some(first) = entries.first_mut() {
                first["isMain"] = json!(true);
            }
            json!({ "ok": true, "worktrees": entries })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn worktree_add(state: State<'_, Arc<AppState>>, opts: Value) -> Value {
    let wt_path = opts
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let branch = opts
        .get("branch")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let new_branch = opts
        .get("newBranch")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut args: Vec<String> = vec!["worktree".to_string(), "add".to_string()];
    if let Some(nb) = new_branch {
        args.push("-b".to_string());
        args.push(nb);
        args.push(wt_path.clone());
        if let Some(b) = branch {
            args.push(b);
        }
    } else if let Some(b) = branch {
        args.push(wt_path.clone());
        args.push(b);
    } else {
        args.push(wt_path);
    }
    match git_exec(&state, &args, None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn worktree_remove(state: State<'_, Arc<AppState>>, wt_path: String) -> Value {
    match git_exec(
        &state,
        &["worktree", "remove", wt_path.as_str(), "--force"],
        None,
    ) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn worktree_lock(state: State<'_, Arc<AppState>>, wt_path: String) -> Value {
    match git_exec(&state, &["worktree", "lock", wt_path.as_str()], None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn worktree_unlock(state: State<'_, Arc<AppState>>, wt_path: String) -> Value {
    match git_exec(&state, &["worktree", "unlock", wt_path.as_str()], None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn worktree_prune(state: State<'_, Arc<AppState>>) -> Value {
    match git_exec(&state, &["worktree", "prune"], None) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ── remote ops ──────────────────────────

#[tauri::command]
pub fn push(state: State<'_, Arc<AppState>>, opts: Option<Value>) -> Value {
    let opts = opts.unwrap_or_default();
    let mut args = vec!["push"];
    if opts.get("force").and_then(|v| v.as_bool()).unwrap_or(false) {
        args.push("--force");
    }
    if let Some(r) = opts.get("remote").and_then(|v| v.as_str()) {
        args.push(r);
    }
    if let Some(b) = opts.get("branch").and_then(|v| v.as_str()) {
        args.push(b);
    }
    match git_exec(&state, &args, None) {
        Ok((stdout, stderr)) => json!({ "ok": true, "output": format!("{stdout}{stderr}") }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn pull(state: State<'_, Arc<AppState>>, opts: Option<Value>) -> Value {
    let opts = opts.unwrap_or_default();
    let mut args = vec!["pull"];
    if let Some(r) = opts.get("remote").and_then(|v| v.as_str()) {
        args.push(r);
    }
    if let Some(b) = opts.get("branch").and_then(|v| v.as_str()) {
        args.push(b);
    }
    match git_exec(&state, &args, None) {
        Ok((stdout, stderr)) => json!({ "ok": true, "output": format!("{stdout}{stderr}") }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn fetch(state: State<'_, Arc<AppState>>, opts: Option<Value>) -> Value {
    let opts = opts.unwrap_or_default();
    let mut args = vec!["fetch"];
    if let Some(r) = opts.get("remote").and_then(|v| v.as_str()) {
        args.push(r);
    }
    match git_exec(&state, &args, None) {
        Ok((stdout, stderr)) => json!({ "ok": true, "output": format!("{stdout}{stderr}") }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}
