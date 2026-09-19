//! Profile cache + activation.
//! Port of `electron/ipc/security.js` (profile:cacheConfig) and the
//! `applyActiveProfileCache` / writeHelixConfig logic from `electron/main.js`.

use crate::config::write_helix_config;
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

/// Re-assert the user's last-saved model profile into Pi's own config
/// (settings.json + models.json) BEFORE spawning the gateway. Called from
/// lib.rs setup.
///
/// The apiKey is deliberately NOT carried: pi's own files (models.json inline
/// key / auth.json) are the single source of truth for credentials. Carrying
/// a cached key here re-created provider entries with a STALE key on every
/// restart, clobbering keys the user rotated outside Helix. An empty key
/// preserves the existing entry's key in apply_pi_model_config.
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
    write_helix_config(model, provider, base_url, None, None);
}

/// Persist the active profile to userData/active-profile.json.
///
/// The apiKey is stripped before writing: the cache exists so a cold start can
/// re-assert the last-selected model/provider/baseUrl into pi's config, and
/// credentials live in pi's own files (models.json / auth.json). Persisting
/// the key here meant a later rotation outside Helix got clobbered back on
/// every restart. Callers that DO save a fresh key still apply it immediately
/// via write_helix_config (activate_profile / helix_set_config) — the cache
/// just no longer remembers it.
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
        // 空 baseUrl 的配置拒绝落盘：写进去也不会被 apply/activate 采用（它们
        // 同样按 is_bad_config 跳过），而静默替换成硬编码默认 provider 会在
        // 下次冷启动时悄悄顶掉用户真实在用的 provider。直接报错，让调用方
        // 感知保存失败。
        return json!({ "success": false, "error": "baseUrl is empty" });
    }
    if cfg.get("apiKey").is_some() || cfg.get("api_key").is_some() {
        cfg.as_object_mut().map(|o| {
            o.remove("apiKey");
            o.remove("api_key");
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

// (activate_profile / profile_list removed — the renderer never called them;
// profile application happens through helix_set_config / cache_config.)
