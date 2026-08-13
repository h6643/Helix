//! Cross-platform path resolution for Hermes data / runtime locations.
//!
//! Uses ~/.hermes/ on all platforms (matches Hermes CLI convention).
//! Windows fallback: %LOCALAPPDATA%/hermes

use std::path::{Path, PathBuf};

/// The Hermes data directory (config.yaml, state.db, skills, memories, logs…).
/// Uses ~/.hermes/ to match Hermes CLI convention on Unix.
/// On Windows, uses %LOCALAPPDATA%/hermes (the location the official
/// Hermes installer and managed runtime use). Falls back to ~/.hermes/
/// only when a legacy install already exists there.
///
/// The location can be overridden (Settings → 数据存储路径) via either an
/// explicit `HERMES_DATA_DIR` env var or a pointer file at
/// `<config_dir>/helix/data_root`. The pointer file intentionally lives
/// OUTSIDE the data dir so it does not move when the data dir is relocated.
pub fn hermes_data_dir() -> PathBuf {
    // 1) Explicit env override (dev / test / CI).
    if let Ok(env) = std::env::var("HERMES_DATA_DIR") {
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
    default_hermes_data_dir()
}

/// The default Hermes data directory (no override applied).
pub fn default_hermes_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        // %LOCALAPPDATA%/hermes is the canonical Windows location used by the
        // official hermes-agent installer. Use it as the default even before
        // the directory exists, so first-run bootstrap creates content there.
        let local = dirs::data_local_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
        let canonical = local.join("hermes");
        // Preserve legacy ~/.hermes/ if it already has a config (migration).
        let legacy = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".hermes");
        if legacy.join("config.yaml").exists() && !canonical.join("config.yaml").exists() {
            return legacy;
        }
        canonical
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".hermes")
    }
}

/// Pointer file (outside the data dir) that overrides `hermes_data_dir()`.
/// Lives in the platform config dir (e.g. `~/.config/helix/data_root` on Unix)
/// so it survives relocation of the data dir itself.
pub fn data_root_pointer_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join("helix").join("data_root"))
}

/// The bundled / managed Hermes agent checkout.
pub fn hermes_agent_dir() -> PathBuf {
    hermes_data_dir().join("hermes-agent")
}

/// Python interpreter inside a Hermes agent venv.
#[allow(dead_code)]
pub fn venv_python(agent_dir: Option<&Path>) -> PathBuf {
    let base = agent_dir.unwrap_or(&hermes_agent_dir()).to_path_buf();
    if cfg!(windows) {
        base.join("venv").join("Scripts").join("python.exe")
    } else {
        base.join("venv").join("bin").join("python")
    }
}

/// Hermes CLI executable inside a Hermes agent venv.
pub fn venv_hermes_bin(agent_dir: Option<&Path>, venv_name: &str) -> PathBuf {
    let base = agent_dir.unwrap_or(&hermes_agent_dir()).to_path_buf();
    if cfg!(windows) {
        base.join(venv_name).join("Scripts").join("hermes.exe")
    } else {
        base.join(venv_name).join("bin").join("hermes")
    }
}

/// Portable standalone Python interpreter bundled with Helix (no venv).
///
/// python-build-standalone layout: `python/python.exe` on Windows,
/// `python/bin/python3` on Unix. Hermes + all deps are pre-installed into
/// this interpreter's site-packages at build time, so launching is simply
/// `python -m hermes …` — no venv, no hardcoded CI paths.
pub fn standalone_python() -> PathBuf {
    let base = hermes_data_dir().join("python");
    if cfg!(windows) {
        base.join("python.exe")
    } else {
        base.join("bin").join("python3")
    }
}
