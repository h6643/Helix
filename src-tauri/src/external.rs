//! External service operations (TCP probe, SSH management).

use serde_json::{json, Value};
use std::net::ToSocketAddrs;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Test TCP connection to a host:port.
#[tauri::command]
pub async fn test_connection(
    host: String,
    port: u32,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000));

    // Resolve via DNS so hostnames work too — parsing "host:port" directly as
    // a SocketAddr would only accept literal IPs.
    let addr: SocketAddr = (host.as_str(), port as u16)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| format!("无法解析地址 {host}:{port}"))?;
    match TcpStream::connect_timeout(&addr, timeout) {
        Ok(_) => Ok(json!({ "ok": true, "connected": true })),
        Err(e) => Ok(json!({
            "ok": false,
            "connected": false,
            "error": e.to_string(),
        })),
    }
}
