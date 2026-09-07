//! Minimal stdio adapter for `codex app-server`.
//!
//! Helix speaks the Helix `session/*` API in its renderer. This module adapts
//! that API to Codex's `thread/*` and `turn/*` lifecycle without requiring the
//! frontend to learn a second protocol.

use crate::gateway::{emit_helix_event, kill_current};
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);

static WRITER: Mutex<Option<mpsc::Sender<String>>> = Mutex::new(None);
static PENDING: std::sync::LazyLock<Mutex<HashMap<u64, PendingRequest>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static TURN_WAITERS: std::sync::LazyLock<Mutex<HashMap<String, TurnWaiter>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static CONTEXT_USAGE: std::sync::LazyLock<Mutex<HashMap<String, Value>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static INITIALIZED: AtomicBool = AtomicBool::new(false);
static CURRENT_THREAD: Mutex<Option<String>> = Mutex::new(None);
static CHILD_GENERATION: AtomicU64 = AtomicU64::new(0);
static APPROVALS: std::sync::LazyLock<Mutex<HashMap<String, PendingApproval>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

struct PendingRequest {
    tx: tokio::sync::oneshot::Sender<Value>,
}

struct TurnWaiter {
    turn_id: Option<String>,
    tx: tokio::sync::oneshot::Sender<Value>,
}

struct PendingApproval {
    id: Value,
    method: String,
    params: Value,
}

pub fn is_active() -> bool {
    INITIALIZED.load(Ordering::SeqCst)
}

fn reset_transport() {
    *WRITER.lock().unwrap() = None;
    PENDING.lock().unwrap().clear();
    TURN_WAITERS.lock().unwrap().clear();
    CONTEXT_USAGE.lock().unwrap().clear();
    *CURRENT_THREAD.lock().unwrap() = None;
    APPROVALS.lock().unwrap().clear();
    INITIALIZED.store(false, Ordering::SeqCst);
}

fn request_frame(method: &str, params: Value) -> Result<(u64, String), String> {
    let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
    let frame = json!({ "id": id, "method": method, "params": params });
    let line = serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n";
    Ok((id, line))
}

fn notification_frame(method: &str, params: Value) -> Result<String, String> {
    let frame = json!({ "method": method, "params": params });
    Ok(serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n")
}

async fn request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let Some(writer) = WRITER.lock().unwrap().clone() else {
        return Err("Codex app-server not connected".into());
    };
    let (id, line) = request_frame(method, params)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    PENDING.lock().unwrap().insert(id, PendingRequest { tx });
    writer
        .send(line)
        .map_err(|_| "Codex app-server stdin closed".to_string())?;

    let message = tokio::time::timeout(timeout, rx)
        .await
        .map_err(|_| format!("Codex request {method} timed out"))?
        .map_err(|_| "Codex app-server response channel closed".to_string())?;
    if let Some(error) = message.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex request failed");
        return Err(message.to_string());
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

fn prompt_text(params: &Value) -> Option<String> {
    match params.get("prompt") {
        Some(Value::String(prompt)) => Some(prompt.clone()),
        Some(Value::Array(blocks)) => Some(
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

fn non_empty_prompt(params: &Value) -> Option<String> {
    prompt_text(params).filter(|prompt| !prompt.trim().is_empty())
}

/// Map Helix prompt content blocks to codex `turn/start` UserInput items.
/// Text blocks pass through; `image_url` blocks (OpenAI shape) become codex
/// `{type:"image", url}` items. Returns None when nothing usable is present.
fn prompt_input_items(params: &Value) -> Option<Value> {
    let blocks = match params.get("prompt") {
        Some(Value::String(prompt)) => {
            return Some(json!([{ "type": "text", "text": prompt }]));
        }
        Some(Value::Array(blocks)) => blocks,
        _ => return None,
    };
    let mut items = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        items.push(json!({ "type": "text", "text": text }));
                    }
                }
            }
            Some("image_url") => {
                let url = block
                    .pointer("/image_url/url")
                    .or_else(|| block.get("url"))
                    .and_then(Value::as_str);
                if let Some(url) = url {
                    items.push(json!({ "type": "image", "url": url }));
                }
            }
            _ => {}
        }
    }
    if items.is_empty() {
        None
    } else {
        Some(Value::Array(items))
    }
}

pub async fn send(method: &str, params: Value) -> Result<Value, String> {
    if !INITIALIZED.load(Ordering::SeqCst) {
        return Err("Codex app-server not initialized".into());
    }

    match method {
        "session/new" => {
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
            let result = request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "sandbox": "workspace-write"
                }),
                RPC_TIMEOUT,
            )
            .await?;
            let Some(thread_id) = result
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .or_else(|| result.get("threadId").and_then(Value::as_str))
            else {
                return Err("Codex thread/start did not return a thread id".into());
            };
            *CURRENT_THREAD.lock().unwrap() = Some(thread_id.to_string());
            emit_helix_event("gateway.sessionCreated", &json!({ "sessionId": thread_id }));
            Ok(json!({ "session_id": thread_id, "threadId": thread_id }))
        }
        "session/set_mode" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| CURRENT_THREAD.lock().unwrap().clone())
                .ok_or_else(|| "No active Codex thread".to_string())?;
            let mode = params
                .get("mode_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (approval_policy, sandbox_policy) = match mode {
                "default" | "accept_edits" => (
                    "on-request",
                    json!({ "type": "workspaceWrite", "networkAccess": false }),
                ),
                "dont_ask" => ("never", json!({ "type": "dangerFullAccess" })),
                "plan" => (
                    "on-request",
                    json!({ "type": "readOnly", "networkAccess": false }),
                ),
                _ => return Err(format!("Unsupported Codex approval mode: {mode}")),
            };
            let result = request(
                "thread/settings/update",
                json!({
                    "threadId": session_id,
                    "approvalPolicy": approval_policy,
                    "sandboxPolicy": sandbox_policy,
                }),
                RPC_TIMEOUT,
            )
            .await?;
            *CURRENT_THREAD.lock().unwrap() = Some(session_id.clone());
            Ok(result)
        }
        "session/context_breakdown" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| CURRENT_THREAD.lock().unwrap().clone())
                .ok_or_else(|| "No active Codex thread".to_string())?;
            let usage = CONTEXT_USAGE
                .lock()
                .unwrap()
                .get(&session_id)
                .cloned()
                .unwrap_or(Value::Null);
            let token_usage = usage.get("tokenUsage").cloned().unwrap_or(Value::Null);
            let total_usage = token_usage.get("total").cloned().unwrap_or(Value::Null);
            let last_usage = token_usage.get("last").cloned().unwrap_or(Value::Null);
            let context_max = token_usage
                .get("modelContextWindow")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let context_used = last_usage
                .get("inputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                + last_usage
                    .get("outputTokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
            let input_tokens = last_usage
                .get("inputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cached_read_tokens = last_usage
                .get("cachedInputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cached_write_tokens = last_usage
                .get("cacheWriteInputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let output_tokens = last_usage
                .get("outputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let thought_tokens = last_usage
                .get("reasoningOutputTokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let mut categories = Vec::new();
            let mut push_category = |id: &str, label: &str, tokens: i64, color: &str| {
                if tokens > 0 {
                    categories.push(json!({
                        "id": id,
                        "label": label,
                        "tokens": tokens,
                        "color": color,
                    }));
                }
            };
            push_category("input", "输入", input_tokens, "var(--context-usage-system)");
            push_category(
                "cached-read",
                "缓存读取",
                cached_read_tokens,
                "var(--context-usage-skills)",
            );
            push_category(
                "cached-write",
                "缓存写入",
                cached_write_tokens,
                "var(--context-usage-mcp)",
            );
            push_category(
                "output",
                "输出",
                output_tokens,
                "var(--context-usage-conversation)",
            );
            push_category(
                "thought",
                "推理",
                thought_tokens,
                "var(--context-usage-subagents)",
            );
            let estimated_total = categories
                .iter()
                .filter_map(|category| category.get("tokens").and_then(Value::as_i64))
                .sum::<i64>();
            let context_percent = if context_max > 0 {
                (context_used as f64 / context_max as f64) * 100.0
            } else {
                0.0
            };
            Ok(json!({
                "context_max": context_max,
                "context_used": context_used,
                "context_percent": context_percent,
                "estimated_total": estimated_total,
                "categories": categories,
            }))
        }
        "session/resume" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or("session/resume is missing session_id")?;
            let result = request(
                "thread/resume",
                json!({ "threadId": session_id }),
                RPC_TIMEOUT,
            )
            .await?;
            let Some(thread_id) = result
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .or_else(|| result.get("threadId").and_then(Value::as_str))
                .or(Some(session_id))
            else {
                return Err("Codex thread/resume did not return a thread id".into());
            };
            *CURRENT_THREAD.lock().unwrap() = Some(thread_id.to_string());
            emit_helix_event("gateway.sessionCreated", &json!({ "sessionId": thread_id }));
            Ok(json!({ "session_id": thread_id, "threadId": thread_id }))
        }
        "session/prompt" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| CURRENT_THREAD.lock().unwrap().clone())
                .ok_or_else(|| "No active Codex thread".to_string())?;
            let prompt = prompt_input_items(&params)
                .or_else(|| {
                    non_empty_prompt(&params)
                        .map(|text| json!([{ "type": "text", "text": text }]))
                })
                .ok_or("session/prompt is missing text")?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            TURN_WAITERS
                .lock()
                .unwrap()
                .insert(session_id.clone(), TurnWaiter { turn_id: None, tx });
            let result = match request(
                "turn/start",
                json!({
                    "threadId": session_id,
                    "input": prompt,
                }),
                RPC_TIMEOUT,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    TURN_WAITERS.lock().unwrap().remove(&session_id);
                    return Err(error);
                }
            };
            let turn_id = result
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let Some(turn_id) = turn_id else {
                TURN_WAITERS.lock().unwrap().remove(&session_id);
                return Err("Codex turn/start did not return a turn id".into());
            };
            TURN_WAITERS
                .lock()
                .unwrap()
                .get_mut(&session_id)
                .map(|waiter| waiter.turn_id = Some(turn_id));
            let completion = tokio::time::timeout(PROMPT_TIMEOUT, rx)
                .await
                .map_err(|_| "Codex turn timed out")?
                .map_err(|_| "Codex turn event channel closed")?;
            Ok(completion.get("turn").cloned().unwrap_or(completion))
        }
        "session/cancel" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| CURRENT_THREAD.lock().unwrap().clone())
                .ok_or_else(|| "No active Codex thread".to_string())?;
            let Some(turn_id) = TURN_WAITERS
                .lock()
                .unwrap()
                .get(&session_id)
                .and_then(|waiter| waiter.turn_id.clone())
            else {
                return Err("No active Codex turn".into());
            };
            let result = request(
                "turn/interrupt",
                json!({ "threadId": session_id, "turnId": turn_id }),
                RPC_TIMEOUT,
            )
            .await?;
            emit_helix_event(
                "session/update",
                &json!({ "session_id": session_id, "type": "run.cancelled" }),
            );
            Ok(result)
        }
        "codex/approval/respond" | "approval/respond" | "approval.respond" => {
            let approval_id = params
                .get("request_id")
                .or_else(|| params.get("requestId"))
                .or_else(|| params.get("tool_call_id"))
                .or_else(|| params.get("toolCallId"))
                .and_then(Value::as_str)
                .ok_or("Approval response is missing request_id")?
                .to_string();
            let choice = params
                .get("choice")
                .and_then(Value::as_str)
                .ok_or("Approval response is missing choice")?;
            let PendingApproval {
                id,
                method,
                params: approval_params,
            } = APPROVALS
                .lock()
                .unwrap()
                .remove(&approval_id)
                .ok_or("Unknown Codex approval request")?;
            let response = approval_response(&method, &approval_params, choice)?;
            let frame = json!({ "id": id, "result": response });
            let line = serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n";
            let Some(writer) = WRITER.lock().unwrap().clone() else {
                return Err("Codex app-server not connected".into());
            };
            writer
                .send(line)
                .map_err(|_| "Codex app-server stdin closed".to_string())?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(format!("Codex adapter does not implement {method}")),
    }
}

pub fn spawn(state: &Arc<AppState>) -> Result<(), String> {
    kill_current(state);
    let generation = CHILD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let home = codex_home();
    std::fs::create_dir_all(&home)
        .map_err(|e| format!("Failed to create Codex home {}: {e}", home.display()))?;

    let mut command = codex_command();
    command
        .args(["app-server", "--stdio"])
        .current_dir(state.work_dir.read().unwrap().clone())
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start codex app-server: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        return Err("Failed to open codex app-server stdout".into());
    };
    let stderr = child.stderr.take();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open codex app-server stdin".to_string())?;
    {
        let mut slot = state.gateway.child.lock().unwrap();
        *slot = Some(child);
    }

    let (writer_tx, writer_rx) = mpsc::channel::<String>();
    *WRITER.lock().unwrap() = Some(writer_tx);
    thread::spawn(move || {
        let mut stdin = stdin;
        for line in writer_rx {
            if stdin.write_all(line.as_bytes()).is_err() {
                break;
            }
            let _ = stdin.flush();
        }
    });

    let state_clone = Arc::clone(state);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            handle_line(&line.trim());
        }
        if CHILD_GENERATION.load(Ordering::SeqCst) == generation {
            emit_helix_event("gateway.disconnected", &json!({ "backend": "codex" }));
            reset_transport();
            let _ = kill_current(&state_clone);
        }
    });

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    eprintln!("[Codex app-server] {line}");
                }
            }
        });
    }

    initialize();
    Ok(())
}

fn initialize() {
    let (id, line) = match request_frame(
        "initialize",
        json!({
            "clientInfo": {
                "name": "helix",
                "title": "Helix",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
    ) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[Codex app-server] failed to encode initialize: {error}");
            return;
        }
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    PENDING.lock().unwrap().insert(id, PendingRequest { tx });
    if let Some(writer) = WRITER.lock().unwrap().clone() {
        let _ = writer.send(line);
    }
    let Some(notification) = notification_frame("initialized", json!({})).ok() else {
        return;
    };

    match rx.blocking_recv() {
        Ok(message) => {
            if message.get("error").is_none() {
                INITIALIZED.store(true, Ordering::SeqCst);
                emit_helix_event("gateway.ready", &json!({ "backend": "codex" }));
                if let Some(writer) = WRITER.lock().unwrap().clone() {
                    let _ = writer.send(notification);
                }
            } else {
                eprintln!("[Codex app-server] initialize failed: {message}");
            }
        }
        Err(_) => eprintln!("[Codex app-server] initialize response channel closed"),
    }
}

fn handle_line(line: &str) {
    if line.is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };

    if message.get("method").is_some() {
        let method = message["method"].as_str().unwrap_or_default().to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = message.get("id").cloned() {
            if is_approval_request(&method) {
                translate_server_request(&method, &params, id);
            } else {
                let result = translate_server_request(&method, &params, id.clone());
                let response = json!({ "id": id, "result": result });
                if let Ok(response_line) = serde_json::to_string(&response) {
                    if let Some(writer) = WRITER.lock().unwrap().clone() {
                        let _ = writer.send(response_line + "\n");
                    }
                }
            }
        } else {
            emit_codex_event(&method, &params);
        }
        return;
    }

    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return;
    };
    if let Some(pending) = PENDING.lock().unwrap().remove(&id) {
        let _ = pending.tx.send(message);
    }
}

fn is_approval_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}

fn translate_server_request(method: &str, params: &Value, message_id: Value) -> Value {
    match method {
        method if is_approval_request(method) => {
            let approval_id = params
                .get("approvalId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    params
                        .get("itemId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| {
                    params
                        .get("threadId")
                        .and_then(Value::as_str)
                        .and_then(|thread_id| {
                            params
                                .get("itemId")
                                .and_then(Value::as_str)
                                .map(|item_id| format!("{thread_id}:{item_id}"))
                        })
                })
                .unwrap_or_else(|| format!("approval-{message_id}"));
            APPROVALS.lock().unwrap().insert(
                approval_id.clone(),
                PendingApproval {
                    id: Value::from(message_id),
                    method: method.to_string(),
                    params: params.clone(),
                },
            );
            emit_helix_event(
                "session/update",
                &json!({
                    "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                    "update": {
                        "sessionUpdate": "permission_request",
                        "toolCallId": approval_id,
                        "toolName": method,
                        "params": {
                            "method": method,
                            "command": params.get("command").cloned().unwrap_or(Value::Null),
                            "reason": params.get("reason").cloned().unwrap_or(Value::Null),
                            "raw": params,
                        },
                    },
                }),
            );
            Value::Null
        }
        _ => {
            let error =
                json!({ "code": -32601, "message": format!("Helix does not support {method}") });
            json!({ "error": error })
        }
    }
}

fn approval_response(method: &str, params: &Value, choice: &str) -> Result<Value, String> {
    let denied = matches!(choice, "deny" | "cancel");
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let decision = match choice {
                "once" => "accept",
                "session" | "always" => "acceptForSession",
                "deny" => "decline",
                "cancel" => "cancel",
                _ => return Err(format!("Unsupported Codex approval choice: {choice}")),
            };
            Ok(json!({ "decision": decision }))
        }
        "item/permissions/requestApproval" => {
            let requested = params.get("permissions").cloned().unwrap_or(json!({}));
            let mut permissions = json!({
                "network": requested.get("network").cloned().unwrap_or(Value::Null),
                "fileSystem": requested
                    .get("fileSystem")
                    .or_else(|| requested.get("file_system"))
                    .cloned()
                    .unwrap_or(Value::Null),
            });
            if denied {
                permissions["network"]["enabled"] = json!(false);
            }
            let scope = if choice == "session" {
                "session"
            } else {
                "turn"
            };
            Ok(json!({ "permissions": permissions, "scope": scope }))
        }
        _ => Err(format!("Unsupported Codex approval method: {method}")),
    }
}

/// Parse Codex's stream-retry warning: "Reconnecting... 2/5".
fn parse_retry_message(message: &str) -> (u64, u64) {
    let Some(retry_part) = message.rsplit_once("... ") else {
        return (1, 5);
    };
    let Some((attempt, total)) = retry_part.1.split_once('/') else {
        return (1, 5);
    };
    let attempt = attempt.trim().parse().unwrap_or(1);
    let total = total.trim().parse().unwrap_or(5);
    (attempt.max(1), total.max(attempt))
}

/// Strip the shell wrapper codex prepends to executed commands on Windows.
/// codex runs agent commands through the resolved shell (often the Store alias
/// `C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\pwsh.exe`) and the
/// CommandExecution item records `shlex_join([shell, -NoProfile, -Command,
/// script])` as `command`. Showing that wrapper in the tool card title is
/// noise — reduce it to the inner script.
/// Returns `Value::Null` when `command` is absent (frontend falls back to raw).
fn clean_command_title(command: Option<&str>) -> Value {
    let Some(command) = command else {
        return Value::Null;
    };
    Value::String(
        strip_shell_wrapper(command).unwrap_or_else(|| command.to_string()),
    )
}

/// UTF-8 console preamble codex prepends to PowerShell scripts
/// (shell-command/src/powershell.rs UTF8_OUTPUT_PREFIX).
const POWERSHELL_UTF8_PREFIX: &str =
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/// Split a shlex-joined command line into tokens, honoring double quotes.
/// This mirrors how codex joined the argv in the first place.
fn tokenize_command_line(line: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' if current.is_empty() => continue,
            ' ' => {
                tokens.push(std::mem::take(&mut current));
            }
            '"' => {
                // Quoted segment: take everything until the closing quote,
                // preserving inner content verbatim (paths, spaces, etc.).
                current.push('"');
                for inner in chars.by_ref() {
                    current.push(inner);
                    if inner == '"' {
                        break;
                    }
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Some(tokens)
}

/// Recognize `<shell-path> [flags] -Command/-c <script>` and `<shell> /C <script>`
/// wrappers and return the inner script. Mirrors codex's own
/// `extract_powershell_command` flag set (-NoLogo/-NoProfile before -Command).
fn strip_shell_wrapper(command: &str) -> Option<String> {
    let tokens = tokenize_command_line(command.trim())?;
    let mut tokens = tokens.into_iter();
    let exe = tokens.next()?.trim_matches('"').to_lowercase();
    let is_shell = exe.ends_with("pwsh.exe")
        || exe.ends_with("powershell.exe")
        || exe.ends_with("pwsh")
        || exe.ends_with("powershell");
    let is_cmd = exe.ends_with("cmd.exe") || exe.ends_with("cmd");
    if !is_shell && !is_cmd {
        return None;
    }
    let mut rest: Vec<String> = tokens.collect();
    if is_cmd {
        // cmd /C <script>: drop the /C and rejoin the remainder.
        if rest.first().map(String::as_str) == Some("/C") {
            rest.remove(0);
        }
        return Some(rest.join(" "));
    }
    // PowerShell: skip -NoLogo/-NoProfile/-NonInteractive until -Command/-c,
    // matching codex's POWERSHELL_FLAGS walk.
    while let Some(flag) = rest.first() {
        let flag_lower = flag.to_lowercase();
        match flag_lower.as_str() {
            "-nologo" | "-noprofile" | "-noninteractive" => {
                rest.remove(0);
            }
            "-command" | "-c" => {
                rest.remove(0);
                // The script is a single argv element; when shlex-joined it may
                // be wrapped in one pair of quotes — unwrap that outer pair.
                let mut script = rest.join(" ");
                if rest.len() == 1
                    && script.starts_with('"')
                    && script.ends_with('"')
                    && script.len() > 1
                {
                    script = script[1..script.len() - 1].to_string();
                }
                let script = script.trim();
                return Some(
                    script
                        .strip_prefix(POWERSHELL_UTF8_PREFIX.trim_start_matches('\n'))
                        .map(str::to_string)
                        .unwrap_or_else(|| script.to_string()),
                );
            }
            _ => return None,
        }
    }
    None
}

fn emit_codex_event(method: &str, params: &Value) {
    if method == "thread/tokenUsage/updated" {
        if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
            let mut usage_by_thread = CONTEXT_USAGE.lock().unwrap();
            let usage = usage_by_thread
                .entry(thread_id.to_string())
                .or_insert_with(|| json!({ "threadId": thread_id }));
            if let Some(token_usage) = params.get("tokenUsage") {
                usage["tokenUsage"] = token_usage.clone();
            }
        }
    }
    if method == "turn/completed" {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(waiter) = TURN_WAITERS.lock().unwrap().remove(&thread_id) {
            let _ = waiter.tx.send(params.clone());
        }
    }

    let translated = match method {
        "thread/started" => "session/info",
        "turn/started" => "session/update",
        "item/agentMessage/delta" => "session/update",
        "item/reasoning/textDelta" => "session/update",
        "turn/completed" => "session/complete",
        "thread/tokenUsage/updated" => "usage:prompt-complete",
        "warning" => {
            let message = params.get("message").and_then(Value::as_str).unwrap_or_default();
            if message.starts_with("Reconnecting...") {
                "model/retry"
            } else {
                "model/warning"
            }
        }
        "error" => {
            if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                "model/retry"
            } else {
                "error"
            }
        }
        _ => "session/update",
    };
    let payload = if method == "item/agentMessage/delta" {
        json!({
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": params.get("delta").cloned().unwrap_or(Value::Null),
            },
            "raw": params,
        })
    } else if method == "item/reasoning/textDelta" {
        json!({
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": params.get("delta").cloned().unwrap_or(Value::Null),
            },
            "raw": params,
        })
    } else if method == "item/commandExecution/outputDelta" {
        json!({
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": params.get("itemId").cloned().unwrap_or(Value::Null),
                "status": "in_progress",
                "content": params.get("delta").cloned().unwrap_or(Value::Null),
            },
            "raw": params,
        })
    } else if method == "warning"
        || (method == "error"
            && params.get("willRetry").and_then(Value::as_bool) == Some(true))
    {
        let message = params
            .get("message")
            .or_else(|| params.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("Model stream is retrying");
        let (attempt, total) = parse_retry_message(message);
        json!({
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "attempt": attempt,
            "total": total,
            "message": message,
            "raw": params,
        })
    } else if method == "item/started" {
        let item = params.get("item").cloned().unwrap_or(Value::Null);
        match item.get("type").and_then(Value::as_str) {
            Some("commandExecution") => json!({
                "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": item.get("id").cloned().unwrap_or(Value::Null),
                    "title": clean_command_title(item.get("command").and_then(Value::as_str)),
                    "rawInput": Value::Null,
                },
                "raw": params,
            }),
            _ => {
                json!({
                    "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                    "raw": params,
                })
            }
        }
    } else if method == "item/completed" {
        let item = params.get("item").cloned().unwrap_or(Value::Null);
        match item.get("type").and_then(Value::as_str) {
            Some("commandExecution") => {
                let content = item
                    .pointer("/aggregatedOutput")
                    .or_else(|| item.get("aggregatedOutput"))
                    .or_else(|| item.get("output"))
                    .cloned()
                    .unwrap_or(Value::Null);
                json!({
                    "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": item.get("id").cloned().unwrap_or(Value::Null),
                        "status": "completed",
                        "content": content,
                    },
                    "raw": params,
                })
            }
            _ => {
                json!({
                    "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
                    "raw": params,
                })
            }
        }
    } else if method == "thread/tokenUsage/updated" {
        let token_usage = params.get("tokenUsage").cloned().unwrap_or(Value::Null);
        let total_usage = token_usage.get("total").cloned().unwrap_or(Value::Null);
        let last_usage = token_usage.get("last").cloned().unwrap_or(Value::Null);
        let model_context_window = token_usage
            .get("modelContextWindow")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        // `last.totalTokens` is THIS TURN's consumption (prompt+completion for the
        // current request) — not the occupied context. The model's next-turn
        // context is exactly what this turn sent as input plus what it produced:
        // inputTokens (includes cached reads/writes already) + outputTokens.
        // `total.*` is the cumulative sum across turns and feeds the token stats.
        let last_input = last_usage
            .get("inputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let last_output = last_usage
            .get("outputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        json!({
            "usage": {
                "totalTokens": total_usage.get("totalTokens").and_then(Value::as_i64),
                "inputTokens": total_usage.get("inputTokens").and_then(Value::as_i64),
                "outputTokens": total_usage.get("outputTokens").and_then(Value::as_i64),
                "thoughtTokens": total_usage.get("reasoningOutputTokens").and_then(Value::as_i64),
                "cachedReadTokens": total_usage.get("cachedInputTokens").and_then(Value::as_i64),
                "cachedWriteTokens": total_usage
                    .get("cacheWriteInputTokens")
                    .and_then(Value::as_i64),
                "context_max": model_context_window,
                "context_used": last_input + last_output,
            },
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "raw": params,
        })
    } else if method == "thread/started" {
        let thread = params.get("thread").cloned().unwrap_or(Value::Null);
        json!({
            "session_id": thread.get("sessionId").cloned().unwrap_or(Value::Null),
            "threadId": thread.get("id").cloned().unwrap_or(Value::Null),
            "cwd": thread.get("cwd").cloned().unwrap_or(Value::Null),
            "raw": params,
        })
    } else if method == "error" {
        json!({
            // Frontend run loops drop events by session_id — without it an
            // error from one thread leaks into every parallel run.
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "message": params
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Codex request failed"),
            "raw": params,
        })
    } else {
        // Fallback for turn/started, turn/completed (→ session/complete) and any
        // unmapped notification. session_id MUST be present: the frontend
        // filter only drops events that carry a session_id, so a missing one
        // makes one thread's completion terminate every parallel run.
        json!({
            "session_id": params.get("threadId").cloned().unwrap_or(Value::Null),
            "type": method,
            "raw": params,
        })
    };
    emit_helix_event(translated, &payload);
}

/// Codex home — same directory the backend resolves all its state from.
/// All backends share ~/.helix so config + auth live in one place.
pub(crate) fn codex_home() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".helix")
}

#[cfg(windows)]
fn codex_command() -> Command {
    // Prefer the codex.exe bundled with the ChatGPT desktop app: it is kept
    // current by the app's own updater and avoids a separate npm global install.
    // The bin dir is a content hash (changes every app update), so discover it
    // dynamically — pick the most recently modified codex.exe under bin\*.
    if let Some(local) = dirs::data_local_dir() {
        let bin_root = local.join("OpenAI").join("Codex").join("bin");
        let bundled = std::fs::read_dir(&bin_root)
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|entry| {
                        let path = entry.ok()?.path().join("codex.exe");
                        let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
                        Some((path, modified))
                    })
                    .max_by_key(|(_, modified)| *modified)
                    .map(|(path, _)| path)
            });
        if let Some(exe) = bundled {
            return Command::new(&exe);
        }
    }
    // Fallback: the npm global shim.
    let mut command = Command::new("cmd");
    command.arg("/C");
    if let Some(npm_shim) = dirs::data_dir().map(|home| home.join("npm").join("codex.cmd")) {
        if npm_shim.exists() {
            command.arg(npm_shim);
        } else {
            command.arg("codex.cmd");
        }
    } else {
        command.arg("codex.cmd");
    }
    command
}

#[cfg(not(windows))]
fn codex_command() -> Command {
    Command::new("codex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_retry_warning_counts() {
        assert_eq!(parse_retry_message("Reconnecting... 1/5"), (1, 5));
        assert_eq!(parse_retry_message("Reconnecting... 4/5"), (4, 5));
        assert_eq!(parse_retry_message("Reconnecting... 2/2"), (2, 2));
        assert_eq!(parse_retry_message("Reconnecting... waiting for network"), (1, 5));
    }

    #[test]
    fn strips_pwsh_store_alias_wrapper() {
        let wrapped = "\"C:\\Users\\hyt\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe\" -NoProfile -Command \"cargo build --release\"";
        assert_eq!(
            strip_shell_wrapper(wrapped).as_deref(),
            Some("cargo build --release")
        );
    }

    #[test]
    fn strips_short_flag_and_unquoted_script() {
        let wrapped = "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -c git status";
        assert_eq!(strip_shell_wrapper(wrapped).as_deref(), Some("git status"));
    }

    #[test]
    fn strips_cmd_slash_c() {
        let wrapped = "cmd.exe /C dir /b";
        assert_eq!(strip_shell_wrapper(wrapped).as_deref(), Some("dir /b"));
    }

    #[test]
    fn strips_utf8_console_prefix() {
        let wrapped = format!(
            "\"C:\\...\\pwsh.exe\" -NoProfile -Command \"{}Write-Host hi\"",
            POWERSHELL_UTF8_PREFIX
        );
        assert_eq!(
            strip_shell_wrapper(&wrapped).as_deref(),
            Some("Write-Host hi")
        );
    }

    #[test]
    fn leaves_non_shell_commands_untouched() {
        let plain = "cargo test";
        assert_eq!(strip_shell_wrapper(plain), None);
        let node = "\"C:\\Program Files\\nodejs\\node.exe\" script.js";
        assert_eq!(strip_shell_wrapper(node), None);
    }
}
