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
pub fn hermes_data_dir() -> PathBuf {
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
