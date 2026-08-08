//! Hermes gateway process lifecycle: spawn, serve-mode handshake, auto-respawn
//! and the acp-mode stdio JSON-RPC bridge.
//!
//! Port of `electron/main.js` (startHermesGateway / processHermesBuffer /
//! sendHermesRequest / scheduleServeRespawn / restartHermesGatewayCore).
//!
//! Two protocols:
//! - **serve** (default): spawn `hermes serve --host 127.0.0.1 --port 0`, parse
//!   `HERMES_BACKEND_READY port=<N>` from stdout, expose `{port, token, baseUrl,
//!   wsUrl}` via `gateway.serveInfo` and let the *renderer* connect to the WS
//!   directly. The main process only supervises (respawn on unexpected exit).
//! - **acp** (fallback): `hermes acp`, stdio newline-delimited JSON-RPC bridged
//!   through this process.

use crate::config::{ensure_coding_context_off, env_path};
use crate::kernel::resolve_hermes_candidates;
use crate::paths::hermes_data_dir;
use crate::state::{app_handle, AppState, ServeGatewayInfo};
use rand::Rng;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

// ── Limits (mirror electron/main.js) ───────────────────────────────────────
const MAX_SERVE_RESPAWN_PER_WINDOW: u64 = 6;
const SERVE_RESPAWN_WINDOW_MS: u64 = 60_000;
const SERVE_RESPAWN_BASE_DELAY_MS: u64 = 800;

// ── acp stdio JSON-RPC bridge state (shared across commands/threads) ───────
static ACP_PENDING: once_cell::sync::Lazy<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));
static ACP_WRITER: once_cell::sync::Lazy<Mutex<Option<mpsc::Sender<String>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
static ACP_REQ_ID: AtomicU64 = AtomicU64::new(0);

// ── event emission ─────────────────────────────────────────────────────────

/// Emit a `hermes:event` to the renderer: `{ method, params }`.
/// The frontend's `onEvent` subscriber unwraps exactly this envelope.
pub fn emit_hermes_event(method: &str, params: &Value) {
    let _ = app_handle().emit(
        "hermes:event",
        serde_json::json!({ "method": method, "params": params }),
    );
}

fn emit_simple(method: &str) {
    emit_hermes_event(method, &Value::Null);
}

/// Which gateway protocol this build runs (HELIX_GATEWAY_MODE, default serve).
pub fn env_gateway_mode() -> &'static str {
    let mode = std::env::var("HELIX_GATEWAY_MODE").unwrap_or_default();
    if mode.eq_ignore_ascii_case("acp") {
        "acp"
    } else {
        "serve"
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── child env construction ─────────────────────────────────────────────────

/// Build the cleaned environment for the hermes subprocess (mirror of the
/// `hermesEnv` block in electron/main.js startHermesGateway).
fn build_hermes_env(cmd: &Path, spawn_cwd: &Path) -> std::collections::HashMap<String, String> {
    let hermes_dir = hermes_data_dir();
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();

    // Pin HERMES_HOME so Hermes loads the same config.yaml/.env we write.
    env.insert("HERMES_HOME".into(), hermes_dir.display().to_string());

    // Strip proxy settings that make httpx chat-completion requests hang.
    for k in [
        "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
        "ALL_PROXY", "all_proxy",
    ] {
        env.remove(k);
    }
    env.insert("NO_PROXY".into(), "*".into());
    env.insert("no_proxy".into(), "*".into());

    // Strip inherited OPENAI_* so Hermes' own .env / config.yaml is authoritative.
    for k in [
        "OPENAI_BASE_URL", "openai_base_url", "OPENAI_API_KEY", "openai_api_key",
    ] {
        env.remove(k);
    }

    // Read .env directly and inject OPENAI_API_KEY / OPENAI_BASE_URL (don't rely
    // on python-dotenv finding it from CWD).
    if let Ok(content) = std::fs::read_to_string(env_path()) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(eq) = trimmed.find('=') {
                if eq <= 0 {
                    continue;
                }
                let key = trimmed[..eq].trim().to_string();
                let val = trimmed[eq + 1..].trim().to_string();
                if (key == "OPENAI_API_KEY" || key == "OPENAI_BASE_URL") && !val.is_empty() {
                    env.insert(key, val);
                }
            }
        }
    }

    // Force Python to flush logs and surface httpx/OpenAI network activity.
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("OPENAI_LOG".into(), "debug".into());
    env.insert("HTTPX_LOG_LEVEL".into(), "debug".into());
    env.insert("PYTHONPATH".into(), String::new());

    // Strip npm / Electron-launch pollution.
    let strip_keys = [
        "INIT_CWD", "NODE", "NODE_EXE", "NPM_CLI_JS", "NPM_PREFIX_JS",
        "NPM_PREFIX_NPM_CLI_JS", "npm_command", "npm_execpath",
        "npm_node_execpath", "npm_lifecycle_event", "npm_lifecycle_script",
        "COLOR", "FORCE_COLOR", "EFC_8920",
    ];
    env.retain(|k, _| !(k.starts_with("npm_") || strip_keys.contains(&k.as_str())));

    // Rebuild PATH: keep system dirs + hermes venv, drop node_modules/.bin that
    // may shadow python tooling.
    let hermes_bin_dir = cmd.parent().map(|p| p.display().to_string()).unwrap_or_default();
    let path_var = std::env::var("PATH").unwrap_or_default();
    let path_var_windows = std::env::var("Path").unwrap_or_default();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut parts: Vec<String> = path_var
        .split(sep)
        .chain(path_var_windows.split(sep))
        .filter(|p| {
            !p.is_empty() && !p.to_lowercase().contains("node_modules")
        })
        .map(|s| s.to_string())
        .collect();
    if !hermes_bin_dir.is_empty() && !parts.contains(&hermes_bin_dir) {
        parts.insert(0, hermes_bin_dir);
    }
    env.insert("PATH".into(), parts.join(&sep.to_string()));

    // Pin the gateway's working directory so tools/terminal run in the project.
    env.insert("TERMINAL_CWD".into(), spawn_cwd.display().to_string());

    env
}

// ── spawn ─────────────────────────────────────────────────────────────────

/// Spawn the gateway in the mode currently selected in state
/// ('local' → serve/acp subprocess, 'remote' → nothing).
pub fn spawn_gateway(state: &Arc<AppState>) -> Result<(), String> {
    let mode = state.hermes.gateway_mode.lock().unwrap().clone();
    if mode == "remote" {
        // Remote mode has no local subprocess; info is owned by set_gateway_mode.
        return Ok(());
    }

    // Kill any existing child process before spawning a new one, so we don't
    // accumulate zombie gateways across app restarts / crashes.
    kill_current(state);
    // Also kill any orphaned hermes-serve processes from prior sessions that
    // share our config home, so we never end up with 7+ gateways competing.
    kill_orphan_serve_processes();

    // Re-assert coding_context: off (mirror ensureCodingContextOff).
    ensure_coding_context_off();

    let candidates = resolve_hermes_candidates();
    let mut last_err = "找不到可启动的 hermes 可执行文件（已尝试多个候选）。请先安装 Hermes，或将其 venv 的 bin 目录加入 PATH。".to_string();
    for cmd in candidates {
        match spawn_candidate(state, &cmd) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    emit_hermes_event(
        "error",
        &serde_json::json!({ "message": last_err }),
    );
    Err(last_err)
}

fn spawn_candidate(state: &Arc<AppState>, cmd: &Path) -> Result<(), String> {
    let serve_mode = env_gateway_mode() == "serve";

    // Serve mode: pin a session token before spawn.
    let session_token = if serve_mode {
        let mut tok = state.hermes.session_token.lock().unwrap();
        if tok.is_none() {
            *tok = Some(gen_token());
        }
        tok.clone().unwrap_or_default()
    } else {
        String::new()
    };

    // spawn cwd must exist (a deleted project dir causes ENOENT).
    let mut spawn_cwd = state.work_dir.read().unwrap().clone();
    if !spawn_cwd.exists() {
        spawn_cwd = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    }

    let mut env = build_hermes_env(cmd, &spawn_cwd);
    if serve_mode {
        env.insert("HERMES_SERVE_HEADLESS".into(), "1".into());
        env.insert("HERMES_DASHBOARD_SESSION_TOKEN".into(), session_token.clone());
        // reset serve info until the new handshake arrives
        *state.hermes.serve_info.write().unwrap() = None;
    }

    let args: Vec<String> = if serve_mode {
        vec!["serve".into(), "--host".into(), "127.0.0.1".into(), "--port".into(), "0".into()]
    } else {
        vec!["acp".into()]
    };

    let child = Command::new(cmd)
        .args(&args)
        .envs(&env)
        .current_dir(&spawn_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if cfg!(windows) && e.raw_os_error() == Some(2) {
                format!("找不到可执行文件: {} — 请确认 Hermes 已安装", cmd.display())
            } else {
                format!("Hermes 启动失败: {} ({e})", cmd.display())
            }
        })?;

    let pid = child.id();
    {
        let mut slot = state.hermes.child.lock().unwrap();
        *slot = Some(child);
    }

    // Take handles for the reader/writer threads. If stdin isn't taken for serve
    // mode it just stays attached (serve ignores it, matching Electron).
    let stdout = {
        let mut slot = state.hermes.child.lock().unwrap();
        slot.as_mut().and_then(|c| c.stdout.take())
    };
    let stderr = {
        let mut slot = state.hermes.child.lock().unwrap();
        slot.as_mut().and_then(|c| c.stderr.take())
    };
    let stdin = {
        let mut slot = state.hermes.child.lock().unwrap();
        slot.as_mut().and_then(|c| c.stdin.take())
    };

    if !serve_mode {
        if let Some(stdin) = stdin {
            let (tx, rx) = mpsc::channel::<String>();
            *ACP_WRITER.lock().unwrap() = Some(tx);
            thread::spawn(move || {
                use std::io::Write;
                let mut stdin = stdin;
                for line in rx {
                    if stdin.write_all(line.as_bytes()).is_err() {
                        break;
                    }
                    let _ = stdin.flush();
                }
            });
        }
    }

    if let Some(stdout) = stdout {
        let state2 = Arc::clone(state);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if serve_mode {
                    handle_serve_line(&state2, trimmed, &session_token, pid);
                } else {
                    handle_acp_line(trimmed);
                }
            }
            // stdout EOF ⇒ process exited or crashed.
            on_child_closed(&state2, pid);
        });
    }

    // Keep a watch on the pid to detect exit even if stdout never closes cleanly.
    let state_watch = Arc::clone(state);
    thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(3600);
        loop {
            if std::time::Instant::now() > deadline {
                break;
            }
            let exited = {
                let mut slot = state_watch.hermes.child.lock().unwrap();
                match slot.as_mut() {
                    Some(c) if c.id() == pid => {
                        match c.try_wait() {
                            Ok(Some(_)) => true,
                            _ => false,
                        }
                    }
                    _ => return, // replaced/removed
                }
            };
            if exited {
                on_child_closed(&state_watch, pid);
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
    });

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                handle_stderr_line(&line, serve_mode);
            }
        });
    }

    Ok(())
}

fn gen_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..24).map(|_| rng.gen()).collect();
    hex::encode(&bytes)
}

// ── serve-mode handshake / supervision ────────────────────────────────────

fn handle_serve_line(state: &AppState, line: &str, token: &str, pid: u32) {
    let port_str = if let Some(p) = line.strip_prefix("HERMES_BACKEND_READY port=") {
        Some(p)
    } else if let Some(p) = line.strip_prefix("HERMES_DASHBOARD_READY port=") {
        Some(p)
    } else {
        None
    };
    if let Some(port_str) = port_str {
        if let Ok(port) = port_str.trim().parse::<u16>() {
            let info = ServeGatewayInfo {
                mode: "serve".into(),
                pending: Some(false),
                port: Some(port),
                token: Some(token.to_string()),
                base_url: Some(format!("http://127.0.0.1:{port}")),
                ws_url: Some(format!("ws://127.0.0.1:{port}/api/ws?token={token}")),
                remote: None,
            };
            {
                let mut prev = state.hermes.serve_info.write().unwrap();
                let prev_port = prev.as_ref().and_then(|p| p.port);
                *prev = Some(info.clone());
                if prev_port != Some(port) {
                    eprintln!("[Hermes] serve gateway ready on port {port}");
                }
            }
            // gateway.ready only flips the connected flag once per process...
            let mut ready = READY_PIDS.lock().unwrap();
            if !ready.contains(&pid) {
                ready.push(pid);
                drop(ready);
                emit_simple("gateway.ready");
            } else {
                drop(ready);
            }
            // ...but gateway.serveInfo MUST be re-sent on EVERY handshake.
            emit_hermes_event(
                "gateway.serveInfo",
                &serde_json::to_value(&info).unwrap_or(Value::Null),
            );
            // A successful (re)connect clears the respawn backoff window.
            state.hermes.respawn_count.store(0, Ordering::Relaxed);
            state.hermes.respawn_window_start.store(0, Ordering::Relaxed);
        }
    } else if looks_like_error(line) {
        eprintln!("[Hermes serve stdout] {line}");
    }
}

static READY_PIDS: once_cell::sync::Lazy<Mutex<Vec<u32>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

fn looks_like_error(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("error") || lower.contains("fail") || lower.contains("traceback")
}

fn contains_http_auth(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("http/")
        || lower.contains("bearer")
        || lower.contains("openai")
        || lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("auth")
        || lower.contains("token")
        || lower.contains("ant-ling")
        || lower.contains("stepfun")
}

/// Handle an acp-mode stdout line (JSON-RPC response/notification).
fn handle_acp_line(line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let msg: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            // Non-JSON output (OpenAI/HTTPX debug logs). Surface HTTP/auth lines.
            if contains_http_auth(trimmed) {
                eprintln!("[Hermes stdout] {trimmed}");
            }
            return;
        }
    };
    let jsonrpc = msg.get("jsonrpc").and_then(|v| v.as_str()).unwrap_or("");
    if jsonrpc != "2.0" {
        return;
    }
    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
        // Response → resolve pending request.
        let sender = ACP_PENDING.lock().unwrap().remove(&id);
        if let Some(sender) = sender {
            let _ = sender.send(msg);
        }
        return;
    }
    if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
        // Notification (event) → forward to renderer.
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        emit_hermes_event(method, &params);
    }
}

fn handle_stderr_line(line: &str, serve_mode: bool) {
    // acp readiness signal
    if !serve_mode && line.to_lowercase().contains("acp client connected") {
        emit_simple("gateway.ready");
        return;
    }
    // Surface raw HTTP/auth debug.
    if contains_http_auth(line) {
        eprintln!("[Hermes stderr] {line}");
    }
    // gateway.retry events (upstream connection drops).
    let lower = line.to_lowercase();
    if lower.contains("connection error")
        || lower.contains("streaming failed before delivery")
        || lower.contains("apiconnectionerror")
    {
        emit_hermes_event(
            "gateway.retry",
            &serde_json::json!({ "phase": "error", "message": "网关连接中断（上游无响应），正在准备重试…" }),
        );
    } else if lower.contains("retrying api call in") {
        let attempt = extract_attempt(line);
        emit_hermes_event(
            "gateway.retry",
            &serde_json::json!({ "phase": "retrying", "attempt": attempt, "message": "网关连接不稳定，正在重连…" }),
        );
    } else if lower.contains("http/1.1 200 ok") {
        emit_hermes_event(
            "gateway.retry",
            &serde_json::json!({ "phase": "recovered", "message": "已恢复连接" }),
        );
    }
}

fn extract_attempt(line: &str) -> Option<u64> {
    // "Retrying API call in Xs (attempt 3/5)"
    let idx = line.to_lowercase().find("attempt")?;
    let rest = &line[idx + "attempt".len()..];
    let mut num = String::new();
    for c in rest.trim_start().chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            break;
        }
    }
    num.parse().ok()
}

/// Called when a gateway exits (stdout EOF or watchdog). Deduped by pid.
fn on_child_closed(state: &Arc<AppState>, pid: u32) {
    // Guard against stale close events from a replaced process.
    {
        let mut slot = state.hermes.child.lock().unwrap();
        match slot.as_ref() {
            Some(c) if c.id() == pid => {
                *slot = None;
            }
            _ => {
                eprintln!("[Hermes] ignoring stale close event for pid {pid}");
                return;
            }
        }
    }
    let mode = env_gateway_mode();
    *state.hermes.serve_info.write().unwrap() = None;
    READY_PIDS.lock().unwrap().clear();

    emit_hermes_event("gateway.disconnected", &serde_json::json!({ "pid": pid }));

    // Unexpected exit (not a deliberate restart) → auto-respawn serve gateway.
    if mode == "serve" && !state.hermes.app_quitting.load(Ordering::Relaxed) {
        schedule_respawn(Arc::clone(state));
    }
}

/// Rate-limited auto-respawn with exponential backoff (mirror scheduleServeRespawn).
fn schedule_respawn(state: Arc<AppState>) {
    let now_ms = now_millis();
    {
        let start = state.hermes.respawn_window_start.load(Ordering::Relaxed);
        if now_ms.saturating_sub(start) > SERVE_RESPAWN_WINDOW_MS {
            state.hermes.respawn_window_start.store(now_ms, Ordering::Relaxed);
            state.hermes.respawn_count.store(0, Ordering::Relaxed);
        }
    }
    let count = state.hermes.respawn_count.fetch_add(1, Ordering::Relaxed) + 1;
    if count > MAX_SERVE_RESPAWN_PER_WINDOW {
        emit_hermes_event(
            "error",
            &serde_json::json!({
                "message": "Hermes 网关反复崩溃，已停止自动重启。请查看 Hermes 日志（hermes 数据目录下的 logs）后手动重启 Helix。",
            }),
        );
        return;
    }
    let delay_ms = (SERVE_RESPAWN_BASE_DELAY_MS << (count - 1).min(4)).min(8000);
    eprintln!(
        "[Hermes] serve gateway died — auto-respawning in {delay_ms}ms (attempt {count}/{MAX_SERVE_RESPAWN_PER_WINDOW})"
    );
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(delay_ms));
        if state.hermes.app_quitting.load(Ordering::Relaxed) {
            return;
        }
        if state.hermes.child.lock().unwrap().is_some() {
            eprintln!("[Hermes] respawn skipped: a gateway process is already running");
            return;
        }
        if let Err(e) = spawn_gateway(&state) {
            eprintln!("[Hermes] auto-respawn failed: {e}");
        }
    });
}

// ── kill / restart helpers (used by commands) ──────────────────────────────

/// Kill any lingering `hermes serve` processes that share our HERMES_HOME, so
/// a fresh spawn never competes with orphans from a prior app restart / crash.
fn kill_orphan_serve_processes() {
    let hermes_dir = hermes_data_dir();
    let hermes_home = hermes_dir.display().to_string();

    // Walk /proc (Linux) looking for hermes-serve processes that reference our
    // HERMES_HOME in their environment.  This is best-effort: if /proc is not
    // available or a process disappears mid-scan, just move on.
    let proc_dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => return,
    };
    for entry in proc_dir.flatten() {
        let pid_str = entry.file_name();
        let pid: u32 = match pid_str.to_string_lossy().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Skip our own pid — we haven't spawned yet.
        if pid == std::process::id() {
            continue;
        }
        // Read environ to confirm HERMES_HOME matches.
        let environ_path = format!("/proc/{pid}/environ");
        let environ = match std::fs::read(&environ_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let has_home = environ
            .split(|&b| b == 0)
            .any(|kv| kv.starts_with(b"HERMES_HOME=") && kv.len() > b"HERMES_HOME=".len()
                 && &kv[b"HERMES_HOME=".len()..] == hermes_home.as_bytes());
        if !has_home {
            continue;
        }
        // Read cmdline — must contain "hermes" + "serve".
        let cmdline_path = format!("/proc/{pid}/cmdline");
        let cmdline = match std::fs::read(&cmdline_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let is_hermes_serve = cmdline
            .split(|&b| b == 0)
            .filter(|a| !a.is_empty())
            .any(|arg| arg == b"serve");
        if !is_hermes_serve {
            continue;
        }
        // Kill it.
        eprintln!("[Helix] killing orphan hermes-serve pid={pid}");
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
}

/// Kill the current local gateway process, if any.
pub fn kill_current(state: &AppState) {
    let child = state.hermes.child.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    READY_PIDS.lock().unwrap().clear();
}

/// Is a local gateway process alive right now?
pub fn gateway_running(state: &AppState) -> bool {
    state.hermes.child.lock().unwrap().is_some()
}

// ── acp request plumbing (used by hermes commands) ─────────────────────────

fn acp_writer() -> Option<mpsc::Sender<String>> {
    ACP_WRITER.lock().unwrap().clone()
}

/// Send a JSON-RPC request to the acp gateway and await its response.
pub async fn acp_request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let writer = acp_writer().ok_or("Hermes not connected")?;
    let id = ACP_REQ_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ACP_PENDING.lock().unwrap().insert(id, tx);
    let frame = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let line = serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n";
    writer.send(line).map_err(|_| "Hermes stdin closed".to_string())?;

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(msg)) => {
            if let Some(err) = msg.get("error") {
                return Err(err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("RPC error")
                    .to_string());
            }
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        }
        _ => Err(format!("Hermes request {method} timed out")),
    }
}

/// Send a fire-and-forget JSON-RPC notification to the acp gateway.
pub fn acp_notify(method: &str, params: Value) {
    let Some(writer) = acp_writer() else {
        eprintln!("[Hermes] notify dropped (not connected): {method}");
        return;
    };
    let frame = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params });
    let line = match serde_json::to_string(&frame) {
        Ok(s) => s + "\n",
        Err(_) => return,
    };
    let _ = writer.send(line);
}

// ── serve-mode RPC relay (hermes:send in serve mode) ───────────────────────

/// Current serve gateway info, if the handshake completed.
pub fn serve_info(state: &AppState) -> Option<ServeGatewayInfo> {
    state.hermes.serve_info.read().unwrap().clone()
}

/// Relay a JSON-RPC request over the serve gateway's WS endpoint. The renderer
/// normally talks to the WS itself; this is only a fallback for IPC callers.
/// Event frames received during the (transient) relay are NOT re-forwarded to
/// avoid duplicates — the persistent renderer WS client gets them.
pub async fn serve_rpc(state: &AppState, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::protocol::Message;

    let info = serve_info(state).ok_or("gateway-not-ready")?;
    let ws_url = info.ws_url.clone().ok_or("gateway-not-ready")?;

    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| format!("WS connect failed: {e}"))?;
    let (mut sink, mut stream) = ws.split();

    let id: u64 = ACP_REQ_ID.fetch_add(1, Ordering::SeqCst);
    let frame = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let line = serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n";
    sink.send(Message::Text(line.into()))
        .await
        .map_err(|e| format!("WS send failed: {e}"))?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("Hermes request {method} timed out"));
        }
        let item = tokio::time::timeout(remaining, stream.next())
            .await
            .map_err(|_| format!("Hermes request {method} timed out"))?
            .ok_or("gateway-disconnected")?
            .map_err(|e| format!("WS recv failed: {e}"))?;

        let text = match item {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(_) => return Err("gateway-disconnected".into()),
            _ => continue,
        };
        for raw in text.split('\n') {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
                if let Some(err) = msg.get("error") {
                    return Err(err
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("RPC error")
                        .to_string());
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
            // Ignore event frames from the relay (renderer owns the event stream).
        }
    }
}

// ── on-exit cleanup ────────────────────────────────────────────────────────

/// Called when the app exits: kill the gateway child.
pub fn shutdown(state: &AppState) {
    state.hermes.app_quitting.store(true, Ordering::Relaxed);
    kill_current(state);
}
