//! `git:*` commands — execFile with arg arrays (no shell) to prevent command
//! injection. Port of `electron/ipc/git.js`.

use crate::state::AppState;
use serde::Serialize;
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
/// 单文件改动统计（已跟踪文件 vs HEAD，或未跟踪文件的新增行数）。
#[derive(Clone, Serialize)]
struct NumstatFile {
    path: String,
    added: u64,
    removed: u64,
    binary: bool,
    untracked: bool,
}

/// 未跟踪文件最多统计多少个、单个最多读多少字节。大仓库里未跟踪的构建产物
/// 可能有几千个，全量读会让这个 5s 轮询的命令卡住。
const MAX_UNTRACKED_FILES: usize = 500;
const MAX_UNTRACKED_BYTES: usize = 5 * 1024 * 1024;

/// numstat 一行的路径列可能带 `core.quotePath` 引号（非 ASCII 路径），或重命名
/// 标记（`dir/{old => new}/file`、`old => new`）。统一成工作区里的真实新路径
/// ——前端拿它当列表 key 与点击目标，格式不统一会显示乱码、点不开。
fn normalize_numstat_path(raw: &str) -> String {
    let s = unquote_git_path(raw);
    if !s.contains("=>") {
        return s;
    }
    // 形式 1：`prefix/{old => new}/suffix` → `prefix/new/suffix`
    if let Some(open) = s.find("{") {
        let after_open = &s[open + 1..];
        if let Some(rel) = after_open.find(" => ") {
            let name_start = open + 1 + rel + 4;
            if let Some(close_rel) = after_open[rel + 4..].find("}") {
                let close = name_start + close_rel;
                let new_name = &s[name_start..close];
                let suffix = &s[close + 1..];
                let prefix = &s[..open];
                return if prefix.ends_with('/') {
                    format!("{prefix}{new_name}{suffix}")
                } else {
                    format!("{prefix}/{new_name}{suffix}")
                };
            }
        }
    }
    // 形式 2：整条就是 `old => new`
    let mut split = s.splitn(2, " => ");
    if let (Some(_), Some(new)) = (split.next(), split.next()) {
        return new.to_string();
    }
    s
}

fn digit_val(c: char) -> Option<u8> {
    ('0'..='7').contains(&c).then(|| (c as u8) - b'0')
}

/// 反转义 git 的 quotePath 输出（非 ASCII 路径会被转成 `"a/\346\226\207.txt"`
/// 这样的三位八进制）。未加引号或无法解析时原样返回——宁可显示引号，
/// 也不要为了"更干净"丢掉字节。
fn unquote_git_path(raw: &str) -> String {
    let t = raw.trim();
    if t.len() < 2 || !t.starts_with('"') || !t.ends_with('"') {
        return raw.to_string();
    }
    let inner = &t[1..t.len() - 1];
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        match chars.next() {
            Some('"') => out.push(b'"'),
            Some('\\') => out.push(b'\\'),
            Some('n') => out.push(b'\n'),
            Some('t') => out.push(b'\t'),
            // git 的 quotePath（C 风格转义）还会发这几个控制字符。不认出来的话
            // 会掉进下面的八进制分支，把后面两个**正文字符**一起当转义吃掉。
            Some('r') => out.push(b'\r'),
            Some('a') => out.push(0x07),
            Some('b') => out.push(0x08),
            Some('f') => out.push(0x0c),
            Some('v') => out.push(0x0b),
            // 必须加 `is_digit(8)` 守卫：无守卫的 `Some(oct0)` 是**兜底**模式，
            // 下面 `Some(other)` 那个臂就永远不可达（rustc: unreachable pattern），
            // 任何非八进制转义（如 `\a`）都会被当成三位八进制去读。
            Some(oct0) if oct0.is_digit(8) => {
                // 八进制转义固定三位，拼成一个 UTF-8 字节。
                let oct1 = chars.next();
                let oct2 = chars.next();
                if let (Some(a), Some(b)) = (oct1, oct2) {
                    if let (Some(d0), Some(d1), Some(d2)) = (
                        digit_val(oct0),
                        digit_val(a),
                        digit_val(b),
                    ) {
                        out.push((d0 << 6) | (d1 << 2) | d2);
                        continue;
                    }
                }
                // 三个字符都是 Option：oct0 已知是 Some，另两个可能为 None
                // （行尾截断的转义）。统一成 Option 再 flatten，逐字符原样输出。
                for c in [Some(oct0), oct1, oct2].into_iter().flatten() {
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                }
            }
            Some(other) => {
                out.push(b'\\');
                let mut buf = [0u8; 4];
                out.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
            }
            None => out.push(b'\\'),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 解析一行 numstat：`<added>\t<removed>\t<path>`；`-` 表示二进制不可计数。
fn parse_numstat_line(line: &str) -> Option<NumstatFile> {
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 3 {
        return None;
    }
    let binary = parts[0] == "-" || parts[1] == "-";
    let added = if binary { 0 } else { parts[0].parse().unwrap_or(0) };
    let removed = if binary { 0 } else { parts[1].parse().unwrap_or(0) };
    // join 的参数是 &str，不是 char（`'\t'` 会报 expected `&str`, found `char`）。
    let path = normalize_numstat_path(&parts[2..].join("\t"));
    if path.is_empty() {
        return None;
    }
    Some(NumstatFile {
        path,
        added,
        removed,
        binary,
        untracked: false,
    })
}

/// 数一个未跟踪文件的行数（git 不给它们出 numstat，而「write 新建文件」
/// 恰恰是这个列表里最常见的一类）。读不到 / 空 / 过大 → None，交给调用方跳过。
fn stat_untracked_file(cwd: &std::path::Path, rel: &str) -> Option<(u64, bool)> {
    let bytes = std::fs::read(cwd.join(rel)).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_UNTRACKED_BYTES {
        return None;
    }
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Some((0, true));
    }
    Some((
        String::from_utf8_lossy(&bytes).lines().count() as u64,
        false,
    ))
}

/// 「未提交的更改」完整明细：已跟踪文件 vs `HEAD`（含删除、含已暂存）
/// **加上未跟踪的新文件**。
///
/// 与 `diff_numstat` 的区别（后者原样保留，分支切换的脏文件提示还在用）：
/// 1. 基准是 `HEAD` 而不是 index —— agent 一旦 `git add`，`git diff` 整段隐身；
/// 2. 覆盖未跟踪文件 —— `write` 新建的文件 `git diff` 永远看不到，
///    这是「右边不显示 +n」的主因；
/// 3. 直接返回结构化列表与总计，前端不用再解析一遍 numstat 文本。
#[tauri::command]
pub fn diff_numstat_full(
    state: State<'_, Arc<AppState>>,
    target_cwd: Option<String>,
) -> Value {
    let cwd = git_cwd(&state, target_cwd.as_deref());
    if !cwd.exists() {
        return json!({ "ok": false, "error": "work dir not found" });
    }
    let mut files: Vec<NumstatFile> = Vec::new();
    let mut numstat = git_exec(
        &state,
        &["diff", "HEAD", "--numstat"],
        target_cwd.as_deref(),
    );
    // 还没提交过（无 HEAD）时 `git diff HEAD` 报 bad revision。
    if numstat.is_err() {
        numstat = git_exec(
            &state,
            &["diff", "--numstat"],
            target_cwd.as_deref(),
        );
    }
    match numstat {
        Ok((stdout, _)) => {
            for line in stdout.lines() {
                if let Some(f) = parse_numstat_line(line) {
                    files.push(f);
                }
            }
        }
        Err(e) => return json!({ "ok": false, "error": e }),
    }
    // 未跟踪文件单独算：`-z` 输出，路径含空格 / 中文也不会串行。
    if let Ok((stdout, _)) = git_exec(
        &state,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        target_cwd.as_deref(),
    ) {
        let mut untracked = 0usize;
        for rel in stdout.split('\0') {
            let rel = rel.trim();
            if rel.is_empty() {
                continue;
            }
            if untracked >= MAX_UNTRACKED_FILES {
                break;
            }
            if let Some((lines, binary)) = stat_untracked_file(&cwd, rel) {
                untracked += 1;
                files.push(NumstatFile {
                    path: rel.to_string(),
                    added: lines,
                    removed: 0,
                    binary,
                    untracked: true,
                });
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let added: u64 = files.iter().map(|f| f.added).sum();
    let removed: u64 = files.iter().map(|f| f.removed).sum();
    json!({
        "ok": true,
        "files": files,
        "added": added,
        "removed": removed,
    })
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
