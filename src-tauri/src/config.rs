//! Helix config.yaml read-write helpers.
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
pub fn read_pi_settings() -> serde_json::Value {
    std::fs::read_to_string(pi_settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}))
}

/// Read Pi's models.json as JSON (empty doc on any error).
pub fn read_pi_models() -> serde_json::Value {
    std::fs::read_to_string(pi_models_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({ "providers": {} }))
}

/// Persist Pi's settings.json, preserving unknown keys.
pub fn write_pi_settings(settings: &serde_json::Value) {
    if let Ok(buf) = serde_json::to_string_pretty(settings) {
        let _ = atomic_write(&pi_settings_path(), &buf);
    }
}

/// Persist Pi's models.json, preserving unknown keys.
pub fn write_pi_models(models: &serde_json::Value) {
    if let Ok(buf) = serde_json::to_string_pretty(models) {
        let _ = atomic_write(&pi_models_path(), &buf);
    }
}

/// Look up a provider entry (baseUrl / apiKey / models) in Pi's models.json.
/// For built-in providers (not in models.json) returns None.
fn pi_provider_entry(provider: &str) -> Option<serde_json::Value> {
    read_pi_models()
        .pointer(&format!("/providers/{provider}"))
        .cloned()
}

/// The context window (in tokens) of the currently selected model, resolved
/// from `~/.pi/agent/models.json` (the custom-endpoint entries Helix writes)
/// or the `defaultProvider`/`defaultModel` settings. Used to populate the
/// context-usage ring when a resumed session's pi instance has not yet been
/// told the window by `get_state`. Returns `None` when the model is
/// unknown — the ring stays at 0 instead of inventing a number.
pub fn model_context_window_fallback() -> i64 {
    let settings = read_pi_settings();
    let provider = settings
        .get("defaultProvider")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let model = settings
        .get("defaultModel")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if provider.is_empty() && model.is_empty() {
        return 0;
    }
    let models_doc = read_pi_models();
    let entry = models_doc
        .pointer(&format!("/providers/{provider}/models"))
        .and_then(|v| v.as_array());
    let found = entry
        .map(|arr| {
            arr.iter()
                .find(|m| {
                    m.get("id")
                        .and_then(|v| v.as_str())
                        .is_some_and(|id| id == model || id.contains(&model))
                })
                .cloned()
        })
        .flatten();
    found
        .and_then(|m| m.get("contextWindow").and_then(|v| v.as_i64()))
        .unwrap_or(0)
}

/// Read the effective API key for a provider: models.json inline key, or
/// Pi's auth.json credential store.
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

pub fn config_yaml_path() -> PathBuf {
    helix_data_dir().join("config.yaml")
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

    // Resolve the target provider: explicit name wins; otherwise keep the stored one.
    let pi_provider = match provider {
        Some(p) if !p.trim().is_empty() && p.trim() != "__custom__" && p.trim() != "custom" => {
            p.trim().to_string()
        }
        _ => old_provider.clone(),
    };

    // settings.json — defaultProvider / defaultModel (preserve everything else).
    let mut settings = old_settings.clone();
    settings["defaultProvider"] = serde_json::Value::String(pi_provider.clone());
    if !model.is_empty() {
        settings["defaultModel"] = serde_json::Value::String(model.trim().to_string());
    }

    // models.json — register the custom endpoint when a baseUrl is given.
    // maxTokens caps at 65536:Helix overrides Pi's 128k context fallback with 256k for custom endpoints.
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
        // Read the whole existing provider entry first: a provider registered
        // through the multi-model settings flow can list several models, and a
        // single-model write (chat dropdown switch) must update ONE entry in
        // that list instead of collapsing it to the model being switched to.
        let old_entry: serde_json::Value = models_doc
            .pointer(&format!("/providers/{pi_provider}"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let mut entries: Vec<serde_json::Value> = old_entry
            .get("models")
            .and_then(|v| v.as_array())
            .map(|arr| arr.clone())
            .unwrap_or_default();
        let model_entry_pos = entries
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(model.trim()));
        let mut model_entry = match model_entry_pos {
            Some(i) => entries.remove(i),
            None => serde_json::json!({ "id": model.trim() }),
        };
        model_entry["id"] = serde_json::Value::String(model.trim().to_string());
        model_entry["name"] = serde_json::Value::String(model.trim().to_string());
        // An explicit window wins; otherwise keep the limit already registered
        // for this model (the settings flow stores one per model) and only fall
        // back to 256k for a brand-new entry, which otherwise gets pi's 128k.
        if let Some(cw) = context_window {
            model_entry["contextWindow"] = serde_json::json!(cw);
        } else if model_entry
            .get("contextWindow")
            .and_then(|v| v.as_u64())
            .is_none()
        {
            model_entry["contextWindow"] = serde_json::json!(256_000);
        }
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
        // Preserve the provider's API format rather than hardcoding
        // "openai-completions": a single-model write (chat selector) must not
        // erase a format recorded by the multi-model provider flow.
        let api_format = old_entry
            .get("api")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("openai-completions")
            .to_string();
        entries.push(model_entry);
        let mut provider_entry = serde_json::json!({
            "baseUrl": b.trim_end_matches('/'),
            "api": api_format,
            "models": entries,
        });
        if !new_key.is_empty() {
            provider_entry["apiKey"] = serde_json::Value::String(new_key.clone());
        }
        // Preserve extra fields the user may have set (compat, headers, …).
        if let Some(old) = old_entry.as_object() {
            for (k, v) in old {
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

/// Register a provider with its full model list in pi's models.json and set
/// the first entry as pi's default model.
///
/// The settings "添加供应商" flow collects several models first, each with its
/// own context limit. `apply_pi_model_config` handles exactly one model and
/// replaces the provider's `models` array, so it would drop every other entry;
/// this one merges instead, so bundled models pi already registered survive a
/// re-save. Returns (changed, key_changed) so the caller only respawns the
/// gateway when something actually changed.
pub fn apply_pi_provider_models(
    provider: &str,
    base_url: &str,
    api_key: Option<&str>,
    api: &str,
    models: &[(String, Option<u64>)],
) -> (bool, bool) {
    let pi_provider = provider.trim();
    let base = base_url.trim().trim_end_matches('/');
    let api = if api.trim().is_empty() {
        "openai-completions".to_string()
    } else {
        api.trim().to_string()
    };
    let default_model = models
        .iter()
        .find(|(id, _)| !id.trim().is_empty())
        .map(|(id, _)| id.trim().to_string());
    if pi_provider.is_empty() || base.is_empty() || default_model.is_none() {
        return (false, false);
    }
    let default_model = default_model.unwrap();

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

    let mut models_doc = read_pi_models();
    if models_doc
        .get("providers")
        .and_then(|v| v.as_object())
        .is_none()
    {
        models_doc["providers"] = serde_json::json!({});
    }
    let old_entry: serde_json::Value = models_doc
        .pointer(&format!("/providers/{pi_provider}"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    // Keep the stored key when the caller sent nothing (startup re-assert must
    // not rotate it to an empty string).
    let mut new_key = api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .unwrap_or_default();
    if new_key.is_empty() {
        new_key = pi_provider_api_key(pi_provider);
    }

    let mut entries: Vec<serde_json::Value> = old_entry
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| arr.clone())
        .unwrap_or_default();
    for (id, context_window) in models {
        let id = id.trim().to_string();
        if id.is_empty() {
            continue;
        }
        let mut entry = entries
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            .map(|i| entries.remove(i))
            .unwrap_or_else(|| serde_json::json!({ "id": id }));
        entry["id"] = serde_json::Value::String(id.clone());
        entry["name"] = serde_json::Value::String(id);
        if let Some(cw) = context_window {
            entry["contextWindow"] = serde_json::json!(cw);
        }
        if entry.get("maxTokens").and_then(|v| v.as_u64()).is_none() {
            entry["maxTokens"] = serde_json::json!(65536);
        }
        entries.push(entry);
    }
    if entries.is_empty() {
        return (false, false);
    }

    // Models-only edits leave defaultProvider/defaultModel untouched, so the
    // pair above would report "unchanged" and skip the write. Compare what
    // would be written against what is already on disk.
    let endpoint_changed = old_entry
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        != base
        || old_entry
            .get("api")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            != api.as_str();
    let models_changed = old_entry
        .get("models")
        .and_then(|v| v.as_array())
        .map(|old| serde_json::Value::Array(old.clone()) != serde_json::Value::Array(entries.clone()))
        .unwrap_or(true);

    let mut provider_entry = serde_json::json!({
        "baseUrl": base,
        "api": api,
        "models": entries,
    });
    if !new_key.is_empty() {
        provider_entry["apiKey"] = serde_json::Value::String(new_key.clone());
    }
    // Preserve extra fields the user may have set (compat, headers, …).
    if let Some(old) = old_entry.as_object() {
        for (k, v) in old {
            if !provider_entry.as_object().unwrap().contains_key(k) {
                provider_entry[k] = v.clone();
            }
        }
    }
    models_doc["providers"][pi_provider] = provider_entry;

    let mut settings = old_settings.clone();
    settings["defaultProvider"] = serde_json::Value::String(pi_provider.to_string());
    settings["defaultModel"] = serde_json::Value::String(default_model.clone());

    let changed = old_provider != pi_provider
        || old_model != default_model
        || endpoint_changed
        || models_changed;
    let key_changed = new_key != pi_provider_api_key(pi_provider);
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

/// Set `delegation_identities` in config.yaml, returning the updated YAML.
pub fn set_delegation_identities(yaml: &str, identities: &serde_json::Value) -> String {
    set_yaml_key(yaml, "delegation_identities", identities)
}

/// Read a 2-level scalar block from config.yaml (e.g. the `vision:` block):
/// returns the sub-key → scalar string map, `{}` when the top-level key is
/// absent. Mirrors the line-oriented style of `read_helix_config`'s
/// delegation parser — config.yaml is intentionally not parsed with a real
/// YAML library so comments and ordering survive the round-trip.
pub fn read_yaml_block(yaml: &str, top: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let mut in_block = false;
    for l in yaml.replace("\r\n", "\n").split('\n') {
        if !l.starts_with(' ') {
            let is_top = l.starts_with(top) && l[top.len()..].starts_with(':');
            if !is_top {
                in_block = false;
                continue;
            }
            in_block = true;
            continue;
        }
        if !in_block {
            continue;
        }
        let t = l.trim_start();
        if t.starts_with('#') {
            continue;
        }
        let Some(colon) = t.find(':') else { continue };
        let key = t[..colon].trim();
        if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let val = t[colon + 1..].trim().trim_matches('"').trim_matches('\'');
        out.insert(key.to_string(), serde_json::Value::String(val.to_string()));
    }
    out
}

/// Atomic file write (tmp + rename) — the same pattern `hooks_save` uses, so
/// a crash mid-write can never leave a truncated settings.json / config.yaml.
pub fn atomic_write(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("tmp")
    ));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
        use super::*;

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

// (read_raw_config / write_raw_config removed with the tauri-bridge methods
// that called them — config edits go through set_yaml_key / set_config paths.)

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
