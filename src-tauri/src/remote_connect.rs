//! 一键远程连接（agent 远程跑）：把「手动三步」收口成一步。
//!
//! 用户在设置里填 `host / port / username / remote_path`，点「连接」后这里：
//!   1) scp 把 `remote-bridge.js` 拷到远端 home；
//!   2) ssh 在远端后台起 `node remote-bridge.js`；
//!   3) 本机开 `ssh -N -L <本地口>:127.0.0.1:<远端口> user@host`（进程内持 Child）；
//!   4) 写 config.yaml：`pi.remote_rpc = "127.0.0.1:<本地口>"` + `pi.remote_cwd = <远端路径>`；
//!   5) 触发 gateway 重启，远端模式自动生效。
//!
//! 「取消」清掉 4)、杀掉本机隧道（远端 bridge 随 stdin EOF 自退）。
//!
//! 前置条件（远端）：装好 node + pi。非交互 ssh 不会 source ~/.bashrc，PATH 里
//! 常常没有 node / pi；起 bridge 时我们显式把 `~/.pi/agent/bin`、`~/.local/*` 等
//! 常见目录补进 PATH（见 `remote_path_prelude`），让 bridge 的 `resolvePiCli()`
//! 能找到 pi。没装 pi 时远端会报 spawn 失败，看远端 `~/remote-bridge.log`。

use std::process::{Child, Command};
use std::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::State;
use std::sync::Arc;
use serde_json::{json, Value};

use crate::state::AppState;

/// 本机 ssh -L 隧道子进程（`ssh -N -L ...`）。进程内 static，重复连接先杀旧。
/// Helix 退出靠 OS 随控制台回收（Tauri 无干净的 process-exit 钩子，不强求）。
static REMOTE_TUNNEL: std::sync::OnceLock<Mutex<Option<Child>>> =
    std::sync::OnceLock::new();

/// 记住当前隧道的目标（供 `remote_tunnel_status` 展示）。
static REMOTE_TUNNEL_TARGET: std::sync::OnceLock<Mutex<Option<RemoteTunnelTarget>>> =
    std::sync::OnceLock::new();

#[derive(Clone)]
struct RemoteTunnelTarget {
    remote_host: String,
    remote_port: u32,
    username: String,
    local_port: u32,
}

/// 远端 `remote-bridge.js` 的监听端口。它和 SSH 端口是**两回事**：隧道必须是
/// `<本地口>:127.0.0.1:<这个口>`。早先误把 SSH 端口当转发目标，本地 connect
/// 打到远端 sshd —— TCP 握手成功、sshd 把 `cwd:` 握手行当垃圾直接关连接，网关
/// 只看到「pi 进程秒退」，冷却 30s 后静默回退本地 pi。表现就是：UI 里选的是
/// 远程项目，agent 却在本地跑。
const BRIDGE_PORT: u32 = 18800;

fn tunnel_state() -> &'static Mutex<Option<Child>> {
    REMOTE_TUNNEL.get_or_init(|| Mutex::new(None))
}

fn tunnel_target_state() -> &'static Mutex<Option<RemoteTunnelTarget>> {
    REMOTE_TUNNEL_TARGET.get_or_init(|| Mutex::new(None))
}

/// 找 `remote-bridge.js`：从 exe 所在目录往上走最多 8 级（覆盖 dev 时
/// `target/debug/helix`、`src-tauri`、repo 根），取第一个存在的。找不到返回
/// None → 调用方报「应用目录缺该文件」。
fn find_remote_bridge() -> Option<std::path::PathBuf> {
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..8 {
        let candidate = dir.join("remote-bridge.js");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// 从 18800 起探测一个可绑定的本地口（避免与既有进程冲突）。
fn pick_local_port() -> Result<u32, String> {
    for port in 18800..18899u16 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port as u32);
        }
    }
    Err("找不到可用本地口（18800-18899 全被占）".to_string())
}

/// 杀掉本机隧道（若存在）。不杀远端 bridge —— 它随 stdin EOF 自退。
fn kill_tunnel() {
    {
        let mut t = tunnel_state().lock().unwrap();
        if let Some(mut child) = t.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    *tunnel_target_state().lock().unwrap() = None;
}

/// 一条 `-o` 串：短超时 + 关 host key 检查 + 静默 + BatchMode（不弹密码窗）。
fn ssh_opts() -> Vec<String> {
    vec![
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "StrictHostKeyChecking=no".into(),
        "-o".into(),
        "BatchMode=yes".into(),
    ]
}

/// 把 bridge 所需的 node / pi 常见目录补进 PATH。非交互 ssh（`ssh host "cmd"`）
/// 走的是 login shell，**不会** source `~/.bashrc`，于是 `~/.local/node-v24/bin`、
/// `~/.pi/agent/bin`、nvm、Homebrew 这些自定义安装位置全都丢了。这些目录名带 `~`，
/// 交给远端 shell 展开（`echo` 只打印、绝不执行它们，安全）。
fn remote_path_prelude() -> String {
    r#"export PATH="$HOME/.pi/agent/bin:$HOME/.local/node-v24/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" 2>/dev/null; "#
        .to_string()
}

/// Step 1+2：scp 拷 bridge 到远端 home，再 ssh 后台起 node。失败返回 Err。
fn push_and_start_remote_bridge(
    host: &str,
    port: u32,
    username: &str,
) -> Result<(), String> {
    let local_bridge = find_remote_bridge()
        .ok_or_else(|| "找不到 remote-bridge.js（请确认应用目录含该文件）".to_string())?;

    // 先杀可能残留的旧远端 bridge（端口冲突会让新 bridge 起不来）。
    // 坑位两个：
    //   1) `pkill -f "node remote-bridge.js"` —— 命令自身命令行含该串，会把正在
    //      执行它的 ssh 会话 shell 一起杀掉（exit 255，新 bridge 起不来）；
    //   2) 加了引号 `pkill -f "remote-bridge[.]js"` —— 远端 shell 不做 glob 展开，
    //      字面 ERE 匹配不到 "node remote-bridge.js"（实测 exit 1），旧 bridge 活着，
    //      新 bridge 绑 18800 失败。
    // 正确写法：**不引号**，让远端 shell 把 `remote-bridge[.]js` 展开成真实文件名
    // `remote-bridge.js`；会话 shell 自己的原始命令行里仍是带括号的串，不会被匹配。
    let _ = Command::new("ssh")
        .args(&ssh_opts())
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{username}@{host}"))
        .arg("pkill -f remote-bridge[.]js || true")
        .output();

    let scp_out = Command::new("scp")
        .args(&ssh_opts())
        .arg("-P")
        .arg(port.to_string())
        .arg(&local_bridge)
        .arg(format!("{username}@{host}:~/remote-bridge.js"))
        .output()
        .map_err(|e| format!("执行 scp 失败: {e}"))?;
    if !scp_out.status.success() {
        let stderr = String::from_utf8_lossy(&scp_out.stderr);
        return Err(format!("scp remote-bridge.js 到远端失败: {}", stderr.trim()));
    }

    // 后台起 bridge（nohup + &，ssh 跑完即退，bridge 留在远端）。
    // 预置 PATH：非交互 ssh 丢自定义 node/pi 安装目录，这里补回（见 prelude）。
    // 关键：`</dev/null >log 2>&1` 把三个 fd 全部脱离 tty —— 否则 ssh 会一直
    // 挂着等后台子进程，导致 `remote_connect` 卡死（exit 255）。
    let start_cmd = format!(
        "{}nohup node remote-bridge.js {} </dev/null > ~/remote-bridge.log 2>&1 &",
        remote_path_prelude(),
        BRIDGE_PORT,
    );
    let out = Command::new("ssh")
        .args(&ssh_opts())
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{username}@{host}"))
        .arg(start_cmd)
        .output()
        .map_err(|e| format!("执行 ssh 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("远端起 bridge 失败: {}", stderr.trim()));
    }
    Ok(())
}

/// Step 3：本机开 `ssh -N -L <本地口>:127.0.0.1:<BRIDGE_PORT> user@host`，持 Child。
///
/// 两个端口别混：`port` 是 **SSH 端口**（`-p`，很多机器不是 22），远端那头的
/// 目标恒为 bridge 的监听口 `BRIDGE_PORT`。
fn open_tunnel(
    host: &str,
    port: u32,
    username: &str,
    local_port: u32,
) -> Result<(), String> {
    kill_tunnel();

    let mut cmd = Command::new("ssh");
    let forward = format!("{local_port}:127.0.0.1:{BRIDGE_PORT}");
    let port_str = port.to_string();
    let userhost = format!("{username}@{host}");
    let args: Vec<&str> = vec![
        "-N",
        "-p",
        &port_str,
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-L",
        &forward,
        &userhost,
    ];
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW，不弹黑窗
    }
    cmd.args(&args);

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动本机 ssh 隧道失败: {e}"))?;

    // 异步收尸，避免僵尸。
    {
        let mut t = tunnel_state().lock().unwrap();
        *t = Some(child);
    }
    let mut target = tunnel_target_state().lock().unwrap();
    *target = Some(RemoteTunnelTarget {
        remote_host: host.to_string(),
        // 这里记的是 **SSH 端点**（host:port + user），前端拿它反查「连的是列表
        // 里哪台服务器」（`matchActiveRemote` 比的就是 ExternalService.port）。
        // 隧道实际转发的目标端口是 BRIDGE_PORT，两者不是一回事，别混。
        remote_port: port,
        username: username.to_string(),
        local_port,
    });
    Ok(())
}

/// Step 4：写 `pi.remote_rpc` + `pi.remote_cwd`，触发 gateway 重启。
fn write_remote_config(
    state: &Arc<AppState>,
    local_port: u32,
    remote_cwd: &str,
) -> Result<(), String> {
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    let mut updated =
        crate::config::set_yaml_key(&yaml, "pi.remote_rpc", &Value::String(format!("127.0.0.1:{local_port}")));
    updated = crate::config::set_yaml_key(&updated, "pi.remote_cwd", &Value::String(remote_cwd.to_string()));
    if updated != yaml {
        crate::config::atomic_write(&path, &updated)
            .map_err(|e| format!("写 config.yaml 失败: {e}"))?;
    }
    crate::gateway::restart_gateway_soon(state);
    Ok(())
}

/// 一键连接：scp + 远端起 bridge + 开隧道 + 写配置 + 重启 gateway。
#[tauri::command]
pub fn remote_connect(
    state: State<'_, Arc<AppState>>,
    host: String,
    port: u32,
    username: String,
    remote_path: String,
) -> Result<Value, String> {
    let port = if port == 0 { 212 } else { port };
    let remote_path = if remote_path.trim().is_empty() {
        "~".to_string()
    } else {
        remote_path.trim().to_string()
    };
    if host.trim().is_empty() {
        return Err("host 不能为空".to_string());
    }
    if username.trim().is_empty() {
        return Err("username 不能为空".to_string());
    }
    let host = host.trim().to_string();
    let username = username.trim().to_string();

    // 先验证 SSH 可达（复用 ssh_connect 的一次性探测）。
    crate::ssh::connect(&host, port, &username, "key", "").map_err(|e| {
        format!("SSH 到 {host}:{port} 失败: {e}")
    })?;

    let local_port = pick_local_port()?;

    // Step 1+2：远端 side。
    push_and_start_remote_bridge(&host, port, &username)?;
    // Step 3：本机隧道。
    open_tunnel(&host, port, &username, local_port)?;
    // Step 4+5：写配置 + 重启。
    let arc: Arc<AppState> = Arc::clone(&state);
    write_remote_config(&arc, local_port, &remote_path)?;

    Ok(json!({
        "ok": true,
        "local_port": local_port,
        "remote_host": host,
        "remote_port": port,
        "username": username,
        "remote_path": remote_path,
    }))}

/// 断开：清两个 config 键 + 杀本机隧道 + 重启 gateway。
#[tauri::command]
pub fn remote_disconnect(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    let mut updated = crate::config::set_yaml_key(&yaml, "pi.remote_rpc", &Value::String(String::new()));
    updated = crate::config::set_yaml_key(&updated, "pi.remote_cwd", &Value::String(String::new()));
    if updated != yaml {
        crate::config::atomic_write(&path, &updated)
            .map_err(|e| format!("写 config.yaml 失败: {e}"))?;
    }
    kill_tunnel();
    let arc: Arc<AppState> = Arc::clone(&state);
    crate::gateway::restart_gateway_soon(&arc);
    Ok(json!({ "ok": true }))
}

/// 远端目录不存在 / 不可读时脚本打的哨兵（区别于「目录空」的空输出）。
const NOT_A_DIR: &str = "__HELIX_NOT_A_DIR__";

/// 远端目录浏览：`ssh user@host "cd <path> && ls"`，返回子目录列表。
/// 走的是纯 SSH，**不依赖 bridge**，所以连接前（向导第 3 步）就能浏览。
///
/// `include_hidden` = 连 `.config` 这类点目录一起列出（`ls -A`，不含 `.` 与 `..`）。
#[tauri::command]
pub fn remote_list_paths(
    host: String,
    port: u32,
    username: String,
    path: String,
    include_hidden: Option<bool>,
) -> Result<Value, String> {
    let port = if port == 0 { 212 } else { port };
    let path = if path.trim().is_empty() { "~".to_string() } else { path.trim().to_string() };
    let host = host.trim().to_string();
    let username = username.trim().to_string();
    if host.is_empty() || username.is_empty() {
        return Err("host / username 不能为空".to_string());
    }
    // 先 `cd` 再 `pwd -P`：目录校验和 `~`/相对路径 → 绝对路径一次搞定。回给前端的
    // `cwd` 因此永远是绝对路径，「上一步」退化成字符串裁剪，写进 config 的
    // `pi.remote_cwd` 也不再带 `~`（少一处远端展开的歧义）。
    // `ls -1p` 给目录加 `/` 后缀，比 bash 的 `[ -d ]` 稳（远端可能是 sh）；
    // grep 无匹配会 exit 1，用 `|| true` 兜住，否则空目录被误报成失败。
    let flags = if include_hidden.unwrap_or(false) { "-1Ap" } else { "-1p" };
    let ls_cmd = format!(
        "p={q}; if cd \"$p\" 2>/dev/null; then pwd -P; {{ ls {flags} 2>/dev/null | grep '/$' || true; }} | head -300; else echo {missing}; fi",
        q = shell_quote(&path),
        flags = flags,
        missing = NOT_A_DIR,
    );
    let out = Command::new("ssh")
        .args(&ssh_opts())
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{username}@{host}"))
        .arg(ls_cmd)
        .output()
        .map_err(|e| format!("执行 ssh 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("列目录失败: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines().map(|l| l.trim_end_matches(['\r', '\n']));
    let cwd = match lines.next() {
        Some(c) if !c.starts_with(NOT_A_DIR) => c.to_string(),
        _ => return Err(format!("远端目录不存在或不可读: {path}")),
    };
    let entries: Vec<String> = lines
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && l.ends_with('/'))
        .map(|l| l.trim_end_matches('/').to_string())
        .collect();
    Ok(json!({ "cwd": cwd, "paths": entries }))
}

/// 把 shell 参数单引号化（防路径里有空格 / 元字符）。`~` 这种要保留原样让 shell 展开。
fn shell_quote(s: &str) -> String {
    if s == "~" || s.starts_with("~/") {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 步骤 2「连接体检」：一次 SSH 往返查清远端有没有 node / pi，顺带把远端 home
/// 带回去给目录浏览当起点。
///
/// 关键：探测用的是**和起 bridge 时同一份 PATH 预置**（`remote_path_prelude`），
/// npm 全局候选也和 `remote-bridge.js` 的 `resolvePiCli()` 保持同一组路径。否则
/// 会出现「体检说 pi 在，真连上却 spawn 失败」——那体检就白做了。
#[tauri::command]
pub fn remote_preflight(host: String, port: u32, username: String) -> Result<Value, String> {
    let port = if port == 0 { 212 } else { port };
    let host = host.trim().to_string();
    let username = username.trim().to_string();
    if host.is_empty() || username.is_empty() {
        return Err("host / username 不能为空".to_string());
    }
    // 先要 SSH 通（复用 ssh_connect 的探测，它的错误分类比这里现写一份全）。
    crate::ssh::connect(&host, port, &username, "key", "")
        .map_err(|e| format!("SSH 到 {host}:{port} 失败: {e}"))?;

    // 只用 POSIX 语法（远端登录 shell 可能是 sh，不保证有 bashism）。
    let probe = concat!(
        "echo \"HX_HOME=$HOME\";",
        " echo \"HX_UNAME=$(uname -srm 2>/dev/null || echo unknown)\";",
        " echo \"HX_NODE=$(command -v node 2>/dev/null)\";",
        " echo \"HX_NODE_VER=$(node -v 2>/dev/null)\";",
        " echo \"HX_PI=$(command -v pi 2>/dev/null)\";",
        " for d in \"$HOME/AppData/Roaming/npm\" /usr/local/lib /usr/lib \"$HOME/.npm-global\";",
        " do f=\"$d/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js\";",
        " if [ -f \"$f\" ]; then echo \"HX_PI_CLI_JS=$f\"; fi; done;",
        " true",
    );
    let out = Command::new("ssh")
        .args(&ssh_opts())
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{username}@{host}"))
        .arg(format!("{}{}", remote_path_prelude(), probe))
        .output()
        .map_err(|e| format!("执行 ssh 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("远端体检失败: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut fields: std::collections::HashMap<String, String> = Default::default();
    for line in stdout.lines() {
        if let Some((k, v)) = line.trim().split_once('=') {
            fields.insert(k.to_string(), v.trim().to_string());
        }
    }
    let get = |k: &str| fields.get(k).cloned().unwrap_or_default();
    let (node_path, node_version) = (get("HX_NODE"), get("HX_NODE_VER"));
    let (pi_path, pi_cli_js) = (get("HX_PI"), get("HX_PI_CLI_JS"));
    let error = if node_path.is_empty() {
        "远端没有 node（bridge 起不来）。装好后重新检测。"
    } else if pi_path.is_empty() && pi_cli_js.is_empty() {
        "远端没找到 pi。装好后重新检测，或确认 pi 在 ~/.pi/agent/bin。"
    } else {
        ""
    };
    Ok(json!({
        "ok": node_path != "" && (pi_path != "" || pi_cli_js != ""),
        "home": get("HX_HOME"),
        "uname": get("HX_UNAME"),
        "node_path": node_path,
        "node_version": node_version,
        "pi_path": pi_path,
        "pi_cli_js": pi_cli_js,
        "error": error,
    }))
}

/// 当前生效的远端项目目录（`pi.remote_cwd`），没配则 None。
fn current_remote_cwd() -> Option<String> {
    let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).ok()?;
    let block = crate::config::read_yaml_block(&yaml, "pi");
    let v = block.get("remote_cwd")?.as_str()?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// 前端徽标：当前隧道状态。
#[tauri::command]
pub fn remote_tunnel_status() -> Value {
    let target: Option<RemoteTunnelTarget> = {
        let g = tunnel_target_state().lock().unwrap();
        g.as_ref().cloned()
    };
    let alive = {
        let mut t = tunnel_state().lock().unwrap();
        match t.as_mut() {
            Some(c) => c.try_wait().map(|s| s.is_none()).unwrap_or(true),
            None => false,
        }
    };
    match target {
        Some(tgt) => json!({
            "connected": alive,
            "local_port": tgt.local_port,
            "remote_host": tgt.remote_host,
            "remote_port": tgt.remote_port,
            "username": tgt.username,
            // 真实生效的远端目录。前端按它把会话归到 `remote://<id>/<路径>`，
            // 少了这个字段就只能记住「上一次点连接时填了啥」，重启应用即失真。
            "remote_path": current_remote_cwd(),
        }),
        None => json!({ "connected": false }),
    }
}
