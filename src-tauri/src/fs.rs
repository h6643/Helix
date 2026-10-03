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
// 落点：`helix_data_dir()/snapshots/<runId>/`。绝不能放
// `~/.pi/agent/sessions/`——pi 按 cwd 编码分桶且会 create_dir_all，
// 混进去会被当成真会话。

/// 超过这个大小或非 UTF-8 的文件跳过快照（二进制/大文件还原风险大于收益）。
const SNAPSHOT_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn snapshot_dir(run_id: &str) -> std::path::PathBuf {
    crate::paths::helix_data_dir()
        .join("snapshots")
        .join(run_id)
}

/// 快照键：把绝对路径压成「盘符/下划线 + 相对路径」，保证能当文件名。
/// Windows 保留字符（`< > : " | ? *` 与路径分隔符）一律换成下划线。
fn snapshot_key(abs_path: &str) -> String {
    abs_path
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '*' | '?' | '<' | '>' | '"' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// 快照落盘：存的是「文件绝对路径 → 内容」对，逐个 atomic_write。
/// 读文件同样过 safe_path：快照只能覆盖工作区内的文件。
#[tauri::command]
pub fn snapshot_save(
    state: State<'_, Arc<AppState>>,
    run_id: String,
    files: Vec<String>,
) -> Value {
    if run_id.trim().is_empty() {
        return json!({ "ok": false, "error": "run_id 不能为空" });
    }
    let dir = snapshot_dir(run_id.trim());
    let mut manifest: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for f in &files {
        let Some(resolved) = safe_path(&state, f) else {
            skipped.push(f.clone());
            continue;
        };
        // 本轮快照的是「改动之前」的状态：文件不存在 = 当时是新建，
        // 记进 manifest 但不存内容，回滚时直接删掉即可。
        if !resolved.exists() {
            manifest.push(resolved.display().to_string());
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
        let key = snapshot_key(&resolved.display().to_string());
        if crate::config::atomic_write(&dir.join(&key), &content).is_err() {
            skipped.push(f.clone());
            continue;
        }
        manifest.push(resolved.display().to_string());
    }
    // manifest 存 key → 原路径的映射；不存在 = 该文件快照时还不存在
    let mf: Vec<serde_json::Value> = manifest
        .iter()
        .map(|p| {
            let key = snapshot_key(p);
            json!({ "key": key, "path": p, "existed": dir.join(&key).exists() })
        })
        .collect();
    let _ = crate::config::atomic_write(
        &dir.join("manifest.json"),
        &serde_json::to_string_pretty(&mf).unwrap_or_else(|_| "[]".into()),
    );
    json!({ "ok": true, "saved": mf.len(), "skipped": skipped })
}

/// 整轮回滚：把快照里的内容写回；快照时不存在的一律删除（还原成"新建前"）。
#[tauri::command]
pub fn snapshot_restore(state: State<'_, Arc<AppState>>, run_id: String) -> Value {
    let dir = snapshot_dir(run_id.trim());
    let mf_path = dir.join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&mf_path) else {
        return json!({ "ok": false, "error": "快照不存在或已清理" });
    };
    let Ok(entries) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return json!({ "ok": false, "error": "快照清单损坏" });
    };
    let Some(list) = entries.as_array() else {
        return json!({ "ok": false, "error": "快照清单格式错误" });
    };
    let mut restored: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for e in list {
        let (Some(key), Some(path)) = (
            e.get("key").and_then(|v| v.as_str()),
            e.get("path").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        // 回滚是写操作，同样必须过 safe_path（防止快照被篡改后写到工作区外）
        let Some(resolved) = safe_path(&state, path) else {
            failed.push(path.to_string());
            continue;
        };
        let snap = dir.join(key);
        if snap.exists() {
            // 两步各自报错即可：读快照失败 或 写回失败 都算这一文件回滚失败
            let outcome = std::fs::read_to_string(&snap)
                .map_err(|e| e.to_string())
                .and_then(|c| crate::config::atomic_write(&resolved, &c).map_err(|e| e.to_string()));
            match outcome {
                Ok(()) => restored.push(path.to_string()),
                Err(_) => failed.push(path.to_string()),
            }
        } else if resolved.exists() {
            // 快照时不存在 → 本轮是新建出来的，回滚 = 删掉
            match std::fs::remove_file(&resolved) {
                Ok(()) => restored.push(path.to_string()),
                Err(_) => failed.push(path.to_string()),
            }
        }
    }
    json!({ "ok": failed.is_empty(), "restored": restored, "failed": failed })
}

/// 清理某轮快照（回滚成功后调用，避免无限涨盘）。
#[tauri::command]
pub fn snapshot_discard(run_id: String) -> Value {
    let dir = snapshot_dir(run_id.trim());
    let _ = std::fs::remove_dir_all(&dir);
    json!({ "ok": true })
}

/// 列出仍保留的快照轮次（runId + 时间），供 UI 展示"可回滚的轮次"。
#[tauri::command]
pub fn snapshot_list() -> Value {
    let base = crate::paths::helix_data_dir().join("snapshots");
    let Ok(rd) = std::fs::read_dir(&base) else {
        return json!({ "ok": true, "runs": [] });
    };
    let mut runs: Vec<serde_json::Value> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let count = std::fs::read_dir(entry.path())
            .map(|it| it.flatten().filter(|e| e.file_name() != "manifest.json").count())
            .unwrap_or(0);
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        runs.push(json!({ "runId": name, "files": count, "modified": modified }));
    }
    runs.sort_by(|a, b| {
        b.get("modified")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(&a.get("modified").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    json!({ "ok": true, "runs": runs })
}
