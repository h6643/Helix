//! Global app state shared across Tauri commands.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicBool};
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

/// Gateway connection info exposed to the renderer (serve mode).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServeGatewayInfo {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ws_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
}

pub struct HermesState {
    /// Handle to the spawned `hermes serve` / `hermes acp` child process.
    pub child: Mutex<Option<std::process::Child>>,
    /// Serve-mode handshake info.
    pub serve_info: RwLock<Option<ServeGatewayInfo>>,
    /// Session token pinned for the serve gateway (loopback WS auth).
    pub session_token: Mutex<Option<String>>,
    /// 'local' spawns the bundled runtime; 'remote' connects to an external WS.
    pub gateway_mode: Mutex<String>,
    pub remote_gateway_url: Mutex<String>,
    pub respawn_count: AtomicU64,
    pub respawn_window_start: AtomicU64,
    pub app_quitting: AtomicBool,
}

impl Default for HermesState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            serve_info: RwLock::new(None),
            session_token: Mutex::new(None),
            gateway_mode: Mutex::new("local".to_string()),
            remote_gateway_url: Mutex::new(String::new()),
            respawn_count: AtomicU64::new(0),
            respawn_window_start: AtomicU64::new(0),
            app_quitting: AtomicBool::new(false),
        }
    }
}

pub struct AppState {
    /// Current working directory the gateway / fs commands operate in.
    pub work_dir: RwLock<PathBuf>,
    /// Extra roots the user has selected (allowed for fs access).
    pub allowed_roots: RwLock<Vec<PathBuf>>,
    pub hermes: HermesState,
    /// Diagnostics snapshot (signature status etc.).
    #[allow(dead_code)]
    pub signature_status: RwLock<String>,
    #[allow(dead_code)]
    pub signature_detail: RwLock<String>,
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
            hermes: HermesState::default(),
            signature_status: RwLock::new("unverified".to_string()),
            signature_detail: RwLock::new("内核签名校验尚未执行".to_string()),
        }
    }
}
