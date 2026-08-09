//! Cross-platform path resolution for Hermes data / runtime locations.
//!
//! Uses ~/.hermes/ on all platforms (matches Hermes CLI convention).
//! Windows fallback: %LOCALAPPDATA%/hermes

use std::path::{Path, PathBuf};

/// The Hermes data directory (config.yaml, state.db, skills, memories, logs…).
/// Uses ~/.hermes/ to match Hermes CLI convention on Unix.
/// On Windows, prefer %LOCALAPPDATA%/hermes (the location the managed
/// install actually uses); fall back to ~/.hermes/ for any legacy layout.
pub fn hermes_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let local = dirs::data_local_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
        let candidate = local.join("hermes");
        if candidate.exists() {
            return candidate;
        }
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".hermes")
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
