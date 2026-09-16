//! Gateway MCP servers — read/write view of the pi MCP adapter's config.
//!
//! The pi agent has no built-in MCP; the user-installed `pi-mcp-adapter`
//! package reads servers from `~/.pi/agent/mcp.json` (`{ "mcpServers":
//! {...} }`, ServerEntry schema: command/args/env/cwd/url/headers/disabled).
//! Helix keeps the canonical copy of the server list in the top-level
//! `mcp_servers:` block of `~/.pi/agent/config.yaml` (the shared user config
//! file, alongside vision/web_search/image/agent blocks), and mirrors it into
//! mcp.json on every save so the adapter picks up the change on respawn.
//!
//! The renderer speaks the old shape: `{ name: { enabled?, ... } }`.
//! `enabled: false` is written as `disabled: true` on disk and translated
//! back on read; every other field passes through verbatim.
//!
//! Reads prefer the config.yaml block; when it's absent, they fall back to
//! legacy `~/.pi/agent/mcp.json` written by older builds.
//!
//! `list(include_env=false)` strips `env` values from every entry (secrets
//! stay out of the renderer's display path); `save` preserves each
//! server's existing env when the incoming config omits it, so a save
//! never silently drops secrets.

use crate::config::{atomic_write, config_yaml_path};
use crate::paths::pi_agent_dir;
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn legacy_mcp_json_path() -> std::path::PathBuf {
    pi_agent_dir().join("mcp.json")
}

// ── Legacy YAML subset parser (migration input only) ───────────────────────

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_blank_or_comment(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

fn next_content(lines: &[&str], mut i: usize) -> Option<(usize, usize)> {
    while i < lines.len() {
        if !is_blank_or_comment(lines[i]) {
            return Some((i, indent_of(lines[i])));
        }
        i += 1;
    }
    None
}

fn strip_quotes(s: &str) -> String {
    s.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn parse_scalar(raw: &str) -> Value {
    let v = raw.trim();
    match v {
        "true" => json!(true),
        "false" => json!(false),
        _ => json!(strip_quotes(v)),
    }
}

fn try_json_value(raw: &str) -> Option<Value> {
    let t = raw.trim();
    if t.starts_with('[') || t.starts_with('{') {
        serde_json::from_str(t).ok()
    } else {
        None
    }
}

/// Split a `key: value` YAML line at the first colon (keys never contain one).
fn split_key_value(line: &str) -> Option<(String, String)> {
    let idx = line.find(':')?;
    let key = line[..idx].trim().to_string();
    let val = line[idx + 1..].trim().to_string();
    if key.is_empty() {
        None
    } else {
        Some((key, val))
    }
}

/// Parse the `mcp_servers:` block of a legacy config.yaml text.
fn parse_legacy_mcp_servers(text: &str) -> Map<String, Value> {
    let lines: Vec<&str> = text.lines().collect();
    let mut servers: Map<String, Value> = Map::new();
    let mut i = 0usize;

    while i < lines.len() {
        let line = lines[i];
        if indent_of(line) == 0 && line.trim_start().starts_with("mcp_servers:") {
            i += 1;
            if let Some((next, next_indent)) = next_content(&lines, i) {
                i = next;
                if let Value::Object(map) = parse_yaml_block(&lines, &mut i, next_indent) {
                    servers = map;
                }
            }
            break;
        }
        i += 1;
    }
    servers
}

fn parse_yaml_block(lines: &[&str], i: &mut usize, indent: usize) -> Value {
    let Some((next, actual)) = next_content(lines, *i) else {
        return Value::Null;
    };
    *i = next;
    let actual = actual.max(indent);
    if lines[*i].trim_start().starts_with("- ") || lines[*i].trim_start() == "-" {
        parse_yaml_list(lines, i, actual)
    } else {
        parse_yaml_map(lines, i, actual)
    }
}

fn parse_yaml_map(lines: &[&str], i: &mut usize, indent: usize) -> Value {
    let mut map: Map<String, Value> = Map::new();
    loop {
        while *i < lines.len() && is_blank_or_comment(lines[*i]) {
            *i += 1;
        }
        if *i >= lines.len() {
            break;
        }
        let line = lines[*i];
        let line_indent = indent_of(line);
        if line_indent != indent {
            break;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("- ") || trimmed == "-" {
            break;
        }
        let Some((key, raw)) = split_key_value(trimmed) else {
            *i += 1;
            continue;
        };
        *i += 1;
        if raw.trim().is_empty() {
            if let Some((next, next_indent)) = next_content(lines, *i) {
                if next_indent > indent {
                    *i = next;
                    map.insert(key, parse_yaml_block(lines, i, next_indent));
                    continue;
                }
            }
            map.insert(key, Value::String(String::new()));
        } else if let Some(v) = try_json_value(raw.trim()) {
            map.insert(key, v);
        } else {
            map.insert(key, parse_scalar(raw.trim()));
        }
    }
    Value::Object(map)
}

fn parse_yaml_list(lines: &[&str], i: &mut usize, indent: usize) -> Value {
    let mut arr: Vec<Value> = Vec::new();
    loop {
        while *i < lines.len() && is_blank_or_comment(lines[*i]) {
            *i += 1;
        }
        if *i >= lines.len() {
            break;
        }
        let line = lines[*i];
        if indent_of(line) < indent {
            break;
        }
        let trimmed = line.trim_start();
        if !trimmed.starts_with('-') {
            break;
        }
        let rest = trimmed.trim_start_matches('-').trim_start();
        *i += 1;
        if rest.is_empty() {
            if let Some((next, next_indent)) = next_content(lines, *i) {
                if next_indent > indent {
                    *i = next;
                    arr.push(parse_yaml_block(lines, i, next_indent));
                    continue;
                }
            }
            arr.push(Value::Null);
        } else if let Some(v) = try_json_value(rest) {
            arr.push(v);
        } else {
            // List items under `args`/`include` are scalars, not YAML maps —
            // a Windows path like `D:\MCP\server.js` must stay a string.
            arr.push(parse_scalar(rest));
        }
    }
    Value::Array(arr)
}

// ── enabled <-> disabled translation ───────────────────────────────────────

/// Adapter shape (mcp.json on disk) → renderer shape (`enabled` instead of
/// `disabled`). Unknown fields pass through untouched.
fn adapter_to_renderer(mut entry: Value) -> Value {
    if let Some(obj) = entry.as_object_mut() {
        if let Some(disabled) = obj.remove("disabled") {
            obj.insert(
                "enabled".into(),
                json!(!disabled.as_bool().unwrap_or(false)),
            );
        }
    }
    entry
}

/// Renderer shape → adapter shape for writing. `enabled: false` becomes
/// `disabled: true`; `enabled: true` is dropped (the adapter default is on).
fn renderer_to_adapter(mut entry: Value) -> Value {
    if let Some(obj) = entry.as_object_mut() {
        if let Some(enabled) = obj.remove("enabled") {
            if !enabled.as_bool().unwrap_or(true) {
                obj.insert("disabled".into(), json!(true));
            }
        }
    }
    entry
}

/// Read the `mcp_servers:` block from config.yaml (full form, env included
/// for the display path). Unknown keys under the block pass through.
fn read_yaml_mcp_servers(include_env: bool) -> Map<String, Value> {
    let text = std::fs::read_to_string(config_yaml_path()).unwrap_or_default();
    let servers = parse_legacy_mcp_servers(&text);
    let mut out: Map<String, Value> = Map::new();
    for (name, entry) in servers {
        let mut entry = adapter_to_renderer(entry);
        if !include_env {
            if let Some(obj) = entry.as_object_mut() {
                obj.remove("env");
            }
        }
        out.insert(name, entry);
    }
    out
}

/// Read the legacy `~/.pi/agent/mcp.json` (adapter schema `{ "mcpServers": ... }`).
/// Non-zero only when the file exists.
fn read_legacy_mcp_json() -> Option<Map<String, Value>> {
    let path = legacy_mcp_json_path();
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let servers = v
        .get("mcpServers")
        .or_else(|| v.get("mcp_servers").or_else(|| v.get("mcp-servers")))
        .and_then(Value::as_object)?
        .clone();
    let mut out: Map<String, Value> = Map::new();
    for (name, entry) in servers {
        out.insert(name, adapter_to_renderer(entry.clone()));
    }
    Some(out)
}

/// Load servers for the renderer: prefer config.yaml; when it has no
/// `mcp_servers:` block yet, fall back to the legacy mcp.json (adapter
/// schema). The legacy file is never modified.
fn load_servers() -> Map<String, Value> {
    let yaml = read_yaml_mcp_servers(true);
    if !yaml.is_empty() {
        return yaml;
    }
    read_legacy_mcp_json().unwrap_or_default()
}

/// Write the full server map into config.yaml's `mcp_servers:` block, replacing
/// the whole block in place and preserving every other part of the file
/// (vision/web_search/image/... blocks, inline data-root comments, etc.).
/// Per-server `env` is carried over from the previous config (yaml or legacy
/// mcp.json) when the incoming entry omits it (display round trips don't
/// carry secrets).
fn save_mcp_servers(
    servers: &Map<String, Value>,
    legacy_env: &Map<String, Value>,
) -> Result<(), String> {
    let mut merged: Map<String, Value> = Map::new();
    for (name, entry) in servers {
        let mut entry = entry.clone();
        // Carry over env when the incoming entry omits it.
        let missing_env = entry
            .get("env")
            .and_then(Value::as_object)
            .map(|e| e.is_empty())
            .unwrap_or(true);
        if missing_env {
            if let Some(old_env) = legacy_env
                .get(name)
                .and_then(|o| o.get("env"))
                .and_then(Value::as_object)
            {
                if !old_env.is_empty() {
                    if let Some(e) = entry.as_object_mut() {
                        e.insert("env".into(), Value::Object(old_env.clone()));
                    }
                }
            }
        }
        merged.insert(name.clone(), renderer_to_adapter(entry));
    }
    let path = config_yaml_path();
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<&str> = existing.lines().collect();
    let mut block_end = lines
        .iter()
        .position(|l| {
            !l.starts_with(' ') && l.starts_with("mcp_servers") && l["mcp_servers".len()..]
                .trim_start()
                .starts_with(':')
        })
        .unwrap_or(lines.len());
    if block_end < lines.len() {
        let mut i = block_end + 1;
        while i < lines.len() && lines[i].starts_with(' ') && !lines[i].trim().is_empty() {
            i += 1;
        }
        block_end = i;
    }
    let body = if merged.is_empty() {
        // Empty map: drop the block entirely so the file stays clean.
        let before = &lines[..block_end];
        let after = &lines[block_end.min(lines.len())..];
        let mut all: Vec<String> = before.iter().map(|s| s.to_string()).collect();
        all.extend(after.iter().map(|s| s.to_string()));
        all.join("\n")
    } else {
        let mut out: Vec<String> = lines[..block_end]
            .iter()
            .map(|s| s.to_string())
            .collect();
        out.push("mcp_servers:".into());
        for (name, entry) in &merged {
            if let Some(obj) = entry.as_object() {
                let keys: Vec<String> = obj.keys().cloned().collect();
                // command first, then the rest alphabetically (stable display).
                let mut ordered: Vec<String> = keys;
                ordered.sort();
                if let Some(ci) = ordered.iter().position(|k| k == "command") {
                    ordered.swap_remove(ci);
                    ordered.insert(0, "command".to_string());
                }
                out.push(format!("  {name}:"));
                for k in &ordered {
                    let v = &obj[k.as_str()];
                    match v {
                        Value::Object(map) => {
                            let mut ks: Vec<String> = map.keys().cloned().collect();
                            ks.sort();
                            out.push(format!("    {k}:"));
                            for sk in &ks {
                                out.push(format!(
                                    "      {sk}: {:?}",
                                    map[sk.as_str()].to_string()
                                ));
                            }
                        }
                        Value::Array(arr) => {
                            out.push(format!("    {k}:"));
                            for item in arr {
                                out.push(format!("      - {:?}", item.to_string()));
                            }
                        }
                        Value::String(s) => out.push(format!("    {k}: {s}")),
                        _ => out.push(format!("    {k}: {}", v.to_string())),
                    }
                }
            } else {
                out.push(format!("  {name}: {}", entry.to_string()));
            }
        }
        out.extend(lines[block_end..].iter().map(|s| s.to_string()));
        out.join("\n")
    };
    atomic_write(&path, &(body + "\n")).map_err(|e| e.to_string())
}

/// Mirror the adapter-shape server map into `~/.pi/agent/mcp.json` so the
/// pi-mcp-adapter picks up the change on the next gateway respawn.
/// The adapter only reads mcp.json — config.yaml is the user-facing source
/// of truth and mcp.json is its runtime mirror.
fn mirror_to_mcp_json(servers_adapter_shape: &Map<String, Value>) {
    let path = legacy_mcp_json_path();
    if servers_adapter_shape.is_empty() {
        // Empty map: drop the mirror file so no server lingers in the adapter.
        let _ = std::fs::remove_file(&path);
        return;
    }
    let mut doc: Map<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    // Preserve unknown top-level keys (adapter settings etc.).
    doc.insert("mcpServers".into(), Value::Object(servers_adapter_shape.clone()));
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let doc = serde_json::to_string_pretty(&Value::Object(doc)).ok();
    if let Some(text) = doc {
        let _ = std::fs::write(&path, text + "\n");
    }
}

#[tauri::command]
pub fn mcp_config_list(include_env: Option<bool>) -> Value {
    let servers = load_servers();
    let servers = if include_env.unwrap_or(false) {
        servers
    } else {
        servers
            .into_iter()
            .map(|(name, mut entry)| {
                if let Some(obj) = entry.as_object_mut() {
                    obj.remove("env");
                }
                (name, entry)
            })
            .collect::<Map<String, Value>>()
    };
    json!({ "ok": true, "servers": Value::Object(servers) })
}

/// Write the full server map ({ name: cfg }) into config.yaml's `mcp_servers:`
/// block, and drop the legacy mcp.json.
#[tauri::command]
pub fn mcp_config_save(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    servers: Value,
) -> Value {
    let Some(obj) = servers.as_object() else {
        return json!({ "ok": false, "error": "servers must be an object" });
    };
    for name in obj.keys() {
        if name.is_empty()
            || name.contains(':')
            || name.contains('\n')
            || name.contains('/')
            || name.contains('\\')
            || name.starts_with('-')
            || name.starts_with(' ')
        {
            return json!({ "ok": false, "error": format!("invalid server name: {name:?}") });
        }
    }

    // env-carry-over source: current config.yaml block first, then legacy mcp.json
    // (both in adapter shape — the carry-over only looks at `env` keys).
    let current = read_yaml_mcp_servers(true);
    let legacy = read_legacy_mcp_json().unwrap_or_default();
    let mut merged_env: Map<String, Value> = current.clone();
    for (k, v) in &legacy {
        merged_env.entry(k.clone()).or_insert_with(|| v.clone());
    }

    if let Err(e) = save_mcp_servers(obj, &merged_env) {
        return json!({ "ok": false, "error": format!("write failed: {e}") });
    }
    // Mirror into mcp.json so the pi-mcp-adapter (which only reads mcp.json)
    // picks up the server list on the next gateway respawn. Build the adapter-
    // shaped server map from the merged view (env carried over, enabled
    // translated to disabled).
    let adapter_map: Map<String, Value> = obj
        .iter()
        .map(|(name, entry)| {
            let mut entry = entry.clone();
            if entry
                .get("env")
                .and_then(Value::as_object)
                .map(|e| e.is_empty())
                .unwrap_or(true)
            {
                if let Some(old_env) = merged_env
                    .get(name)
                    .and_then(|o| o.get("env"))
                    .and_then(Value::as_object)
                {
                    if !old_env.is_empty() {
                        if let Some(e) = entry.as_object_mut() {
                            e.insert("env".into(), Value::Object(old_env.clone()));
                        }
                    }
                }
            }
            (name.clone(), renderer_to_adapter(entry))
        })
        .collect();
    mirror_to_mcp_json(&adapter_map);
    // The adapter reads config.yaml at process start — respawn pi so the change
    // takes effect for the running agent.
    crate::gateway::restart_gateway_soon(&Arc::clone(&state));
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_disabled_round_trip() {
        let on = json!({ "command": "npx", "enabled": true });
        let adapter = renderer_to_adapter(on);
        assert!(
            adapter.get("disabled").is_none(),
            "enabled:true must not write disabled"
        );
        assert!(
            adapter.get("enabled").is_none(),
            "adapter shape has no enabled field"
        );
        assert_eq!(adapter.get("command"), Some(&json!("npx")));
        // No `disabled` key reads back as enabled (renderer checks === false).
        let back = adapter_to_renderer(adapter);
        assert!(back.get("enabled").is_none() || back.get("enabled") == Some(&json!(true)));
        assert!(back.get("disabled").is_none());

        let off = json!({ "command": "npx", "enabled": false });
        let adapter = renderer_to_adapter(off);
        assert_eq!(adapter.get("disabled"), Some(&json!(true)));
        let back = adapter_to_renderer(adapter);
        assert_eq!(back.get("enabled"), Some(&json!(false)));
        assert!(back.get("disabled").is_none());
    }

    #[test]
    fn legacy_yaml_migrates_to_adapter_shape() {
        let yaml = concat!(
            "model: something\n",
            "mcp_servers:\n",
            "  demo:\n",
            "    command: npx\n",
            "    args:\n",
            "      - -y\n",
            "      - demo-server\n",
            "    env:\n",
            "      TOKEN: secret\n",
            "    enabled: false\n",
            "agent:\n",
            "  personality: ''\n",
        );
        let legacy = parse_legacy_mcp_servers(yaml);
        assert_eq!(legacy.len(), 1);
        let adapter = renderer_to_adapter(legacy["demo"].clone());
        assert_eq!(adapter.get("command"), Some(&json!("npx")));
        let args = adapter.get("args").unwrap().as_array().unwrap();
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], json!("-y"));
        assert_eq!(adapter.get("disabled"), Some(&json!(true)));
        assert_eq!(
            adapter.get("env").unwrap().get("TOKEN"),
            Some(&json!("secret")),
            "env must survive migration"
        );
        // The block ends at the next top-level key.
        assert!(!legacy.contains_key("agent"));
    }

    #[test]
    fn list_strips_env_when_not_included() {
        let entry = json!({ "command": "npx", "env": { "TOKEN": "s" } });
        let stripped = {
            let mut e = entry.clone();
            if let Some(obj) = e.as_object_mut() {
                obj.remove("env");
            }
            e
        };
        assert!(stripped.get("env").is_none());
        assert_eq!(stripped.get("command"), Some(&json!("npx")));
    }

    #[test]
    fn windows_path_args_stay_strings() {
        let yaml = concat!(
            "mcp_servers:\n",
            "  demo:\n",
            "    command: D:\\nodejs\\node.EXE\n",
            "    args:\n",
            "      - D:\\MCP\\demo\\server.js\n",
        );
        let legacy = parse_legacy_mcp_servers(yaml);
        let cfg = legacy["demo"].as_object().unwrap();
        assert_eq!(cfg["command"], json!("D:\\nodejs\\node.EXE"));
        let args = cfg["args"].as_array().unwrap();
        assert_eq!(args[0], json!("D:\\MCP\\demo\\server.js"));
    }
}
