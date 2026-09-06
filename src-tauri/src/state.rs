//! Global app state shared across Tauri commands.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, RwLock};
use tauri::Manager;

/// Global AppHandle set once during setup — lets background threads and sync
/// commands emit Tauri events / resolve paths without threading a handle
/// through every function.
pub static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn app_handle() -> &'static tauri::AppHandle {
    APP_HANDLE.get().expect("APP_HANDLE not initialized")
}

/// The app's data dir (mirror of Electron `app.getPath('userData')`).
pub fn user_data_dir() -> Option<PathBuf> {
    app_handle().path().app_data_dir().ok()
}

/// State for the agent backend child process (`codex app-server --stdio`).
pub struct GatewayState {
    /// Handle to the spawned backend child process.
    pub child: Mutex<Option<std::process::Child>>,
    pub app_quitting: AtomicBool,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            app_quitting: AtomicBool::new(false),
        }
    }
}

pub struct AppState {
    /// Current working directory the backend / fs commands operate in.
    pub work_dir: RwLock<PathBuf>,
    /// Extra roots the user has selected (allowed for fs access).
    pub allowed_roots: RwLock<Vec<PathBuf>>,
    pub gateway: GatewayState,
}

impl AppState {
    /// Register `dir` as an allowed fs root (path-resolved, deduped).
    pub fn add_allowed_root(&self, dir: &str) {
        let dir = dir.trim();
        if dir.is_empty() {
            return;
        }
        let p = std::path::Path::new(dir);
        let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let mut roots = self.allowed_roots.write().unwrap();
        if !roots.contains(&resolved) {
            roots.push(resolved);
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            work_dir: RwLock::new(dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))),
            allowed_roots: RwLock::new(Vec::new()),
            gateway: GatewayState::default(),
        }
    }
}
