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
