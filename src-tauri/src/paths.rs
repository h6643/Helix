//! Cross-platform path resolution for Helix backend data / runtime locations.
//!
//! Uses ~/.codex/ on all platforms — the same home the codex gateway
//! (CODEX_HOME) and the codex CLI / VS Code extension use, so config + auth +
//! sessions + skills all live in one place. The separate ~/.helix mirror was
//! retired (2026-09-08).

use std::path::PathBuf;

/// The backend data directory (config.yaml, state.db, skills, memories, logs…).
/// Uses ~/.codex/ on all platforms, matching the codex gateway home so the
/// whole backend lives in a single directory.
///
/// The location can be overridden (Settings → 数据存储路径) via either an
/// explicit `HELIX_DATA_DIR` env var or a pointer file at
/// `<config_dir>/helix/data_root`. The pointer file intentionally lives
/// OUTSIDE the data dir so it does not move when the data dir is relocated.
pub fn helix_data_dir() -> PathBuf {
    // 1) Explicit env override (dev / test / CI).
    if let Ok(env) = std::env::var("HELIX_DATA_DIR") {
        let p = env.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    // 2) Persisted override pointer (set via Settings → 数据存储路径).
    if let Some(ptr) = data_root_pointer_path() {
        if let Ok(raw) = std::fs::read_to_string(&ptr) {
            let p = raw.trim();
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    // 3) Default.
    default_helix_data_dir()
}

/// The default backend data directory (no override applied).
pub fn default_helix_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

/// Pointer file (outside the data dir) that overrides `helix_data_dir()`.
/// Lives in the platform config dir (e.g. `~/.config/helix/data_root` on Unix)
/// so it survives relocation of the data dir itself.
pub fn data_root_pointer_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join("helix").join("data_root"))
}

/// Portable standalone Python interpreter bundled with the data dir.
/// `python/python.exe` on Windows, `python/bin/python3` on Unix.
pub fn standalone_python() -> PathBuf {
    let base = helix_data_dir().join("python");
    if cfg!(windows) {
        base.join("python.exe")
    } else {
        base.join("bin").join("python3")
    }
}
