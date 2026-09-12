//! Profile cache + activation.
//! Port of `electron/ipc/security.js` (profile:cacheConfig) and the
//! `applyActiveProfileCache` / writeHelixConfig logic from `electron/main.js`.

use crate::config::{write_helix_config, APIHUB_DEFAULT};
use crate::state::user_data_dir;
use serde_json::{json, Value};

pub const ACTIVE_PROFILE_FILE: &str = "active-profile.json";

/// Read a string field from a profile config, accepting both the camelCase
/// (renderer: baseUrl/apiKey) and snake_case (legacy) spellings.
fn cfg_str<'a>(cfg: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    cfg.get(camel)
        .or_else(|| cfg.get(snake))
        .and_then(|v| v.as_str())
}

pub fn active_profile_path() -> Option<std::path::PathBuf> {
    user_data_dir().map(|d| d.join(ACTIVE_PROFILE_FILE))
}

fn is_bad_config(cfg: &Value) -> bool {
    // Mirror electron/ipc/security.js isBadConfig: empty baseUrl == bad.
    // Both key spellings are accepted — the renderer writes camelCase, older
    // cached files may carry snake_case.
    let base = cfg_str(cfg, "baseUrl", "base_url").unwrap_or("");
    base.trim().is_empty()
}

/// Re-assert the user's last-saved model profile into Helix config.yaml
/// BEFORE spawning the gateway. Called from lib.rs setup.
pub fn apply_active_profile_cache() {
    let Some(path) = active_profile_path() else {
        return;
    };
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
    let provider = cfg_str(&cfg, "provider", "provider");
    if provider.is_none() || provider.unwrap().trim().is_empty() {
        return;
    }
    if is_bad_config(&cfg) {
        return;
    }
    let model = cfg_str(&cfg, "model", "model");
    let base_url = cfg_str(&cfg, "baseUrl", "base_url");
    let api_key = cfg_str(&cfg, "apiKey", "api_key");
    write_helix_config(model, provider, base_url, api_key, None);
}

/// Persist the active profile to userData/active-profile.json.
#[tauri::command]
pub fn cache_config(cfg: Value) -> Value {
    // Normalize to one shape (camelCase) before writing so every reader can
    // rely on the same keys.
    let mut cfg = cfg;
    if cfg.get("base_url").is_some() && cfg.get("baseUrl").is_none() {
        if let Some(b) = cfg.get("base_url").cloned() {
            cfg["baseUrl"] = b;
        }
    }
    if cfg.get("api_key").is_some() && cfg.get("apiKey").is_none() {
        if let Some(k) = cfg.get("api_key").cloned() {
            cfg["apiKey"] = k;
        }
    }
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
    let model = cfg_str(&cfg, "model", "model");
    let provider = cfg_str(&cfg, "provider", "provider");
    let base_url = cfg_str(&cfg, "baseUrl", "base_url");
    let api_key = cfg_str(&cfg, "apiKey", "api_key");
    write_helix_config(model, provider, base_url, api_key, None);
    let _ = cache_config(cfg);
    json!({ "success": true })
}

/// List known profiles (placeholder — profile storage lives in the renderer).
#[tauri::command]
pub fn profile_list() -> Value {
    json!({ "ok": true, "profiles": [] })
}
