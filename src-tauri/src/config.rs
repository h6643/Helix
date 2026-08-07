//! Hermes config.yaml / .env read-write helpers.
//! Port of `electron/lib/config.js` (pure string manipulation) plus the
//! getConfig / writeHermesConfig / setModel logic from `electron/main.js`.
//!
//! Hermes YAML is edited line-by-line (2-space indentation) so the rest of the
//! file — including comments and ordering — is preserved byte-for-byte.

use crate::paths::hermes_data_dir;
use std::path::PathBuf;

pub const BUILTIN_PROVIDER_ENV: &[(&str, &str)] = &[("stepfun", "STEPFUN_API_KEY"), ("deepseek", "DEEPSEEK_API_KEY")];

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

const KNOWN_BASE_PROVIDERS: &[&str] = &[
    "openai", "anthropic", "openrouter", "agnes-ai", "nous", "moa", "ollama", "vllm", "llamacpp",
    "zai", "kimi-coding", "kimi-coding-cn", "minimax", "minimax-cn", "bedrock", "gemini",
    "deepseek", "qwen", "grok", "xai", "antling",
];

pub fn config_yaml_path() -> PathBuf {
    hermes_data_dir().join("config.yaml")
}

pub fn env_path() -> PathBuf {
    hermes_data_dir().join(".env")
}

fn norm_lines(yaml: &str) -> Vec<String> {
    yaml.replace("\r\n", "\n").split('\n').map(|s| s.to_string()).collect()
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
        if value.as_bool().unwrap_or(false) { "true".to_string() } else { "false".to_string() }
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

/// Extract the `name:` value of each `- name:` entry under `custom_providers:`.
fn custom_provider_names(yaml: &str) -> Vec<String> {
    let mut in_prov = false;
    let mut names = Vec::new();
    for l in norm_lines(yaml) {
        if l.starts_with("custom_providers:") {
            in_prov = true;
            continue;
        }
        if !in_prov {
            continue;
        }
        if !l.starts_with(' ') && !l.starts_with('-') {
            break;
        }
        if let Some(idx) = l.find("- name:") {
            let name = l[idx + "- name:".len()..].trim().to_string();
            if !name.is_empty() {
                names.push(name);
            }
        }
    }
    names
}

fn custom_provider_base_url(yaml: &str, name: &str) -> String {
    let mut active = false;
    for l in norm_lines(yaml) {
        if let Some(idx) = l.find("- name:") {
            active = l[idx + "- name:".len()..].trim() == name;
            continue;
        }
        if active {
            let t = l.trim_start();
            if let Some(rest) = t.strip_prefix("base_url:") {
                return rest.trim().trim_end_matches('/').to_string();
            }
            if !l.starts_with(' ') && !l.starts_with('-') {
                return String::new();
            }
        }
    }
    String::new()
}

pub fn custom_provider_api_key(yaml: &str, name: &str) -> String {
    let mut active = false;
    for l in norm_lines(yaml) {
        if let Some(idx) = l.find("- name:") {
            active = l[idx + "- name:".len()..].trim() == name;
            continue;
        }
        if active {
            let t = l.trim_start();
            if let Some(rest) = t.strip_prefix("api_key:") {
                return rest.trim().to_string();
            }
            if !l.starts_with(' ') && !l.starts_with('-') {
                return String::new();
            }
        }
    }
    String::new()
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

pub fn resolve_provider(yaml: &str, requested: Option<&str>, new_base_url: Option<&str>) -> String {
    let custom_names = custom_provider_names(yaml);
    let valid_named = |p: &str| custom_names.iter().any(|n| n == p);
    let valid_base = |p: &str| KNOWN_BASE_PROVIDERS.contains(&p);

    if let Some(nb) = new_base_url {
        if !nb.trim().is_empty() {
            let norm_new = nb.trim_end_matches('/').to_string();
            for n in &custom_names {
                if custom_provider_base_url(yaml, n).trim_end_matches('/') == norm_new {
                    return n.clone();
                }
            }
            if let Some(derived) = provider_name_from_url(&norm_new) {
                return derived;
            }
        }
    }
    if let Some(req) = requested {
        if !req.trim().is_empty() && valid_named(req.trim()) {
            return req.trim().to_string();
        }
        if !req.trim().is_empty() && valid_base(req.trim()) {
            return req.trim().to_string();
        }
    }
    if !custom_names.is_empty() {
        return custom_names[0].clone();
    }
    "custom".to_string()
}

pub fn disambiguate_custom_provider(yaml: &str, name: &str) -> String {
    let colliding: Vec<&str> = BUILTIN_PROVIDER_ENV.iter().map(|(n, _)| *n).collect();
    let custom_names = custom_provider_names(yaml);
    if custom_names.iter().any(|n| n == name) && colliding.contains(&name) {
        return format!("custom:{name}");
    }
    name.to_string()
}

/// Port of `setCustomProviderModel` / `setCustomProviderField`.
pub fn set_custom_provider_field(yaml: &str, name: &str, field: &str, value: &str) -> String {
    if name.is_empty() || field.is_empty() || value.is_empty() {
        return yaml.to_string();
    }
    let mut lines = norm_lines(yaml);
    let mut in_prov = false;
    let mut entry_active = false;
    let mut entry_found = false;
    let mut entry_end = -1i64;
    for i in 0..lines.len() {
        let lp = &lines[i];
        if lp.starts_with("custom_providers:") {
            in_prov = true;
            continue;
        }
        if !in_prov {
            continue;
        }
        if !lp.starts_with(' ') && !lp.starts_with('-') {
            break;
        }
        if let Some(idx) = lp.find("- name:") {
            let n = lp[idx + "- name:".len()..].trim();
            entry_active = n == name;
            if entry_active {
                entry_found = true;
                entry_end = i as i64;
            }
            continue;
        }
        if entry_active {
            let t = lp.trim_start();
            if t.starts_with(field) && t[field.len()..].starts_with(':') {
                let lead = &lp[..lp.len() - t.len()];
                lines[i] = format!("{lead}{field}: {value}");
                return lines.join("\n");
            }
            entry_end = i as i64;
        }
    }
    if !entry_found {
        let default_base_url = "https://api.openai.com/v1";
        let default_model = "gpt-4o";
        let fld = if field == "base_url" { value } else { default_base_url };
        let mdl = if field == "model" { value } else { default_model };
        let entry_lines = vec![
            format!("  - name: {name}"),
            format!("    base_url: {fld}"),
            "    api_key_env: OPENAI_API_KEY".to_string(),
            format!("    model: {mdl}"),
        ];
        let has_block = yaml.contains("custom_providers:");
        if has_block {
            let mut in_p = false;
            let mut last_idx = -1i64;
            for (i, l) in lines.iter().enumerate() {
                if l.starts_with("custom_providers:") {
                    in_p = true;
                    continue;
                }
                if in_p {
                    if !l.starts_with(' ') && !l.starts_with('-') {
                        in_p = false;
                        continue;
                    }
                    last_idx = i as i64;
                }
            }
            if last_idx >= 0 {
                for (k, el) in entry_lines.iter().enumerate() {
                    lines.insert((last_idx + 1) as usize + k, el.clone());
                }
                return lines.join("\n");
            }
            return format!("{}\n{}\n", yaml.replace("\r\n", "\n"), entry_lines.join("\n"));
        }
        let mut block = vec!["custom_providers:".to_string()];
        block.extend(entry_lines);
        block.push(String::new());
        block.push(yaml.replace("\r\n", "\n"));
        return block.join("\n");
    }
    lines.insert((entry_end + 1) as usize, format!("    {field}: {value}"));
    lines.join("\n")
}

/// Write `delegation.identities` as a JSON-on-one-line YAML flow value.
pub fn set_delegation_identities(yaml: &str, identities: &serde_json::Value) -> String {
    let arr = if identities.is_array() { identities.clone() } else { serde_json::json!([]) };
    let value_str = arr.to_string();
    let line = format!("  identities: {value_str}");
    let mut lines = norm_lines(yaml);
    let mut top_idx = -1i64;
    for (i, l) in lines.iter().enumerate() {
        if !l.starts_with(' ') && l.starts_with("delegation:") {
            top_idx = i as i64;
            break;
        }
    }
    if top_idx == -1 {
        lines.push("delegation:".to_string());
        lines.push(line);
        return lines.join("\n");
    }
    // find block extent
    let mut block_end = top_idx;
    for i in (top_idx + 1)..lines.len() as i64 {
        if !lines[i as usize].starts_with(' ') {
            break;
        }
        block_end = i;
    }
    let mut i = block_end;
    while i > top_idx {
        if lines[i as usize].trim_start().starts_with("identities:") {
            lines.remove(i as usize);
        }
        i -= 1;
    }
    lines.insert((top_idx + 1) as usize, line);
    lines.join("\n")
}

/// Parse the `agent:` block into a flat map of personality fields.
pub fn parse_hermes_personalities(yaml: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let lines = norm_lines(yaml);
    let mut start = -1i64;
    for (i, l) in lines.iter().enumerate() {
        if l.starts_with("agent:") {
            start = i as i64;
            break;
        }
    }
    if start == -1 {
        return out;
    }
    for i in (start + 1)..lines.len() as i64 {
        let l = &lines[i as usize];
        if !l.starts_with(' ') {
            break;
        }
        if let Some(rest) = l.strip_prefix("    ") {
            if let Some(colon) = rest.find(':') {
                let key = &rest[..colon];
                if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    let val = rest[colon + 1..].trim().trim_matches('"').trim_matches('\'').to_string();
                    out.insert(key.to_string(), serde_json::Value::String(val));
                }
            }
        }
    }
    out
}

/// Set `agent.system_prompt` (quoted YAML scalar).
pub fn set_agent_system_prompt(yaml: &str, value: &str) -> String {
    let safe = format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    set_yaml_key(yaml, "agent.system_prompt", &serde_json::Value::String(safe))
}

/// Read the effective Hermes config (mirror of main.js `hermes:getConfig`).
#[derive(Serialize, Default)]
pub struct HermesConfig {
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

pub fn read_hermes_config() -> HermesConfig {
    let mut res = HermesConfig::default();
    let yaml_path = config_yaml_path();
    let env_path = env_path();
    let yaml = match std::fs::read_to_string(&yaml_path) {
        Ok(s) => s.replace("\r\n", "\n"),
        Err(e) => {
            res.error = Some(e.to_string());
            return res;
        }
    };
    let mut in_model = false;
    let mut in_providers = false;
    let mut entry_active = false;
    let mut cp_base_url = String::new();
    let mut cp_model = String::new();
    for l in yaml.split('\n') {
        let lp = l;
        if let Some(rest) = lp.strip_prefix("provider:") {
            if !in_model && !in_providers {
                res.provider = rest.trim().to_string();
                continue;
            }
        }
        if lp.starts_with("model:") {
            in_model = true;
            continue;
        }
        if lp.starts_with("custom_providers:") {
            in_model = false;
            in_providers = true;
            continue;
        }
        if in_model {
            if !lp.starts_with(' ') {
                in_model = false;
            } else {
                let t = lp.trim_start();
                if let Some(rest) = t.strip_prefix("provider:") {
                    res.provider = rest.trim().to_string();
                } else if let Some(rest) = t.strip_prefix("default:") {
                    res.model = rest.trim().to_string();
                } else if let Some(rest) = t.strip_prefix("base_url:") {
                    res.base_url = rest.trim().to_string();
                }
                continue;
            }
        }
        if in_providers {
            if !lp.starts_with(' ') && !lp.starts_with('-') {
                in_providers = false;
                entry_active = false;
                continue;
            }
            if let Some(idx) = lp.find("- name:") {
                entry_active = lp[idx + "- name:".len()..].trim() == res.provider;
                continue;
            }
            if entry_active {
                let t = lp.trim_start();
                if let Some(rest) = t.strip_prefix("base_url:") {
                    cp_base_url = rest.trim().to_string();
                } else if let Some(rest) = t.strip_prefix("model:") {
                    cp_model = rest.trim().to_string();
                }
            }
        }
    }
    if !cp_base_url.is_empty() {
        res.base_url = cp_base_url;
    }
    if !cp_model.is_empty() {
        res.model = cp_model;
    }
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
                    delegation.insert(key.to_string(), serde_json::Value::String(t[colon + 1..].trim().trim_matches('"').trim_matches('\'').to_string()));
                }
            }
        }
    }
    if !delegation.is_empty() {
        res.delegation = Some(delegation);
    }
    if let Ok(env) = std::fs::read_to_string(&env_path) {
        res.has_api_key = env.lines().any(|l| l.starts_with("OPENAI_API_KEY="));
    }
    res
}

fn provider_env_var(name: &str) -> Option<&'static str> {
    BUILTIN_PROVIDER_ENV.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

/// Sync `.env` — the OPENAI_BASE_URL / OPENAI_API_KEY / provider-specific keys.
fn sync_env(base_url: Option<&str>, api_key: Option<&str>, provider: &str) {
    let env_path = env_path();
    let mut content = String::new();
    if let Ok(c) = std::fs::read_to_string(&env_path) {
        content = c;
    }
    let strip_key = api_key.map_or(false, |k| !k.is_empty());
    let mut lines: Vec<String> = content
        .split('\n')
        .filter(|l| {
            !l.starts_with("OPENAI_BASE_URL=")
                && !starts_provider_key(l)
                && !(strip_key && l.starts_with("OPENAI_API_KEY="))
        })
        .map(|s| s.to_string())
        .collect();
    if let Some(b) = base_url {
        if !b.is_empty() {
            lines.push(format!("OPENAI_BASE_URL={b}"));
        }
    }
    if let Some(k) = api_key {
        if !k.is_empty() {
            lines.push(format!("OPENAI_API_KEY={k}"));
            if let Some(ev) = provider_env_var(provider) {
                lines.push(format!("{ev}={k}"));
            }
        }
    }
    if let Some(dir) = env_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&env_path, lines.join("\n"));
}

fn starts_provider_key(l: &str) -> bool {
    // matches /^\w+_API_KEY=/
    if let Some(eq) = l.find('=') {
        let k = &l[..eq];
        !k.is_empty()
            && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && k.ends_with("_API_KEY")
    } else {
        false
    }
}

/// Write model/provider/baseUrl/apiKey into config.yaml + .env.
/// Mirrors `writeHermesConfig` in main.js.
pub fn write_hermes_config(model: Option<&str>, provider: Option<&str>, base_url: Option<&str>, api_key: Option<&str>) {
    let yaml_path = config_yaml_path();
    let mut yaml = String::new();
    if let Ok(c) = std::fs::read_to_string(&yaml_path) {
        yaml = c;
    }
    let incoming_key = api_key.map(|k| k.trim().to_string()).unwrap_or_default();
    // on-disk OPENAI_API_KEY (fallback)
    let mut disk_key = String::new();
    if let Ok(env) = std::fs::read_to_string(env_path()) {
        for l in env.lines() {
            if let Some(rest) = l.strip_prefix("OPENAI_API_KEY=") {
                disk_key = rest.trim().to_string();
                break;
            }
        }
    }
    let req_provider = match provider {
        Some(p) if !p.is_empty() && p != "__custom__" && p != "custom" => p.to_string(),
        _ => "custom".to_string(),
    };
    let resolved = resolve_provider(&yaml, Some(&req_provider), base_url.filter(|b| !b.trim().is_empty()));
    let target_cp_key = custom_provider_api_key(&yaml, &resolved);
    let effective_key = if !incoming_key.is_empty() {
        incoming_key.clone()
    } else if !target_cp_key.is_empty() {
        target_cp_key
    } else {
        disk_key
    };

    sync_env(base_url, Some(&effective_key), &resolved);

    if model.is_some() || provider.is_some() || base_url.is_some() {
        let mut updated = yaml.clone();
        if let Some(m) = model {
            updated = set_yaml_key(&updated, "model.default", &serde_json::Value::String(m.trim().to_string()));
        }
        let yaml_provider = disambiguate_custom_provider(&updated, &resolved);
        updated = set_yaml_key(&updated, "model.provider", &serde_json::Value::String(yaml_provider));
        if let Some(b) = base_url {
            updated = set_yaml_key(&updated, "model.base_url", &serde_json::Value::String(b.trim().to_string()));
        }
        if let Some(m) = model {
            updated = set_custom_provider_field(&updated, &resolved, "model", m.trim());
        }
        if let Some(b) = base_url {
            updated = set_custom_provider_field(&updated, &resolved, "base_url", b.trim());
        }
        if !effective_key.is_empty() {
            updated = set_custom_provider_field(&updated, &resolved, "api_key", &effective_key);
            updated = set_yaml_key(&updated, "model.api_key", &serde_json::Value::String(effective_key));
        }
        if let Some(dir) = yaml_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&yaml_path, updated);
    }
}

/// Mirrors the `hermes:setModel` handler. Returns (changed, key_changed).
pub fn set_model(model: &str, base_url: Option<&str>, api_key: Option<&str>, provider: Option<&str>) -> (bool, bool) {
    let hermes_dir = hermes_data_dir();
    let requested = provider
        .filter(|p| !p.trim().is_empty() && p.trim() != "custom")
        .map(|p| p.trim().to_string())
        .unwrap_or_default();
    let mut hermes_key = api_key.map(|k| k.trim().to_string()).unwrap_or_default();
    if hermes_key.is_empty() && base_url.map_or(true, |b| b.trim().is_empty()) {
        if let Ok(env) = std::fs::read_to_string(hermes_dir.join(".env")) {
            for l in env.lines() {
                if let Some(rest) = l.strip_prefix("OPENAI_API_KEY=") {
                    hermes_key = rest.trim().to_string();
                    break;
                }
            }
        }
    }
    let mut old_env_key = String::new();
    if let Ok(env) = std::fs::read_to_string(hermes_dir.join(".env")) {
        for l in env.lines() {
            if let Some(rest) = l.strip_prefix("OPENAI_API_KEY=") {
                old_env_key = rest.trim().to_string();
                break;
            }
        }
    }
    let base_url_s = base_url.unwrap_or_default();
    let mut prev_default = String::new();
    let mut prev_yaml_has_provider = false;
    let mut prev_provider = String::new();
    let mut prev_base = String::new();

    let dirs: Vec<PathBuf> = vec![hermes_dir.clone(), dirs::home_dir().unwrap_or_default().join(".hermes")];
    for config_dir in dirs {
        let yaml_path = config_dir.join("config.yaml");
        let Ok(yaml) = std::fs::read_to_string(&yaml_path) else { continue };
        if config_dir == hermes_dir {
            prev_default = extract_after(&yaml, "model.default:");
            prev_yaml_has_provider = yaml.contains("model.provider");
            prev_provider = extract_after(&yaml, "model.provider:");
            prev_base = extract_after(&yaml, "model.base_url:");
        }
        let eff_provider = resolve_provider(&yaml, if requested.is_empty() { None } else { Some(&requested) }, if base_url_s.trim().is_empty() { None } else { Some(&base_url_s) });
        let mut updated = set_yaml_key(&yaml, "model.default", &serde_json::Value::String(model.trim().to_string()));
        updated = set_yaml_key(&updated, "model.base_url", &serde_json::Value::String(base_url_s.trim().to_string()));
        let yaml_provider = disambiguate_custom_provider(&updated, &eff_provider);
        updated = set_yaml_key(&updated, "model.provider", &serde_json::Value::String(yaml_provider));
        if !hermes_key.is_empty() {
            updated = set_yaml_key(&updated, "model.api_key", &serde_json::Value::String(hermes_key.clone()));
        }
        updated = set_custom_provider_field(&updated, &eff_provider, "model", model.trim());
        if !hermes_key.is_empty() && !eff_provider.is_empty() {
            updated = set_custom_provider_field(&updated, &eff_provider, "api_key", &hermes_key);
        }
        let _ = std::fs::create_dir_all(&config_dir);
        let _ = std::fs::write(&yaml_path, updated);
        if config_dir == hermes_dir {
            if !base_url_s.trim().is_empty() || !hermes_key.is_empty() {
                let key_for_env = if hermes_key.is_empty() { None } else { Some(hermes_key.as_str()) };
                sync_env(if base_url_s.trim().is_empty() { None } else { Some(base_url_s.trim()) }, key_for_env, &eff_provider);
            }
        }
    }
    let model_changed = prev_default.trim() != model.trim();
    let changed = prev_yaml_has_provider
        && (prev_provider.trim() != requested || prev_base.trim() != base_url_s.trim() || model_changed);
    let key_changed = old_env_key != hermes_key;
    (changed, key_changed)
}

fn extract_after(yaml: &str, key: &str) -> String {
    yaml.lines()
        .find_map(|l| l.trim().strip_prefix(key).map(|r| r.trim().to_string()))
        .unwrap_or_default()
}

/// Write `agent:` block settings (reasoning_effort, system_prompt).
pub fn write_agent_config(reasoning_effort: Option<&str>, personality: Option<&str>) {
    let yaml_path = config_yaml_path();
    let Ok(mut yaml) = std::fs::read_to_string(&yaml_path) else { return };
    if let Some(re) = reasoning_effort {
        yaml = set_yaml_key(&yaml, "agent.reasoning_effort", &serde_json::Value::String(re.to_string()));
    }
    if let Some(p) = personality {
        if !p.trim().is_empty() {
            let safe = format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""));
            yaml = set_yaml_key(&yaml, "agent.system_prompt", &serde_json::Value::String(safe));
        }
    }
    let _ = std::fs::write(&yaml_path, yaml);
}

/// Pin `coding_context: off` into config.yaml so a Windows git subprocess
/// deadlock can never hang model output (mirror ensureCodingContextOff in
/// electron/main.js). Survives Hermes config rewrites.
pub fn ensure_coding_context_off() {
    let yaml_path = config_yaml_path();
    let Ok(yaml) = std::fs::read_to_string(&yaml_path) else { return };
    // fix any legacy broken inline-merge (e.g. "max_turns: 150  coding_context: off")
    let mut yaml = yaml;
    let lines: Vec<String> = yaml.split('\n').map(|s| s.to_string()).collect();
    let fixed: Vec<String> = lines
        .into_iter()
        .map(|l| {
            let t = l.trim_start();
            if let Some(rest) = t.strip_prefix("max_turns:") {
                if let Some(num_end) = rest.trim_start().find(|c: char| !c.is_ascii_digit()) {
                    let num = &rest.trim_start()[..num_end];
                    let lead = &l[..l.len() - l.trim_start().len()];
                    let _ = num;
                    return format!("{lead}max_turns: {num}");
                }
            }
            l
        })
        .collect();
    yaml = fixed.join("\n");
    let updated = set_yaml_key(&yaml, "agent.coding_context", &serde_json::Value::String("off".into()));
    if updated != yaml {
        let _ = std::fs::write(&yaml_path, updated);
    }
}

/// Read a key from the hermes .env (OPENAI_API_KEY / OPENAI_BASE_URL / …).
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
