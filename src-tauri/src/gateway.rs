//! Child-process lifecycle helpers for the agent backend.
//!
//! The pi adapter (`pi_gateway.rs`) owns process spawning; this module keeps
//! only the shared event emission + kill/shutdown plumbing that other commands
//! (tray quit, hooks, etc.) need.

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

/// Kill every backend child process (main + per-conversation instances).
pub fn kill_current(state: &AppState) {
    let _ = state; // instances track their own children
    crate::pi_gateway::kill_all();
}

/// Stop all backend instances while holding the lifecycle lock. Unlike
/// `kill_current`, this cannot race a startup/restart handshake and kill the
/// fresh child before `get_state` completes.
pub fn stop_current(state: &AppState) {
    let _ = state;
    crate::pi_gateway::stop_all();
}

/// Spawn (or respawn) the backend child process.
pub fn spawn_gateway(state: &Arc<AppState>) -> Result<(), String> {
    crate::pi_gateway::spawn(state)
}

/// Debounced restart: pi snapshots its settings/model at process start, so
/// config writes (config.yaml, ~/.pi/agent/mcp.json, …) need a respawn to take
/// effect. Rapid successive writes coalesce into one restart.
///
/// The restart overlaps (see `pi_gateway::restart_overlapping`): the
/// replacement is spawned and handshaked while the old main keeps serving,
/// then promoted atomically — no disconnected window, no multi-second
/// cold-start badge. The pre-spawn sleep stays small: it only exists to let
/// rapid successive config writes coalesce.
pub fn restart_gateway_soon(state: &Arc<AppState>) {
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        static LAST_RESTART: std::sync::Mutex<u64> = std::sync::Mutex::new(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut last = LAST_RESTART.lock().unwrap();
        if now.saturating_sub(*last) < 500 && *last != 0 {
            return;
        }
        *last = now;
        drop(last);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = crate::pi_gateway::restart_overlapping(&state);
    });
}

/// Called when the app exits: kill the backend child.
pub fn shutdown(state: &AppState) {
    state
        .gateway
        .app_quitting
        .store(true, std::sync::atomic::Ordering::Relaxed);
    stop_current(state);
}
