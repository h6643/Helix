//! `external:testConnection` — TCP reachability probe.
//! Port of `electron/ipc/external.js`.

use serde_json::{json, Value};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

#[tauri::command]
pub fn test_connection(host: String, port: Option<Value>, timeout_ms: Option<u64>) -> Value {
    let port_num: u16 = match port {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as u16,
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    };
    if host.trim().is_empty() || port_num == 0 {
        return json!({ "ok": false, "error": "缺少主机或端口" });
    }
    let timeout = timeout_ms.unwrap_or(4000).clamp(500, 15000);
    let addr_str = format!("{host}:{port_num}");
    let socket_addr = match addr_str.to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(a) => a,
            None => return json!({ "ok": false, "error": "无效的主机或端口" }),
        },
        Err(e) => return json!({ "ok": false, "error": format!("无效的主机或端口 ({e})") }),
    };
    let start = Instant::now();
    match TcpStream::connect_timeout(&socket_addr, Duration::from_millis(timeout)) {
        Ok(_) => json!({ "ok": true, "latencyMs": start.elapsed().as_millis() }),
        Err(_) => json!({ "ok": false, "error": "连接超时" }),
    }
}
