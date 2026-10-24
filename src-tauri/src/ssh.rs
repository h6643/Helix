//! SSH connection management using system SSH client.
//!
//! 认证方式三选一（`SshAuth`）：
//!   * 默认（auth_type 空）：`BatchMode=yes`，只走 ssh-agent / 默认密钥，永不弹密码框；
//!   * `password`：关 pubkey、限一次密码提示，密码经 SSH_ASKPASS 喂给 ssh.exe ——
//!     askpass 程序就是 Helix 主程序自己（main.rs 见到 HELIX_SSH_ASKPASS_VALUE
//!     环境变量即打印密码退出），不引入额外二进制；
//!   * `key`：`-i <私钥文件>` + BatchMode（带口令的密钥视为失败，请交给 ssh-agent）。
//!
//! 所有远程命令（探测/体检/列目录/推 bridge/开隧道）都从这里的 `ssh_opts_for`
//! + `apply_auth_env` 取参数，保证「探测能过 ⇒ 真连接也能过」。

use std::process::Command;

/// 一份远程目标的认证描述。secret：password = 明文密码；key = 私钥文件路径。
#[derive(Clone, Default)]
pub struct SshAuth {
    pub auth_type: String,
    pub secret: String,
}

impl SshAuth {
    pub fn new(auth_type: Option<String>, secret: Option<String>) -> Self {
        SshAuth {
            auth_type: auth_type.unwrap_or_default(),
            secret: secret.unwrap_or_default(),
        }
    }
}

/// 一条 ssh/scp 命令的公共 -o 串 + 按认证方式追加的选项。
pub fn ssh_opts_for(auth: &SshAuth) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "StrictHostKeyChecking=no".into(),
    ];
    match auth.auth_type.as_str() {
        "password" if !auth.secret.trim().is_empty() => {
            v.extend([
                "-o".into(),
                "PreferredAuthentications=password".into(),
                "-o".into(),
                "PubkeyAuthentication=no".into(),
                "-o".into(),
                "NumberOfPasswordPrompts=1".into(),
            ]);
        }
        "key" => {
            v.push("-o".into());
            v.push("BatchMode=yes".into());
            let p = auth.secret.trim();
            if !p.is_empty() {
                v.push("-i".into());
                v.push(p.to_string());
                // 指定了密钥文件就别再混用 agent 里的其他密钥（太多会被服务器掐）。
                v.push("-o".into());
                v.push("IdentitiesOnly=yes".into());
            }
        }
        _ => {
            v.push("-o".into());
            v.push("BatchMode=yes".into());
        }
    }
    v
}

/// 密码认证时给子进程挂 SSH_ASKPASS 三件套。非密码方式不动环境。
/// askpass 程序 = 当前 exe（main.rs 顶部有对应的快速退出分支）。
pub fn apply_auth_env(cmd: &mut Command, auth: &SshAuth) {
    if auth.auth_type == "password" && !auth.secret.trim().is_empty() {
        if let Ok(exe) = std::env::current_exe() {
            cmd.env("SSH_ASKPASS", exe.as_os_str());
            cmd.env("SSH_ASKPASS_REQUIRE", "force");
            cmd.env("HELIX_SSH_ASKPASS_VALUE", auth.secret.trim());
        }
    }
}

/// Windows 上 ssh 子进程不弹黑窗。
pub fn detach_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

pub fn connect(
    host: &str,
    port: u32,
    username: &str,
    auth: &SshAuth,
) -> Result<String, String> {
    if host.is_empty() {
        return Err("主机地址不能为空".to_string());
    }
    if username.is_empty() {
        return Err("用户名不能为空".to_string());
    }

    let conn_id = format!("{}:{}@{}", username, host, port);

    let opts = ssh_opts_for(auth);
    let mut cmd = Command::new("ssh");
    cmd.args(&opts)
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{}@{}", username, host))
        .arg("echo")
        .arg("connection_test");
    apply_auth_env(&mut cmd, auth);
    detach_window(&mut cmd);
    let output = cmd.output();

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

// (async)：ssh 探测是阻塞子进程调用，绝不能在主线程跑，否则远端不可达时
// 每次探测最多卡死界面 10s（ConnectTimeout）。
#[tauri::command(async)]
pub fn ssh_connect(
    host: String,
    port: u32,
    username: String,
    auth_type: String,
    secret: String,
) -> Result<String, String> {
    let auth = SshAuth::new(Some(auth_type), Some(secret));
    connect(&host, port, &username, &auth)
}

