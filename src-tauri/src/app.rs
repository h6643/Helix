//! `app:*` Tauri commands + work-dir persistence.
//! Port of `electron/main.js` (app:getInfo / syncWorkDir / setWorkDir / quit)
//! and the workdir.json persistence helpers.

use crate::gateway::{kill_current, shutdown, spawn_gateway};
use crate::paths::{
    data_root_pointer_path, default_helix_data_dir, helix_data_dir, strip_verbatim_prefix,
};
use crate::state::{user_data_dir, AppState};
use serde_json::{json, Value};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

pub const WORKDIR_FILE: &str = "workdir.json";

// ── work-dir persistence ───────────────────────

pub fn persisted_work_dir() -> Option<PathBuf> {
    let dir = user_data_dir()?;
    let p = dir.join(WORKDIR_FILE);
    let raw = std::fs::read_to_string(p).ok()?;
    let obj: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if let Some(w) = obj.get("workDir").and_then(|v| v.as_str()) {
        let w = w.trim();
        if !w.is_empty() {
            return Some(PathBuf::from(w));
        }
    }
    None
}

pub fn persist_work_dir(dir: &str) {
    if let Some(d) = user_data_dir() {
        let _ = std::fs::create_dir_all(&d);
        // Strip the verbatim `\\?\` prefix std::fs::canonicalize adds on Windows.
        // Storing it verbatim is harmless while the dir exists, but the raw form
        // is what later spawn() calls use as child cwd — and it also leaks into
        // the renderer, where path joins compare against non-verbatim paths.
        // NOTE: a raw string can't end with a backslash, so the previous
        // `trim_start_matches(r"\\?\\")` matched a 5-char pattern (`\\?\\`)
        // that never occurs — the prefix was never stripped and workdir.json
        // kept `\\?\D:\...`. Use the shared helper (also handles UNC).
        let clean = strip_verbatim_prefix(Path::new(dir));
        let _ = std::fs::write(
            d.join(WORKDIR_FILE),
            json!({ "workDir": clean }).to_string(),
        );
    }
}

/// Render a path for the renderer. `std::fs::canonicalize` returns verbatim
/// `\\?\`-prefixed paths on Windows (correct for internal comparison, but ugly
/// in the UI — e.g. the terminal prompt becomes `\\?\D:\桌面\...`). Strip the
/// namespace prefix for display only; internal storage (state.work_dir /
/// allowed_roots) keeps the canonical form so path checks stay consistent.
fn display_path(p: &Path) -> String {
    let s = p.display().to_string();
    match s.strip_prefix("\\\\?\\") {
        // `rest[..4]` would PANIC when byte 4 lands inside a multi-byte UTF-8
        // char (e.g. `\\?\D:\桌面\...` → `D:\桌...`); `get(..4)` returns None
        // there and falls through to the plain strip. `rest[4..]` below is safe
        // because the `UNC\` prefix is 4 ASCII bytes.
        Some(rest)
            if rest
                .get(..4)
                .is_some_and(|r| r.eq_ignore_ascii_case("UNC\\")) =>
        {
            format!("\\\\{}", &rest[4..])
        }
        Some(rest) => rest.to_string(),
        None => s,
    }
}

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn platform() -> String {
    if cfg!(windows) {
        "win32".to_string()
    } else if cfg!(target_os = "macos") {
        "darwin".to_string()
    } else {
        "linux".to_string()
    }
}

// ── commands ───────────────────────────

#[tauri::command]
pub fn get_info(state: State<'_, Arc<AppState>>) -> Value {
    let work_dir = state.work_dir.read().unwrap().clone();
    let pi_version = crate::helix::installed_pi_version();
    json!({
        "version": app_version(),
        "piVersion": pi_version.unwrap_or_default(),
        "platform": platform(),
        "workDir": display_path(&work_dir),
    })
}

/// Lightweight alignment: only set main-process workDir + register the allowed
/// root. No restart, no persist, no mkdir (mirror app:syncWorkDir).
#[tauri::command]
pub fn sync_work_dir(state: State<'_, Arc<AppState>>, dir: String) -> Value {
    let d = dir.trim().to_string();
    if d.is_empty() {
        let w = state.work_dir.read().unwrap().clone();
        return json!({ "success": false, "workDir": display_path(&w) });
    }
    let resolved = if std::path::Path::new(&d).is_absolute() {
        PathBuf::from(&d)
    } else {
        state.work_dir.read().unwrap().join(&d)
    };
    let resolved = resolved.canonicalize().unwrap_or(resolved);
    *state.work_dir.write().unwrap() = resolved.clone();
    state.add_allowed_root(resolved.to_str().unwrap_or(""));
    json!({ "success": true, "workDir": display_path(&resolved) })
}

#[tauri::command]
pub fn set_work_dir(state: State<'_, Arc<AppState>>, dir: Option<String>) -> Value {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let d = match dir {
        Some(d) if d.trim().is_empty() => String::new(),
        Some(d) => d,
        None => String::new(),
    };
    // Drive roots / "/" resolve back to the home dir (mirror Electron).
    let is_root = d == "/"
        || d == "\\"
        || (d.len() == 3 && d.as_bytes()[1] == b':' && d.ends_with(['/', '\\']));
    let base = if is_root {
        home.clone()
    } else {
        state.work_dir.read().unwrap().clone()
    };
    let target = if is_root || d.is_empty() {
        base
    } else if std::path::Path::new(&d).is_absolute() {
        PathBuf::from(&d)
    } else {
        base.join(&d)
    };
    // Ensure the directory exists — explicit_cwd requires isdir() == true.
    if let Err(e) = std::fs::create_dir_all(&target) {
        eprintln!(
            "[setWorkDir] failed to create directory: {} {e}",
            target.display()
        );
    }
    // Canonicalize so the path returned to the renderer matches the canonicalized
    // form stored in allowed_roots. Windows paths are case-insensitive but compared
    // as strings, so a case/separator mismatch would make a later scanTree fail
    // with "Path is outside working directory".
    let canonical = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    *state.work_dir.write().unwrap() = canonical.clone();
    state.add_allowed_root(canonical.to_str().unwrap_or(""));
    persist_work_dir(canonical.to_str().unwrap_or(""));
    // Backend cwd is fixed at spawn time — restart to apply.
    kill_current(&state);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let _ = spawn_gateway(&state);
    json!({ "success": true, "workDir": display_path(&canonical) })
}

/// Kill + respawn the backend.
#[tauri::command]
pub fn restart_gateway(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    kill_current(&state);
    std::thread::sleep(std::time::Duration::from_millis(300));
    spawn_gateway(&state)
}

#[tauri::command]
pub fn quit(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    shutdown(&state);
    let handle = crate::state::app_handle();
    handle.exit(0);
    Ok(())
}

/// Read a key value from the helix .env file (e.g. TAVILY_API_KEY).
#[tauri::command]
pub fn read_env_key(key: String) -> String {
    crate::config::read_env_key(&key)
}

/// Returns the effective data-root info for the Settings UI.
#[tauri::command]
pub fn get_data_root() -> Value {
    let default = default_helix_data_dir();
    let current = helix_data_dir();
    let custom = current != default;
    json!({
        "dataRoot": current.display().to_string(),
        "dataRootDefault": default.display().to_string(),
        "dataRootCustom": custom,
    })
}

/// Set (or clear) the Helix data-root override.
///
/// - `path` empty  → restore the default location (copy current data there,
///   then delete the pointer so the default is used on next launch).
/// - `path` set    → copy current data into `path`, then write the pointer so
///   the new location is used on next launch. The running process keeps using
///   the old location until Helix is restarted.
#[tauri::command]
pub fn set_data_root(path: String) -> Result<Value, String> {
    let current = helix_data_dir();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let default = default_helix_data_dir();

    // Resolve the requested target path.
    let raw = path.trim();
    let target = if raw.is_empty() {
        default.clone()
    } else {
        let expanded = if raw.starts_with('~') {
            home.join(
                raw.trim_start_matches('~')
                    .trim_start_matches('/')
                    .trim_start_matches('\\'),
            )
        } else if Path::new(raw).is_absolute() {
            PathBuf::from(raw)
        } else {
            home.join(raw)
        };
        // Canonicalize only if it already exists; otherwise keep as-is so we
        // can create it below. Strip the verbatim `\\?\` prefix canonicalize
        // adds on Windows — the plain form goes into the pointer file, the
        // renderer response, and the `target == current/default` equality
        // checks (verbatim vs plain strings would never compare equal).
        let canon = expanded.canonicalize().unwrap_or(expanded);
        strip_verbatim_prefix(&canon)
    };

    // No-op: already at the requested location. Make sure the pointer reflects
    // the intent (default ⇒ no pointer file).
    if target == current {
        if target == default {
            remove_pointer()?;
        }
        return Ok(json!({
            "success": true,
            "dataRoot": current.display().to_string(),
            "dataRootDefault": default.display().to_string(),
            "dataRootCustom": target != default,
            "copied": false,
        }));
    }

    // Create the target directory.
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("无法创建目标目录 {}: {e}", target.display()))?;

    // Copy existing data (if any) into the target.
    let mut copied: u64 = 0;
    if current.exists() {
        copied = copy_tree(&current, &target).map_err(|e| format!("复制数据失败: {e}"))?;
    }

    // Persist the pointer (or clear it when targeting the default).
    if target == default {
        remove_pointer()?;
    } else {
        write_pointer(&target).map_err(|e| format!("写入数据路径配置失败: {e}"))?;
    }

    Ok(json!({
        "success": true,
        "dataRoot": target.display().to_string(),
        "dataRootDefault": default.display().to_string(),
        "dataRootCustom": target != default,
        "copied": copied > 0,
        "bytes": copied,
    }))
}

/// Recursively copy `src` into `dst` (merge, overwrite). Symlinks are skipped
/// to avoid following (and duplicating) external trees. Returns bytes copied.
fn copy_tree(src: &Path, dst: &Path) -> io::Result<u64> {
    let mut total: u64 = 0;
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_symlink() {
            // Skip symlinks to avoid loops / external duplication.
            continue;
        } else if file_type.is_dir() {
            total += copy_tree(&src_path, &dst_path)?;
        } else {
            let mut reader = std::fs::File::open(&src_path)?;
            let mut writer = std::fs::File::create(&dst_path)?;
            total += io::copy(&mut reader, &mut writer)?;
        }
    }
    Ok(total)
}

/// Write the override pointer (absolute target path, no trailing newline).
fn write_pointer(target: &Path) -> io::Result<()> {
    if let Some(ptr) = data_root_pointer_path() {
        if let Some(parent) = ptr.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&ptr, target.display().to_string())?;
    }
    Ok(())
}

/// Remove the override pointer if present.
fn remove_pointer() -> Result<(), String> {
    if let Some(ptr) = data_root_pointer_path() {
        if ptr.exists() {
            std::fs::remove_file(&ptr).map_err(|e| format!("无法清除数据路径配置: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_path_strips_verbatim_prefix() {
        // Plain drive path with no prefix → unchanged.
        assert_eq!(display_path(Path::new("D:\\foo")), "D:\\foo");
        // ASCII drive path.
        assert_eq!(display_path(Path::new("\\\\?\\C:\\Windows")), "C:\\Windows");
        // CJK immediately after the drive root: byte 4 falls inside a multi-byte
        // char — must strip without panicking on the byte-index slice.
        assert_eq!(
            display_path(Path::new("\\\\?\\D:\\桌面\\客户知识库\\wiki")),
            "D:\\桌面\\客户知识库\\wiki"
        );
        // UNC share.
        assert_eq!(
            display_path(Path::new("\\\\?\\UNC\\server\\share")),
            "\\\\server\\share"
        );
    }
}

// ── Version & Status ────────────────────────

#[tauri::command]
pub fn get_helix_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn get_status() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
    })
}

// ── Raw Config ──────────────────────────

#[tauri::command]
pub async fn helix_get_raw_config() -> Result<Value, String> {
    crate::config::read_raw_config()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn helix_set_raw_config(config: Value) -> Result<(), String> {
    crate::config::write_raw_config(config)
        .await
        .map_err(|e| e.to_string())
}

// ── Doctor / Diagnostic ───────────────────────

#[tauri::command]
pub async fn helix_doctor() -> Result<Value, String> {
    let data_dir = helix_data_dir();
    let config_ok = std::fs::read_to_string(data_dir.join("config.yaml")).is_ok();
    let env_ok = std::fs::read_to_string(data_dir.join(".env")).is_ok();
    let runtime_ok = which::which("python3").is_ok() || which::which("python").is_ok();

    Ok(json!({
        "dataDir": data_dir.display().to_string(),
        "configYaml": if config_ok { "ok" } else { "missing" },
        "envFile": if env_ok { "ok" } else { "missing" },
        "python": if runtime_ok { "ok" } else { "not found" },
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// ── Update Check ─────────────────────────

#[tauri::command]
pub async fn helix_update() -> Result<Value, String> {
    // Placeholder: Tauri's built-in updater should be used in production
    Ok(json!({
        "available": false,
        "version": env!("CARGO_PKG_VERSION"),
        "message": "暂无更新"
    }))
}
