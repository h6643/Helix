//! Helix config.yaml / .env read-write helpers.
//! Port of `electron/lib/config.js` (pure string manipulation) plus the
//! getConfig / writeHelixConfig / setModel logic from `electron/main.js`.
//!
//! Helix YAML is edited line-by-line (2-space indentation) so the rest of the
//! file — including comments and ordering — is preserved byte-for-byte.

use crate::paths::{helix_data_dir, pi_agent_dir};

// ─────────────────────────────────────────────────────────────────────────────
// Pi-native model config (single source of truth)
//
// Helix no longer keeps its own model config. The Pi agent's own files are
// read/written directly:
//   ~/.pi/agent/settings.json  — defaultProvider / defaultModel
//   ~/.pi/agent/models.json    — custom providers (baseUrl, apiKey, models)
// config.yaml's `model:` / `custom_providers:` blocks are legacy and ignored
// for model selection.
// ─────────────────────────────────────────────────────────────────────────────

fn pi_settings_path() -> PathBuf {
    pi_agent_dir().join("settings.json")
}

fn pi_models_path() -> PathBuf {
    pi_agent_dir().join("models.json")
}

/// Read Pi's settings.json as JSON (empty object on any error).
fn read_pi_settings() -> serde_json::Value {
    std::fs::read_to_string(pi_settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}))
}

/// Read Pi's models.json as JSON (empty doc on any error).
fn read_pi_models() -> serde_json::Value {
    std::fs::read_to_string(pi_models_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({ "providers": {} }))
}

/// Persist Pi's settings.json, preserving unknown keys.
fn write_pi_settings(settings: &serde_json::Value) {
    let path = pi_settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(buf) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(&path, buf);
    }
}

/// Persist Pi's models.json, preserving unknown keys.
fn write_pi_models(models: &serde_json::Value) {
    let path = pi_models_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(buf) = serde_json::to_string_pretty(models) {
        let _ = std::fs::write(&path, buf);
    }
}

/// Look up a provider entry (baseUrl / apiKey / models) in Pi's models.json.
/// For built-in providers (not in models.json) returns None.
fn pi_provider_entry(provider: &str) -> Option<serde_json::Value> {
    read_pi_models()
        .pointer(&format!("/providers/{provider}"))
        .cloned()
}

/// Read the effective API key for a provider: models.json inline key, or
/// Pi's auth.json credential store, or the legacy .env fallback.
fn pi_provider_api_key(provider: &str) -> String {
    if let Some(entry) = pi_provider_entry(provider) {
        if let Some(key) = entry.get("apiKey").and_then(|v| v.as_str()) {
            return key.to_string();
        }
    }
    // auth.json — Pi's credential store ("provider": {"type":"api_key","key":…})
    if let Ok(raw) = std::fs::read_to_string(pi_agent_dir().join("auth.json")) {
        if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(key) = auth
                .pointer(&format!("/{provider}/key"))
                .and_then(|v| v.as_str())
            {
                return key.to_string();
            }
        }
    }
    String::new()
}
use std::path::PathBuf;

/// Known-good fallback endpoint used when the frontend supplies a dead/bad
/// config (mirror of electron/lib/security.js APIHUB_DEFAULT).
#[derive(Debug, Clone)]
pub struct ApiHubDefault {
    pub provider: &'static str,
    pub base_url: &'static str,
    pub model: &'static str,
    pub api_key: &'static str,
}

pub const APIHUB_DEFAULT: ApiHubDefault = ApiHubDefault {
    provider: "ant-ling",
    base_url: "https://api.ant-ling.com/v1",
    model: "Ling-2.6-1T",
    api_key: "",
};

pub fn config_yaml_path() -> PathBuf {
    helix_data_dir().join("config.yaml")
}

pub fn env_path() -> PathBuf {
    helix_data_dir().join(".env")
}

fn norm_lines(yaml: &str) -> Vec<String> {
    yaml.replace("\r\n", "\n")
        .split('\n')
        .map(|s| s.to_string())
        .collect()
}

fn is_scalar_bool(v: &serde_json::Value) -> bool {
    v.is_boolean()
}

/// Port of `setYamlKey` — sets a 2-level dotted key, preserving the file.
pub fn set_yaml_key(yaml: &str, dotted: &str, value: &serde_json::Value) -> String {
    let parts: Vec<&str> = dotted.split('.').collect();
    if parts.len() != 2 {
        return yaml.to_string();
    }
    let (top, sub) = (parts[0], parts[1]);
    let value_str = if is_scalar_bool(value) {
        if value.as_bool().unwrap_or(false) {
            "true".to_string()
        } else {
            "false".to_string()
        }
    } else {
        value.to_string()
    };
    let mut lines = norm_lines(yaml);
    let mut top_idx = -1i64;
    for (i, l) in lines.iter().enumerate() {
        if !l.starts_with(' ') && l.starts_with(top) && l[top.len()..].starts_with(':') {
            top_idx = i as i64;
            break;
        }
    }
    if top_idx == -1 {
        lines.push(format!("{top}:"));
        lines.push(format!("  {sub}: {value_str}"));
        return lines.join("\n");
    }
    let mut sub_idx = -1i64;
    for i in (top_idx + 1)..lines.len() as i64 {
        let l = &lines[i as usize];
        if !l.starts_with(' ') {
            break;
        }
        let trimmed = l.trim_start();
        if trimmed.starts_with(sub) && trimmed[sub.len()..].starts_with(':') {
            sub_idx = i;
            break;
        }
    }
    if sub_idx != -1 {
        let sub_str = lines[sub_idx as usize].trim_start();
        let lead = &lines[sub_idx as usize][..lines[sub_idx as usize].len() - sub_str.len()];
        lines[sub_idx as usize] = format!("{lead}{sub}: {value_str}");
        // remove duplicate sub: lines within the same parent block
        let mut i = sub_idx + 1;
        while i < lines.len() as i64 {
            let l = &lines[i as usize];
            if !l.starts_with(' ') {
                break;
            }
            let trimmed = l.trim_start();
            if trimmed.starts_with(sub) && trimmed[sub.len()..].starts_with(':') {
                lines.remove(i as usize);
            } else {
                i += 1;
            }
        }
    } else {
        lines.insert((top_idx + 1) as usize, format!("  {sub}: {value_str}"));
    }
    lines.join("\n")
}

fn provider_name_from_url(base_url: &str) -> Option<String> {
    let host = base_url
        .split("://")
        .nth(1)?
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    let mut host = host.as_str();
    for p in ["api.", "apihub.", "gateway."] {
        if let Some(rest) = host.strip_prefix(p) {
            host = rest;
            break;
        }
    }
    host.split('.').next().map(|s| s.to_string())
}
/// Read the effective config (mirror of main.js `helix:getConfig`).
#[derive(Serialize, Default)]
pub struct HelixConfig {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub has_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegation: Option<serde_json::Map<String, serde_json::Value>>,
}

use serde::Serialize;

pub fn read_helix_config() -> HelixConfig {
    let mut res = HelixConfig::default();

    // ── Model selection — read Pi's own config (single source of truth) ──
    let settings = read_pi_settings();
    res.provider = settings
        .get("defaultProvider")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    res.model = settings
        .get("defaultModel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if let Some(entry) = pi_provider_entry(&res.provider) {
        if let Some(base_url) = entry.get("baseUrl").and_then(|v| v.as_str()) {
            res.base_url = base_url.to_string();
        }
    }
    res.has_api_key = !pi_provider_api_key(&res.provider).is_empty();

    // ── Non-model settings still live in config.yaml (delegation etc.) ──
    let yaml_path = config_yaml_path();
    let yaml = match std::fs::read_to_string(&yaml_path) {
        Ok(s) => s.replace("\r\n", "\n"),
        Err(_) => return res,
    };
    // delegation block
    let mut delegation = serde_json::Map::new();
    let mut in_delegation = false;
    for l in yaml.split('\n') {
        if l.starts_with("delegation:") {
            in_delegation = true;
            continue;
        }
        if in_delegation {
            if !l.starts_with(' ') {
                break;
            }
            let t = l.trim_start();
            if let Some(colon) = t.find(':') {
                let key = t[..colon].trim();
                if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    delegation.insert(
                        key.to_string(),
                        serde_json::Value::String(
                            t[colon + 1..]
                                .trim()
                                .trim_matches('"')
                                .trim_matches('\'')
                                .to_string(),
                        ),
                    );
                }
            }
        }
    }
    if !delegation.is_empty() {
        res.delegation = Some(delegation);
    }
    res
}

/// Write the model/provider selection directly into Pi's own config:
/// - `~/.pi/agent/settings.json`  → defaultProvider / defaultModel
/// - `~/.pi/agent/models.json`    → provider entry (baseUrl, apiKey, model list)
///
/// Pi reads these at startup; the caller triggers a gateway respawn so the
/// change takes effect. Returns (model_or_provider_changed, api_key_changed).
fn apply_pi_model_config(
    model: &str,
    provider: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
    context_window: Option<u64>,
) -> (bool, bool) {
    let old_settings = read_pi_settings();
    let old_provider = old_settings
        .get("defaultProvider")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let old_model = old_settings
        .get("defaultModel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Resolve the target provider: explicit name, else derived from the base
    // URL (apihub.agnes-ai.com → agnes-ai), else keep the current one.
    let pi_provider = match provider {
        Some(p) if !p.trim().is_empty() && p.trim() != "__custom__" && p.trim() != "custom" => {
            p.trim().to_string()
        }
        _ => match base_url
            .map(|b| b.trim())
            .filter(|b| !b.is_empty())
            .and_then(provider_name_from_url)
        {
            Some(derived) => derived,
            None => old_provider.clone(),
        },
    };

    // settings.json — defaultProvider / defaultModel (preserve everything else).
    let mut settings = old_settings.clone();
    settings["defaultProvider"] = serde_json::Value::String(pi_provider.clone());
    if !model.is_empty() {
        settings["defaultModel"] = serde_json::Value::String(model.trim().to_string());
    }

    // models.json — register the custom endpoint when a baseUrl is given.
    // maxTokens caps at 65536: gateway-style providers (Agnes) reject pi's
    // 128k default with "max_tokens exceeds the limit of 65536" (HTTP 500),
    // which surfaces as an empty reply.
    // Helix overrides Pi's 128k context fallback with 256k for custom endpoints.
    let mut new_key = api_key.map(|k| k.trim().to_string()).unwrap_or_default();
    let mut models_doc = read_pi_models();
    if let Some(b) = base_url.map(str::trim).filter(|b| !b.is_empty()) {
        if models_doc
            .get("providers")
            .and_then(|v| v.as_object())
            .is_none()
        {
            models_doc["providers"] = serde_json::json!({});
        }
        let models_path_json = format!("/providers/{pi_provider}/models");
        let existing = models_doc
            .pointer(&models_path_json)
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model.trim()))
                    .cloned()
            })
            .unwrap_or(serde_json::json!({ "id": model.trim() }));
        let mut model_entry = existing;
        model_entry["id"] = serde_json::Value::String(model.trim().to_string());
        model_entry["name"] = serde_json::Value::String(model.trim().to_string());
        model_entry["contextWindow"] = serde_json::json!(context_window.unwrap_or(256_000));
        if model_entry
            .get("maxTokens")
            .and_then(|v| v.as_u64())
            .is_none()
        {
            model_entry["maxTokens"] = serde_json::json!(65536);
        }
        // apiKey: prefer an explicit new key, else keep the existing entry's.
        if new_key.is_empty() {
            if let Some(k) = models_doc
                .pointer(&format!("/providers/{pi_provider}/apiKey"))
                .and_then(|v| v.as_str())
            {
                new_key = k.to_string();
            }
        }
        let mut provider_entry = serde_json::json!({
            "baseUrl": b.trim_end_matches('/'),
            "api": "openai-completions",
            "models": [ model_entry ],
        });
        if !new_key.is_empty() {
            provider_entry["apiKey"] = serde_json::Value::String(new_key.clone());
        }
        // Preserve extra fields the user may have set (compat, headers, …).
        if let Some(old_entry) = models_doc
            .pointer(&format!("/providers/{pi_provider}"))
            .and_then(|v| v.as_object())
        {
            for (k, v) in old_entry {
                if !provider_entry.as_object().unwrap().contains_key(k) {
                    provider_entry[k] = v.clone();
                }
            }
        }
        models_doc["providers"][&pi_provider] = provider_entry;
    } else {
        // No baseUrl: nothing in models.json changes for this provider, so
        // the effective key REMAINS the stored one — backfill it so the
        // key-change comparison below doesn't flag a phantom rotation when
        // the caller pushed an empty key (frontend startup re-assert).
        new_key = pi_provider_api_key(&pi_provider);
    }

    let changed = old_provider != pi_provider || old_model != model.trim();
    // The apiKey lives in models.json's provider entry; treat a DIFFERENT key
    // as a change too, else a key-only rotation would skip the respawn that
    // makes pi pick it up (pi snapshots config at process start).
    let key_changed = new_key != pi_provider_api_key(&pi_provider);
    if changed || key_changed {
        write_pi_settings(&settings);
        write_pi_models(&models_doc);
    }
    (changed, key_changed)
}

/// Write model/provider/baseUrl/apiKey from the Settings page. Returns
/// (model_or_provider_changed, api_key_changed) so the caller can respawn the
/// gateway only when something actually changed.
pub fn write_helix_config(
    model: Option<&str>,
    provider: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
    context_window: Option<u64>,
) -> (bool, bool) {
    let model = model.unwrap_or("").trim();
    if model.is_empty() {
        return (false, false);
    }
    apply_pi_model_config(model, provider, base_url, api_key, context_window)
}

/// Switch the active model (chat input selector path).
/// Returns (changed, key_changed) so the caller can respawn the gateway only
/// when something actually changed.
pub fn set_model(
    model: &str,
    base_url: Option<&str>,
    api_key: Option<&str>,
    provider: Option<&str>,
    context_window: Option<u64>,
) -> (bool, bool) {
    apply_pi_model_config(model, provider, base_url, api_key, context_window)
}

/// Read a key from the helix .env (OPENAI_API_KEY / OPENAI_BASE_URL / …).
#[allow(dead_code)]
pub fn read_env_key(key: &str) -> String {
    let Ok(env) = std::fs::read_to_string(env_path()) else {
        return String::new();
    };
    let needle = format!("{key}=");
    env.lines()
        .find(|l| l.starts_with(&needle))
        .map(|l| l[needle.len()..].trim().to_string())
        .unwrap_or_default()
}

/// Set `delegation_identities` in config.yaml, returning the updated YAML.
pub fn set_delegation_identities(yaml: &str, identities: &serde_json::Value) -> String {
    set_yaml_key(yaml, "delegation_identities", identities)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_name_from_url_strips_gateway_prefixes() {
        // gateway hosts derive clean provider ids
        assert_eq!(
            provider_name_from_url("https://apihub.agnes-ai.com/v1"),
            Some("agnes-ai".to_string())
        );
        assert_eq!(
            provider_name_from_url("https://api.tokenrouter.com/v1"),
            Some("tokenrouter".to_string())
        );
        assert_eq!(
            provider_name_from_url("https://api.deepseek.com"),
            Some("deepseek".to_string())
        );
    }

    #[test]
    fn pi_settings_and_models_paths_are_in_agent_dir() {
        // Both live directly under ~/.pi/agent — the single config root.
        let settings = pi_settings_path();
        let models = pi_models_path();
        assert!(settings.ends_with("settings.json"));
        assert!(models.ends_with("models.json"));
        assert_eq!(settings.parent(), models.parent());
        assert_eq!(settings.parent().unwrap().file_name().unwrap(), "agent");
    }
}

// ── Raw Config (full YAML/JSON read-write) ───────────

/// Read the raw config.yaml as a JSON Value.
pub async fn read_raw_config() -> Result<serde_json::Value, String> {
    let path = config_yaml_path();
    let yaml = tokio::task::spawn_blocking({
        let path = path.clone();
        move || std::fs::read_to_string(&path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let value: serde_json::Value =
        serde_yaml::from_str(&yaml).map_err(|e| format!("YAML parse error: {}", e))?;
    Ok(value)
}

/// Write a JSON Value back to config.yaml.
pub async fn write_raw_config(config: serde_json::Value) -> Result<(), String> {
    let yaml =
        serde_yaml::to_string(&config).map_err(|e| format!("YAML serialize error: {}", e))?;

    tokio::task::spawn_blocking(move || {
        let path = config_yaml_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, yaml).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

#[cfg(test)]
mod pi_roundtrip_tests {
    use super::*;

    /// Round-trip against the REAL pi config files (~/.pi/agent/…). Saves and
    /// restores both files so the user's selection is untouched.
    #[test]
    fn apply_pi_model_config_roundtrip_preserves_user_selection() {
        let settings_backup = std::fs::read_to_string(pi_settings_path()).ok();
        let models_backup = std::fs::read_to_string(pi_models_path()).ok();

        // 1) Read current selection via the Helix surface.
        let before = read_helix_config();
        assert!(
            !before.provider.is_empty(),
            "pi settings must have a defaultProvider"
        );

        // 2) Switch to another provider (tokenroute is registered in models.json
        //    on this machine; skip silently if absent).
        let has_tokenroute = pi_provider_entry("tokenroute").is_some();
        if has_tokenroute {
            let (changed, _) =
                apply_pi_model_config("z-ai/glm-5.3-free", Some("tokenroute"), None, None, None);
            assert!(changed, "switching provider must report changed");
            let mid = read_helix_config();
            assert_eq!(mid.provider, "tokenroute");
            assert_eq!(mid.model, "z-ai/glm-5.3-free");
            assert!(!mid.base_url.is_empty(), "baseUrl read from models.json");
            assert!(mid.has_api_key, "apiKey read from models.json");
        }

        // 3) Restore the user's original selection + files.
        let (changed, _) = apply_pi_model_config(
            &before.model,
            Some(&before.provider),
            if before.base_url.is_empty() {
                None
            } else {
                Some(&before.base_url)
            },
            None,
            None,
        );
        assert!(changed || !has_tokenroute);
        let after = read_helix_config();
        assert_eq!(after.provider, before.provider);
        assert_eq!(after.model, before.model);

        // Byte-restore both files exactly as they were (the round-trip above
        // rewrites JSON formatting; keep the user's original formatting).
        if let Some(raw) = settings_backup {
            std::fs::write(pi_settings_path(), raw).unwrap();
        }
        if let Some(raw) = models_backup {
            std::fs::write(pi_models_path(), raw).unwrap();
        }
    }
}
