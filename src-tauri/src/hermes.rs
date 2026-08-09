//! `hermes:*` Tauri commands — gateway-facing API.
//!
//! Port of the ipcMain handlers in `electron/main.js` (hermes:send / notify /
//! status / getGatewayInfo / setGatewayMode / fetchModels / getRawConfig /
//! setRawConfig / getConfig / setConfig / setYamlKey / setDelegationIdentities /
//! setAgentConfig / setReasoningEffort / setConfigKeyValue / approvalRespond /
//! listPersonalities / update / setPersonality / setModel).
//!
//! Mode dispatch: in **serve** mode the renderer talks to the gateway WS
//! directly; these commands handle config writes + serve RPC relay fallback. In
//! **acp** mode everything routes through the stdio JSON-RPC bridge.

use crate::config::{
    config_yaml_path, parse_hermes_personalities, read_hermes_config, set_agent_system_prompt,
    set_delegation_identities, set_model as config_set_model, set_yaml_key, write_agent_config,
    write_hermes_config, HermesConfig, APIHUB_DEFAULT,
};
use crate::gateway::{
    acp_notify, acp_request, emit_hermes_event, env_gateway_mode, gateway_running, kill_current,
    serve_info, serve_rpc, spawn_gateway, shutdown,
};
use crate::kernel::resolve_hermes_cmd;
use crate::paths::hermes_data_dir;
use crate::state::{AppState, ServeGatewayInfo};
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::io::{BufReader, Read, Write};
use std::process::{Command, Stdio};
use tauri::{Emitter, State};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(1800);

// ── shared helpers ─────────────────────────────────────────────────────────

fn is_bad_config(_provider: Option<&str>, base_url: Option<&str>, _api_key: Option<&str>) -> bool {
    // Port of electron/ipc/security.js isBadConfig: a config with no usable
    // baseUrl must never poison Hermes config.yaml. Non-empty configs pass
    // through as-is — no host blocklist, so local gateways are respected.
    let base = base_url.unwrap_or("").trim();
    base.is_empty()
}

fn api_hub_default() -> (String, String, String, String) {
    let d = APIHUB_DEFAULT;
    (
        d.model.to_string(),
        d.base_url.to_string(),
        d.api_key.to_string(),
        d.provider.to_string(),
    )
}

fn read_yaml() -> String {
    std::fs::read_to_string(config_yaml_path()).unwrap_or_default()
}

fn write_yaml(content: &str) {
    if let Some(dir) = config_yaml_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(config_yaml_path(), content);
}

fn mark_own_config_write() {
    // Watcher is not ported (serve re-reads config per session; acp path rarely
    // triggers recycle). Kept as a no-op seam for parity with the JS watcher.
}

/// Debounced gateway restart. Serve mode: no-op (config re-read on session
/// create). acp mode: kill + respawn. Mirrors restartGatewayDebounced.
fn restart_gateway_debounced(state: &Arc<AppState>, _label: &str) -> Result<(), String> {
    if env_gateway_mode() == "serve" {
        return Ok(());
    }
    // acp mode: simple synchronous recycle (Electron debounces; we accept the
    // small latency of a direct restart).
    kill_current(state);
    std::thread::sleep(Duration::from_millis(300));
    spawn_gateway(state)
}

// ── hermes:send / notify / interrupt / status ──────────────────────────────

fn local_capability(method: &str) -> Option<Value> {
    // Methods the current Hermes gateway build does not implement; answer
    // locally so probes don't 404 (mirror electron/main.js).
    match method {
        "tools/list" => Some(json!({ "tools": [] })),
        "hermes:getTasks" => Some(json!({ "tasks": [] })),
        _ => None,
    }
}

async fn acp_send(state: &Arc<AppState>, method: &str, params: Value) -> Result<Value, String> {
    if !gateway_running(state) {
        return Err("Hermes not connected".into());
    }
    if method == "session/prompt" {
        // Session-not-found auto-recovery + usage forwarding.
        match acp_request(method, params.clone(), PROMPT_TIMEOUT).await {
            Ok(result) => {
                if let Some(usage) = result.get("usage") {
                    emit_hermes_event(
                        "usage:prompt-complete",
                        &json!({ "usage": usage }),
                    );
                }
                Ok(result)
            }
            Err(err) => {
                let msg = err.to_string();
                if (msg.to_lowercase().contains("not found")
                    || msg.contains("session_not_found")
                    || msg.to_lowercase().contains("no such session")
                    || msg.to_lowercase().contains("unknown session"))
                    && params.get("session_id").and_then(|v| v.as_str()).is_some()
                {
                    let new_session = acp_request("session/new", json!({}), RPC_TIMEOUT).await?;
                    let new_id = new_session
                        .get("result")
                        .and_then(|r| r.get("session_id"))
                        .and_then(|v| v.as_str())
                        .or_else(|| new_session.get("session_id").and_then(|v| v.as_str()))
                        .map(|s| s.to_string());
                    if let Some(new_id) = new_id {
                        let old_id = params.get("session_id").cloned().unwrap_or(Value::Null);
                        emit_hermes_event(
                            "gateway.sessionReplaced",
                            &json!({ "oldId": old_id, "newId": new_id }),
                        );
                        let mut retry = params.clone();
                        retry["session_id"] = json!(new_id);
                        return acp_request(method, retry, PROMPT_TIMEOUT).await;
                    }
                }
                Err(msg)
            }
        }
    } else {
        acp_request(method, params, RPC_TIMEOUT).await
    }
}

#[tauri::command]
pub async fn hermes_send(
    state: State<'_, Arc<AppState>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or(Value::Null);
    if let Some(local) = local_capability(&method) {
        return Ok(local);
    }
    if env_gateway_mode() == "serve" {
        serve_rpc(&state, &method, params, RPC_TIMEOUT).await
    } else {
        acp_send(&state, &method, params).await
    }
}

#[tauri::command]
pub fn hermes_notify(state: State<'_, Arc<AppState>>, method: String, params: Option<Value>) {
    let params = params.unwrap_or(Value::Null);
    if env_gateway_mode() == "serve" {
        // Serve has no notification semantics; fire-and-forget RPC is handled
        // by the renderer's WS client. Nothing to do here.
        let _ = &state;
        return;
    }
    acp_notify(&method, params);
}

#[tauri::command]
pub async fn hermes_interrupt(state: State<'_, Arc<AppState>>, session_id: String) -> Result<Value, String> {
    // session/cancel is a notification on acp, an RPC on serve.
    if env_gateway_mode() == "serve" {
        let _ = serve_rpc(&state, "session.interrupt", json!({ "session_id": session_id }), RPC_TIMEOUT).await?;
        return Ok(json!({ "ok": true }));
    }
    acp_notify("session/cancel", json!({ "session_id": session_id }));
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn hermes_status(state: State<'_, Arc<AppState>>) -> Value {
    let connected = gateway_running(&state);
    if !connected && env_gateway_mode() == "serve" {
        // Lazily self-heal on the periodic health check (mirror hermes:status).
        let arc = Arc::clone(&state);
        match spawn_gateway(&arc) {
            Ok(()) => return json!({ "connected": true }),
            Err(e) => return json!({ "connected": false, "error": e }),
        }
    }
    json!({ "connected": connected })
}

#[tauri::command]
pub fn hermes_get_gateway_info(state: State<'_, Arc<AppState>>) -> Value {
    if env_gateway_mode() == "serve" {
        match serve_info(&state) {
            Some(info) => json!(info),
            None => json!({ "mode": "serve", "pending": true }),
        }
    } else {
        json!({ "mode": "acp" })
    }
}

#[tauri::command]
pub fn hermes_set_gateway_mode(
    state: State<'_, Arc<AppState>>,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or_default();
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("local");
    let mode = if mode == "remote" { "remote" } else { "local" };
    let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    *state.hermes.gateway_mode.lock().unwrap() = mode.to_string();
    *state.hermes.remote_gateway_url.lock().unwrap() = url.clone();

    if mode == "remote" {
        if url.is_empty() {
            return Err("remote 模式需要提供网关地址（WebSocket URL）".into());
        }
        let info = build_remote_gateway_info(&url)?;
        kill_current(&state);
        *state.hermes.serve_info.write().unwrap() = Some(info.clone());
        emit_hermes_event("gateway.serveInfo", &serde_json::to_value(&info).unwrap_or(Value::Null));
        Ok(json!({ "ok": true, "mode": "remote", "info": info }))
    } else {
        // Back to local: respawn the bundled runtime (handshake will push serveInfo).
        kill_current(&state);
        let arc = Arc::clone(&state);
        if let Err(e) = spawn_gateway(&arc) {
            return Err(e);
        }
        Ok(json!({ "ok": true, "mode": "local" }))
    }
}

fn build_remote_gateway_info(raw_url: &str) -> Result<ServeGatewayInfo, String> {
    let mut ws_url = raw_url.trim().to_string();
    if ws_url.to_lowercase().starts_with("http://") || ws_url.to_lowercase().starts_with("https://") {
        let base = ws_url.trim_end_matches('/').to_string();
        let scheme = if base.to_lowercase().starts_with("https") { "wss" } else { "ws" };
        let rest = base.replacen("http", scheme, 1).replacen("https", scheme, 1);
        ws_url = format!("{rest}/api/ws");
    }
    let base_url = ws_url
        .split('?')
        .next()
        .unwrap_or("")
        .trim_end_matches("/api/ws")
        .to_string();
    let base_url = if base_url.to_lowercase().starts_with("wss://") {
        base_url.replacen("wss://", "https://", 1)
    } else if base_url.to_lowercase().starts_with("ws://") {
        base_url.replacen("ws://", "http://", 1)
    } else {
        base_url
    };
    Ok(ServeGatewayInfo {
        mode: "serve".into(),
        pending: Some(false),
        port: Some(0),
        token: None,
        base_url: Some(base_url),
        ws_url: Some(ws_url),
        remote: Some(true),
    })
}

// ── hermes:fetchModels ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn hermes_fetch_models(base_url: String, api_key: String) -> Value {
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return json!({ "models": [] }),
    };
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            match r.json::<Value>().await {
                Ok(data) => {
                    let arr = data.get("data").or_else(|| data.get("models")).cloned().unwrap_or(Value::Array(vec![]));
                    let models: Vec<String> = arr
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|m| {
                                    m.get("id")
                                        .or_else(|| m.get("name"))
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                        .or_else(|| {
                                            m.as_str().map(|s| s.to_string())
                                        })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({ "models": models })
                }
                Err(e) => json!({ "models": [], "error": e.to_string() }),
            }
        }
        Ok(r) => json!({ "models": [], "error": format!("HTTP {}", r.status()) }),
        Err(e) => json!({ "models": [], "error": e.to_string() }),
    }
}

// ── hermes:getRawConfig / setRawConfig (via serve gateway /api/config) ─────

fn serve_config_url(state: &AppState) -> Option<(String, String)> {
    if env_gateway_mode() != "serve" {
        return None;
    }
    let info = serve_info(state)?;
    let port = info.port?;
    let token = info.token.clone().unwrap_or_default();
    Some((format!("http://127.0.0.1:{port}/api/config"), token))
}

#[tauri::command]
pub async fn hermes_get_raw_config(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let Some((url, token)) = serve_config_url(&state) else {
        return Ok(json!({ "ok": false, "error": "gateway-not-ready" }));
    };
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return Ok(json!({ "ok": false, "error": "client" })),
    };
    match client.get(&url).header("X-Hermes-Session-Token", token).send().await {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(cfg) => Ok(json!({ "ok": true, "config": cfg })),
            Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
        },
        Ok(r) => Ok(json!({ "ok": false, "error": format!("HTTP {}", r.status()) })),
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
pub async fn hermes_set_raw_config(state: State<'_, Arc<AppState>>, patch: Value) -> Result<Value, String> {
    let Some((url, token)) = serve_config_url(&state) else {
        return Ok(json!({ "ok": false, "error": "gateway-not-ready" }));
    };
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return Ok(json!({ "ok": false, "error": "client" })),
    };
    match client
        .put(&url)
        .header("X-Hermes-Session-Token", token)
        .json(&json!({ "config": patch }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => Ok(json!({ "ok": true })),
        Ok(r) => Ok(json!({ "ok": false, "error": format!("HTTP {}", r.status()) })),
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

// ── External memory provider config (serve gateway /api/memory/*) ──────────
//
// The desktop UI's provider config panel is schema-driven by the serve gateway
// (GET /api/memory for status, GET/PUT /api/memory/providers/{name}/config for
// the per-provider fields). These wrap the same token-authenticated REST
// pattern as the raw-config commands above.

fn serve_api_url(state: &AppState, path: &str) -> Option<(String, String)> {
    if env_gateway_mode() != "serve" {
        return None;
    }
    let info = serve_info(state)?;
    let port = info.port?;
    let token = info.token.clone().unwrap_or_default();
    Some((format!("http://127.0.0.1:{port}{path}"), token))
}

#[tauri::command]
pub async fn hermes_get_memory_status(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let Some((url, token)) = serve_api_url(&state, "/api/memory") else {
        return Ok(json!({ "ok": false, "error": "gateway-not-ready" }));
    };
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return Ok(json!({ "ok": false, "error": "client" })),
    };
    match client.get(&url).header("X-Hermes-Session-Token", token).send().await {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => Ok(json!({ "ok": true, "status": v })),
            Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
        },
        Ok(r) => Ok(json!({ "ok": false, "error": format!("HTTP {}", r.status()) })),
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
pub async fn hermes_get_memory_provider_config(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<Value, String> {
    let path = format!("/api/memory/providers/{name}/config");
    let Some((url, token)) = serve_api_url(&state, &path) else {
        return Ok(json!({ "ok": false, "error": "gateway-not-ready" }));
    };
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return Ok(json!({ "ok": false, "error": "client" })),
    };
    match client.get(&url).header("X-Hermes-Session-Token", token).send().await {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => Ok(json!({ "ok": true, "config": v })),
            Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
        },
        Ok(r) => Ok(json!({ "ok": false, "error": format!("HTTP {}", r.status()) })),
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
pub async fn hermes_set_memory_provider_config(
    state: State<'_, Arc<AppState>>,
    name: String,
    values: Value,
) -> Result<Value, String> {
    let path = format!("/api/memory/providers/{name}/config");
    let Some((url, token)) = serve_api_url(&state, &path) else {
        return Ok(json!({ "ok": false, "error": "gateway-not-ready" }));
    };
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return Ok(json!({ "ok": false, "error": "client" })),
    };
    match client
        .put(&url)
        .header("X-Hermes-Session-Token", token)
        .json(&json!({ "values": values }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => Ok(json!({ "ok": true, "result": v })),
            Err(_) => Ok(json!({ "ok": true })),
        },
        Ok(r) => {
            // Surface the gateway's validation detail when present.
            let status = r.status();
            let detail = r
                .json::<Value>()
                .await
                .ok()
                .and_then(|d| d.get("detail").and_then(|x| x.as_str()).map(|s| s.to_string()));
            Ok(json!({ "ok": false, "error": detail.unwrap_or_else(|| format!("HTTP {status}")) }))
        }
        Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
    }
}

// ── hermes:getConfig / setConfig ───────────────────────────────────────────

#[tauri::command]
pub fn hermes_get_config() -> HermesConfig {
    read_hermes_config()
}

#[tauri::command]
pub fn hermes_set_config(
    state: State<'_, Arc<AppState>>,
    config: Value,
) -> Value {
    let model = config.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let provider = config.get("provider").and_then(|v| v.as_str()).map(|s| s.to_string());
    let base_url = config.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
    let api_key = config.get("apiKey").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Defense-in-depth: validate the incoming config (mirror isBadConfig gate).
    let (model, provider, base_url, api_key) = if is_bad_config(provider.as_deref(), base_url.as_deref(), api_key.as_deref()) {
        let (dm, db, dk, dp) = api_hub_default();
        (
            Some(if model.as_deref().map_or(true, |m| m.trim().is_empty()) { dm } else { model.unwrap() }),
            Some(dp),
            Some(db),
            Some(dk),
        )
    } else {
        (model, provider, base_url, api_key)
    };

    write_hermes_config(model.as_deref(), provider.as_deref(), base_url.as_deref(), api_key.as_deref());
    mark_own_config_write();

    // serve mode: no restart (config re-read on session create). acp: restart.
    if env_gateway_mode() != "serve" {
        let arc = Arc::clone(&state);
        let _ = restart_gateway_debounced(&arc, "setConfig");
    }
    json!({ "success": true })
}

#[tauri::command]
pub fn hermes_set_yaml_key(
    state: State<'_, Arc<AppState>>,
    key: String,
    value: Value,
) -> Value {
    let yaml = read_yaml();
    let updated = set_yaml_key(&yaml, &key, &value);
    if updated == yaml {
        return json!({ "success": true, "changed": false });
    }
    write_yaml(&updated);
    mark_own_config_write();
    if env_gateway_mode() != "serve" {
        let arc = Arc::clone(&state);
        let _ = restart_gateway_debounced(&arc, "setYamlKey");
    }
    json!({ "success": true, "changed": true })
}

#[tauri::command]
pub fn hermes_set_delegation_identities(
    state: State<'_, Arc<AppState>>,
    identities: Value,
) -> Value {
    let yaml = read_yaml();
    let updated = set_delegation_identities(&yaml, &identities);
    if updated == yaml {
        return json!({ "success": true, "changed": false });
    }
    write_yaml(&updated);
    mark_own_config_write();
    if env_gateway_mode() != "serve" {
        let arc = Arc::clone(&state);
        let _ = restart_gateway_debounced(&arc, "setDelegationIdentities");
    }
    json!({ "success": true, "changed": true })
}

#[tauri::command]
pub fn hermes_set_agent_config(
    state: State<'_, Arc<AppState>>,
    params: Option<Value>,
) -> Value {
    let params = params.unwrap_or_default();
    let reasoning_effort = params.get("reasoningEffort").and_then(|v| v.as_str());
    let personality = params.get("personality").and_then(|v| v.as_str());
    write_agent_config(reasoning_effort, personality);
    mark_own_config_write();
    if env_gateway_mode() != "serve" {
        let arc = Arc::clone(&state);
        let _ = restart_gateway_debounced(&arc, "setAgentConfig");
    }
    json!({ "success": true })
}

#[tauri::command]
pub fn hermes_set_reasoning_effort(params: Option<Value>) -> Value {
    let params = params.unwrap_or_default();
    let re = params.get("reasoningEffort").and_then(|v| v.as_str());
    let Some(re) = re else {
        return json!({ "success": false });
    };
    let yaml = read_yaml();
    let updated = set_yaml_key(&yaml, "agent.reasoning_effort", &json!(re));
    if updated != yaml {
        write_yaml(&updated);
        mark_own_config_write();
    }
    json!({ "success": true })
}

#[tauri::command]
pub async fn hermes_set_config_key_value(
    state: State<'_, Arc<AppState>>,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or_default();
    let key = params.get("key").and_then(|v| v.as_str());
    let Some(key) = key else {
        return Ok(json!({ "success": false }));
    };
    let value = params.get("value").cloned().unwrap_or(Value::Null);
    let session_id = params.get("session_id").and_then(|v| v.as_str());

    let yaml = read_yaml();
    let val_str = value.as_str().map(|s| s.to_string()).unwrap_or_else(|| value.to_string());
    let updated = set_yaml_key(&yaml, key, &json!(val_str));
    if updated != yaml {
        write_yaml(&updated);
        mark_own_config_write();
    }
    // Best-effort live push to the running session via config.set RPC.
    if let Some(sid) = session_id {
        if env_gateway_mode() == "serve" {
            let _ = serve_rpc(
                &state,
                "config.set",
                json!({ "key": key, "value": val_str, "session_id": sid }),
                RPC_TIMEOUT,
            )
            .await;
        } else {
            let _ = acp_request(
                "config.set",
                json!({ "key": key, "value": val_str, "session_id": sid }),
                RPC_TIMEOUT,
            )
            .await;
        }
    }
    Ok(json!({ "success": true }))
}

// ── hermes:approvalRespond ─────────────────────────────────────────────────

#[tauri::command]
pub async fn hermes_approval_respond(
    state: State<'_, Arc<AppState>>,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or_default();
    let session_id = params.get("session_id").cloned().unwrap_or(Value::Null);
    let tool_call_id = params.get("tool_call_id").cloned().unwrap_or(Value::Null);
    let choice = params.get("choice").and_then(|v| v.as_str()).unwrap_or("approve");
    let rpc_params = json!({ "session_id": session_id, "tool_call_id": tool_call_id, "choice": choice });
    let _ = if env_gateway_mode() == "serve" {
        serve_rpc(&state, "approval.respond", rpc_params, RPC_TIMEOUT).await
    } else {
        acp_request("approval.respond", rpc_params, RPC_TIMEOUT).await
    };
    Ok(json!({ "success": true }))
}

// ── hermes:listPersonalities / setPersonality / update / setModel ──────────

#[tauri::command]
pub fn hermes_list_personalities() -> Value {
    let yaml = read_yaml();
    let personalities = parse_hermes_personalities(&yaml);
    json!({ "success": true, "personalities": personalities })
}

#[tauri::command]
pub fn hermes_update() -> Value {
    match resolve_hermes_cmd() {
        Some(cmd) => {
            let hermes_dir = hermes_data_dir();
            let spawn_result = std::process::Command::new(&cmd)
                .arg("update")
                .current_dir(&hermes_dir)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            match spawn_result {
                Ok(_) => json!({ "ok": true, "message": "已启动 Hermes 更新，完成后请重启 Helix" }),
                Err(e) => json!({ "ok": false, "message": e.to_string() }),
            }
        }
        None => json!({ "ok": false, "message": "找不到 hermes 可执行文件" }),
    }
}

/// 带超时地执行一条命令并捕获输出（stdout/stderr），返回 `(退出码, stdout, stderr)`。
/// 子进程输出都很小（git clone / CLI 提示），管道不会撑满；轮询 `try_wait` 以便超时中止。
fn run_cmd_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err("命令执行超时，已中止".into());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut err);
    }
    Ok((status.code().unwrap_or(-1), out, err))
}

fn is_safe_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 解析官方内存 Provider 仓库标识：`owner/repo/.../plugins/memory/<id>` 或
/// `https://github.com/owner/repo/...` 浏览器 URL。只认 NousResearch/hermes-agent，
/// 匹配则返回 Provider id（用于稀疏克隆安装）。
fn monorepo_memory_provider(identifier: &str) -> Option<String> {
    let s = identifier.trim().trim_end_matches('/');
    let s = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .unwrap_or(s);
    let marker = "plugins/memory/";
    let idx = s.find(marker)?;
    let prefix = &s[..idx];
    let id = s[idx + marker.len()..].split('/').next()?.to_string();
    if !is_safe_provider_id(&id) {
        return None;
    }
    let tokens: Vec<&str> = prefix.trim_matches('/').split('/').filter(|p| !p.is_empty()).collect();
    let is_official = tokens.len() >= 2 && tokens[0] == "NousResearch" && tokens[1] == "hermes-agent";
    is_official.then_some(id)
}

/// 官方内存 Provider 插件（NousResearch/hermes-agent 的 `plugins/memory/<id>`）
/// 用 sparse 稀疏克隆安装。整仓有约 600MB，普通浅克隆太重；`--depth 1
/// --filter=blob:none --sparse` 只拉树结构 + 需要的子目录，实测约 3MB / 数十秒。
/// 递归收集 GitHub 目录（contents API）下所有文件的相对路径。
/// 每个目录一级一次 API 调用；插件目录都是扁平的，通常只需 1 次。
fn github_walk_dir(
    client: &reqwest::blocking::Client,
    api_path: &str,
    base: &str,
    out: &mut Vec<String>,
) -> Result<(), String> {
    let url = format!("https://api.github.com/repos/NousResearch/hermes-agent/contents/{api_path}");
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("请求 GitHub 失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API {url} → HTTP {}", resp.status()));
    }
    let entries: Value = resp.json().map_err(|e| format!("解析 GitHub 响应失败：{e}"))?;
    let arr = entries
        .as_array()
        .ok_or_else(|| "GitHub 返回的不是目录结构".to_string())?;
    for it in arr {
        let ty = it.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let rel = if base.is_empty() { name.clone() } else { format!("{base}/{name}") };
        match ty {
            "dir" => github_walk_dir(client, &format!("{api_path}/{name}"), &rel, out)?,
            "file" => out.push(rel),
            _ => {}
        }
    }
    Ok(())
}

/// 带重试地下载一个文件（走 contents API 的 raw Accept 头，仍落在 api.github.com，
/// 因为 raw.githubusercontent.com 在某些网络环境不可达）。返回文件字节。
fn github_download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    rel: &str,
) -> Result<Vec<u8>, String> {
    let mut last_err: Option<String> = None;
    for attempt in 0..3 {
        match client.get(url).header("Accept", "application/vnd.github.raw").send() {
            Ok(resp) if resp.status().is_success() => {
                return resp.bytes().map(|b| b.to_vec()).map_err(|e| format!("读取 {rel} 失败：{e}"));
            }
            Ok(resp) => return Err(format!("下载 {rel} 失败：HTTP {}", resp.status())),
            Err(e) => {
                last_err = Some(format!("{e}"));
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(400 * (attempt + 1)));
                }
            }
        }
    }
    Err(format!("下载 {rel} 失败（重试后仍失败）：{}", last_err.unwrap_or_default()))
}

/// 官方内存 Provider 插件（NousResearch/hermes-agent 的 `plugins/memory/<id>`）
/// 直接用 GitHub contents API + raw 原始文件下载安装。
///
/// 不用 git clone：整仓有约 600MB，浅/稀疏克隆都要先协商整个仓库的树结构，
/// 实测要 1–5 分钟；而插件子目录只有几个小文件（如 mem0 = 6 个文件 / 100KB），
/// API 一次列目录 + 逐个 raw 下载，几秒内完成。
async fn install_memory_provider_official(provider: String, force: bool, hermes_bin: &std::path::Path) -> Value {
    use std::io::Write;
    let hermes_home = hermes_data_dir();

    let provider_in = provider.clone();
    let hermes_home_in = hermes_home.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("Helix/0.3")
            .build()
            .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

        // 1. 递归列出插件目录所有文件（相对路径）
        let api_dir = format!("plugins/memory/{provider_in}");
        let mut files: Vec<String> = Vec::new();
        github_walk_dir(&client, &api_dir, "", &mut files)?;
        if files.is_empty() {
            return Err(format!("GitHub 上没找到插件目录 plugins/memory/{provider_in}"));
        }
        if !files.iter().any(|rel| rel == "plugin.yaml" || rel == "plugin.yml") {
            return Err("该目录没有 plugin.yaml / plugin.yml，不是有效的插件".into());
        }

        // 2. 落地到 $HERMES_HOME/plugins/<provider>
        let plugins_dir = hermes_home_in.join("plugins");
        let target = plugins_dir.join(&provider_in);
        if target.exists() {
            if !force {
                return Err(format!("插件 {provider_in} 已安装，如需重装请在命令后加 --force"));
            }
            std::fs::remove_dir_all(&target).map_err(|e| format!("清理旧插件失败：{e}"))?;
        }
        std::fs::create_dir_all(&target).map_err(|e| format!("无法创建插件目录：{e}"))?;

        let mut downloaded = 0usize;
        for rel in &files {
            let url = format!(
                "https://api.github.com/repos/NousResearch/hermes-agent/contents/{api_dir}/{rel}"
            );
            let bytes = github_download_file(&client, &url, rel)?;
            let dest = target.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
            }
            let mut f = std::fs::File::create(&dest).map_err(|e| format!("写入 {rel} 失败：{e}"))?;
            f.write_all(&bytes).map_err(|e| format!("写入 {rel} 失败：{e}"))?;
            downloaded += 1;
        }

        Ok(format!(
            "已安装插件 {provider_in}（{downloaded} 个文件）→ {}",
            target.display()
        ))
    })
    .await;

    let install_msg = match result {
        Ok(Ok(msg)) => msg,
        Ok(Err(e)) => return json!({ "ok": false, "message": e }),
        Err(e) => return json!({ "ok": false, "message": e.to_string() }),
    };

    // 3. 尝试加入启用列表（内存 Provider 加载不走该门控，属锦上添花，失败不影响）
    use std::process::Command;
    let enable = run_cmd_with_timeout(
        {
            let mut c = Command::new(hermes_bin);
            c.arg("plugins")
                .arg("enable")
                .arg(provider)
                .arg("--no-allow-tool-override")
                .envs(crate::kanban::build_clean_env(hermes_bin))
                .env("HERMES_HOME", hermes_home.display().to_string());
            c
        },
        Duration::from_secs(60),
    );
    match enable {
        Ok((0, _, _)) => json!({ "ok": true, "message": format!("{install_msg}。插件已启用。") }),
        Ok((code, so, se)) => json!({
            "ok": true,
            "message": format!(
                "{install_msg}。（启用步骤未生效，退出码 {code}：{}）",
                if !se.trim().is_empty() { se } else { so }
            )
        }),
        Err(e) => json!({ "ok": true, "message": format!("{install_msg}。（启用步骤跳过：{e}）") }),
    }
}

/// 安装 Hermes 插件的异步封装（设置页「运行」按钮）。
///
/// 两种路径：
/// - 官方内存 Provider（`NousResearch/hermes-agent/plugins/memory/<id>`）→ GitHub API
///   直接下载插件文件（几秒完成，绕开 600MB 整仓）；
/// - 其他仓库 → 交给 `hermes plugins install <identifier> --enable`（免交互确认）。
/// `--force` 在重装时覆盖已存在插件。环境用 kanban 的 `build_clean_env`（清 npm 变量、
/// hermes venv bin 前置到 PATH），并钉住 `HERMES_HOME` 指向本应用的数据目录，否则插件
/// 会装到 CLI 默认的 `~/.hermes`，网关（读 `~/.local/share/hermes`）扫描不到。
#[tauri::command]
pub async fn hermes_install_plugin(identifier: String, force: Option<bool>) -> Value {
    use std::process::Command;
    let Some(hermes_bin) = resolve_hermes_cmd() else {
        return json!({ "ok": false, "message": "找不到 hermes 可执行文件" });
    };
    let identifier = identifier.trim().to_string();
    if identifier.is_empty() {
        return json!({ "ok": false, "message": "安装命令不能为空，请输入 owner/repo 或 Git URL" });
    }
    let force = force.unwrap_or(false);

    if let Some(provider) = monorepo_memory_provider(&identifier) {
        return install_memory_provider_official(provider, force, &hermes_bin).await;
    }

    let hermes_home = hermes_data_dir();
    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(&hermes_bin);
        child
            .arg("plugins")
            .arg("install")
            .arg(&identifier)
            .arg("--enable");
        if force {
            child.arg("--force");
        }
        child
            .envs(crate::kanban::build_clean_env(&hermes_bin))
            .env("HERMES_HOME", hermes_home.display().to_string())
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await;
    match result {
        Ok(Ok(o)) => {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let combined = if !stdout.is_empty() && !stderr.is_empty() {
                format!("{stdout}\n{stderr}")
            } else if !stderr.is_empty() {
                stderr
            } else {
                stdout
            };
            if o.status.success() {
                json!({ "ok": true, "message": combined })
            } else {
                let code = o.status.code().unwrap_or(-1);
                json!({ "ok": false, "message": format!("退出码 {code}: {combined}") })
            }
        }
        Ok(Err(e)) => json!({ "ok": false, "message": e.to_string() }),
        Err(e) => json!({ "ok": false, "message": e.to_string() }),
    }
}

#[tauri::command]
pub fn hermes_set_personality(
    state: State<'_, Arc<AppState>>,
    params: Option<Value>,
) -> Value {
    let params = params.unwrap_or_default();
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let prompt = params.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string());

    let yaml = read_yaml();
    let clear_names = ["", "none", "default", "neutral", "clear"];
    let name_lower = name.to_lowercase();
    let resolved = if clear_names.contains(&name_lower.as_str()) {
        String::new()
    } else {
        match prompt {
            Some(p) => p,
            None => {
                let personas = parse_hermes_personalities(&yaml);
                match personas.get(&name) {
                    Some(v) => v.as_str().unwrap_or("").to_string(),
                    None => {
                        return json!({ "success": false, "error": format!("Unknown personality: {name}") })
                    }
                }
            }
        }
    };
    let updated = set_agent_system_prompt(&yaml, &resolved);
    write_yaml(&updated);
    mark_own_config_write();
    if env_gateway_mode() != "serve" {
        let arc = Arc::clone(&state);
        let _ = restart_gateway_debounced(&arc, "setPersonality");
    }
    json!({ "success": true })
}

#[tauri::command]
pub fn hermes_set_model(
    state: State<'_, Arc<AppState>>,
    params: Option<Value>,
) -> Value {
    let params = params.unwrap_or_default();
    let model = params.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let Some(model) = model else {
        return json!({ "success": true, "applied": false, "reason": "no model" });
    };
    let model = model.trim().to_string();
    if model.is_empty() {
        return json!({ "success": true, "applied": false, "reason": "no model" });
    }
    let mut base_url = params.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut api_key = params.get("apiKey").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut provider = params.get("provider").and_then(|v| v.as_str()).map(|s| s.to_string());

    // If the requested endpoint is bad, keep the model but force the known-good
    // apihub endpoint + key (mirror electron main.js hermes:setModel).
    if is_bad_config(provider.as_deref(), base_url.as_deref(), api_key.as_deref()) {
        let (dm, db, dk, dp) = api_hub_default();
        base_url = Some(db);
        api_key = Some(dk);
        provider = Some(dp);
        let _ = dm;
    }

    let (changed, key_changed) = config_set_model(&model, base_url.as_deref(), api_key.as_deref(), provider.as_deref());
    mark_own_config_write();

    if (changed || key_changed) && env_gateway_mode() != "serve" {
        let arc = Arc::clone(&state);
        let _ = restart_gateway_debounced(&arc, "setModel");
    }
    json!({ "success": true, "applied": true })
}

// ── helpers for lib.rs ─────────────────────────────────────────────────────

/// Shut the gateway down (called on app exit).
#[allow(dead_code)]
pub fn shutdown_gateway(state: &AppState) {
    shutdown(state);
}

/// Current serve gateway info for diagnostics.
#[allow(dead_code)]
pub fn current_serve_info(state: &AppState) -> Option<ServeGatewayInfo> {
    serve_info(state)
}

// ── Hermes dirs / read helpers (hermes:getSkillsDir etc.) ──────────────────

#[tauri::command]
pub fn hermes_get_skills_dir() -> Option<String> {
    Some(hermes_data_dir().join("skills").display().to_string())
}

#[tauri::command]
pub fn hermes_get_plugins_dir() -> Option<String> {
    Some(hermes_data_dir().join("plugins").display().to_string())
}

#[tauri::command]
pub fn hermes_read_dir(dir_path: String) -> Vec<Value> {
    let entries = match std::fs::read_dir(&dir_path) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    entries
        .flatten()
        .map(|e| {
            json!({
                "name": e.file_name().to_string_lossy().to_string(),
                "isDirectory": e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            })
        })
        .collect()
}

#[tauri::command]
pub fn hermes_read_file(file_path: String) -> Option<String> {
    std::fs::read_to_string(&file_path).ok()
}

// ── Hermes memory sync (hermes:listMemories etc.) ──────────────────────────

#[tauri::command]
pub fn hermes_list_memories() -> Value {
    let dir = crate::memory::hermes_memories_dir();
    json!({
        "memory": crate::memory::read_mem_file(&dir.join("MEMORY.md")),
        "user": crate::memory::read_mem_file(&dir.join("USER.md")),
        "manual": crate::memory::read_manual_markers(&dir),
    })
}

#[tauri::command]
pub fn hermes_add_memory_entry(target: String, text: String) -> Value {
    let dir = crate::memory::hermes_memories_dir();
    let file = if target == "user" {
        dir.join("USER.md")
    } else {
        dir.join("MEMORY.md")
    };
    let mut entries = crate::memory::read_mem_file(&file);
    let t = text.trim().to_string();
    if t.is_empty() {
        return json!({ "ok": false, "error": "empty" });
    }
    let is_new = !entries.contains(&t);
    if is_new {
        entries.push(t.clone());
        crate::memory::write_mem_file(&file, &entries);
    }
    if target != "user" {
        crate::memory::add_manual_marker(&dir, &t);
    }
    json!({ "ok": true, "entries": entries })
}

#[tauri::command]
pub fn hermes_remove_memory_entry(target: String, text: String) -> Value {
    let dir = crate::memory::hermes_memories_dir();
    let file = if target == "user" {
        dir.join("USER.md")
    } else {
        dir.join("MEMORY.md")
    };
    let entries = crate::memory::read_mem_file(&file);
    let t = text.trim().to_string();
    let next: Vec<String> = entries.into_iter().filter(|e| e != &t).collect();
    crate::memory::write_mem_file(&file, &next);
    if target != "user" {
        crate::memory::remove_manual_marker(&dir, &t);
    }
    json!({ "ok": true, "entries": next })
}

// ── Hermes skills (hermes:listSkills etc.) ─────────────────────────────────

#[tauri::command]
pub fn hermes_list_skills() -> Vec<Value> {
    let skills_dir = hermes_data_dir().join("skills");
    let mut skills: Vec<Value> = Vec::new();

    // Custom first (custom wins over built-in on name collision).
    crate::memory::collect_skills_from_dir(&skills_dir.join("helix-custom"), false, &mut skills);

    // Built-in: skip helix-custom (already scanned as custom).
    let entries = match std::fs::read_dir(&skills_dir) {
        Ok(e) => e,
        Err(_) => return skills,
    };
    for e in entries.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == "helix-custom" || name == "tests" || name.starts_with('.') {
            continue;
        }
        crate::memory::collect_skills_from_dir(&e.path(), true, &mut skills);
    }

    // Deduplicate by name.
    let mut seen = std::collections::HashSet::new();
    skills.into_iter().filter(|s| {
        let n = s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        seen.insert(n)
    }).collect()
}

#[tauri::command]
pub fn hermes_track_skill_call(skill_name: String) -> u64 {
    crate::memory::increment_skill_call_count(&skill_name)
}

#[tauri::command]
pub fn hermes_delete_dir(dir_path: String) -> Value {
    // Security: confine deletion to the Hermes skills directory.
    let skills_root = hermes_data_dir().join("skills");
    let target = if dir_path.ends_with("SKILL.md") {
        std::path::PathBuf::from(&dir_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&dir_path))
    } else {
        std::path::PathBuf::from(&dir_path)
    };
    let resolved = match std::fs::canonicalize(&target) {
        Ok(p) => p,
        Err(_) => target,
    };
    let resolved_root = match std::fs::canonicalize(&skills_root) {
        Ok(p) => p,
        Err(_) => skills_root,
    };
    if resolved != resolved_root && !resolved.starts_with(&resolved_root) {
        return json!({ "success": false, "error": "refused: target outside skills directory" });
    }
    match std::fs::remove_dir_all(&resolved) {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

// ── hermes:cron / doctor ─────────────────────────────────────────────────

#[tauri::command]
pub fn hermes_cron_list() -> Value {
    match resolve_hermes_cmd() {
        Some(cmd) => {
            let out = std::process::Command::new(&cmd)
                .args(["cron", "list", "--json"])
                .envs(crate::kanban::build_clean_env(&cmd))
                .current_dir(hermes_data_dir())
                .output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    if o.status.success() {
                        match serde_json::from_str::<Value>(&stdout) {
                            Ok(v) => json!({ "success": true, "jobs": v }),
                            Err(_) => json!({ "success": true, "jobs": stdout }),
                        }
                    } else {
                        let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                        json!({ "success": false, "error": stderr })
                    }
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            }
        }
        None => json!({ "success": false, "error": "找不到 hermes 可执行文件" }),
    }
}

#[tauri::command]
pub fn hermes_cron_create(schedule: String, command: String, name: Option<String>) -> Value {
    match resolve_hermes_cmd() {
        Some(cmd) => {
            let mut args = vec!["cron".to_string(), "create".to_string(), schedule, command];
            if let Some(n) = name {
                args.push("--name".to_string());
                args.push(n);
            }
            let out = std::process::Command::new(&cmd)
                .args(&args)
                .envs(crate::kanban::build_clean_env(&cmd))
                .current_dir(hermes_data_dir())
                .output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    if o.status.success() {
                        json!({ "success": true, "output": stdout })
                    } else {
                        json!({ "success": false, "error": stderr })
                    }
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            }
        }
        None => json!({ "success": false, "error": "找不到 hermes 可执行文件" }),
    }
}

#[tauri::command]
pub fn hermes_cron_delete(job_id: String) -> Value {
    match resolve_hermes_cmd() {
        Some(cmd) => {
            let out = std::process::Command::new(&cmd)
                .args(["cron", "delete", &job_id])
                .envs(crate::kanban::build_clean_env(&cmd))
                .current_dir(hermes_data_dir())
                .output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    if o.status.success() {
                        json!({ "success": true, "output": stdout })
                    } else {
                        json!({ "success": false, "error": stderr })
                    }
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            }
        }
        None => json!({ "success": false, "error": "找不到 hermes 可执行文件" }),
    }
}

#[tauri::command]
pub fn hermes_cron_run(job_id: String) -> Value {
    match resolve_hermes_cmd() {
        Some(cmd) => {
            let out = std::process::Command::new(&cmd)
                .args(["cron", "run", &job_id])
                .envs(crate::kanban::build_clean_env(&cmd))
                .current_dir(hermes_data_dir())
                .output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    if o.status.success() {
                        json!({ "success": true, "output": stdout })
                    } else {
                        json!({ "success": false, "error": stderr })
                    }
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            }
        }
        None => json!({ "success": false, "error": "找不到 hermes 可执行文件" }),
    }
}

#[tauri::command]
pub fn hermes_doctor() -> Value {
    match resolve_hermes_cmd() {
        Some(cmd) => {
            let out = std::process::Command::new(&cmd)
                .args(["doctor"])
                .envs(crate::kanban::build_clean_env(&cmd))
                .current_dir(hermes_data_dir())
                .output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    json!({
                        "success": o.status.success(),
                        "output": stdout,
                        "error": if stderr.is_empty() { None } else { Some(stderr) },
                    })
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            }
        }
        None => json!({ "success": false, "error": "找不到 hermes 可执行文件" }),
    }
}

// ── hermes_transcribe ─────────────────────────────────────────────────────

/// Resolve (canonicalize) a path, following symlinks.
fn resolve_symlink(p: &std::path::Path) -> std::path::PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Resolve a Python interpreter from the same venv that hermes uses.
fn resolve_hermes_python(hermes_bin: &std::path::Path) -> Option<PathBuf> {
    // Canonicalize to follow symlinks (hermes may be a symlink on PATH).
    let resolved = resolve_symlink(hermes_bin);
    let venv_bin = resolved.parent()?;
    let python = if cfg!(windows) {
        venv_bin.join("python.exe")
    } else {
        let py3 = venv_bin.join("python3");
        if py3.exists() {
            py3
        } else {
            venv_bin.join("python")
        }
    };
    if python.exists() {
        return Some(python);
    }
    // Last resort: try to locate python3 on PATH.
    let sys_python = if cfg!(windows) { "python.exe" } else { "python3" };
    match std::process::Command::new(sys_python).arg("--version").output() {
        Ok(o) if o.status.success() => Some(std::path::PathBuf::from(sys_python)),
        _ => None,
    }
}

/// Resolve the Hermes-agent repository root from the hermes binary path.
/// hermes lives at ``<repo>/.venv/bin/hermes`` (or ``<repo>/venv/bin/hermes``),
/// so the repo root is three directories up from the binary.
fn resolve_hermes_agent_root(hermes_bin: &std::path::Path) -> Option<PathBuf> {
    // Canonicalize to follow symlinks.
    let resolved = resolve_symlink(hermes_bin);
    let root = resolved.parent()?.parent()?.parent()?.to_path_buf();
    if root.join("tools").is_dir() {
        return Some(root);
    }
    // Maybe the binary is not inside a venv — try the managed agent location
    // that the app installer provisions.
    let managed = hermes_data_dir().join("hermes-agent");
    if managed.join("tools").is_dir() {
        return Some(managed);
    }
    None
}

/// Run the Helix STT bridge with inline Python (-c) when the standalone
/// script file is not available.
fn run_stt_inline(
    python: &std::path::Path,
    agent_root: &std::path::Path,
    audio_path: &std::path::Path,
    hermes_bin: &std::path::Path,
) -> Result<Value, String> {
    let python_code = "import sys,json,os\n\
sys.path.insert(0, os.environ['_HELIX_AGENT_ROOT'])\n\
from tools.transcription_tools import transcribe_audio\n\
r=transcribe_audio(os.environ['_HELIX_AUDIO_FILE'])\n\
json.dump(r,sys.stdout)\n\
sys.stdout.flush()";

    let mut cmd = std::process::Command::new(python);
    cmd.arg("-c")
        .arg(python_code)
        .envs(crate::kanban::build_clean_env(hermes_bin))
        .env("HERMES_HOME", hermes_data_dir().display().to_string())
        .env("_HELIX_AGENT_ROOT", agent_root.display().to_string())
        .env("_HELIX_AUDIO_FILE", audio_path.display().to_string());

    match run_cmd_with_timeout(cmd, Duration::from_secs(120)) {
        Ok((0, stdout, _stderr)) => {
            match serde_json::from_str::<Value>(&stdout) {
                Ok(v) => Ok(v),
                Err(e) => {
                    let trimmed = stdout.trim().to_string();
                    if trimmed.is_empty() {
                        Err(format!("STT 返回空结果（解析错误: {e}）"))
                    } else {
                        Ok(json!({"success": true, "transcript": trimmed, "provider": "unknown"}))
                    }
                }
            }
        }
        Ok((code, _stdout, stderr)) => {
            Err(if stderr.trim().is_empty() {
                format!("STT 进程退出码 {code}")
            } else {
                stderr.trim().to_string()
            })
        }
        Err(e) => Err(e),
    }
}

/// Transcribe an audio file using Hermes STT backends.
///
/// Receives base64-encoded audio bytes, writes them to a temp file, runs the
/// Hermes Python transcription pipeline, and returns the recognised text.
///
/// This is the backend half of the MediaRecorder voice-input path, used on
/// platforms where ``SpeechRecognition`` (Web Speech API) is unavailable
/// (e.g. WebKitGTK on Linux).
#[tauri::command]
pub async fn hermes_transcribe(audio_b64: String, format: String) -> Value {
    // 1. Decode base64 audio.
    let audio_bytes = match base64::engine::general_purpose::STANDARD.decode(&audio_b64) {
        Ok(b) => b,
        Err(e) => return json!({"success": false, "transcript": "", "error": format!("Base64 解码失败: {e}")}),
    };

    if audio_bytes.is_empty() {
        return json!({"success": false, "transcript": "", "error": "音频数据为空"});
    }

    // 2. Write to temp file.
    let ext = if format == "webm" || format.is_empty() { "webm" } else { &format };
    let temp_dir = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let temp_path = temp_dir.join(format!("helix_stt_{ts}.{ext}"));
    if let Err(e) = std::fs::write(&temp_path, &audio_bytes) {
        return json!({"success": false, "transcript": "", "error": format!("写入临时文件失败: {e}")});
    }

    // 3. Resolve Python + hermes paths.
    let hermes_bin = match resolve_hermes_cmd() {
        Some(b) => b,
        None => {
            let _ = std::fs::remove_file(&temp_path);
            return json!({"success": false, "transcript": "", "error": "找不到 hermes 可执行文件"});
        }
    };

    let python = match resolve_hermes_python(&hermes_bin) {
        Some(p) => p,
        None => {
            let _ = std::fs::remove_file(&temp_path);
            return json!({"success": false, "transcript": "", "error": "找不到 Python 解释器"});
        }
    };

    // 4. Run transcription (heavy — run on blocking thread pool).
    let tp = temp_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        if let Some(agent_root) = resolve_hermes_agent_root(&hermes_bin) {
            let script_path = agent_root.join("scripts").join("_helix_stt.py");
            if script_path.is_file() {
                let mut cmd = std::process::Command::new(&python);
                cmd.arg(&script_path)
                    .arg("--file")
                    .arg(tp.display().to_string())
                    .envs(crate::kanban::build_clean_env(&hermes_bin))
                    .env("HERMES_HOME", hermes_data_dir().display().to_string());

                match run_cmd_with_timeout(cmd, Duration::from_secs(120)) {
                    Ok((0, stdout, _stderr)) => {
                        match serde_json::from_str::<Value>(&stdout) {
                            Ok(v) => v,
                            Err(_) => {
                                let trimmed = stdout.trim().to_string();
                                if trimmed.is_empty() {
                                    json!({"success": false, "transcript": "", "error": "STT 返回空结果"})
                                } else {
                                    json!({"success": true, "transcript": trimmed, "provider": "unknown"})
                                }
                            }
                        }
                    }
                    Ok((code, _stdout, stderr)) => {
                        json!({"success": false, "transcript": "", "error": if stderr.trim().is_empty() { format!("STT 退出码 {code}") } else { stderr.trim().to_string() }})
                    }
                    Err(e) => {
                        json!({"success": false, "transcript": "", "error": e})
                    }
                }
            } else {
                match run_stt_inline(&python, &agent_root, &tp, &hermes_bin) {
                    Ok(v) => v,
                    Err(e) => json!({"success": false, "transcript": "", "error": e}),
                }
            }
        } else {
            match run_stt_inline(&python, &hermes_data_dir(), &tp, &hermes_bin) {
                Ok(v) => v,
                Err(e) => json!({"success": false, "transcript": "", "error": e}),
            }
        }
    }).await.unwrap_or_else(|e| json!({"success": false, "transcript": "", "error": format!("任务异常: {e}")}));

    // 5. Cleanup temp file.
    let _ = std::fs::remove_file(&temp_path);

    result
}

// ── Native audio recording (arecord) — Linux WebKitGTK fallback ──────────

/// Start native audio recording via `arecord`.
///
/// Spawns ``arecord -f cd -t wav <temp_file>`` in the background and returns
/// a ``record_id``.  The caller should call ``hermes_record_stop`` to end the
/// recording and get the transcript.
///
/// This is the primary voice-input path on Linux because WebKitGTK does not
/// support ``getUserMedia`` audio capture reliably.
#[tauri::command]
pub fn hermes_record_start(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let mut child_guard = state.hermes.record_child.lock().unwrap();
    let mut file_guard = state.hermes.record_file.lock().unwrap();

    // If a recording is already in progress, stop it first.
    if let Some(mut c) = child_guard.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if let Some(ref p) = *file_guard {
        let _ = std::fs::remove_file(p);
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let temp_path = std::env::temp_dir().join(format!("helix_rec_{ts}.wav"));
    let record_id = format!("rec_{ts}");

    // Prefer arecord (ALSA, works with both ALSA and PulseAudio/PipeWire);
    // fall back to ffmpeg (pulse input).
    let child = if which_cmd("arecord").is_some() {
        std::process::Command::new("arecord")
            .args(["-f", "cd", "-t", "wav"])
            .arg(temp_path.display().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
    } else if which_cmd("ffmpeg").is_some() {
        std::process::Command::new("ffmpeg")
            .args(["-y", "-f", "pulse", "-i", "default"])
            .args(["-ac", "2", "-ar", "44100"])
            .arg(temp_path.display().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
    } else {
        return Err("未找到可用的录音工具（arecord / ffmpeg）".to_string());
    };

    match child {
        Ok(c) => {
            *child_guard = Some(c);
            *file_guard = Some(temp_path);
            Ok(record_id)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(format!("启动录音失败: {e}"))
        }
    }
}

/// Check if a command exists on PATH.
fn which_cmd(name: &str) -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("which")
        .arg(name)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(std::path::PathBuf::from(s));
        }
    }
    // Fallback: try running the command directly.
    let path = std::path::PathBuf::from(name);
    match std::process::Command::new(name).arg("--version").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status() {
        Ok(s) if s.success() => Some(path),
        _ => None,
    }
}

/// Stop the active audio recording, transcribe the captured audio, and return
/// the transcript.
#[tauri::command]
pub async fn hermes_record_stop(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    // Extract values and drop guards before any await point.
    let (child, file_path) = {
        let mut child_guard = state.hermes.record_child.lock().unwrap();
        let mut file_guard = state.hermes.record_file.lock().unwrap();
        (child_guard.take(), file_guard.take())
    };

    // Kill the recording process (fast — inline).
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }

    let Some(audio_path) = file_path else {
        return Ok(json!({"success": false, "transcript": "", "error": "没有正在进行的录音"}));
    };

    if !audio_path.exists() || audio_path.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&audio_path);
        return Ok(json!({"success": false, "transcript": "", "error": "录音文件为空"}));
    }

    // Resolve Python and transcribe (fast path resolution, heavy transcription).
    let hermes_bin = match resolve_hermes_cmd() {
        Some(b) => b,
        None => {
            let _ = std::fs::remove_file(&audio_path);
            return Ok(json!({"success": false, "transcript": "", "error": "找不到 hermes 可执行文件"}));
        }
    };

    let python = match resolve_hermes_python(&hermes_bin) {
        Some(p) => p,
        None => {
            let _ = std::fs::remove_file(&audio_path);
            return Ok(json!({"success": false, "transcript": "", "error": "找不到 Python 解释器"}));
        }
    };

    // Offload the slow transcription subprocess to a blocking thread.
    let ap = audio_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        if let Some(agent_root) = resolve_hermes_agent_root(&hermes_bin) {
            let script_path = agent_root.join("scripts").join("_helix_stt.py");
            if script_path.is_file() {
                let mut cmd = std::process::Command::new(&python);
                cmd.arg(&script_path)
                    .arg("--file")
                    .arg(ap.display().to_string())
                    .envs(crate::kanban::build_clean_env(&hermes_bin))
                    .env("HERMES_HOME", hermes_data_dir().display().to_string());

                match run_cmd_with_timeout(cmd, Duration::from_secs(120)) {
                    Ok((0, stdout, _stderr)) => {
                        match serde_json::from_str::<Value>(&stdout) {
                            Ok(v) => v,
                            Err(_) => {
                                let trimmed = stdout.trim().to_string();
                                if trimmed.is_empty() {
                                    json!({"success": false, "transcript": "", "error": "STT 返回空结果"})
                                } else {
                                    json!({"success": true, "transcript": trimmed, "provider": "unknown"})
                                }
                            }
                        }
                    }
                    Ok((code, _stdout, stderr)) => {
                        json!({"success": false, "transcript": "", "error": if stderr.trim().is_empty() { format!("STT 退出码 {code}") } else { stderr.trim().to_string() }})
                    }
                    Err(e) => {
                        json!({"success": false, "transcript": "", "error": e})
                    }
                }
            } else {
                match run_stt_inline(&python, &agent_root, &ap, &hermes_bin) {
                    Ok(v) => v,
                    Err(e) => json!({"success": false, "transcript": "", "error": e}),
                }
            }
        } else {
            match run_stt_inline(&python, &hermes_data_dir(), &ap, &hermes_bin) {
                Ok(v) => v,
                Err(e) => json!({"success": false, "transcript": "", "error": e}),
            }
        }
    }).await.unwrap_or_else(|e| json!({"success": false, "transcript": "", "error": format!("任务异常: {e}")}));

    // Cleanup.
    let _ = std::fs::remove_file(&audio_path);
    Ok(result)
}

// ── TTS (Text-to-Speech) ──────────────────────────────────────────────────

/// Synthesize text to speech via the Hermes TTS pipeline (edge_tts by default)
/// and play the resulting audio through the system audio player.
#[tauri::command]
pub async fn hermes_tts_speak(
    state: State<'_, Arc<AppState>>,
    text: String,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(json!({"success": true, "played": false}));
    }

    let hermes_bin = match resolve_hermes_cmd() {
        Some(b) => b,
        None => return Err("找不到 hermes 可执行文件".to_string()),
    };
    let python = match resolve_hermes_python(&hermes_bin) {
        Some(p) => p,
        None => return Err("找不到 Python 解释器".to_string()),
    };
    let agent_root = match resolve_hermes_agent_root(&hermes_bin) {
        Some(r) => r,
        None => return Err("找不到 hermes-agent 根目录".to_string()),
    };

    let temp_dir = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string());
    let output_path = temp_dir.join(format!("helix_tts_{}.mp3", ts));

    // Synthesize via Hermes TTS pipeline (edge_tts is default, free, no API key).
    let python_code = "import sys,json,os\n\
sys.path.insert(0, os.environ['_HELIX_AGENT_ROOT'])\n\
from tools.tts_tool import text_to_speech_tool\n\
r=text_to_speech_tool(text=os.environ['_HELIX_TTS_TEXT'],output_path=os.environ['_HELIX_TTS_OUTPUT'])\n\
json.dump(r,sys.stdout)\n\
sys.stdout.flush()";

    let mut cmd = std::process::Command::new(&python);
    cmd.arg("-c")
        .arg(python_code)
        .envs(crate::kanban::build_clean_env(&hermes_bin))
        .env("HERMES_HOME", hermes_data_dir().display().to_string())
        .env("_HELIX_AGENT_ROOT", agent_root.display().to_string())
        .env("_HELIX_TTS_TEXT", &text)
        .env("_HELIX_TTS_OUTPUT", output_path.display().to_string());

    let synthesis_result = tokio::task::spawn_blocking(move || {
        match run_cmd_with_timeout(cmd, Duration::from_secs(60)) {
            Ok((0, stdout, _stderr)) => {
                match serde_json::from_str::<Value>(&stdout) {
                    Ok(v) => {
                        let success = v.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
                        if success {
                            Ok(v)
                        } else {
                            let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("TTS 合成失败");
                            Err(format!("TTS 合成失败: {}", err))
                        }
                    }
                    Err(e) => {
                        let trimmed = stdout.trim().to_string();
                        if trimmed.is_empty() {
                            Err(format!("TTS 返回空结果（解析错误: {e}）"))
                        } else {
                            Err(format!("TTS 解析错误: {e}"))
                        }
                    }
                }
            }
            Ok((code, _stdout, stderr)) => {
                Err(if stderr.trim().is_empty() {
                    format!("TTS 退出码 {}", code)
                } else {
                    stderr.trim().to_string()
                })
            }
            Err(e) => Err(e),
        }
    }).await.unwrap_or_else(|e| Err(format!("TTS 任务异常: {e}")));

    match synthesis_result {
        Ok(_) => {
            // Play the synthesized audio file.
            let op = output_path.clone();
            let player = if let Some(p) = which_cmd("paplay") {
                Some(std::process::Command::new(p)
                    .arg(&op)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn())
            } else if let Some(p) = which_cmd("ffplay") {
                Some(std::process::Command::new(p)
                    .args(["-nodisp", "-autoexit", "-loglevel", "quiet"])
                    .arg(&op)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn())
            } else if let Some(p) = which_cmd("aplay") {
                Some(std::process::Command::new(p)
                    .arg("-q")
                    .arg(&op)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn())
            } else {
                None
            };

            match player {
                Some(Ok(child)) => {
                    *state.hermes.tts_playback_child.lock().unwrap() = Some(child);
                    Ok(json!({"success": true, "played": true, "file_path": op.display().to_string()}))
                }
                Some(Err(e)) => {
                    let _ = std::fs::remove_file(&op);
                    Err(format!("无法播放音频: {}", e))
                }
                None => {
                    let _ = std::fs::remove_file(&op);
                    Err("未找到可用的音频播放器（paplay / ffplay / aplay）".to_string())
                }
            }
        }
        Err(e) => {
            // Cleanup temp file on synthesis failure.
            let _ = std::fs::remove_file(&output_path);
            Err(e)
        }
    }
}

/// Stop any in-progress TTS playback.
#[tauri::command]
pub fn hermes_tts_stop(state: State<'_, Arc<AppState>>) -> Value {
    let mut guard = state.hermes.tts_playback_child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    json!({"ok": true})
}


/// Streaming TTS: synthesize and play audio chunk-by-chunk.
///
/// Spawns the Python streaming TTS script, reads audio chunks from its stdout,
/// and pipes them to aplay/paplay via a named pipe (FIFO). This allows audio
/// to start playing before the full synthesis is complete.
#[tauri::command]
pub async fn hermes_tts_speak_stream(
    state: State<'_, Arc<AppState>>,
    text: String,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(json!({"success": true, "played": false}));
    }

    // Stop any existing playback first.
    {
        let mut guard = state.hermes.tts_playback_child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    let hermes_bin = match resolve_hermes_cmd() {
        Some(b) => b,
        None => return Err("找不到 hermes 可执行文件".to_string()),
    };
    let python = match resolve_hermes_python(&hermes_bin) {
        Some(p) => p,
        None => return Err("找不到 Python 解释器".to_string()),
    };
    let agent_root = match resolve_hermes_agent_root(&hermes_bin) {
        Some(r) => r,
        None => return Err("找不到 hermes-agent 根目录".to_string()),
    };

    let stream_script = agent_root.join("scripts").join("_helix_tts_stream.py");
    if !stream_script.exists() {
        return Err(format!("流式 TTS 脚本不存在: {}", stream_script.display()));
    }

    // Create a named pipe for streaming audio.
    let pipe_name = format!(
        "/tmp/helix_tts_stream_{}.fifo",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    // Create the FIFO (Unix) or empty file (Windows).
    #[cfg(unix)]
    unsafe {
        let c_path = std::ffi::CString::new(pipe_name.clone()).unwrap();
        if libc::mkfifo(c_path.as_ptr(), 0o644) != 0 {
            return Err(format!("创建命名管道失败: {}", pipe_name));
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::File::create(&pipe_name)
            .map_err(|e| format!("创建临时音频文件失败: {}", e))?;
    }

    let pipe_path = pipe_name.clone();
    let text_clone = text.clone();
    let script_clone = stream_script.clone();
    let agent_root_clone = agent_root.clone();
    let hermes_bin_clone = hermes_bin.clone();

    // Spawn the Python streaming script.
    let mut child = Command::new(&python)
        .arg(script_clone)
        .arg("stream")
        .arg(&text_clone)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("HERMES_HOME", hermes_data_dir().display().to_string())
        .env("_HELIX_AGENT_ROOT", agent_root_clone.display().to_string())
        .envs(crate::kanban::build_clean_env(&hermes_bin_clone))
        .spawn()
        .map_err(|e| format!("启动流式 TTS 脚本失败: {}", e))?;

    let stdout = child.stdout.take().ok_or("无法获取 TTS 脚本 stdout")?;

    // Spawn aplay to read from the FIFO in a separate thread (Unix only).
    #[cfg(unix)]
    let aplay_handle = {
        let fifo_for_aplay = pipe_path.clone();
        std::thread::spawn(move || {
        // Wait for the FIFO to be ready.
        std::thread::sleep(Duration::from_millis(50));

        let player = if let Some(p) = which_cmd("aplay") {
            Command::new(p)
                .args(["-q", "-t", "raw", "-f", "S16_LE", "-r", "24000", "-c", "1"])
                .arg(&fifo_for_aplay)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .spawn()
                .ok()
        } else if let Some(p) = which_cmd("paplay") {
            Command::new(p)
                .arg("--rate=24000")
                .arg("--channels=1")
                .arg("--format=s16le")
                .arg(&fifo_for_aplay)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .spawn()
                .ok()
        } else {
            None
        };

        if let Some(mut player) = player {
            let _ = player.wait();
        }

            // Cleanup FIFO.
            let _ = std::fs::remove_file(&fifo_for_aplay);
        })
    };
    #[cfg(not(unix))]
    let aplay_handle = std::thread::spawn(|| {});

    // Read audio chunks from Python stdout and write to the FIFO.
    let mut reader = BufReader::new(stdout);
    let mut fifo_file = std::fs::File::create(&pipe_path)
        .map_err(|e| format!("无法打开命名管道: {}", e))?;

    // Read loop: parse length-prefixed chunks.
    loop {
        // Read 8-byte length header.
        let mut len_buf = [0u8; 8];
        match reader.read_exact(&mut len_buf) {
            Ok(_) => {}
            Err(e) => {
                if e.kind() == std::io::ErrorKind::UnexpectedEof {
                    break;
                }
                return Err(format!("读取 TTS 数据头失败: {}", e));
            }
        }

        let chunk_len = u64::from_le_bytes(len_buf) as usize;

        // Zero length = end of stream.
        if chunk_len == 0 {
            break;
        }

        // Read the audio chunk.
        let mut chunk = vec![0u8; chunk_len];
        if let Err(e) = reader.read_exact(&mut chunk) {
            return Err(format!("读取 TTS 音频数据失败: {}", e));
        }

        // Write to FIFO.
        if let Err(e) = fifo_file.write_all(&chunk) {
            return Err(format!("写入音频管道失败: {}", e));
        }
        let _ = fifo_file.flush();
    }

    // Close FIFO file to signal EOF to aplay.
    drop(fifo_file);

    // Store the child process handle for potential cancellation.
    *state.hermes.tts_playback_child.lock().unwrap() = Some(child);

    // Wait briefly for aplay to finish, then cleanup.
    let _ = aplay_handle.join();

    Ok(json!({"success": true, "played": true, "streaming": true}))
}


// ── Wake-word detection ──────────────────────────────────────────────────

/// Spawn the Python wake-word bridge (`_helix_wake.py`) as a long-running
/// subprocess. Stdout lines are parsed as JSON events and forwarded to the
/// renderer as `hermes:event` with method derived from the event type.
#[tauri::command]
pub async fn hermes_wake_start(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    {
        let guard = state.hermes.wake_child.lock().unwrap();
        if guard.is_some() {
            return Ok(json!({"success": true, "already_running": true}));
        }
    }

    let hermes_bin = match resolve_hermes_cmd() {
        Some(b) => b,
        None => return Err("找不到 hermes 可执行文件".to_string()),
    };
    let python = match resolve_hermes_python(&hermes_bin) {
        Some(p) => p,
        None => return Err("找不到 Python 解释器".to_string()),
    };
    let agent_root = match resolve_hermes_agent_root(&hermes_bin) {
        Some(r) => r,
        None => return Err("找不到 hermes-agent 根目录".to_string()),
    };

    let script = agent_root.join("scripts").join("_helix_wake.py");
    if !script.exists() {
        return Err(format!("唤醒词脚本不存在: {}", script.display()));
    }

    // Build LD_LIBRARY_PATH with ~/.local/lib prepended, so PortAudio is found.
    let local_lib = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/home/hyt"))
        .join(".local")
        .join("lib");
    let mut ld_paths: Vec<String> = vec![local_lib.display().to_string()];
    if let Ok(existing) = std::env::var("LD_LIBRARY_PATH") {
        for p in existing.split(':') {
            let p = p.trim().to_string();
            if !p.is_empty() && !ld_paths.contains(&p) {
                ld_paths.push(p);
            }
        }
    }
    let ld_library_path = ld_paths.join(":");

    // Ensure PulseAudio / PipeWire can find the runtime socket when the app
    // is launched from a .desktop file (which inherits a minimal env).
    let runtime_dir = dirs::runtime_dir()
        .or_else(|| std::env::var("XDG_RUNTIME_DIR").ok().map(std::path::PathBuf::from))
        .unwrap_or_else(|| {
            #[cfg(unix)]
            let uid: u32 = unsafe { libc::getuid() };
            #[cfg(not(unix))]
            let uid: u32 = 0;
            std::path::PathBuf::from(format!("/run/user/{}", uid))
        });
    let pulse_socket = runtime_dir.join("pulse/native");

    let mut cmd = std::process::Command::new(&python);
    cmd.arg(&script)
        .envs(crate::kanban::build_clean_env(&hermes_bin))
        .env("HERMES_HOME", hermes_data_dir().display().to_string())
        .env("_HELIX_AGENT_ROOT", agent_root.display().to_string())
        .env("LD_LIBRARY_PATH", &ld_library_path)
        .env("XDG_RUNTIME_DIR", &runtime_dir)
        .env("PULSE_SERVER", format!("unix:{}", pulse_socket.display()))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动唤醒词进程失败: {e}"))?;

    // Take ownership of stdin and stdout.
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法获取唤醒词进程 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取唤醒词进程 stdout".to_string())?;
    let stderr = child.stderr.take();

    // Store the child + stdin handle.
    {
        let mut child_guard = state.hermes.wake_child.lock().unwrap();
        *child_guard = Some(child);
    }
    {
        let mut stdin_guard = state.hermes.wake_stdin.lock().unwrap();
        *stdin_guard = Some(stdin);
    }

    // Background task: read stdout lines and forward as Tauri events.
    let app_handle = app.clone();
    tokio::task::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let reader = tokio::io::BufReader::new(
            tokio::process::ChildStdout::from_std(stdout)
                .expect("failed to convert ChildStdout"),
        );
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let method = match serde_json::from_str::<Value>(&line) {
                Ok(v) => {
                    let ev = v
                        .get("event")
                        .and_then(|e| e.as_str())
                        .unwrap_or("unknown");
                    format!("wake_word_{}", ev)
                }
                Err(_) => "wake_word_raw".to_string(),
            };
            let _ = app_handle.emit(
                "hermes:event",
                serde_json::json!({
                    "method": method,
                    "params": serde_json::from_str::<Value>(&line).unwrap_or(Value::Null),
                }),
            );
        }
        // If we get here, the child's stdout closed — collect stderr for diagnostics.
        if let Some(stderr) = stderr {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(
                tokio::process::ChildStderr::from_std(stderr)
                    .expect("failed to convert ChildStderr"),
            );
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if !line.is_empty() {
                    eprintln!("[wake-word stderr] {}", line);
                }
            }
        }
    });

    Ok(json!({"success": true}))
}

/// Send a control command to the wake-word bridge and (optionally) stop it.
#[tauri::command]
pub async fn hermes_wake_control(
    state: State<'_, Arc<AppState>>,
    action: String,
) -> Result<Value, String> {
    use std::io::Write;

    let action = action.trim().to_lowercase();

    if action == "stop" {
        // Tell the bridge to stop gracefully.
        {
            let mut stdin_guard = state.hermes.wake_stdin.lock().unwrap();
            if let Some(ref mut stdin) = *stdin_guard {
                let _ = writeln!(stdin, "stop");
                let _ = stdin.flush();
            }
        }
        // Wait briefly for the child to exit, then kill if needed.
        let mut child_guard = state.hermes.wake_child.lock().unwrap();
        if let Some(mut child) = child_guard.take() {
            // Give it up to 3 seconds to exit gracefully.
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if start.elapsed() > std::time::Duration::from_secs(3) {
                            let _ = child.kill();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(_) => {
                        let _ = child.kill();
                        break;
                    }
                }
            }
        }
        // Clear stdin handle.
        let mut stdin_guard = state.hermes.wake_stdin.lock().unwrap();
        *stdin_guard = None;

        return Ok(json!({"ok": true, "action": "stop"}));
    }

    // pause / resume / status
    {
        let mut stdin_guard = state.hermes.wake_stdin.lock().unwrap();
        if let Some(ref mut stdin) = *stdin_guard {
            let _ = writeln!(stdin, "{}", action);
            let _ = stdin.flush();
            return Ok(json!({"ok": true, "action": action}));
        }
    }

    Err("唤醒词进程未运行".to_string())
}
