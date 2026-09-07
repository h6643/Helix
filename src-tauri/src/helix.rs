//! `helix:*` Tauri commands — the renderer's bridge to the agent backend.
//!
//! The backend is the `codex app-server` stdio adapter (`codex_gateway.rs`).
//! This module is the command surface `tauri-bridge.ts` invokes: session RPCs
//! are forwarded to the adapter, config commands write config.yaml AND mirror
//! into the codex `config.toml` (which codex reads at startup — hence the
//! restart on config writes).

use crate::codex_gateway;
use crate::config::{
    read_helix_config, set_model as config_set_model, set_yaml_key, write_helix_config, HelixConfig,
};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

const RESTART_DELAY_MS: u64 = 100;

/// Debounced restart: codex snapshots its config at process start, so config
/// writes need a respawn to take effect. Rapid successive writes coalesce
/// into one restart.
fn restart_gateway_soon(state: &Arc<AppState>) {
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        static LAST_RESTART: std::sync::Mutex<u64> = std::sync::Mutex::new(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut last = LAST_RESTART.lock().unwrap();
        if now.saturating_sub(*last) < 500 && *last != 0 {
            return;
        }
        *last = now;
        drop(last);
        std::thread::sleep(std::time::Duration::from_millis(RESTART_DELAY_MS));
        let _ = crate::gateway::kill_current(&state);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = crate::gateway::spawn_gateway(&state);
    });
}

#[tauri::command]
pub async fn helix_send(method: String, params: Option<Value>) -> Result<Value, String> {
    codex_gateway::send(&method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
pub async fn helix_notify(method: String, params: Option<Value>) {
    // Fire-and-forget RPC: resolve and discard (session/cancel etc.).
    let _ = codex_gateway::send(&method, params.unwrap_or(Value::Null)).await;
}

#[tauri::command]
pub async fn helix_interrupt(session_id: String) -> Result<Value, String> {
    codex_gateway::send("session/cancel", json!({ "session_id": session_id })).await
}

#[tauri::command]
pub fn helix_status() -> Value {
    json!({ "connected": codex_gateway::is_active() })
}

#[tauri::command]
pub fn helix_get_gateway_info() -> Value {
    json!({ "mode": "codex", "connected": codex_gateway::is_active() })
}

#[tauri::command]
pub fn helix_get_config() -> HelixConfig {
    read_helix_config()
}

/// Apply a model/provider config from the Settings page. Writes config.yaml +
/// the codex config.toml mirror, then respawns codex so the new model takes
/// effect (codex snapshots its config at startup).
#[tauri::command]
pub fn helix_set_config(state: State<'_, Arc<AppState>>, config: Value) -> Value {
    let model = config.get("model").and_then(|v| v.as_str());
    let provider = config.get("provider").and_then(|v| v.as_str());
    // Accept both shapes — the renderer sends camelCase (baseUrl/apiKey).
    let base_url = config
        .get("baseUrl")
        .or_else(|| config.get("base_url"))
        .and_then(|v| v.as_str());
    let api_key = config
        .get("apiKey")
        .or_else(|| config.get("api_key"))
        .and_then(|v| v.as_str());

    write_helix_config(model, provider, base_url, api_key);
    let arc: Arc<AppState> = Arc::clone(&state);
    restart_gateway_soon(&arc);
    json!({ "success": true })
}

/// Set a single 2-level dotted key in config.yaml (agent toggles etc.).
#[tauri::command]
pub fn helix_set_yaml_key(state: State<'_, Arc<AppState>>, key: String, value: Value) -> Value {
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = set_yaml_key(&yaml, &key, &value);
    if updated == yaml {
        return json!({ "success": true, "changed": false });
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, updated);
    let arc: Arc<AppState> = Arc::clone(&state);
    restart_gateway_soon(&arc);
    json!({ "success": true, "changed": true })
}

/// Persist subagent delegation identities (agents settings page).
#[tauri::command]
pub fn helix_set_delegation_identities(
    state: State<'_, Arc<AppState>>,
    identities: Value,
) -> Value {
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = crate::config::set_delegation_identities(&yaml, &identities);
    if updated == yaml {
        return json!({ "success": true, "changed": false });
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, updated);
    let arc: Arc<AppState> = Arc::clone(&state);
    restart_gateway_soon(&arc);
    json!({ "success": true, "changed": true })
}

/// Switch the active model (chat input selector path).
#[tauri::command]
pub fn helix_set_model(state: State<'_, Arc<AppState>>, params: Option<Value>) -> Value {
    let params = params.unwrap_or_default();
    let Some(model) = params.get("model").and_then(|v| v.as_str()).map(str::trim) else {
        return json!({ "success": true, "applied": false, "reason": "no model" });
    };
    if model.is_empty() {
        return json!({ "success": true, "applied": false, "reason": "no model" });
    }
    let base_url = params
        .get("baseUrl")
        .or_else(|| params.get("base_url"))
        .and_then(|v| v.as_str());
    let api_key = params
        .get("apiKey")
        .or_else(|| params.get("api_key"))
        .and_then(|v| v.as_str());
    let provider = params.get("provider").and_then(|v| v.as_str());

    let (changed, key_changed) = config_set_model(model, base_url, api_key, provider);
    let arc: Arc<AppState> = Arc::clone(&state);
    if changed || key_changed {
        restart_gateway_soon(&arc);
    }
    json!({ "success": true, "applied": true })
}

/// Live config push from the renderer (personality / reasoning effort / fast
/// mode etc.): writes the dotted key into config.yaml. Takes effect for new
/// codex turns; no restart needed for these display/agent keys.
#[tauri::command]
pub fn helix_set_config_key_value(params: Option<Value>) -> Value {
    let params = params.unwrap_or_default();
    let Some(key) = params.get("key").and_then(|v| v.as_str()) else {
        return json!({ "success": false, "error": "missing key" });
    };
    let value = params.get("value").cloned().unwrap_or(Value::Null);
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = set_yaml_key(&yaml, key, &value);
    if updated != yaml {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, updated);
    }
    json!({ "success": true })
}

/// Persist agent config (reasoning effort / personality) to config.yaml.
#[tauri::command]
pub fn helix_set_agent_config(state: State<'_, Arc<AppState>>, params: Option<Value>) -> Value {
    let params = params.unwrap_or_default();
    let yaml_path = crate::config::config_yaml_path();
    let mut yaml = std::fs::read_to_string(&yaml_path).unwrap_or_default();
    let mut changed = false;
    if let Some(re) = params.get("reasoningEffort").and_then(|v| v.as_str()) {
        yaml = set_yaml_key(&yaml, "agent.reasoning_effort", &json!(re));
        changed = true;
    }
    if let Some(p) = params.get("personality").and_then(|v| v.as_str()) {
        yaml = set_yaml_key(&yaml, "display.personality", &json!(p));
        changed = true;
    }
    if changed {
        if let Some(dir) = yaml_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&yaml_path, yaml);
        let arc: Arc<AppState> = Arc::clone(&state);
        restart_gateway_soon(&arc);
    }
    json!({ "success": true })
}

#[tauri::command]
pub fn helix_set_reasoning_effort(params: Option<Value>) -> Value {
    let params = params.unwrap_or_default();
    let Some(re) = params.get("reasoningEffort").and_then(|v| v.as_str()) else {
        return json!({ "success": false });
    };
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = set_yaml_key(&yaml, "agent.reasoning_effort", &json!(re));
    if updated != yaml {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, updated);
    }
    json!({ "success": true })
}

/// Approve/deny a pending tool call. Codex approvals flow through
/// `codex/approval/respond` via helix_send; the legacy shape is translated
/// here for older renderer call sites.
#[tauri::command]
pub async fn helix_approval_respond(params: Option<Value>) -> Result<Value, String> {
    let params = params.unwrap_or_default();
    let request_id = params
        .get("request_id")
        .or_else(|| params.get("tool_call_id"))
        .or_else(|| params.get("toolCallId"))
        .and_then(|v| v.as_str())
        .ok_or("approval response is missing request id")?;
    let choice = params
        .get("choice")
        .and_then(|v| v.as_str())
        .unwrap_or("approve");
    codex_gateway::send(
        "codex/approval/respond",
        json!({ "request_id": request_id, "choice": choice }),
    )
    .await
}

/// Fetch the model list from an OpenAI-compatible endpoint (GET /models).
#[tauri::command]
pub async fn helix_fetch_models(base_url: String, api_key: String) -> Value {
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return json!({ "models": [] }),
    };
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let resp = client.get(&url).bearer_auth(api_key).send().await;
    match resp {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(data) => {
                let arr = data
                    .get("data")
                    .or_else(|| data.get("models"))
                    .cloned()
                    .unwrap_or(Value::Array(vec![]));
                let models: Vec<String> = arr
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| {
                                m.get("id")
                                    .or_else(|| m.get("name"))
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                                    .or_else(|| m.as_str().map(str::to_string))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                json!({ "models": models })
            }
            Err(e) => json!({ "models": [], "error": e.to_string() }),
        },
        Ok(r) => json!({ "models": [], "error": format!("HTTP {}", r.status()) }),
        Err(e) => json!({ "models": [], "error": e.to_string() }),
    }
}

// ── memories (MEMORY.md / USER.md) ─────────────────

#[tauri::command]
pub fn helix_list_memories() -> Value {
    let dir = crate::memory::helix_memories_dir();
    json!({
        "memory": crate::memory::read_mem_file(&dir.join("MEMORY.md")),
        "user": crate::memory::read_mem_file(&dir.join("USER.md")),
        "manual": crate::memory::read_manual_markers(&dir),
    })
}

#[tauri::command]
pub fn helix_add_memory_entry(target: String, text: String) -> Value {
    let dir = crate::memory::helix_memories_dir();
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
    if !entries.contains(&t) {
        entries.push(t.clone());
        crate::memory::write_mem_file(&file, &entries);
    }
    if target != "user" {
        crate::memory::add_manual_marker(&dir, &t);
    }
    json!({ "ok": true, "entries": entries })
}

#[tauri::command]
pub fn helix_remove_memory_entry(target: String, text: String) -> Value {
    let dir = crate::memory::helix_memories_dir();
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

// ── Personality Management ──────────────────────

#[tauri::command]
pub fn helix_list_personalities() -> Result<Vec<serde_json::Value>, String> {
    // Return default personalities; actual storage could be extended
    Ok(vec![
        json!({ "name": "default", "label": "默认", "system_prompt": "" }),
        json!({
            "name": "code",
            "label": "代码专家",
            "system_prompt": "你是一位专业的代码助手...",
        }),
        json!({
            "name": "explain",
            "label": "解释模式",
            "system_prompt": "请详细解释代码和概念...",
        }),
    ])
}

#[tauri::command]
pub fn helix_set_personality(name: String) -> Result<(), String> {
    // Store selected personality (can be extended to persist to config)
    eprintln!("[helix] set_personality: {}", name);
    Ok(())
}

// ── Plugin Installation ───────────────────────

#[tauri::command]
pub async fn helix_install_plugin(identifier: String) -> Result<Value, String> {
    // Use `helix plugins install` via shell
    let output = tokio::process::Command::new("helix")
        .args(&["plugins", "install", &identifier])
        .output()
        .await
        .map_err(|e| format!("Failed to spawn: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(json!({ "ok": true, "message": stdout }))
    } else {
        Ok(json!({ "ok": false, "error": stderr }))
    }
}

// ── Memory Status ─────────────────────────

#[tauri::command]
pub fn helix_get_memory_status() -> Value {
    let dir = crate::memory::helix_memories_dir();
    let memory_md = dir.join("MEMORY.md");
    let user_md = dir.join("USER.md");

    let memory_count = if memory_md.exists() {
        std::fs::read_to_string(&memory_md)
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0)
    } else {
        0
    };

    let user_count = if user_md.exists() {
        std::fs::read_to_string(&user_md)
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0)
    } else {
        0
    };

    json!({
        "enabled": memory_md.exists() || user_md.exists(),
        "memoryEntries": memory_count,
        "userEntries": user_count,
        "memoryPath": memory_md.display().to_string(),
        "userPath": user_md.display().to_string(),
    })
}

// ── Memory Provider Config ──────────────────────

#[tauri::command]
pub fn helix_get_memory_provider_config() -> Value {
    // Return default provider config
    json!({
        "provider": "local",
        "config": {}
    })
}

#[tauri::command]
pub fn helix_set_memory_provider_config(_config: Value) -> Result<(), String> {
    // Stub: memory provider configuration would go here
    Ok(())
}
