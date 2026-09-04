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
    "openai", "anthropic", "openrouter", "agnes-ai", "nous", "moa", "vllm", "llamacpp",
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

/// Like `set_yaml_key` but supports arbitrarily-deep dotted keys
/// (e.g. `auxiliary.vision.model`). `set_yaml_key` (2-level only) silently
/// drops deeper keys, which is exactly why the vision config command needs
/// this variant to write the `auxiliary.vision.*` block.
pub fn set_yaml_key_deep(yaml: &str, dotted: &str, value: &serde_json::Value) -> String {
    let parts: Vec<&str> = dotted.split('.').collect();
    if parts.is_empty() {
        return yaml.to_string();
    }
    let value_str = yaml_scalar_string(value);
    let mut lines: Vec<String> = norm_lines(yaml);
    set_deep(&mut lines, &parts, &value_str, 0, 0);
    lines.join("\n")
}

/// Remove a `key:` line at a dotted path (used to strip legacy inline secrets
/// that are now stored in `.env`, e.g. `auxiliary.vision.api_key`).
pub fn remove_yaml_key_deep(yaml: &str, dotted: &str) -> String {
    let parts: Vec<&str> = dotted.split('.').collect();
    if parts.is_empty() {
        return yaml.to_string();
    }
    let mut lines: Vec<String> = norm_lines(yaml);
    remove_deep(&mut lines, &parts, 0, 0);
    lines.join("\n")
}

fn yaml_scalar_string(value: &serde_json::Value) -> String {
    if let Some(b) = value.as_bool() {
        if b { "true".to_string() } else { "false".to_string() }
    } else if let Some(s) = value.as_str() {
        let needs_quote = s.is_empty()
            || s.chars().any(|c| {
                c == ':' || c == '#' || c == '"' || c == '\'' || c == '%' || c.is_whitespace()
            });
        if needs_quote {
            format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
        } else {
            s.to_string()
        }
    } else if value.is_null() {
        "\"\"".to_string()
    } else {
        value.to_string()
    }
}

/// Find the index of a `key:` header at exactly `indent` spaces, scoped to the
/// block that starts at `start`. A deeper-indented line (more spaces) is
/// intentionally not matched so we don't confuse a child block with a sibling.
/// The search stops at the first non-blank, non-comment line shallower than
/// `indent`, so a same-indent key in an unrelated section (e.g. a
/// `custom_providers` field) can never shadow a nested key like
/// `auxiliary.vision.base_url`.
fn find_at_indent(lines: &[String], key: &str, indent: usize, start: usize) -> Option<usize> {
    let prefix = " ".repeat(indent);
    for (i, l) in lines.iter().enumerate().skip(start) {
        if indent > 0 {
            let trimmed = l.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if leading_spaces(l) < indent {
                break;
            }
        }
        if l.len() >= indent && l.starts_with(&prefix) {
            let rest = &l[indent..];
            if !rest.starts_with(' ') {
                if rest == format!("{key}:") || rest.starts_with(&format!("{key}:")) {
                    return Some(i);
                }
            }
        }
    }
    None
}

/// Recursively locate/create the nested block for `parts[depth..]` and set its
/// leaf to `value_str`. When a parent header exists but the child is missing,
/// the child header is inserted right after the parent header (keeps the block
/// cohesive). When the top-level key is absent it is appended at EOF (the only
/// caller writes `auxiliary.*`, so this stays correct). `start` anchors every
/// lookup to the parent block so nested keys can't leak into sibling sections.
fn set_deep(lines: &mut Vec<String>, parts: &[&str], value_str: &str, indent: usize, start: usize) {
    let key = parts[0];
    let idx = find_at_indent(lines, key, indent, start);
    match idx {
        None => {
            lines.push(format!("{}{}:", " ".repeat(indent), key));
            set_deep(lines, &parts[1..], value_str, indent + 2, lines.len() - 1);
        }
        Some(i) => {
            if parts.len() == 1 {
                lines[i] = format!("{}{}: {}", " ".repeat(indent), key, value_str);
                return;
            }
            let child = parts[1];
            if find_at_indent(lines, child, indent + 2, i + 1).is_none() {
                lines.insert(i + 1, format!("{}{}:", " ".repeat(indent + 2), child));
            }
            set_deep(lines, &parts[1..], value_str, indent + 2, i + 1);
        }
    }
}

/// Recursively remove the leaf `key` line at `parts[0]..`, scoped like
/// `set_deep`. Leaves parent headers (and sibling keys) intact.
fn remove_deep(lines: &mut Vec<String>, parts: &[&str], indent: usize, start: usize) {
    let Some(i) = find_at_indent(lines, parts[0], indent, start) else {
        return;
    };
    if parts.len() == 1 {
        lines.remove(i);
    } else {
        remove_deep(lines, &parts[1..], indent + 2, i + 1);
    }
}

#[derive(Debug)]
struct CustomProviderEntry {
    end: usize,
    dash_indent: usize,
    name: String,
    fields: Vec<(usize, String, String)>,
}

impl CustomProviderEntry {
    fn field(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(_, k, _)| k == key)
            .map(|(_, _, v)| v.as_str())
    }
}

fn leading_spaces(s: &str) -> usize {
    s.len() - s.trim_start().len()
}

fn yaml_scalar(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn parse_custom_provider_entries(yaml: &str) -> Vec<CustomProviderEntry> {
    let lines = norm_lines(yaml);
    let Some(block_start) = lines
        .iter()
        .position(|l| l.starts_with("custom_providers:"))
    else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    let mut current: Option<CustomProviderEntry> = None;

    for i in (block_start + 1)..lines.len() {
        let line = &lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let indent = leading_spaces(line);
        if indent == 0 && !trimmed.starts_with('-') {
            break;
        }

        if let Some(rest) = trimmed.strip_prefix('-') {
            let is_nested_list = current
                .as_ref()
                .is_some_and(|entry| indent > entry.dash_indent);

            if is_nested_list {
                if let Some(entry) = current.as_mut() {
                    entry.end = i + 1;
                }
                continue;
            }

            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            let mut entry = CustomProviderEntry {
                end: i + 1,
                dash_indent: indent,
                name: String::new(),
                fields: Vec::new(),
            };
            let content = rest.trim_start();
            if let Some(colon) = content.find(':') {
                let key = content[..colon].trim().to_string();
                let value = yaml_scalar(&content[colon + 1..]);
                if key == "name" {
                    entry.name = value.clone();
                }
                entry.fields.push((i, key, value));
            }
            current = Some(entry);
            continue;
        }

        if let Some(colon) = trimmed.find(':') {
            let key = trimmed[..colon].trim().to_string();
            let value = yaml_scalar(&trimmed[colon + 1..]);
            if let Some(entry) = current.as_mut() {
                if key == "name" && entry.name.is_empty() {
                    entry.name = value.clone();
                }
                entry.fields.push((i, key, value));
                entry.end = i + 1;
            }
        }
    }

    if let Some(entry) = current {
        entries.push(entry);
    }
    entries
}

/// Extract the `name:` value of each custom provider entry.
fn custom_provider_names(yaml: &str) -> Vec<String> {
    parse_custom_provider_entries(yaml)
        .into_iter()
        .filter_map(|entry| (!entry.name.is_empty()).then_some(entry.name))
        .collect()
}

fn custom_provider_base_url(yaml: &str, name: &str) -> String {
    parse_custom_provider_entries(yaml)
        .into_iter()
        .find(|entry| entry.name == name)
        .and_then(|entry| entry.field("base_url").map(|v| v.trim_end_matches('/').to_string()))
        .unwrap_or_default()
}

pub fn custom_provider_api_key(yaml: &str, name: &str) -> String {
    parse_custom_provider_entries(yaml)
        .into_iter()
        .find(|entry| entry.name == name)
        .and_then(|entry| entry.field("api_key").map(|v| v.to_string()))
        .unwrap_or_default()
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

    let entries = parse_custom_provider_entries(yaml);
    if let Some(entry) = entries.iter().find(|entry| entry.name == name) {
        if let Some((idx, _, _)) = entry.fields.iter().find(|(_, key, _)| key == field) {
            let existing = &lines[*idx];
            let mut lead = existing[..existing.len() - existing.trim_start().len()].to_string();
            if let Some(rest) = existing.trim_start().strip_prefix("- ") {
                if rest.strip_prefix(field).is_some_and(|tail| tail.starts_with(':')) {
                    lead.push_str("- ");
                }
            }
            lines[*idx] = format!("{lead}{field}: {value}");
            return lines.join("\n");
        }

        let field_indent = " ".repeat(entry.dash_indent + 2);
        lines.insert(entry.end, format!("{field_indent}{field}: {value}"));
        return lines.join("\n");
    }

    let dash_indent = entries.first().map_or(2, |entry| entry.dash_indent);
    let field_indent = dash_indent + 2;
    let dash_pad = " ".repeat(dash_indent);
    let field_pad = " ".repeat(field_indent);
    let default_base_url = "https://api.openai.com/v1";
    let default_model = "gpt-4o";
    let fld = if field == "base_url" { value } else { default_base_url };
    let mdl = if field == "model" { value } else { default_model };
    let new_lines = vec![
        format!("{dash_pad}- name: {name}"),
        format!("{field_pad}base_url: {fld}"),
        format!("{field_pad}api_key_env: OPENAI_API_KEY"),
        format!("{field_pad}model: {mdl}"),
    ];

    let Some(block_start) = lines.iter().position(|l| l.starts_with("custom_providers:")) else {
        let mut block = vec!["custom_providers:".to_string()];
        block.extend(new_lines);
        block.push(String::new());
        block.extend(lines);
        return block.join("\n");
    };

    let mut insert_at = lines.len();
    for i in (block_start + 1)..lines.len() {
        let trimmed = lines[i].trim();
        if !trimmed.is_empty() && !trimmed.starts_with('-') && leading_spaces(&lines[i]) == 0 {
            insert_at = i;
            break;
        }
    }
    for (offset, line) in new_lines.into_iter().enumerate() {
        lines.insert(insert_at + offset, line);
    }
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

    let custom_names = custom_provider_names(&yaml);
    let provider_for_custom = res
        .provider
        .strip_prefix("custom:")
        .unwrap_or(&res.provider);
    if res.provider.starts_with("custom:")
        || custom_names.iter().any(|name| name == provider_for_custom)
    {
        if let Some(entry) = parse_custom_provider_entries(&yaml)
            .into_iter()
            .find(|entry| entry.name == provider_for_custom)
        {
            if let Some(base_url) = entry.field("base_url") {
                res.base_url = base_url.to_string();
            }
            if let Some(model) = entry.field("model") {
                res.model = model.to_string();
            }
        }
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
            // Preserve web-search provider keys — they are written by
            // web_search_save and would otherwise be wiped on every model-config
            // write (incl. the startup profile re-assert), making the search
            // engine config disappear after a restart.
            if is_search_env_key(l) {
                return true;
            }
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

/// Web-search provider API keys written by `web_search_save`. `sync_env` must
/// never strip these (they are not model-provider keys), or the search engine
/// config vanishes after a restart.
fn is_search_env_key(l: &str) -> bool {
    l.starts_with("TAVILY_API_KEY=")
        || l.starts_with("EXA_API_KEY=")
        || l.starts_with("BRAVE_SEARCH_API_KEY=")
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

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST_STYLE: &str = r#"custom_providers:
- api_key: sk-a
  base_url: https://a.com/v1
  name: a
  model: a1
  models:
  - a1
  - a2
- api_key: sk-b
  base_url: https://b.com/v1
  name: b
dashboard:
  theme: default
"#;

    const INDENTED_STYLE: &str = r#"custom_providers:
  - name: x
    base_url: https://x.com/v1
    model: x1
dashboard:
  theme: default
"#;

    #[test]
    fn parses_both_custom_provider_styles() {
        assert_eq!(custom_provider_names(FIRST_STYLE), vec!["a", "b"]);
        assert_eq!(custom_provider_base_url(FIRST_STYLE, "a"), "https://a.com/v1");
        assert_eq!(custom_provider_api_key(FIRST_STYLE, "b"), "sk-b");

        assert_eq!(custom_provider_names(INDENTED_STYLE), vec!["x"]);
        assert_eq!(custom_provider_base_url(INDENTED_STYLE, "x"), "https://x.com/v1");
    }

    #[test]
    fn updates_first_style_entry_without_duplicating_it() {
        let updated = set_custom_provider_field(FIRST_STYLE, "a", "model", "a3");
        assert!(updated.contains("  model: a3"));
        assert_eq!(updated.matches("name: a").count(), 1);

        let updated = set_custom_provider_field(FIRST_STYLE, "a", "timeout", "60");
        assert!(updated.contains("  timeout: 60"));
        assert!(!updated.contains("  - timeout: 60"));

        let updated = set_custom_provider_field(FIRST_STYLE, "a", "api_key", "sk-new");
        assert!(updated.contains("- api_key: sk-new"));
        assert!(!updated.contains("\n  api_key: sk-new"));
    }

    #[test]
    fn appends_missing_entry_with_matching_indent() {
        let updated = set_custom_provider_field(FIRST_STYLE, "c", "base_url", "https://c.com/v1");
        assert!(updated.contains("- name: c"));
        assert!(updated.contains("  base_url: https://c.com/v1"));
        assert!(!updated.contains("    base_url: https://c.com/v1"));

        let updated = set_custom_provider_field(INDENTED_STYLE, "y", "base_url", "https://y.com/v1");
        assert!(updated.contains("  - name: y"));
        assert!(updated.contains("    base_url: https://y.com/v1"));
    }
}
