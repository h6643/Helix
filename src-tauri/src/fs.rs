//! `fs:*` commands — path-validated file operations scoped to the working
//! directory. Port of `electron/ipc/fs.js`.

use crate::paths::helix_data_dir;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// Case-insensitive path normalization for root-membership checks.
/// Windows is a case-insensitive filesystem, but roots and incoming paths are
/// compared as strings; a drive-letter/segment case difference (e.g. `D:\Project\Helix`
/// vs `d:\project\helix`) would otherwise make a legitimately-in-project file fail
/// the prefix check and report "outside working directory". Mirrors the separator
/// and case normalization used by `pi_gateway::same_path` so comparisons agree.
fn norm_ci(p: &str) -> String {
    norm(p).to_lowercase()
}

/// Allowed roots: current workDir + user-selected projects + helix memories.
fn allowed_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![state.work_dir.read().unwrap().clone()];
    roots.extend(state.allowed_roots.read().unwrap().clone());
    roots
        .into_iter()
        .filter(|r| !r.as_os_str().is_empty())
        .map(|r| std::fs::canonicalize(&r).unwrap_or(r))
        .collect()
}

/// Resolve a renderer-supplied path safely. Returns None if outside any root.
fn safe_path(state: &AppState, file_path: &str) -> Option<PathBuf> {
    let work_dir = state.work_dir.read().unwrap().clone();
    let resolved = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        work_dir.join(file_path)
    };

    // Allow helix memory directory (used by learning view).
    let memory_dir = helix_data_dir().join("memories");
    if norm(&resolved.display().to_string()).starts_with(&norm(&memory_dir.display().to_string())) {
        return Some(resolved);
    }

    // Canonicalize the input (when it exists) before checking root membership.
    // Windows paths are case-insensitive but compared as strings, and the roots
    // in allowed_roots are themselves canonicalized — so a case/separator/symlink
    // difference makes a string prefix check fail with "outside working directory".
    // Fall back to the raw path when it does not exist yet (e.g. a file about to
    // be created): try canonicalizing the parent and re-attaching the file name.
    let candidate = if let Ok(real) = std::fs::canonicalize(&resolved) {
        real
    } else if let Some(parent) = resolved.parent() {
        if let Ok(real_parent) = std::fs::canonicalize(parent) {
            real_parent.join(resolved.file_name().unwrap_or_default())
        } else {
            resolved.clone()
        }
    } else {
        resolved.clone()
    };

    let roots = allowed_roots(state);
    let in_any_root = roots.iter().any(|root| {
        let r = norm_ci(&root.display().to_string());
        let p = norm_ci(&candidate.display().to_string());
        p == r || p.starts_with(&format!("{r}/"))
    });
    if !in_any_root {
        return None;
    }
    Some(candidate)
}

fn outside_err() -> String {
    "Path is outside working directory".to_string()
}

/// Public wrapper for other modules (e.g. shell:showItemInFolder).
pub fn resolve_safe(state: &AppState, file_path: &str) -> Option<PathBuf> {
    safe_path(state, file_path)
}

#[tauri::command]
pub fn read(state: State<'_, Arc<AppState>>, file_path: String) -> Result<String, String> {
    let resolved = safe_path(&state, &file_path).ok_or_else(outside_err)?;
    std::fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write(
    state: State<'_, Arc<AppState>>,
    file_path: String,
    content: String,
) -> Result<Value, String> {
    let resolved = safe_path(&state, &file_path).ok_or_else(outside_err)?;
    if let Some(dir) = resolved.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&resolved, content).map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub fn edit(
    state: State<'_, Arc<AppState>>,
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<Value, String> {
    let resolved = safe_path(&state, &file_path).ok_or_else(outside_err)?;
    let content = std::fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
    if !content.contains(&old_string) {
        return Err(format!("old_string not found in {file_path}"));
    }
    let updated = if replace_all.unwrap_or(false) {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };
    std::fs::write(&resolved, updated).map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub fn readdir(state: State<'_, Arc<AppState>>, dir_path: String) -> Result<Value, String> {
    let resolved = safe_path(&state, &dir_path).ok_or_else(outside_err)?;
    let entries = std::fs::read_dir(&resolved).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in entries.flatten() {
        out.push(json!({
            "name": e.file_name().to_string_lossy().to_string(),
            "isDirectory": e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        }));
    }
    Ok(json!(out))
}

#[tauri::command]
pub fn helix_memory_dir() -> String {
    helix_data_dir().join("memories").display().to_string()
}

#[tauri::command]
pub fn stat(state: State<'_, Arc<AppState>>, file_path: String) -> Result<Value, String> {
    let resolved = safe_path(&state, &file_path).ok_or_else(outside_err)?;
    let m = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    Ok(json!({
        "isFile": m.is_file(),
        "isDirectory": m.is_dir(),
        "size": m.len(),
        "mtime": m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0),
    }))
}

#[tauri::command]
pub fn rename(
    state: State<'_, Arc<AppState>>,
    old_path: String,
    new_path: String,
) -> Result<Value, String> {
    let resolved_old = safe_path(&state, &old_path).ok_or_else(outside_err)?;
    let resolved_new = safe_path(&state, &new_path).ok_or_else(outside_err)?;
    if let Some(dir) = resolved_new.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::rename(&resolved_old, &resolved_new).map_err(|e| e.to_string())?;
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub fn delete(state: State<'_, Arc<AppState>>, file_path: String) -> Result<Value, String> {
    let resolved = safe_path(&state, &file_path).ok_or_else(outside_err)?;
    // VS Code-style delete: move to trash (recoverable), not permanent unlink.
    // Tauri plugin-dialog doesn't expose trash; fall back to trash-rs semantics:
    // we remove the file/dir permanently but that's a deliberate trade-off for
    // the Linux-first build. Keep the error contract identical.
    if resolved.is_dir() {
        std::fs::remove_dir_all(&resolved).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&resolved).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
pub fn scan_tree(
    state: State<'_, Arc<AppState>>,
    relative_path: Option<String>,
) -> Result<Value, String> {
    let work_dir = state.work_dir.read().unwrap().clone();
    let root = match relative_path {
        Some(rp) => safe_path(&state, &rp).ok_or_else(outside_err)?,
        None => work_dir,
    };
    let mut counter = 0usize;
    let tree = build_file_tree(&root, "", 0, &mut counter);
    Ok(json!(tree))
}

fn build_file_tree(dir: &Path, base: &str, depth: usize, counter: &mut usize) -> Vec<Value> {
    if depth > 7 || *counter > 4000 {
        return Vec::new();
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut nodes = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // Skip common heavy directories to keep the tree small and fast.
        if name.eq_ignore_ascii_case("node_modules")
            || name.eq_ignore_ascii_case("dist")
            || name.eq_ignore_ascii_case("target")
            || name.eq_ignore_ascii_case("__pycache__")
        {
            continue;
        }
        let abs = e.path();
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => match std::fs::metadata(&abs) {
                Ok(m) => m.file_type(),
                Err(_) => continue,
            },
        };
        if ft.is_dir() {
            let children = build_file_tree(&abs, &rel, depth + 1, counter);
            nodes.push(json!({ "id": rel, "name": name, "type": "folder", "children": children }));
        } else if ft.is_file() {
            nodes.push(json!({ "id": rel, "name": name, "type": "file" }));
        }
        *counter += 1;
    }
    nodes.sort_by(|a, b| {
        let at = a.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let bt = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if at != bt {
            return if at == "folder" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    nodes
}

#[tauri::command]
pub fn allow_root(state: State<'_, Arc<AppState>>, dir: String) -> Value {
    state.add_allowed_root(&dir);
    json!({ "success": true })
}

// ── 会话级文件快照（session-level snapshot）────────────────────────────────
// 用途：一轮 run 可能连改十几个文件，`git revert` 只能单个文件回滚，而
// tool_call 事件里只有 unified diff、没有 oldText，diff 被截断时连
// `reverseUnifiedDiff` 都会标 undoUnsafe 而拒绝撤销。快照在 run **开始前**
// 把「即将被改的文件」原样存一份，整轮一句话就能全部还原。
//
// 落点：`helix_data_dir()/snapshots/`。绝不能放
// `~/.pi/agent/sessions/`——pi 按 cwd 编码分桶且会 create_dir_all，
// 混进去会被当成真会话。
//
// 目录布局（内容寻址 + 每个对话留最近 N 轮）：
//   snapshots/blobs/<hash>-<len>          同一份内容全盘只存一次
//   snapshots/runs/<runId>/manifest.json  {"session","entries"}：本轮属于哪个
//                                        对话、引用了哪些 blob
//
// 为什么要去重：每轮存的都是「当时所有脏文件」，而一个大文件可以连着几百轮
// 不提交 —— 旧布局于是每轮再拷一份全量（实测 4 天堆到 155MB，其中
// agent-flow-panel.tsx / pi_gateway.rs / helix-store.ts 三个文件占 106MB）。
// 按内容寻址后同样的轮次只有一份，再叠加「每个对话超出 N 轮的老快照连 manifest
// 一起丢、没人引用的 blob 回收掉」，占用被钉在「留下来的轮次里出现过的不同内容」
// 这个量级。
//
// 为什么按对话计数而不是全局计数：全局上限会让一条活跃对话把另一条对话的快照挤
// 掉——用户切回旧对话点「撤销本轮」时，那份还原数据早就没了。

/// 超过这个大小或非 UTF-8 的文件跳过快照（二进制/大文件还原风险大于收益）。
const SNAPSHOT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 每个对话最多保留多少轮的快照；更老的连 manifest 一起删，blob 由 gc 回收。
const SNAPSHOT_MAX_KEEP_RUNS_PER_SESSION: usize = 10;

fn snap_root() -> std::path::PathBuf {
    crate::paths::helix_data_dir().join("snapshots")
}

fn blob_dir() -> std::path::PathBuf {
    snap_root().join("blobs")
}

fn runs_root() -> std::path::PathBuf {
    snap_root().join("runs")
}

fn run_dir(run_id: &str) -> std::path::PathBuf {
    runs_root().join(run_id)
}

/// 轮次 id 与 blob 文件名都会直接当路径片段用（而且这里做的是**删除**）：
/// 空串会让路径退化成上级目录、`..` 能跳出去，所以宁可在入口处就拒掉。
/// 只认自家生成器用得上的字符：`run-<base36>` 与 `<hex>-<len>`。
fn is_safe_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// blob 键 = FNV-1a 64 位摘要 + 字节长度。这里只是「内容相同 ⇒ 文件名相同」的
/// 复用键，不是安全摘要；正确性由 `store_blob` 里"命中同名 blob 就先读回来
/// 逐字节比对"那一步兜住 —— 真撞上就把这份内容另存一个 `-altN` 变体，绝不会
/// 把 A 的内容当成 B 还原出去。
fn blob_key(content: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in content.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}-{}", h, content.len())
}

/// 写入 blob，命中已有同名同内容的直接复用。返回最终文件名。
fn store_blob(content: &str) -> Result<String, String> {
    let base = blob_key(content);
    let dir = blob_dir();
    let mut name = base.clone();
    let mut alt = 1u32;
    loop {
        let path = dir.join(&name);
        if !path.exists() {
            // atomic_write 自己会建父目录
            crate::config::atomic_write(&path, content).map_err(|e| e.to_string())?;
            return Ok(name);
        }
        // 同名已存在：内容一致就省掉这一份拷贝；读不出来或不同（哈希撞了）
        // 就换下一个候选名，总之绝不覆盖别人正在引用的 blob。
        if let Ok(existing) = std::fs::read_to_string(&path) {
            if existing == content {
                return Ok(name);
            }
        }
        name = format!("{base}-alt{alt}");
        alt += 1;
    }
}

/// 按目录 mtime 从新到旧排列的轮次目录。
fn run_dirs() -> Vec<std::path::PathBuf> {
    let mut scored: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(runs_root()) {
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            scored.push((modified, path));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().map(|(_, p)| p).collect()
}

/// 一轮快照的 manifest：这轮属于哪个对话、引用了哪些 blob。
/// `session` 只当分组键用（不进路径），所以对话 id 里有什么字符都无所谓。
struct RunRecord {
    session: String,
    entries: Vec<serde_json::Value>,
}

fn read_run(dir: &std::path::Path) -> Option<RunRecord> {
    let raw = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let entries = value.get("entries")?.as_array()?.clone();
    Some(RunRecord {
        session: value
            .get("session")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        entries,
    })
}

/// 回收：没有一份 manifest 再引用这份内容，它就不可能被还原了 → 删。
fn gc_blobs() {
    let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();
    for dir in run_dirs() {
        for e in read_run(&dir).map(|r| r.entries).unwrap_or_default() {
            if let Some(b) = e.get("blob").and_then(|v| v.as_str()) {
                alive.insert(b.to_string());
            }
        }
    }
    let Ok(rd) = std::fs::read_dir(blob_dir()) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !alive.contains(&name) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 快照落盘：manifest 记本轮属于哪个对话 +「文件绝对路径 → blob」映射，内容
/// 本身按内容寻址共用。读文件同样过 safe_path：快照只能覆盖工作区内的文件。
#[tauri::command]
pub fn snapshot_save(
    state: State<'_, Arc<AppState>>,
    run_id: String,
    session_id: String,
    files: Vec<String>,
) -> Value {
    let id = run_id.trim();
    if !is_safe_id(id) {
        return json!({ "ok": false, "error": "非法的快照 id" });
    }
    let dir = run_dir(id);
    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for f in &files {
        let Some(resolved) = safe_path(&state, f) else {
            skipped.push(f.clone());
            continue;
        };
        let path = resolved.display().to_string();
        // 文件当时不存在 → 它属于「本轮会被新建」的那类：记进 manifest 但不存
        // 内容，撤销时直接删掉，还原成"新建之前"。
        if !resolved.exists() {
            entries.push(json!({ "path": path, "existed": false }));
            continue;
        }
        let Ok(meta) = std::fs::metadata(&resolved) else {
            skipped.push(f.clone());
            continue;
        };
        if !meta.is_file() || meta.len() > SNAPSHOT_MAX_BYTES {
            skipped.push(f.clone());
            continue;
        }
        // 非 UTF-8（二进制）读失败即跳过
        let Ok(content) = std::fs::read_to_string(&resolved) else {
            skipped.push(f.clone());
            continue;
        };
        match store_blob(&content) {
            Ok(blob) => entries.push(json!({ "path": path, "existed": true, "blob": blob })),
            Err(_) => skipped.push(f.clone()),
        }
    }
    let saved = entries.len();
    let manifest = json!({ "session": session_id.trim(), "entries": entries });
    let _ = crate::config::atomic_write(
        &dir.join("manifest.json"),
        &serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".into()),
    );
    // 每轮存完顺手收口：按对话分组、每组只留最近 N 轮（run_dirs 已按 mtime 从新
    // 到旧），超量的连目录一起丢；再回收没人引用的 blob。
    let mut per_session: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for old in run_dirs() {
        // manifest 读不出来（损坏 / 半截写）没有归属，落到 "" 这一组，同样按
        // N 轮淘汰，不会永久赖在盘上。
        let session = read_run(&old).map(|r| r.session).unwrap_or_default();
        let n = per_session.entry(session).or_insert(0);
        *n += 1;
        if *n > SNAPSHOT_MAX_KEEP_RUNS_PER_SESSION {
            let _ = std::fs::remove_dir_all(&old);
        }
    }
    gc_blobs();
    json!({ "ok": true, "saved": saved, "skipped": skipped })
}

/// 把某轮快照写回工作区（「撤销本轮」的兜底段）：存过内容的还原成原文，
/// 快照时还不存在的（本轮新建的）删掉。
#[tauri::command]
pub fn snapshot_restore(state: State<'_, Arc<AppState>>, run_id: String) -> Value {
    let id = run_id.trim();
    if !is_safe_id(id) {
        return json!({ "ok": false, "error": "非法的快照 id" });
    }
    let Some(run) = read_run(&run_dir(id)) else {
        return json!({ "ok": false, "error": "快照不存在或已清理" });
    };
    let mut restored: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for e in &run.entries {
        let Some(path) = e.get("path").and_then(|v| v.as_str()) else {
            continue;
        };
        // 回滚是写操作，同样必须过 safe_path（防止快照被篡改后写到工作区外）
        let Some(resolved) = safe_path(&state, path) else {
            failed.push(path.to_string());
            continue;
        };
        // blob 名也过一遍 id 校验：manifest 是磁盘上的文件，被改成 `../x` 时
        // 不能让它跳出 blobs/。
        let outcome = if e
            .get("existed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            let content = e
                .get("blob")
                .and_then(|v| v.as_str())
                .filter(|b| is_safe_id(b))
                .and_then(|b| std::fs::read_to_string(blob_dir().join(b)).ok());
            match content {
                Some(c) => crate::config::atomic_write(&resolved, &c),
                // blob 不在了（被手工清过 / 键被删）：如实报失败，绝不能当成
                // "本轮新建的文件"把用户已有的文件删掉。
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "快照内容缺失",
                )),
            }
        } else if resolved.exists() {
            std::fs::remove_file(&resolved)
        } else {
            Ok(())
        };
        match outcome {
            Ok(()) => restored.push(path.to_string()),
            Err(_) => failed.push(path.to_string()),
        }
    }
    json!({ "ok": failed.is_empty(), "restored": restored, "failed": failed })
}

/// 清理某轮快照（「撤销本轮」还原成功后调用，避免无限涨盘）。
#[tauri::command]
pub fn snapshot_discard(run_id: String) -> Value {
    let id = run_id.trim();
    // runId 直接当目录名用：空串会让路径退化成上级目录，删除又是不可逆的。
    if !is_safe_id(id) {
        return json!({ "ok": false, "error": "非法的快照 id" });
    }
    let _ = std::fs::remove_dir_all(run_dir(id));
    gc_blobs();
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::{blob_key, is_safe_id};

    #[test]
    fn blob_keys_are_stable_and_content_specific() {
        assert_eq!(blob_key("abc"), blob_key("abc"));
        assert_ne!(blob_key("abc"), blob_key("abd"));
        // 长度进键：摘要之外还能区分前缀相同的内容
        assert_ne!(blob_key("abc"), blob_key("abcd"));
    }

    #[test]
    fn only_generator_shaped_ids_are_accepted() {
        assert!(is_safe_id("run-1f2e3d4c"));
        assert!(is_safe_id(&blob_key("x")));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id(".."));
        assert!(!is_safe_id("../blobs"));
        assert!(!is_safe_id("a/b"));
    }
}
