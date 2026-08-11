//! `fs:*` commands — path-validated file operations scoped to the working
//! directory. Port of `electron/ipc/fs.js`.

use crate::paths::hermes_data_dir;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// Allowed roots: current workDir + user-selected projects + hermes memories.
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

    // Allow hermes memory directory (used by learning view).
    let memory_dir = hermes_data_dir().join("memories");
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
        let r = norm(&root.display().to_string());
        let p = norm(&candidate.display().to_string());
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
pub fn write(state: State<'_, Arc<AppState>>, file_path: String, content: String) -> Result<Value, String> {
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
pub fn hermes_memory_dir() -> String {
    hermes_data_dir().join("memories").display().to_string()
}

#[tauri::command]
pub fn stat(state: State<'_, Arc<AppState>>, file_path: String) -> Result<Value, String> {
    let resolved = safe_path(&state, &file_path).ok_or_else(outside_err)?;
    let m = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    Ok(json!({
        "isFile": m.is_file(),
        "isDirectory": m.is_dir(),
        "size": m.len(),
        "mtime": m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0),
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
pub fn scan_tree(state: State<'_, Arc<AppState>>, relative_path: Option<String>) -> Result<Value, String> {
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
            return if at == "folder" { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.get("name").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    nodes
}

#[tauri::command]
pub fn allow_root(state: State<'_, Arc<AppState>>, dir: String) -> Value {
    state.add_allowed_root(&dir);
    json!({ "success": true })
}
