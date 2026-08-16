//! Diagnostics snapshot (gateway status, runtime version, kernel signature).
//! Port of `electron/main.js` getDiagnostics + the kernel verification path.

use crate::gateway::{gateway_running, serve_info};
use crate::kernel::verify_kernel;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_status(state: State<'_, Arc<AppState>>) -> Value {
    let running = gateway_running(&state);
    let sig = verify_kernel();
    let signature_status = if sig.sig.ok { "verified" } else { "unverified" };
    let info = serve_info(&state);
    json!({
        "gatewayRunning": running,
        "gatewayStartedAt": 0,
        "runtimeVersion": env!("CARGO_PKG_VERSION"),
        "signatureStatus": signature_status,
        "signatureDetail": sig.message,
        "platform": if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" },
        "serve": info.map(|i| json!({
            "mode": i.mode,
            "pending": i.pending,
            "port": i.port,
            "token": i.token,
            "baseUrl": i.base_url,
            "wsUrl": i.ws_url,
        })),
        "uptime": 0,
    })
}

/// TEMP DIAG: 前端诊断日志通道（用于排查功能问题，验证后删除）。
#[tauri::command]
pub fn dbg_log(msg: String) {
    eprintln!("[dbg-fe] {msg}");
}
