//! SSH connection management using system SSH client.
//!
//! Only the connection test survives: ssh_exec/ssh_status/ssh_disconnect had
//! no renderer callers (the bridge methods were removed) and their one-shot
//! `BatchMode=yes` ssh invocations never kept a live session anyway, so the
//! connection-map bookkeeping went with them.

use std::process::Command;

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
