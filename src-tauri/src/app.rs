//! `app:*` Tauri commands + work-dir persistence.
//! Port of `electron/main.js` (app:getInfo / syncWorkDir / getHermesVersion /
//! setWorkDir / quit) and the workdir.json persistence helpers.

use crate::gateway::{env_gateway_mode, kill_current, shutdown, spawn_gateway};
use crate::kernel::resolve_hermes_cmd;
use crate::state::{user_data_dir, AppState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::State;

pub const WORKDIR_FILE: &str = "workdir.json";

// ── work-dir persistence (userData/workdir.json) ───────────────────────────

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
        let _ = std::fs::write(d.join(WORKDIR_FILE), json!({ "workDir": dir }).to_string());
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

// ── commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_info(state: State<'_, Arc<AppState>>) -> Value {
    let work_dir = state.work_dir.read().unwrap().clone();
    json!({
        "version": app_version(),
        "platform": platform(),
        "workDir": work_dir.display().to_string(),
    })
}

/// Lightweight alignment: only set main-process workDir + register the allowed
/// root. No restart, no persist, no mkdir (mirror app:syncWorkDir).
#[tauri::command]
pub fn sync_work_dir(state: State<'_, Arc<AppState>>, dir: String) -> Value {
    let d = dir.trim().to_string();
    if d.is_empty() {
        let w = state.work_dir.read().unwrap().clone();
        return json!({ "success": false, "workDir": w.display().to_string() });
    }
    let resolved = if std::path::Path::new(&d).is_absolute() {
        PathBuf::from(&d)
    } else {
        state
            .work_dir
            .read()
            .unwrap()
            .join(&d)
    };
    let resolved = resolved
        .canonicalize()
        .unwrap_or(resolved);
    *state.work_dir.write().unwrap() = resolved.clone();
    state.add_allowed_root(resolved.to_str().unwrap_or(""));
    json!({ "success": true, "workDir": resolved.display().to_string() })
}

/// Get installed Hermes backend version via `hermes --version`.
#[tauri::command]
pub fn get_hermes_version() -> Option<String> {
    let cmd = resolve_hermes_cmd()?;
    let mut ver_cmd = Command::new(&cmd);
    ver_cmd.arg("--version");
    #[cfg(windows)]
    ver_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let out = ver_cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    // Hermes prints e.g. "Hermes Agent v1.x.y (1.2.3)" — grab the (x.y.z) group.
    parse_version(&s)
}

pub fn parse_version(s: &str) -> Option<String> {
    // Match "(x.y.z)" or "(x.y.z.w)" inside the output.
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '(' {
            let mut j = i + 1;
            let mut buf = String::new();
            let mut segments = 0;
            let mut ok = false;
            while j < chars.len() {
                let c = chars[j];
                if c == ')' {
                    ok = true;
                    break;
                }
                if c.is_ascii_digit() {
                    buf.push(c);
                } else if c == '.' {
                    segments += 1;
                    buf.push(c);
                } else {
                    break;
                }
                j += 1;
            }
            if ok && segments >= 2 && segments <= 3 && !buf.is_empty() {
                return Some(buf);
            }
            i = j;
        }
        i += 1;
    }
    None
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
    let is_root = d == "/" || d == "\\" || (d.len() == 3 && d.as_bytes()[1] == b':' && d.ends_with(['/', '\\']));
    let base = if is_root { home.clone() } else { state.work_dir.read().unwrap().clone() };
    let target = if is_root || d.is_empty() {
        base
    } else if std::path::Path::new(&d).is_absolute() {
        PathBuf::from(&d)
    } else {
        base.join(&d)
    };
    // Ensure the directory exists — explicit_cwd requires isdir() == true.
    if let Err(e) = std::fs::create_dir_all(&target) {
        eprintln!("[setWorkDir] failed to create directory: {} {e}", target.display());
    }
    // Canonicalize so the path returned to the renderer matches the canonicalized
    // form stored in allowed_roots. Windows paths are case-insensitive but compared
    // as strings, so a case/separator mismatch would make a later scanTree fail
    // with "Path is outside working directory".
    let canonical = std::fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    *state.work_dir.write().unwrap() = canonical.clone();
    state.add_allowed_root(canonical.to_str().unwrap_or(""));
    persist_work_dir(canonical.to_str().unwrap_or(""));
    // serve mode: cwd applied per-session via explicit_cwd — no restart.
    // acp mode: gateway cwd is fixed at spawn time — restart to apply.
    if env_gateway_mode() != "serve" {
        kill_current(&state);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = spawn_gateway(&state);
    }
    json!({ "success": true, "workDir": canonical.display().to_string() })
}

/// Kill + respawn the gateway. serve mode: no-op (config re-read per session).
#[tauri::command]
pub fn restart_gateway(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if env_gateway_mode() == "serve" {
        return Ok(());
    }
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
