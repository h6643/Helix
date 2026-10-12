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

/// Stop all backend instances while holding the lifecycle lock, so it cannot
/// race a startup/restart handshake and kill a fresh child before `get_state`
/// completes. Config-driven respawns must NOT use this: go through
/// `restart_gateway_now` / `restart_gateway_soon` (overlapping handover). This
/// is for shutdown, where killing everything is the point.
pub fn stop_current(state: &AppState) {
    let _ = state;
    crate::pi_gateway::stop_all();
}

/// A restart handover is running (or about to run) on the coalescer's worker.
static RESTART_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// Config writes landed while the handover was running, so one more restart is
/// owed. Cleared by the worker before it hands over, because the handover reads
/// the fresh disk state anyway.
static RESTART_PENDING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Releases the coalescer's claim even if the handover panics (the lifecycle
/// lock is `.unwrap()`ed, so a poisoned lock panics — without this the claim
/// would latch and every later config change would silently never restart).
struct RestartClaim;

impl Drop for RestartClaim {
    fn drop(&mut self) {
        RESTART_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Coalescing restart: pi snapshots its settings/model at process start, so
/// config writes (config.yaml, ~/.pi/agent/mcp.json, …) need a respawn to take
/// effect. Rapid successive writes coalesce into one restart.
///
/// The restart overlaps (see `pi_gateway::restart_overlapping`): the
/// replacement is spawned and handshaked while the old main keeps serving,
/// then promoted atomically — no disconnected window, no multi-second
/// cold-start badge.
///
/// "Coalescing" is something this used to claim but not do. The old gate was
/// "drop calls arriving <500ms after the previous one", while a restart holds
/// the lifecycle lock for its whole 11-27s handshake. So a multi-key save (the
/// 子智能体 settings page writes 6 `delegation.*` keys concurrently) passed the
/// gate several times, and those calls then queued on the lock and ran
/// back-to-back — 4 chained restarts observed 2026-10-12 at 02:08:34→02:09:06,
/// each one's post-handover sweep killing the handshakes the previous restart
/// had just started (`killed by Helix`, 16-20s cold prepares instead of a warm
/// spare). Now a caller that arrives while a restart is in flight only raises
/// the pending flag, and exactly one follow-up restart runs afterwards.
///
/// `reason` lands in helix-recover.log: restarts are otherwise invisible there,
/// and this storm had to be reconstructed from call sites.
fn schedule_restart(state: &Arc<AppState>, reason: &str, settle_first: bool) {
    use std::sync::atomic::Ordering::SeqCst;
    // Claim the slot in the CALLING thread, i.e. after that caller's config
    // write has already landed on disk. Claiming inside the worker would let
    // every thread of a burst spawn a loop of its own.
    if RESTART_IN_FLIGHT.swap(true, SeqCst) {
        RESTART_PENDING.store(true, SeqCst);
        crate::pi_gateway::log_spawn_diag(&format!(
            "restart coalesced into the in-flight restart: {reason}"
        ));
        return;
    }
    let state = Arc::clone(state);
    let mut reason = reason.to_string();
    std::thread::spawn(move || {
        let _claim = RestartClaim;
        loop {
            if settle_first {
                // Let a burst of config writes settle into this one restart.
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            RESTART_PENDING.store(false, SeqCst);
            crate::pi_gateway::log_spawn_diag(&format!("restart requested: {reason}"));
            let _ = crate::pi_gateway::restart_overlapping(&state);
            reason =
                "follow-up restart (its triggers logged as coalesced above)".to_string();
            if !RESTART_PENDING.swap(false, SeqCst) {
                break;
            }
        }
    });
}

pub fn restart_gateway_soon(state: &Arc<AppState>, reason: &str) {
    schedule_restart(state, reason, true);
}

/// Restart for a one-shot user action (work-dir switch) whose change must take
/// effect immediately, so it skips the settle window. It still coalesces into an
/// in-flight restart instead of chaining a second full handover behind it: the
/// follow-up reads the same disk state, so the change is applied either way.
pub fn restart_gateway_now(state: &Arc<AppState>, reason: &str) {
    schedule_restart(state, reason, false);
}

/// Called when the app exits: kill the backend child.
pub fn shutdown(state: &AppState) {
    state
        .gateway
        .app_quitting
        .store(true, std::sync::atomic::Ordering::Relaxed);
    stop_current(state);
}
