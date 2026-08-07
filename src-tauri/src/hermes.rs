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
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

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
