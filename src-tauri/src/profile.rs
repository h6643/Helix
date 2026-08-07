//! Profile cache + activation.
//! Port of `electron/ipc/security.js` (profile:cacheConfig) and the
//! `applyActiveProfileCache` / writeHermesConfig logic from `electron/main.js`.

use crate::config::{write_hermes_config, APIHUB_DEFAULT};
use crate::state::user_data_dir;
use serde_json::{json, Value};

pub const ACTIVE_PROFILE_FILE: &str = "active-profile.json";

pub fn active_profile_path() -> Option<std::path::PathBuf> {
    user_data_dir().map(|d| d.join(ACTIVE_PROFILE_FILE))
}

fn is_bad_config(cfg: &Value) -> bool {
    // Mirror electron/ipc/security.js isBadConfig: empty baseUrl == bad.
    cfg.get("base_url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

/// Re-assert the user's last-saved model profile into Hermes config.yaml
/// BEFORE spawning the gateway. Called from lib.rs setup.
pub fn apply_active_profile_cache() {
    let Some(path) = active_profile_path() else { return };
    if !path.exists() {
        return;
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let cfg: Value = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(_) => return,
    };
    let provider = cfg.get("provider").and_then(|v| v.as_str());
    if provider.is_none() || provider.unwrap().trim().is_empty() {
        return;
    }
    if is_bad_config(&cfg) {
        return;
    }
    let model = cfg.get("model").and_then(|v| v.as_str());
    let base_url = cfg.get("base_url").and_then(|v| v.as_str());
    let api_key = cfg.get("api_key").and_then(|v| v.as_str());
    write_hermes_config(model, provider, base_url, api_key);
}

/// Persist the active profile to userData/active-profile.json.
#[tauri::command]
pub fn cache_config(cfg: Value) -> Value {
    let mut cfg = cfg;
    if is_bad_config(&cfg) {
        // Fall back to the known-good apihub default (mirror Electron).
        cfg = json!({
            "provider": APIHUB_DEFAULT.provider,
            "baseUrl": APIHUB_DEFAULT.base_url,
            "model": APIHUB_DEFAULT.model,
            "apiKey": APIHUB_DEFAULT.api_key,
        });
    }
    let Some(path) = active_profile_path() else {
        return json!({ "success": false, "error": "no user data dir" });
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, cfg.to_string()) {
        Ok(_) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// Apply a profile immediately: write config + persist cache.
#[tauri::command]
pub fn activate_profile(cfg: Value) -> Value {
    if is_bad_config(&cfg) {
        return json!({ "success": false, "error": "invalid profile config" });
    }
    let model = cfg.get("model").and_then(|v| v.as_str());
    let provider = cfg.get("provider").and_then(|v| v.as_str());
    let base_url = cfg.get("baseUrl").or_else(|| cfg.get("base_url")).and_then(|v| v.as_str());
    let api_key = cfg.get("apiKey").or_else(|| cfg.get("api_key")).and_then(|v| v.as_str());
    write_hermes_config(model, provider, base_url, api_key);
    let _ = cache_config(cfg);
    json!({ "success": true })
}

/// List known profiles (placeholder — profile storage lives in the renderer).
#[tauri::command]
pub fn profile_list() -> Value {
    json!({ "ok": true, "profiles": [] })
}
