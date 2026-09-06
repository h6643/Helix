//! Child-process lifecycle helpers for the agent backend.
//!
//! The codex adapter (`codex_gateway.rs`) owns process spawning; this module
//! keeps only the shared event emission + kill/shutdown plumbing that other
//! commands (tray quit, hooks, etc.) need.

use crate::state::{app_handle, AppState};
use serde_json::Value;
use std::sync::Arc;
use tauri::Emitter;

/// Emit a `helix:event` to the renderer: `{ method, params }`.
/// The frontend's `onEvent` subscriber unwraps exactly this envelope.
pub fn emit_helix_event(method: &str, params: &Value) {
    let _ = app_handle().emit(
        "helix:event",
        serde_json::json!({ "method": method, "params": params }),
    );
}

/// Kill the current backend child process, if any.
pub fn kill_current(state: &AppState) {
    let child = state.gateway.child.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Spawn (or respawn) the backend child process.
pub fn spawn_gateway(state: &Arc<AppState>) -> Result<(), String> {
    crate::codex_gateway::spawn(state)
}

/// Called when the app exits: kill the backend child.
pub fn shutdown(state: &AppState) {
    state
        .gateway
        .app_quitting
        .store(true, std::sync::atomic::Ordering::Relaxed);
    kill_current(state);
}
