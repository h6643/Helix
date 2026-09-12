//! SSH connection management using system SSH client.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

static SSH_CONNECTIONS: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

pub fn connect(
    host: &str,
    port: u32,
    username: &str,
    _auth_type: &str,
    _secret: &str,
) -> Result<String, String> {
    if host.is_empty() {
        return Err("主机地址不能为空".to_string());
    }
    if username.is_empty() {
        return Err("用户名不能为空".to_string());
    }

    let conn_id = format!("{}:{}@{}", username, host, port);

    let output = Command::new("ssh")
        .args([
            "-o",
            "ConnectTimeout=10",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-p",
            &port.to_string(),
            &format!("{}@{}", username, host),
            "echo",
            "connection_test",
        ])
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                let mut conns = SSH_CONNECTIONS.lock().unwrap();
                if conns.is_none() {
                    *conns = Some(HashMap::new());
                }
                conns.as_mut().unwrap().insert(conn_id.clone(), true);
                Ok(conn_id)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if stderr.contains("No route to host") || stderr.contains("Connection refused") {
                    Err(format!("无法连接到 {}:{}: {}", host, port, stderr.trim()))
                } else if stderr.contains("Permission denied") {
                    Err(format!("认证失败: {}", stderr.trim()))
                } else {
                    Err(format!("SSH 连接失败: {}", stderr.trim()))
                }
            }
        }
        Err(e) => Err(format!("执行 SSH 命令失败: {}", e)),
    }
}

pub fn exec(conn_id: &str, command: &str) -> Result<String, String> {
    let parts: Vec<&str> = conn_id.split('@').collect();
    if parts.len() != 2 {
        return Err("无效的连接 ID 格式".to_string());
    }

    let username_host = parts[0];
    let host_port = parts[1];

    let (host, port) = if let Some(idx) = host_port.rfind(':') {
        (&host_port[..idx], &host_port[idx + 1..])
    } else {
        (host_port, "22")
    };

    let username = if let Some(idx) = username_host.find(':') {
        &username_host[..idx]
    } else {
        username_host
    };

    let output = Command::new("ssh")
        .args([
            "-o",
            "ConnectTimeout=30",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-p",
            port,
            &format!("{}@{}", username, host),
            command,
        ])
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("命令执行失败: {}", stderr.trim()))
            }
        }
        Err(e) => Err(format!("执行 SSH 命令失败: {}", e)),
    }
}

pub fn status(conn_id: &str) -> bool {
    let conns = SSH_CONNECTIONS.lock().unwrap();
    conns
        .as_ref()
        .map(|m| m.get(conn_id).copied().unwrap_or(false))
        .unwrap_or(false)
}

pub fn disconnect(conn_id: &str) -> Result<(), String> {
    let mut conns = SSH_CONNECTIONS.lock().unwrap();
    if let Some(ref mut m) = *conns {
        m.remove(conn_id);
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_connect(
    host: String,
    port: u32,
    username: String,
    auth_type: String,
    secret: String,
) -> Result<String, String> {
    connect(&host, port, &username, &auth_type, &secret)
}

#[tauri::command]
pub fn ssh_exec(conn_id: String, command: String) -> Result<String, String> {
    exec(&conn_id, &command)
}

#[tauri::command]
pub fn ssh_status(conn_id: String) -> bool {
    status(&conn_id)
}

#[tauri::command]
pub fn ssh_disconnect(conn_id: String) -> Result<(), String> {
    disconnect(&conn_id)
}
