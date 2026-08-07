//! Cross-platform path resolution for Hermes data / runtime locations.
//! Port of `electron/lib/platform-paths.js`.
//!
//! Windows: `%LOCALAPPDATA%/hermes`; POSIX: `$XDG_DATA_HOME/hermes`
//! (default `~/.local/share/hermes`).

use std::path::{Path, PathBuf};

pub fn local_app_data_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(v) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(v);
        }
        dirs::home_dir().map(|h| h.join("AppData").join("Local")).unwrap_or_default()
    } else {
        if let Ok(v) = std::env::var("XDG_DATA_HOME") {
            if !v.is_empty() {
                return PathBuf::from(v);
            }
        }
        dirs::data_dir().unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        })
    }
}

/// The Hermes data directory (config.yaml, state.db, skills, memories, logs…).
pub fn hermes_data_dir() -> PathBuf {
    local_app_data_dir().join("hermes")
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
