//! 渠道中心 —— 一次性 pi RPC 桥。
//!
//! 在独立的 `pi --mode rpc --no-session` 进程里执行 pi-connect 扩展的
//! `/connect` 命令，把扩展的 notify 文本收回来给设置页（「渠道中心」）。
//!
//! 为什么不复用常驻网关：网关的 RPC 通道是聊天主链路（prompt/事件流都归
//! 会话用），往里塞扩展命令会污染当前会话的 transcript 与事件流；并且常驻
//! 会话已经带上了工作目录等上下文，而渠道查询只需要扩展自身。一次性进程
//! 完全隔离：命令执行完即杀，`--no-session` 保证不落 ~/.pi/agent/sessions。
//!
//! 除设置页的「渠道中心」面板外，Helix 的每日自动签到定时任务
//! （scheduled_tasks::dispatch_channel_checkin）也复用本桥。
//!
//! 协议（pi RPC，JSONL stdin/stdout，均已实测）：
//!   发送 {"id":"hx-1","type":"prompt","message":"/connect status"}
//!   收到若干 {type:"extension_ui_request", method:"notify", message, notifyType}
//!   以及 {type:"extension_ui_request", method:"confirm", id, title, message}
//!     —— checkin 会先确认，桥在此自动回 `confirmed: true`（前端已先行确认）；
//!   最后 {type:"response", command:"prompt", success} 表示 handler 结束。
//! 每个 prompt 一个 id，收齐后按需发下一条：`checkin` 接一次 `/connect status`
//! 复用同一进程（冷启动 ~5-15s 是主要开销，省一次进程很值），前端拿第二段
//! 结果直接刷新卡片。
//!
//! 硬约束：
//! - 绝不走 `pi.cmd` shim（CreateProcess 会留 cmd 孙进程，kill 漏杀），复用
//!   `pi_gateway::pi_cli_args()` 的 cli.js 解析；
//! - 全局 try_lock 串行：同一时间只允许一个桥进程（避免多份扩展运行时同时
//!   拉上游目录、抢 hermes-memory 的 SQLite 写事务）；
//! - 总时限内必须杀死：stdout 阻塞读没有超时参数，只能由 watchdog 外部 kill，
//!   任何返回路径（含错误）都先收尸再返回。

use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 同一时间只跑一个桥进程；第二个调用直接快速失败而不是排队。
static BRIDGE_LOCK: Mutex<()> = Mutex::new(());

/// 总时限。冷启动实测首轮 ~41s（含一次 10s 目录超时），加签到 + 状态两段
/// 网络操作，150s 是宽裕上限；到点无论走到哪一步都 kill。
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(150);

/// stderr 只留尾部若干行用于报错（pi 的启动错误 —— 扩展加载失败、配置损坏
/// —— 只从这里出来）。
const STDERR_TAIL_LINES: usize = 30;

/// 执行一条 /connect 操作，返回各 prompt 的 notify 集合。
/// 只有 `status` / `checkin` 两个白名单动作，前端无法注入任意 prompt。
#[tauri::command]
pub async fn pi_connect_query(action: String) -> Result<Value, String> {
    let prompts = prompts_for(&action)?;
    tauri::async_runtime::spawn_blocking(move || run_bridge(&prompts))
        .await
        .map_err(|e| format!("渠道桥线程异常: {e}"))?
}

/// action → prompt 序列。checkin 后接一次 status，复用同一进程。
fn prompts_for(action: &str) -> Result<Vec<String>, String> {
    match action {
        "status" => Ok(vec!["/connect status".to_string()]),
        "checkin" => Ok(vec![
            "/connect checkin".to_string(),
            "/connect status".to_string(),
        ]),
        other => Err(format!("不支持的渠道操作: {other}")),
    }
}

/// 供定时任务复用：直接执行 checkin 序列并返回桥结果。阻塞调用（桥自带
/// 看门狗与串行锁），调用方需在独立线程里跑；confirm 自动放行语义与前端
/// 入口完全一致。
pub fn run_checkin_blocking() -> Result<Value, String> {
    let prompts = prompts_for("checkin")?;
    run_bridge(&prompts)
}

fn run_bridge(prompts: &[String]) -> Result<Value, String> {
    let _guard = BRIDGE_LOCK
        .try_lock()
        .map_err(|_| "渠道命令正在执行中，请稍候再试".to_string())?;

    let (mut command, _base) = crate::pi_gateway::pi_cli_args();
    command
        .arg("--mode")
        .arg("rpc")
        // 一次性会话：不落 sessions 目录（否则会在 Helix 侧栏留下垃圾会话）。
        .arg("--no-session")
        .env("PI_OFFLINE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(home) = dirs::home_dir() {
        command.current_dir(home);
    }
    for (k, v) in crate::proxy::proxy_env_pairs() {
        command.env(k, v);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command.spawn().map_err(|e| {
        format!(
            "无法启动 pi 进程: {e} — {}",
            crate::pi_gateway::pi_cli_debug_summary()
        )
    })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("无法连接 pi stdout".into());
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("无法连接 pi stdin".into());
    };
    let stderr = child.stderr.take();

    // stderr 排水线程：留尾用于报错，防止管道写满卡死子进程。
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = stderr {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let t = line.trim_end();
                        if t.is_empty() {
                            continue;
                        }
                        let mut tail = tail.lock().unwrap();
                        if tail.len() >= STDERR_TAIL_LINES {
                            tail.remove(0);
                        }
                        tail.push(t.to_string());
                    }
                }
            }
        });
    }

    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        let timed_out = Arc::clone(&timed_out);
        std::thread::spawn(move || {
            let deadline = Instant::now() + BRIDGE_TIMEOUT;
            while !finished.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(500));
            }
            if !finished.load(Ordering::SeqCst) {
                timed_out.store(true, Ordering::SeqCst);
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
            }
        });
    }

    let mut reader = BufReader::new(stdout);
    let outcome = drive(
        &mut stdin,
        &mut reader,
        prompts,
        &timed_out,
        &stderr_tail,
    );

    // 无论成败都收尸：先停止看门狗（置 finished 也顺带让它对 kill 幂等）。
    finished.store(true, Ordering::SeqCst);
    let mut guard = child.lock().unwrap();
    let _ = guard.kill();
    let _ = guard.wait();
    drop(guard);

    outcome.map(|results| json!({ "results": results }))
}

/// 依次发送 prompts、逐条收 notify 直到对应的 prompt 响应；返回每段结果。
fn drive(
    stdin: &mut std::process::ChildStdin,
    reader: &mut BufReader<std::process::ChildStdout>,
    prompts: &[String],
    timed_out: &Arc<AtomicBool>,
    stderr_tail: &Arc<Mutex<Vec<String>>>,
) -> Result<Vec<Value>, String> {
    let mut results: Vec<Value> = Vec::new();
    let mut line = String::new();

    for (i, prompt) in prompts.iter().enumerate() {
        let req = json!({ "id": format!("hx-{}", i + 1), "type": "prompt", "message": prompt });
        writeln!(stdin, "{req}")
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("向 pi 写入命令失败: {e}"))?;

        let mut messages: Vec<Value> = Vec::new();
        let success = loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let reason = if timed_out.load(Ordering::SeqCst) {
                        "渠道命令超时（pi 进程已被终止）"
                    } else {
                        "pi 进程提前退出"
                    };
                    return Err(with_stderr(reason, stderr_tail));
                }
                Err(e) => return Err(format!("读取 pi 输出失败: {e}")),
                Ok(_) => {}
            }
            let text = line.trim();
            if text.is_empty() {
                continue;
            }
            let Ok(j) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            match j.get("type").and_then(Value::as_str) {
                Some("extension_ui_request") => {
                    match j.get("method").and_then(Value::as_str) {
                        Some("notify") => messages.push(json!({
                            "message": j.get("message").and_then(Value::as_str).unwrap_or(""),
                            "type": j.get("notifyType").and_then(Value::as_str).unwrap_or("info"),
                        })),
                        Some("confirm") => {
                            // checkin 的确认：前端已先行确认，且领取幂等 —— 放行。
                            // status 不该出现 confirm；若出现就取消，绝不冒充用户。
                            let confirmed = prompt.contains("checkin");
                            respond(
                                stdin,
                                json!({
                                    "type": "extension_ui_response",
                                    "id": j.get("id").cloned().unwrap_or(Value::Null),
                                    "confirmed": confirmed,
                                }),
                            );
                        }
                        Some(_) => {
                            // 未知交互类型一律取消（select/input 等将来才可能用上）。
                            respond(
                                stdin,
                                json!({
                                    "type": "extension_ui_response",
                                    "id": j.get("id").cloned().unwrap_or(Value::Null),
                                    "cancelled": true,
                                }),
                            );
                        }
                        None => {}
                    }
                }
                Some("response") => {
                    if j.get("command").and_then(Value::as_str) == Some("prompt") {
                        break j.get("success").and_then(Value::as_bool).unwrap_or(true);
                    }
                }
                _ => {}
            }
        };

        results.push(json!({
            "prompt": prompt,
            "success": success,
            "messages": messages,
        }));
        if !success {
            // 第一段失败就别追问第二段；已有结果照常返回给前端。
            break;
        }
    }

    Ok(results)
}

/// 写一行响应；失败不致命（下一轮读会先撞上 EOF）。
fn respond(stdin: &mut std::process::ChildStdin, resp: Value) {
    let _ = writeln!(stdin, "{resp}");
    let _ = stdin.flush();
}

fn with_stderr(reason: &str, tail: &Arc<Mutex<Vec<String>>>) -> String {
    let tail = tail.lock().map(|t| t.join("\n")).unwrap_or_default();
    if tail.is_empty() {
        reason.to_string()
    } else {
        format!("{reason}\n{tail}")
    }
}
