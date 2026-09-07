//! External service operations (TCP probe, SSH management).

use serde_json::Value;
use std::net::TcpStream;
use std::time::Duration;

/// Test TCP connection to a host:port.
#[tauri::command]
pub async fn test_connection(
    host: String,
    port: u32,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000));
    
    match TcpStream::connect_timeout(&(host.as_str(), port).into(), timeout) {
        Ok(_) => Ok(json!({ "ok": true, "connected": true })),
        Err(e) => Ok(json!({
            "ok": false,
            "connected": false,
            "error": e.to_string(),
        })),
    }
}
