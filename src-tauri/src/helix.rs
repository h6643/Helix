//! `helix:*` Tauri commands — the renderer's bridge to the agent backend.
//!
//! The backend is the pi coding agent's RPC mode stdio adapter
//! (`pi_gateway.rs`, `pi --mode rpc`). This module is the command surface
//! `tauri-bridge.ts` invokes: session RPCs are forwarded to the adapter,
//! config commands write config.yaml (restarts respawn pi so the new model
//! takes effect).

use crate::config::{
    apply_pi_provider_models, atomic_write, read_helix_config, set_model as config_set_model,
    set_yaml_key, write_helix_config, HelixConfig,
};
use crate::gateway::restart_gateway_soon;
use crate::pi_gateway;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tauri::State;

/// Open a URL in the right-sidebar embedded browser. Emits a
/// `helix:open-browser` event that the renderer's global hook
/// (`window.__helixOpenBrowser`, registered in `helix-layout.tsx`) listens for
/// and forwards to `setPreviewRailUrl` + the browser tab.
#[tauri::command]
pub fn open_browser_url(url: String) -> Value {
    use crate::state::app_handle;
    let _ = app_handle().emit("helix:open-browser", json!({ "url": url }));
    json!({ "ok": true, "url": url })
}

/// Poll the pi extension's browser request queue
/// (`~/.pi/agent/browser-requests/*.json`), forward each NEW request's
/// full payload (op/url/reqId/params) as a `helix:browser-request` event, and
/// mark consumed files by renaming to `*.consumed` so the frontend's periodic
/// poll picks up each request exactly once. Result files (`*.result.json`)
/// are skipped — they belong to the extension's request-response protocol.
/// Requests older than `STALE_REQUEST_MS` are marked consumed WITHOUT emitting:
/// they belong to a run where the frontend wasn't polling (app closed/restarting),
/// and consuming one "late" would silently build a browser page from a stale URL.
const STALE_REQUEST_MS: u64 = 2 * 60 * 1000;

#[tauri::command]
pub fn poll_browser_requests() -> Value {
    use crate::state::app_handle;
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("browser-requests");
    let mut opened: Vec<String> = Vec::new();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            if !name.ends_with(".json")
                || name.starts_with("latest")
                || name.ends_with(".consumed")
                || name.ends_with(".result.json")
            {
                continue;
            }
            let path = dir.join(&name);
            // 未消费请求只在前端轮询时才有意义。过期的（前端当时不在线）
            // 直接标记消费并跳过——否则前端晚启动时会"迟到地"消费它，在用户
            // 下次打开侧边栏时凭空建出一个网页页签并导航到几分钟前的旧 URL。
            // 年龄优先取文件名前缀（扩展写入时的 Date.now()），退回文件 mtime。
            let ts_from_name = name
                .split('-')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let age_ms = if now_ms > 0 && ts_from_name > 0 {
                now_ms.saturating_sub(ts_from_name)
            } else {
                entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| now_ms.saturating_sub(d.as_millis() as u64))
                    .unwrap_or(0)
            };
            if age_ms > STALE_REQUEST_MS {
                let consumed = dir.join(format!("{}.consumed", name));
                let _ = std::fs::rename(&path, &consumed);
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            // url is optional: navigate ops always carry one, but read/click/
            // type/press target the currently-open browser page (url omitted).
            // The frontend resolves the active URL from its own store; when
            // there is no open page it writes a descriptive error result.
            let url = v.get("url").and_then(Value::as_str).unwrap_or("");
            let req_id = v
                .get("reqId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let op = v.get("op").and_then(Value::as_str).unwrap_or("navigate");
            let _ = app_handle().emit("helix:browser-request", &v);
            // navigate has no execution payload of its own: it just points the
            // real webview at `url`. Write an immediate result file so the pi
            // extension's poll loop doesn't burn its full timeout waiting on a
            // no-op; the frontend's navigate listener (helix:open-browser) is
            // the source of truth for the actual webview navigation.
            if op == "navigate" && !req_id.is_empty() {
                let _ = browser_write_result(
                    req_id.clone(),
                    json!({ "ok": true, "navigated": url }),
                );
                // Back-compat: emit the legacy event so the sidebar-open path
                // keeps working. `quiet: true` marks it as agent-triggered so
                // the frontend navigates in place instead of yanking the
                // sidebar open over whatever tab the user is reading.
                let _ = app_handle().emit(
                    "helix:open-browser",
                    json!({ "url": url, "quiet": true }),
                );
            }
            let consumed = dir.join(format!("{}.consumed", name));
            let _ = std::fs::rename(&path, &consumed);
            opened.push(url.to_string());
        }
    }
    json!({ "ok": true, "opened": opened })
}

/// Write a browser automation result (`<reqId>.result.json`) that the pi
/// extension's request-response tools poll for. `result` is stored verbatim.
#[tauri::command]
pub fn browser_write_result(req_id: String, result: Value) -> Value {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("browser-requests");
    let _ = std::fs::create_dir_all(&dir);
    // Sanitize the id: it names a file — strip separators so a crafted reqId
    // can't escape the request directory.
    let safe: String = req_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return json!({ "ok": false, "error": "invalid req id" });
    }
    let path = dir.join(format!("{safe}.result.json"));
    let payload = json!({ "reqId": safe, "result": result, "ts": std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0) });
    match std::fs::write(&path, serde_json::to_string(&payload).unwrap_or_default()) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() })
    }
}

#[tauri::command]
pub async fn helix_send(method: String, params: Option<Value>) -> Result<Value, String> {
    pi_gateway::send(&method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
pub async fn helix_notify(method: String, params: Option<Value>) {
    // Fire-and-forget RPC: resolve and discard (session/cancel etc.).
    let _ = pi_gateway::send(&method, params.unwrap_or(Value::Null)).await;
}

#[tauri::command]
pub async fn helix_interrupt(session_id: String) -> Result<Value, String> {
    pi_gateway::send("session/cancel", json!({ "session_id": session_id })).await
}

#[tauri::command]
pub fn helix_status() -> Value {
    json!({ "connected": pi_gateway::is_active() })
}

#[tauri::command]
pub fn helix_get_gateway_info() -> Value {
    json!({ "mode": "pi", "connected": pi_gateway::is_active() })
}

#[tauri::command]
pub fn helix_get_config() -> HelixConfig {
    read_helix_config()
}

/// Apply a model/provider config from the Settings page. Writes Pi's own
/// config (settings.json + models.json), then respawns pi so the new model
/// takes effect (pi snapshots its settings at startup).
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
    let context_window = config
        .get("contextWindow")
        .or_else(|| config.get("context_window"))
        .and_then(|v| v.as_u64());

    // Startup race: the renderer re-asserts its restored model config on every
    // launch (helix-layout startupSync → pushModelConfig → setConfig). An
    // UNCONDITIONAL restart here kills the main pi instance + warm spare while
    // their get_state handshake is still in flight ("process exited (no
    // response channel)" + "warm spare spawn failed" on every boot). Respawn
    // only when the written config actually differs from pi's current one.
    let (changed, _key_changed) =
        write_helix_config(model, provider, base_url, api_key, context_window);
    if !changed {
        return json!({ "success": true, "changed": false });
    }
    let arc: Arc<AppState> = Arc::clone(&state);
    restart_gateway_soon(&arc);
    json!({ "success": true, "changed": true })
}

/// Register a provider with its whole model list (settings 添加供应商 flow).
/// Each model carries its own `contextWindow`; the first one becomes pi's
/// `defaultModel`. Writes settings.json + models.json, then respawns pi so it
/// picks the new registry up (pi snapshots its config at startup).
#[tauri::command]
pub fn helix_set_provider_models(state: State<'_, Arc<AppState>>, config: Value) -> Value {
    let provider = config
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = config
        .get("baseUrl")
        .or_else(|| config.get("base_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let api_key = config
        .get("apiKey")
        .or_else(|| config.get("api_key"))
        .and_then(|v| v.as_str());
    let api = config
        .get("api")
        .or_else(|| config.get("apiFormat"))
        .and_then(|v| v.as_str())
        .unwrap_or("openai-completions")
        .to_string();
    let models: Vec<(String, Option<u64>)> = config
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m
                        .get("id")
                        .and_then(|v| v.as_str())
                        ?.trim()
                        .to_string();
                    if id.is_empty() {
                        return None;
                    }
                    Some((id, m.get("contextWindow").and_then(|v| v.as_u64())))
                })
                .collect()
        })
        .unwrap_or_default();

    let (changed, _key_changed) =
        apply_pi_provider_models(&provider, &base_url, api_key, &api, &models);
    if !changed {
        return json!({ "success": true, "changed": false });
    }
    let arc: Arc<AppState> = Arc::clone(&state);
    restart_gateway_soon(&arc);
    json!({ "success": true, "changed": true })
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
    let _ = atomic_write(&path, &updated);
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
    let _ = atomic_write(&path, &updated);
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
    let context_window = params
        .get("contextWindow")
        .or_else(|| params.get("context_window"))
        .and_then(|v| v.as_u64());

    let (changed, key_changed) =
        config_set_model(model, base_url, api_key, provider, context_window);
    let arc: Arc<AppState> = Arc::clone(&state);
    if changed || key_changed {
        restart_gateway_soon(&arc);
    }
    json!({ "success": true, "applied": true })
}

/// Live config push from the renderer (personality / reasoning effort / fast
/// mode etc.): writes the dotted key into config.yaml. Takes effect on the
/// next gateway respawn.
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
        let _ = atomic_write(&path, &updated);
    }
    json!({ "success": true })
}

/// Approve/deny a pending tool call. Approvals flow through
/// `pi/approval/respond` via helix_send; the legacy shape is translated
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
    pi_gateway::send(
        "pi/approval/respond",
        json!({ "request_id": request_id, "choice": choice }),
    )
    .await
}

/// Fetch the model list from an OpenAI-compatible endpoint (GET /models).
#[tauri::command]
pub async fn helix_fetch_models(base_url: String, api_key: String) -> Value {
    let client = match crate::proxy::proxy_aware_client() {
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
// (helix_list_personalities / helix_set_personality removed — the renderer
// persists display.personality via helix_set_config_key_value through
// config-sync's pushConfigKeyValue.)

// ── Pi Commands (extensions / skills / prompts) ─────────────────────

// (pi_get_commands removed — slash commands are now a client-side registry in
// src/components/Helix/slash-commands.ts. The `get_commands` RPC itself stays:
// helix.rs uses it internally to seed hook/skill metadata.)

/// Read the enabled/disabled state of each package from pi's settings.json
/// `packages` list. A plain string entry ("npm:foo") means fully enabled.
/// An object entry narrows what loads; when every resource array is empty
/// the package is fully disabled (still installed on disk). A missing entry
/// means the package was installed but removed from settings — also disabled.
fn pi_packages_enabled_map() -> std::collections::HashMap<String, bool> {
    let mut map = std::collections::HashMap::new();
    let settings = crate::config::read_pi_settings();
    let empty = Vec::new();
    let packages = settings
        .get("packages")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    for entry in packages {
        match entry {
            Value::String(source) => {
                map.insert(source.clone(), true);
            }
            Value::Object(obj) => {
                let Some(source) = obj.get("source").and_then(Value::as_str) else {
                    continue;
                };
                // Enabled unless every declared resource type is filtered to [].
                // An absent key means "load all" → enabled.
                let all_disabled = ["extensions", "skills", "prompts", "themes"]
                    .iter()
                    .all(|k| {
                        obj.get(*k)
                            .and_then(Value::as_array)
                            .map(|a| a.is_empty())
                            .unwrap_or(false)
                    });
                map.insert(source.to_string(), !all_disabled);
            }
            _ => {}
        }
    }
    map
}

/// Toggle a package's resources on/off in pi's settings.json `packages` list.
/// - enable:  entry becomes the plain string "npm:<name>" (load everything).
/// - disable: entry becomes an object filtering every resource type to []
///   (the package stays installed; `pi install` state is untouched).
/// Returns the new state. The gateway is respawned so the change takes
/// effect — pi reads settings at process start only.
#[tauri::command]
pub async fn pi_set_package_enabled(
    state: State<'_, Arc<AppState>>,
    package: String,
    enabled: bool,
) -> Result<Value, String> {
    let raw = package.trim().to_string();
    if raw.is_empty() {
        return Err("package name cannot be empty".into());
    }

    let mut settings = crate::config::read_pi_settings();
    if settings.is_null() {
        settings = json!({});
    }

    if raw.starts_with("npm:") {
        let name = raw.trim_start_matches("npm:");
        if name.is_empty() {
            return Err("package name cannot be empty".into());
        }
        let source = format!("npm:{name}");
        // Lite wrapper (extensions/<name>-lite.ts) imports the npm backend
        // directly, bypassing the packages list — it is the actual load path
        // and thus the real switch. When it exists:
        //   disable → exclude the wrapper AND filter the npm entry (if any)
        //             so neither layer can load the plugin;
        //   enable  → un-exclude the wrapper and keep the npm entry DISABLED —
        //             enabling it as a direct load path would double-load.
        let lite_pattern = format!("extensions/{name}-lite.ts");
        let has_lite_wrapper = crate::paths::pi_agent_dir().join(&lite_pattern).is_file();
        if has_lite_wrapper {
            if !enabled {
                set_npm_package_enabled(&mut settings, &source, false)?;
            }
            set_local_extension_enabled(&mut settings, &lite_pattern, enabled)?;
        } else {
            set_npm_package_enabled(&mut settings, &source, enabled)?;
        }
    } else {
        // Local extension (source "pi" from pi_list_installed): toggle via the
        // top-level `extensions` array with `-path` / `+path` override patterns —
        // the same mechanism `pi config` uses for auto-discovered resources.
        set_local_extension_enabled(&mut settings, &package, enabled)?;
    }

    crate::config::write_pi_settings(&settings);

    // pi snapshots settings at process start: respawn the gateway so the
    // enabled/disabled change actually takes effect.
    let arc = Arc::clone(&state);
    restart_gateway_soon(&arc);

    Ok(json!({ "success": true, "package": package, "enabled": enabled }))
}

/// Enable/disable an npm package entry in `settings.json` `packages`.
fn set_npm_package_enabled(
    settings: &mut Value,
    source: &str,
    enabled: bool,
) -> Result<(), String> {
    // Ensure a packages array exists.
    if settings.get("packages").and_then(Value::as_array).is_none() {
        settings["packages"] = json!([]);
    }
    let packages = settings
        .get_mut("packages")
        .and_then(Value::as_array_mut)
        .ok_or("settings.json has no packages list")?;

    // Locate the existing entry (string or object) by source id.
    let idx = packages.iter().position(|e| match e {
        Value::String(s) => s == source,
        Value::Object(o) => o.get("source").and_then(Value::as_str) == Some(source),
        _ => false,
    });

    let new_entry = if enabled {
        Value::String(source.to_string())
    } else {
        json!({
            "source": source,
            "extensions": [],
            "skills": [],
            "prompts": [],
            "themes": [],
        })
    };

    match idx {
        Some(i) => packages[i] = new_entry,
        None => {
            if enabled {
                packages.push(new_entry);
            }
            // Not listed at all + disable: already effectively disabled — no-op.
        }
    }
    Ok(())
}

/// Enable/disable a local extension via the top-level `extensions` array.
/// pi matches auto-discovered `~/.pi/agent/extensions/<file>` entries against
/// override patterns: `-<pattern>` force-excludes, `+<pattern>` force-includes
/// (patterns are exact paths relative to the agent dir, posix-style). We keep
/// only one pattern per target, mirroring `pi config`'s toggle behavior.
fn set_local_extension_enabled(
    settings: &mut Value,
    pattern: &str,
    enabled: bool,
) -> Result<(), String> {
    // Normalize the incoming identifier to a canonical core path: strip a
    // single leading override prefix (+ / - / !) and a leading "./", then
    // normalize separators. We deliberately do NOT strip trailing glob
    // wildcards here — the caller may pass either the bare resource path
    // ("extensions/pi-cron") or an existing override pattern
    // ("!extensions/pi-cron/**"); both collapse to the same core below.
    let mut target = pattern.trim_start_matches(['+', '-', '!']);
    if let Some(rest) = target.strip_prefix("./") {
        target = rest;
    }
    let target = target.replace('\\', "/");
    if target.trim_end_matches(|c: char| c == '*' || c == '?' || c == '/').is_empty() {
        return Err("extension pattern cannot be empty".into());
    }

    let entries = settings
        .get("extensions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Core of any entry: drop one leading override prefix, a leading "./",
    // normalize backslashes, and trim trailing glob/slash characters. This
    // lets `!target/**`, `+target`, `-target` and a bare `target` all
    // collapse to `target` for matching, regardless of which shape the
    // identifier arrived in.
    let core = |s: &str| -> String {
        let mut c = s.trim_start_matches(['+', '-', '!']);
        if let Some(rest) = c.strip_prefix("./") {
            c = rest;
        }
        c.replace('\\', "/")
            .trim_end_matches(|ch: char| ch == '*' || ch == '?' || ch == '/')
            .to_string()
    };
    let target_core = core(&target);

    // Drop every override that points at the same resource so toggling never
    // accumulates stale `+`/`-`/`!` pairs.
    let mut updated: Vec<Value> = entries
        .into_iter()
        .filter(|e| {
            let s = e.as_str().unwrap_or("");
            core(s) != target_core
        })
        .collect();

    if !enabled {
        // pi config writes a `-<path>` force-exclude for a disabled resource.
        // Mirror that exact shape so a later enable (which just removes it)
        // round-trips, and the next toggle's core-equality filter finds it.
        updated.push(Value::String(format!("-{target}")));
    }
    // enable: removing the override restores the auto-discovered default (on).

    if updated.is_empty() {
        // No overrides left — remove the key entirely to match pi's default.
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("extensions");
        }
    } else {
        settings["extensions"] = Value::Array(updated);
    }
    Ok(())
}

/// Scan Pi's local extension/skill directories and combine with `get_commands`
/// RPC data to produce a comprehensive list of installed plugins.
///
/// Directory layout scanned (everything pi itself loads):
///   ~/.pi/agent/extensions/*.ts|*.js — Pi TypeScript extensions
///   ~/.pi/agent/extensions/*/index.ts — subdirectory extensions
///   ~/.pi/agent/npm/node_modules/<dep> — packages declaring a `pi` manifest
///     field (extension entry + bundled skills + bundled prompts)
///   prompt templates from get_commands RPC
/// (User/memory-extension/package skills are also surfaced by `helix_list_skills`.)
#[tauri::command]
pub async fn pi_list_installed() -> Result<Value, String> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut items: Vec<Value> = Vec::new();
    let enabled_map = pi_packages_enabled_map();
    let local_ext_patterns = pi_local_extension_patterns();

    // ── Pi extensions (user-installed via `pi install`) ──
    // Read ~/.pi/agent/npm/package.json to get user-installed extensions
    let pi_npm_dir = home.join(".pi").join("agent").join("npm");
    let pi_ext_dir = home.join(".pi").join("agent").join("extensions");

    // Collect user-installed extension names from package.json
    let user_ext_names: Vec<String> = {
        let pkg_json = pi_npm_dir.join("package.json");
        if let Ok(content) = std::fs::read_to_string(&pkg_json) {
            if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
                pkg.get("dependencies")
                    .and_then(Value::as_object)
                    .map(|deps| deps.keys().cloned().collect())
                    .unwrap_or_default()
            } else {
                vec![]
            }
        } else {
            vec![]
        }
    };

    // Scan extensions directory for .ts files
    if pi_ext_dir.is_dir() {
        scan_pi_extensions(&pi_ext_dir, &mut items, &local_ext_patterns);
        // registerTool() tools are invisible to the pi runtime's get_commands RPC
        // (it only returns extension commands, prompt templates and skills),
        // so the plugin manager must recover them statically: a `pi.registerTool`
        // call in an enabled extension's source declares a model-facing tool.
        extract_registered_tools(&pi_ext_dir, &mut items);
    }

    // Scan node_modules for user-installed extensions (directories with package.json)
    let node_modules = pi_npm_dir.join("node_modules");
    if node_modules.is_dir() {
        scan_user_extensions(&node_modules, &user_ext_names, &mut items, &enabled_map);
    }
    merge_lite_wrappers(&mut items);

    // ── Prompt templates from get_commands RPC ──
    if let Ok(cmds_data) = pi_gateway::send("get_commands", Value::Null).await {
        if let Some(cmds) = cmds_data.get("commands").and_then(Value::as_array) {
            for cmd in cmds {
                let name = cmd.get("name").and_then(Value::as_str).unwrap_or("");
                let source = cmd.get("source").and_then(Value::as_str).unwrap_or("");
                if source == "prompt" {
                    items.push(json!({
                        "name": name,
                        "type": "prompt",
                        "source": "pi-rpc",
                        "description": cmd.get("description").and_then(Value::as_str).unwrap_or(""),
                        "path": cmd.get("path").and_then(Value::as_str).unwrap_or(""),
                        "location": cmd.get("location").and_then(Value::as_str).unwrap_or(""),
                    }));
                }
            }
        }
    }

    Ok(json!({ "items": items }))
}

/// Override patterns from settings.json's top-level `extensions` array that
/// control whether an auto-discovered local extension is loaded. Mirrors pi's
/// `isEnabledByOverrides`: `!<glob>` excludes, `+<path>` force-includes,
/// `-<path>` force-excludes; a path with no matching override defaults to on.
fn pi_local_extension_patterns() -> Vec<String> {
    let settings = crate::config::read_pi_settings();
    settings
        .get("extensions")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Does `rel_path` (posix-style, relative to the agent dir) match a glob-ish
/// override pattern? Supports `*` (within a segment), `?` (single char) and
/// `**` (any chars incl. separators) — the subset of minimatch pi uses for
/// these simple settings patterns. Exact string equality matches too.
fn local_pattern_matches(pattern: &str, rel_path: &str) -> bool {
    let pattern = pattern.replace('\\', "/");
    let target = rel_path.replace('\\', "/");
    if pattern == target {
        return true;
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = target.chars().collect();
    glob_match(&p, &t)
}

/// Iterative-free recursive glob matcher: `*` matches any run of non-`/`
/// chars, `**` matches anything (including `/`), `?` matches one non-`/` char.
fn glob_match(pattern: &[char], text: &[char]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }
    match pattern[0] {
        '*' => {
            // Coalesce consecutive stars; track whether this is a `**`.
            let mut rest = 1usize;
            let mut double = false;
            while rest < pattern.len() && pattern[rest] == '*' {
                double = true;
                rest += 1;
            }
            let pat_rest = &pattern[rest..];
            if double {
                // `**/` may also match zero segments.
                if !pat_rest.is_empty() && pat_rest[0] == '/' && glob_match(&pat_rest[1..], text) {
                    return true;
                }
                // `**` swallows any prefix of text.
                for i in 0..=text.len() {
                    if glob_match(pat_rest, &text[i..]) {
                        return true;
                    }
                }
                false
            } else {
                // `*` swallows any run of non-separator chars.
                for i in 0..=text.len() {
                    if glob_match(pat_rest, &text[i..]) {
                        return true;
                    }
                    if i < text.len() && text[i] == '/' {
                        break;
                    }
                }
                false
            }
        }
        '?' => !text.is_empty() && text[0] != '/' && glob_match(&pattern[1..], &text[1..]),
        c => !text.is_empty() && text[0] == c && glob_match(&pattern[1..], &text[1..]),
    }
}

fn scan_pi_extensions(dir: &std::path::Path, items: &mut Vec<Value>, patterns: &[String]) {
    let agent_dir = crate::paths::pi_agent_dir();
    // Enabled state for an auto-discovered local extension follows pi's
    // `isEnabledByOverrides`: `!glob` excludes, `-path` force-excludes,
    // `+path` force-includes; no matching override → enabled.
    let enabled_for = |abs_path: &std::path::Path, extra_rels: &[&str]| -> bool {
        let rel = abs_path
            .strip_prefix(&agent_dir)
            .map(|r| r.display().to_string())
            .unwrap_or_else(|_| "extensions".to_string());
        // All candidate paths this entry could be referenced by: the file/dir
        // itself, plus explicit extras (e.g. "<dir>/index.ts" for package dirs)
        // so a `!dir/**` disable pattern registers on the UI row too.
        let candidates: Vec<String> = std::iter::once(rel.clone())
            .chain(extra_rels.iter().map(|s| s.to_string()))
            .collect();
        // Mirrors pi's isEnabledByOverrides precedence: `!glob` excludes,
        // then `+path` force-includes, then `-path` force-excludes.
        let mut excludes: Vec<&str> = Vec::new();
        let mut force_includes: Vec<&str> = Vec::new();
        let mut force_excludes: Vec<&str> = Vec::new();
        for raw in patterns {
            let body = raw
                .trim_start_matches(['+', '-', '!'])
                .trim_start_matches("./");
            if body.is_empty() {
                continue;
            }
            if let Some(rest) = raw.strip_prefix('!') {
                excludes.push(rest);
            } else if let Some(rest) = raw.strip_prefix('+') {
                force_includes.push(rest);
            } else if let Some(rest) = raw.strip_prefix('-') {
                force_excludes.push(rest);
            } else {
                // Bare entries are explicit include paths — they add resources,
                // they don't disable anything.
                continue;
            }
        }
        let hit = |body: &str, cand: &str| {
            body == cand
                || local_pattern_matches(body, cand)
                || local_pattern_matches(
                    body,
                    std::path::Path::new(cand)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(""),
                )
        };
        let any_hit = |list: &[&str]| candidates.iter().any(|c| list.iter().any(|p| hit(p, c)));
        let mut enabled = true;
        if any_hit(&excludes) {
            enabled = false;
        }
        if any_hit(&force_includes) {
            enabled = true;
        }
        if any_hit(&force_excludes) {
            enabled = false;
        }
        enabled
    };

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if file_name.starts_with('.') {
            continue;
        }
        if path.is_file() && (file_name.ends_with(".ts") || file_name.ends_with(".js")) {
            let ext_name = file_name.trim_end_matches(".ts").trim_end_matches(".js");
            let rel = path
                .strip_prefix(&crate::paths::pi_agent_dir())
                .map(|r| r.display().to_string())
                .unwrap_or_else(|_| "extensions".to_string());
            items.push(json!({
                "name": ext_name,
                "type": "extension",
                "source": "pi",
                "description": format!("TypeScript extension: {ext_name}"),
                "path": path.display().to_string(),
                "location": "user",
                "enabled": enabled_for(&path, &[]),
                // Toggle identifier: the file relative to the agent dir — the
                // exact key `set_local_extension_enabled` writes `-<file>` for.
                "packageId": rel,
            }));
        } else if path.is_dir() {
            let entry_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            // One directory can satisfy BOTH probes below (an index.ts AND a
            // package.json declaring `pi.extensions`). Emitting both produced
            // two cards for a single package whenever the dir name differed
            // from the package name (dir `pi-web-access` vs package
            // `pi-web-access-lean`), and — when the names happened to match —
            // the renderer's `${type}:${name}` dedupe kept the folder-name
            // entry and silently dropped the richer one (real version +
            // description). The manifest entry always wins.
            let mut emitted_manifest = false;
            let pkg_json = path.join("package.json");
            if pkg_json.exists() {
                if let Ok(content) = std::fs::read_to_string(&pkg_json) {
                    if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
                        // A declared pi manifest is the rule pi itself uses to
                        // load an extension package — anything else is not one.
                        if pkg.pointer("/pi/extensions").is_some() {
                            let pkg_name = pkg
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or(entry_name);
                            let version = pkg.get("version").and_then(Value::as_str).unwrap_or("");
                            let description =
                                pkg.get("description").and_then(Value::as_str).unwrap_or("");
                            let entry_rel = format!("extensions/{entry_name}");
                            items.push(json!({
                                "name": pkg_name,
                                "type": "extension",
                                "source": "pi-package",
                                "description": description,
                                "version": version,
                                "path": path.display().to_string(),
                                "location": "user",
                                "enabled": enabled_for(
                                    &path,
                                    &[&format!("extensions/{entry_name}/index.ts")],
                                ),
                                // Toggle identifier: dir relative to the agent dir;
                                // `set_local_extension_enabled` resolves it to the
                                // concrete index entry when it exists.
                                "packageId": entry_rel,
                            }));
                            emitted_manifest = true;
                        }
                    }
                }
            }
            // Fallback: a bare index.ts/index.js directory with no pi manifest.
            if !emitted_manifest {
                let index_ts = path.join("index.ts");
                let index_js = path.join("index.js");
                if index_ts.exists() || index_js.exists() {
                    let entry_rel = format!("extensions/{entry_name}");
                    items.push(json!({
                        "name": entry_name,
                        "type": "extension",
                        "source": "pi",
                        "description": format!("Extension package: {entry_name}"),
                        "path": path.display().to_string(),
                        "location": "user",
                        "enabled": enabled_for(
                            &path,
                            &[&format!("extensions/{entry_name}/index.ts")],
                        ),
                        "packageId": entry_rel,
                    }));
                }
            }
        }
    }
}

/// Extract `registerTool` declarations from local extension sources so the
/// plugin manager can surface model-facing tools. pi's `get_commands` RPC only
/// returns extension commands (registerCommand), prompt templates, and skills —
/// tools are a separate registry the RPC never exposes, so without this pass
/// tools like the browser suite look "missing" from the extension list.
///
/// Heuristic: a `pi.registerTool(` call in an enabled extension's source
/// contributes one `tool` item. The tool name is read from the `name:`
/// property of the first argument object (string literal or identifier),
/// falling back to the extension's own name when no `name` is present.
fn extract_registered_tools(dir: &std::path::Path, items: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if file_name.starts_with('.') {
            continue;
        }
        if path.is_file() {
            let is_ext = file_name.ends_with(".ts")
                || file_name.ends_with(".js")
                || file_name.ends_with(".mts")
                || file_name.ends_with(".mjs");
            if is_ext {
                ingest_extension_source(&path, items);
            }
            continue;
        }
        // Directory extension: pi loads a package when package.json has a
        // `pi` manifest, or when a bare index.ts/index.js exists.
        let pkg_json = path.join("package.json");
        if pkg_json.exists() {
            let content = std::fs::read_to_string(&pkg_json).unwrap_or_default();
            if content.contains("\"pi\"") {
                // Package with pi manifest — its tools are declared in index.*
                for rel in ["index.ts", "index.js"] {
                    let p = path.join(rel);
                    if p.exists() {
                        ingest_extension_source(&p, items);
                    }
                }
            }
            // No `pi` key in manifest: not a pi extension, skip.
        } else if path.join("index.ts").exists() || path.join("index.js").exists() {
            // Bare index dir
            for rel in ["index.ts", "index.js"] {
                let p = path.join(rel);
                if p.exists() {
                    ingest_extension_source(&p, items);
                }
            }
        }
    }
}

fn ingest_extension_source(file: &std::path::Path, items: &mut Vec<Value>) {
    ingest_extension_source_named(file, None, items);
}

/// `ingest_extension_source` with an explicit display name (used by
/// `scan_user_extensions` where the file stem is `index`, which is useless
/// as a label — the npm package name is the right one).
fn ingest_extension_source_named(
    file: &std::path::Path,
    display_override: Option<&str>,
    items: &mut Vec<Value>,
) {
    let content = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(_) => return,
    };
    let raw_stem = file
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("extension");
    let mut stem = raw_stem.to_string();
    for suffix in [".mts", ".mjs", ".ts", ".js"] {
        if let Some(pos) = stem.strip_suffix(suffix) {
            stem = pos.to_string();
        }
    }
    let display_name = match display_override {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => {
            if stem == "index" || stem.is_empty() {
                "extension".to_string()
            } else {
                stem
            }
        }
    };

    // Scan for `registerTool(` call sites. Handles two patterns:
    //   1. Direct:  pi.registerTool({ name: "foo", ... })  → literal name
    //   2. Helper:  registerTool(pi, { name: "foo", ... }) → literal name
    // Both carry the tool name as a string literal in the tool object, so a
    // 300-char window from the call site is enough. When `name:` holds a bare
    // identifier (a variable reference like `tool.name`), skip it — the
    // heuristic can't resolve a runtime value.
    let search_text = content.as_str();
    let mut search_from = 0usize;
    loop {
        let idx = match search_text[search_from..].find("registerTool(") {
            Some(i) => search_from + i,
            None => break,
        };
        // A `function registerTool(` / `function registerTool(` declaration
        // line is not a call site — skip it.
        let pre = &search_text[..idx];
        let is_declaration = pre.trim_end().ends_with("function")
            || pre.trim_end().ends_with("const")
            || pre.trim_end().ends_with("let")
            || pre.trim_end().ends_with("var");
        if is_declaration {
            search_from = idx + "registerTool(".len();
            continue;
        }
        // 结束位置必须回退到 char 边界：idx + 300 是**字节**偏移，扩展源码通常
        // 是含中文的 UTF-8（一个汉字 3 字节），落在多字节字符中间时按 str 切片
        // 会 panic（"end byte index N is not a char boundary"）。
        // 起点 idx 由 ASCII 模式 "registerTool(" 的 find 得到，天然是边界，只需
        // 把终点往回退到最近的边界（退到 idx 为止，退化成一个短窗口也不 panic）。
        let mut window_end = (idx + 300).min(search_text.len());
        while window_end > idx && !search_text.is_char_boundary(window_end) {
            window_end -= 1;
        }
        let window = &search_text[idx..window_end];
        let after_call = &window["registerTool(".len()..];
        // Skip to the first `{` (the tool object argument).
        let scan_from = after_call.find('{').unwrap_or(0);
        let rest = &after_call[scan_from..];
        let name_pos = rest.find("name:");
        let tool_name: Option<String> = if let Some(np) = name_pos {
            let after = &rest[np + 5..];
            let trimmed = after.trim_start();
            if trimmed.starts_with('"') || trimmed.starts_with('\'') {
                let quote = trimmed.chars().next().unwrap();
                trimmed[1..].find(quote).map(|end| trimmed[1..end + 1].to_string())
            } else {
                // Identifier (variable reference) — skip.
                None
            }
        } else {
            None
        };
        if let Some(tool_name) = tool_name {
            items.push(json!({
                "name": tool_name,
                "type": "tool",
                "source": "pi-tool",
                "description": format!("Tool registered by extension: {display_name}"),
                "path": file.display().to_string(),
                "location": "user",
            }));
        }
        search_from = idx + "registerTool(".len();
    }
}

/// Scan node_modules for user-installed Pi extensions.
/// A package counts when it declares a `pi` manifest field (the exact rule
/// pi itself uses — `pi.extensions` / `pi.skills` / `pi.prompts`); the legacy
/// `main`-file check missed packages like pi-subagents that only declare
/// `pi.extensions`.
/// For each such package we emit one `extension` item plus its bundled
/// `skill` / `prompt` items, mirroring what pi loads.
fn scan_user_extensions(
    node_modules: &std::path::Path,
    user_ext_names: &[String],
    items: &mut Vec<Value>,
    enabled_map: &std::collections::HashMap<String, bool>,
) {
    for ext_name in user_ext_names {
        let pkg_dir = node_modules.join(ext_name);
        if !pkg_dir.is_dir() {
            continue;
        }
        let pkg_json = pkg_dir.join("package.json");
        let Ok(content) = std::fs::read_to_string(&pkg_json) else {
            continue;
        };
        let Ok(pkg) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let Some(pi_manifest) = pkg.get("pi") else {
            continue;
        };
        let version = pkg.get("version").and_then(Value::as_str).unwrap_or("");
        let description = pkg.get("description").and_then(Value::as_str).unwrap_or("");
        let package_id = format!("npm:{ext_name}");
        // Listed as enabled string → true; object with all-[] filters → false;
        // missing from packages → false (installed but not loaded).
        let enabled = enabled_map.get(&package_id).copied().unwrap_or(false);

        let ext_entry = if pi_manifest.get("extensions").is_some() {
            let entry_path = pi_manifest
                .get("extensions")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(Value::as_str)
                .unwrap_or("");
            json!({
                "name": ext_name,
                "type": "extension",
                "source": "pi-npm",
                "description": description,
                "version": version,
                "path": pkg_dir.join(entry_path.trim_start_matches("./")).display().to_string(),
                "location": "user",
                "packageId": package_id,
                "enabled": enabled,
            })
        } else {
            json!({
                "name": ext_name,
                "type": "package",
                "source": "pi-npm",
                "description": description,
                "version": version,
                "path": pkg_dir.display().to_string(),
                "location": "user",
                "packageId": package_id,
                "enabled": enabled,
            })
        };
        items.push(ext_entry);

        // ── Bundled skills (pi.skills) ──
        if let Some(skill_paths) = pi_manifest.get("skills").and_then(Value::as_array) {
            for raw in skill_paths.iter().filter_map(Value::as_str) {
                if raw.starts_with('!') || raw.contains('*') {
                    continue; // exclusions / globs — directory scan covers matches
                }
                let root = pkg_dir.join(raw.trim_start_matches("./"));
                push_skill_dirs(&root, ext_name, version, items);
            }
        }

        // ── Bundled prompts (pi.prompts) ──
        if let Some(prompt_paths) = pi_manifest.get("prompts").and_then(Value::as_array) {
            for raw in prompt_paths.iter().filter_map(Value::as_str) {
                if raw.starts_with('!') || raw.contains('*') {
                    continue;
                }
                let dir = pkg_dir.join(raw.trim_start_matches("./"));
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for file in entries.flatten() {
                    let fpath = file.path();
                    let fname = fpath.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if fname.starts_with('.')
                        || !(fname.ends_with(".md") || fname.ends_with(".txt"))
                    {
                        continue;
                    }
                    let stem = fname.trim_end_matches(".md").trim_end_matches(".txt");
                    items.push(json!({
                        "name": stem,
                        "type": "prompt",
                        "source": "pi-npm",
                        "description": format!("Prompt template from {ext_name}"),
                        "version": version,
                        "path": fpath.display().to_string(),
                        "location": "user",
                    }));
                }
            }
        }

        // ── registerTool tools declared in the extension entry point(s) ──
        // pi's get_commands RPC never exposes these (tools are a separate
        // registry), so scan the manifest's extension entry files directly.
        if let Some(ext_paths) = pi_manifest.get("extensions").and_then(Value::as_array) {
            for raw in ext_paths.iter().filter_map(Value::as_str) {
                if raw.starts_with('!') || raw.contains('*') {
                    continue;
                }
                let p = pkg_dir.join(raw.trim_start_matches("./"));
                if p.is_file() {
                    ingest_extension_source_named(&p, Some(ext_name), items);
                }
            }
        }
    }
}

/// Collapse a local `<package>-lite` wrapper into its npm backend.
///
/// A lite wrapper is an implementation detail of the same plugin: it imports
/// the installed npm package while filtering bundled resources. Showing both
/// entries makes the manager look as though the plugin is installed twice and
/// lets update/uninstall act on the wrapper instead of the actual backend.
fn merge_lite_wrappers(items: &mut Vec<Value>) {
    let mut backend_names = std::collections::HashSet::new();
    for item in items.iter() {
        if item.get("source").and_then(Value::as_str) == Some("pi-npm") {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                backend_names.insert(name.to_string());
            }
        }
    }

    let mut lite_backends: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    items.retain(|item| {
        if item.get("source").and_then(Value::as_str) != Some("pi") {
            return true;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            return true;
        };
        let Some(package) = name.strip_suffix("-lite") else {
            return true;
        };
        if !backend_names.contains(package) {
            return true;
        }
        let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        lite_backends.insert(name.to_string(), (package.to_string(), enabled));
        false
    });

    for item in items.iter_mut() {
        if item.get("source").and_then(Value::as_str) != Some("pi-npm") {
            continue;
        }
        let Some(package) = item.get("name").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Some((lite_name, lite_enabled)) = lite_backends
            .iter()
            .find(|(_, (backend, _))| backend.as_str() == package)
            .map(|(lite, (_, enabled))| (lite.to_string(), *enabled))
        else {
            continue;
        };

        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let package_path = item
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(obj) = item.as_object_mut() {
            obj.insert("name".into(), Value::String(lite_name.clone()));
            obj.insert(
                "description".into(),
                Value::String(format!(
                    "{description} (lite wrapper active; npm backend installed)"
                )),
            );
            obj.insert("packageName".into(), Value::String(package.to_string()));
            obj.insert("packagePath".into(), Value::String(package_path));
            obj.insert("enabled".into(), Value::Bool(lite_enabled));
            obj.insert(
                "path".into(),
                Value::String(format!(
                    "{}\\extensions\\{lite_name}.ts",
                    crate::paths::pi_agent_dir().display()
                )),
            );
        }
    }
}

/// Push every `<dir>/<skill>/SKILL.md` directory (depth 1 and 2) as a
/// `skill` item, mirroring pi's skill directory layout.
fn push_skill_dirs(dir: &std::path::Path, pkg_name: &str, version: &str, items: &mut Vec<Value>) {
    let Ok(top) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in top.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            items.push(json!({
                "name": name,
                "type": "skill",
                "source": "pi-npm",
                "description": format!("Skill from {pkg_name}"),
                "version": version,
                "path": path.display().to_string(),
                "location": "user",
            }));
            continue;
        }
        // Depth 2: <category>/<skill>/SKILL.md
        let Ok(children) = std::fs::read_dir(&path) else {
            continue;
        };
        for child in children.flatten() {
            let cpath = child.path();
            if cpath.is_dir() && cpath.join("SKILL.md").is_file() {
                let name = cpath.file_name().and_then(|s| s.to_str()).unwrap_or("");
                items.push(json!({
                    "name": name,
                    "type": "skill",
                    "source": "pi-npm",
                    "description": format!("Skill from {pkg_name}"),
                    "version": version,
                    "path": cpath.display().to_string(),
                    "location": "user",
                }));
            }
        }
    }
}

/// Query Pi's `get_available_models` RPC.
#[tauri::command]
pub async fn pi_get_available_models() -> Result<Value, String> {
    pi_gateway::send("get_available_models", Value::Null).await
}

/// Broadcast a thinking level to every live Pi instance (live, no restart).
#[tauri::command]
pub async fn pi_set_thinking_level_all(level: String) -> Result<Value, String> {
    pi_gateway::set_thinking_level_all(level);
    Ok(json!({ "success": true }))
}

// (pi_get_state / pi_set_model / pi_set_thinking_level / pi_compact /
// pi_get_session_stats removed — the renderer reaches the same data through
// helix_status / helix_set_model (config-backed) / session.compress (which
// also returns before/after token counts) / session.context_breakdown.)

// ── Pi Package Manager ─────────────────────────────────────────────

/// Search npm for Pi packages (extensions, skills, themes, prompts).
/// Uses the npm registry search API.
#[tauri::command]
pub async fn pi_search_packages(query: String) -> Result<Value, String> {
    if query.trim().is_empty() {
        return Err("query cannot be empty".into());
    }
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size=20",
        urlencoding::encode(&query)
    );
    let resp = crate::proxy::proxy_aware_client_builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("npm registry request failed: {e}"))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse npm response: {e}"))?;

    let mut packages = Vec::new();
    if let Some(objects) = body.get("objects").and_then(Value::as_array) {
        for obj in objects {
            if let Some(pkg) = obj.get("package") {
                let name = pkg.get("name").and_then(Value::as_str).unwrap_or("");
                let description = pkg.get("description").and_then(Value::as_str).unwrap_or("");
                let version = pkg.get("version").and_then(Value::as_str).unwrap_or("");
                // Extract keywords to determine type
                let keywords: Vec<String> = pkg
                    .get("keywords")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let pkg_type = if keywords.iter().any(|k| k == "pi-extension") {
                    "extension"
                } else if keywords.iter().any(|k| k == "pi-skill") {
                    "skill"
                } else if keywords.iter().any(|k| k == "pi-theme") {
                    "theme"
                } else if keywords.iter().any(|k| k == "pi-prompt") {
                    "prompt"
                } else {
                    "package"
                };
                // Get author
                let author = pkg
                    .get("author")
                    .and_then(|a| a.get("name").or(Some(a)).and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                // Get npm link
                let npm_url = format!("https://www.npmjs.com/package/{name}");

                // Get download count (weekly) from score.detail.downloads
                let downloads = obj
                    .get("score")
                    .and_then(|s| s.get("detail"))
                    .and_then(|d| d.get("downloads"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0) as u64;

                // Get publish date
                let date = pkg
                    .get("date")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();

                packages.push(json!({
                    "name": name,
                    "description": description,
                    "version": version,
                    "type": pkg_type,
                    "author": author,
                    "npmUrl": npm_url,
                    "installCmd": format!("pi install npm:{name}"),
                    "downloads": downloads,
                    "date": date,
                }));
            }
        }
    }
    Ok(json!({ "packages": packages }))
}

/// Install a Pi package via `pi install npm:<package>`. For an installed
/// package this upgrades it to the latest version. pi loads packages at
/// process start, so a successful install restarts the agent.
#[tauri::command]
pub async fn pi_install_package(
    state: State<'_, Arc<AppState>>,
    package: String,
) -> Result<Value, String> {
    if package.trim().is_empty() {
        return Err("package name cannot be empty".into());
    }
    let install_id = format!("npm:{package}");
    let (program, base_args) = pi_gateway::pi_cli_strings();
    let output = tokio::process::Command::new(&program)
        .args(&base_args)
        .args(["install", &install_id])
        .output()
        .await
        .map_err(|e| format!("failed to run pi install: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        let arc: Arc<AppState> = Arc::clone(&state);
        restart_gateway_soon(&arc);
        Ok(json!({
            "success": true,
            "message": format!("Successfully installed {package}"),
            "output": stdout,
        }))
    } else {
        Err(format!("pi install failed: {stderr}\n{stdout}"))
    }
}

/// Uninstall a Pi package via `pi uninstall npm:<package>`. pi loads
/// packages at process start, so a successful uninstall restarts the agent.
#[tauri::command]
pub async fn pi_uninstall_package(
    state: State<'_, Arc<AppState>>,
    package: String,
) -> Result<Value, String> {
    if package.trim().is_empty() {
        return Err("package name cannot be empty".into());
    }
    let install_id = format!("npm:{package}");
    let (program, base_args) = pi_gateway::pi_cli_strings();
    let output = tokio::process::Command::new(&program)
        .args(&base_args)
        .args(["uninstall", &install_id])
        .output()
        .await
        .map_err(|e| format!("failed to run pi uninstall: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        let arc: Arc<AppState> = Arc::clone(&state);
        restart_gateway_soon(&arc);
        Ok(json!({
            "success": true,
            "message": format!("Successfully uninstalled {package}"),
            "output": stdout,
        }))
    } else {
        Err(format!("pi uninstall failed: {stderr}\n{stdout}"))
    }
}

// ── Update checks (pi agent + npm-installed plugins) ──────────────────

/// Semver-ish comparison: is `latest` newer than `installed`? Tolerates
/// missing components and non-numeric suffixes (compared lexically).
fn version_is_newer(installed: &str, latest: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse::<u64>().ok())
            .collect()
    };
    let a = parse(installed);
    let b = parse(latest);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if y > x {
            return true;
        }
        if y < x {
            return false;
        }
    }
    false
}

/// Fetch a package's latest version from the npm registry. Scoped names use
/// the %2F-encoded form (the registry does not accept a literal @ in the path).
async fn npm_latest_version(name: &str) -> Result<String, String> {
    let encoded = name.replace('/', "%2F");
    let url = format!("https://registry.npmjs.org/{encoded}/latest");
    let resp = crate::proxy::proxy_aware_client_builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("npm registry request failed: {e}"))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse npm response: {e}"))?;
    body.get("version")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| "npm response missing version".into())
}

/// Installed version of the pi agent itself, from the npm-global package.json
/// the gateway spawns (`dirs::data_dir()/npm/node_modules/...`).
pub fn installed_pi_version() -> Option<String> {
    let pkg_json = dirs::data_dir()?
        .join("npm")
        .join("node_modules/@earendil-works/pi-coding-agent/package.json");
    let content = std::fs::read_to_string(pkg_json).ok()?;
    serde_json::from_str::<Value>(&content)
        .ok()?
        .get("version")
        .and_then(Value::as_str)
        .map(String::from)
}

/// Check for updates: the pi agent itself + every npm-installed pi plugin
/// (deps of ~/.pi/agent/npm/package.json), each against the npm registry.
/// Returns per-item `{installed, latest, hasUpdate}`; registry failures
/// degrade to `latest: null` rather than failing the whole call.
#[tauri::command]
pub async fn pi_check_updates() -> Result<Value, String> {
    let mut pi_entry = serde_json::Map::new();
    match installed_pi_version() {
        Some(installed) => {
            pi_entry.insert("installed".into(), json!(installed));
            match npm_latest_version("@earendil-works/pi-coding-agent").await {
                Ok(latest) => {
                    let has_update = version_is_newer(&installed, &latest);
                    pi_entry.insert("latest".into(), json!(latest));
                    pi_entry.insert("hasUpdate".into(), json!(has_update));
                }
                Err(_) => {
                    pi_entry.insert("latest".into(), Value::Null);
                }
            }
        }
        None => {
            pi_entry.insert("installed".into(), Value::Null);
        }
    }

    let mut packages: Vec<Value> = Vec::new();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let pi_npm_dir = home.join(".pi").join("agent").join("npm");
    let deps: Vec<String> = std::fs::read_to_string(pi_npm_dir.join("package.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|p| {
            p.get("dependencies")
                .and_then(Value::as_object)
                .map(|d| d.keys().cloned().collect())
        })
        .unwrap_or_default();

    for name in deps {
        let installed = std::fs::read_to_string(
            pi_npm_dir
                .join("node_modules")
                .join(&name)
                .join("package.json"),
        )
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|p| p.get("version").and_then(Value::as_str).map(String::from));
        let Some(installed) = installed else { continue };
        let mut entry = serde_json::Map::new();
        entry.insert("name".into(), json!(name));
        entry.insert("installed".into(), json!(installed));
        match npm_latest_version(&name).await {
            Ok(latest) => {
                let has_update = version_is_newer(&installed, &latest);
                entry.insert("latest".into(), json!(latest));
                entry.insert("hasUpdate".into(), json!(has_update));
            }
            Err(_) => {
                entry.insert("latest".into(), Value::Null);
            }
        }
        packages.push(Value::Object(entry));
    }

    Ok(json!({ "pi": Value::Object(pi_entry), "packages": packages }))
}

#[cfg(test)]
mod tests {
    use super::{glob_match, ingest_extension_source, merge_lite_wrappers, set_local_extension_enabled};
    use serde_json::Value;

    fn m(pattern: &str, text: &str) -> bool {
        let p: Vec<char> = pattern.chars().collect();
        let t: Vec<char> = text.chars().collect();
        glob_match(&p, &t)
    }

    #[test]
    fn glob_exact() {
        assert!(m("extensions/foo.ts", "extensions/foo.ts"));
        assert!(!m("extensions/foo.ts", "extensions/bar.ts"));
    }

    #[test]
    fn glob_star_within_segment() {
        assert!(m("extensions/*.ts", "extensions/foo.ts"));
        assert!(!m("extensions/*.ts", "extensions/sub/foo.ts"));
        assert!(!m("*.ts", "sub/foo.ts"));
    }

    #[test]
    fn glob_double_star_crosses_segments() {
        assert!(m("**/*.ts", "extensions/sub/foo.ts"));
        assert!(m("extensions/**/*.ts", "extensions/sub/foo.ts"));
        // `**/` matches zero segments too.
        assert!(m("**/foo.ts", "foo.ts"));
        assert!(m("**/foo.ts", "extensions/foo.ts"));
    }

    #[test]
    fn glob_question_mark() {
        assert!(m("extensions/foo?.ts", "extensions/foo1.ts"));
        assert!(!m("extensions/foo?.ts", "extensions/foo12.ts"));
        assert!(!m("extensions/foo?.ts", "extensions/foo/.ts"));
    }

    #[test]
    fn glob_trailing_star() {
        assert!(m("extensions/foo*", "extensions/foo.ts"));
        assert!(m("extensions/foo*", "extensions/foo"));
        assert!(!m("extensions/foo*", "extensions/bar"));
    }

    #[test]
    fn glob_empty() {
        assert!(m("", ""));
        assert!(!m("", "x"));
        assert!(m("*", "anything"));
    }

    #[test]
    fn set_local_extension_enabled_removes_disable_override() {
        // pi-cron scenario: a dir-based local extension is currently disabled by
        // a `!extensions/pi-cron/**` glob. Enabling it must remove that entry
        // (restoring the auto-discovered default = on), leaving the rest intact.
        let mut settings = serde_json::json!({
            "extensions": [
                "!extensions/pi-cron/**",
                "!extensions/pi-web-access/**",
                "!extensions/pi-verify/**"
            ]
        });
        // Frontend computes the identifier as the path relative to the agent
        // dir (dir form: "extensions/pi-cron"), not a glob.
        set_local_extension_enabled(&mut settings, "extensions/pi-cron", true).unwrap();
        assert_eq!(
            settings["extensions"],
            serde_json::json!(["!extensions/pi-web-access/**", "!extensions/pi-verify/**"]),
            "enabling must drop the pi-cron glob only"
        );

        // Disabling it writes an exact `-<file>` override (pi config style),
        // not a glob. The dir has no index on the filesystem in this test, so
        // the concrete target stays the dir path.
        set_local_extension_enabled(&mut settings, "extensions/pi-cron", false)
            .unwrap();
        assert!(
            settings["extensions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e == "-extensions/pi-cron" || e == "!extensions/pi-cron/**"),
            "disabling must add an override entry for pi-cron"
        );
    }

    #[test]
    fn merge_lite_wrappers_into_npm_backend() {
        let mut items = vec![
            serde_json::json!({
                "name": "pi-lens-lite",
                "type": "extension",
                "source": "pi",
                "enabled": true,
                "path": "C:\\extensions\\pi-lens-lite.ts",
            }),
            serde_json::json!({
                "name": "pi-lens",
                "type": "extension",
                "source": "pi-npm",
                "description": "Real-time code feedback",
                "version": "4.1.5",
                "packageId": "npm:pi-lens",
                "path": "C:\\npm\\node_modules\\pi-lens\\dist\\index.js",
            }),
        ];

        merge_lite_wrappers(&mut items);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["name"], "pi-lens-lite");
        assert_eq!(items[0]["packageName"], "pi-lens");
        assert_eq!(items[0]["enabled"], true);
        assert!(items[0]["description"]
            .as_str()
            .unwrap()
            .contains("lite wrapper active"));
    }

    #[test]
    fn extract_register_tool_direct_and_helper_call_sites() {
        let dir = std::env::temp_dir().join(format!(
            "helix-test-ext-{}-{}",
            std::process::id(),
            1
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pi-test-ext.ts");
        std::fs::write(
            &file,
            "function registerTool(pi: any, tool: any) {\n"
                .to_string()
                + "  pi.registerTool({\n"
                    + "    name: tool.name,\n"
                    + "    description: tool.description,\n"
                    + "  });\n"
                    + "}\n"
                    + "export default function register(pi: any) {\n"
                    // Helper pattern: name literal lives in the call-site object.
                    + "  registerTool(pi, {\n"
                    + "    name: \"open_browser\",\n"
                    + "    description: \"x\",\n"
                    + "  });\n"
                    // Direct pattern.
                    + "  pi.registerTool({\n"
                    + "    name: \"browser_read\",\n"
                    + "  });\n"
                    + "}\n",
        )
        .unwrap();
        let mut items: Vec<Value> = Vec::new();
        ingest_extension_source(&file, &mut items);
        let names: Vec<String> = items
            .iter()
            .filter_map(|i| i.get("name").and_then(Value::as_str).map(String::from))
            .collect();
        // The helper's own `pi.registerTool({ name: tool.name ... })` call
        // uses a variable name — skipped. The two call sites with literal
        // names are found.
        assert!(names.contains(&"open_browser".to_string()), "{names:?}");
        assert!(names.contains(&"browser_read".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("tool")), "{names:?}");
        assert!(items.iter().all(|i| i["type"] == "tool"));
        assert!(items.iter().all(|i| i["source"] == "pi-tool"));
    }

    /// Regression: CJK (3-byte UTF-8) inside the 300-byte tool window used to
    /// make `(idx + 300)` land mid-character and panic on the str slice. The
    /// user's pi-helix-browser.ts has this exact shape (Chinese tool
    /// descriptions), which crashed `pi_list_installed` and kept the plugin
    /// manager panel from opening.
    #[test]
    fn extract_register_tool_cjk_window_does_not_panic() {
        let dir = std::env::temp_dir().join(format!(
            "helix-test-ext-cjk-{}-{}",
            std::process::id(),
            2
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pi-cjk-ext.ts");
        // ~300 bytes of ASCII before the call, then a CJK description so the
        // `idx + 300` byte offset lands inside a 3-byte char.
        let pad = "a".repeat(280);
        let body = format!(
            "{pad}\n  registerTool(pi, {{\n    name: \"cjk_tool\",\n    \
             description: \"中文字段：在侧边栏打开页面并读取内容\",\n  }});\n"
        );
        std::fs::write(&file, body).unwrap();
        let mut items: Vec<Value> = Vec::new();
        ingest_extension_source(&file, &mut items);
        let names: Vec<String> = items
            .iter()
            .filter_map(|i| i.get("name").and_then(Value::as_str).map(String::from))
            .collect();
        assert!(names.contains(&"cjk_tool".to_string()), "{names:?}");
    }
}
