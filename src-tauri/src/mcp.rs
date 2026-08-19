//! Gateway MCP servers — read/write view of the `mcp_servers:` block in
//! Hermes config.yaml.
//!
//! The desktop app manages its OWN MCP list in the store (localStorage,
//! sent per-session via ACP `session/new`). Separately, the Hermes gateway
//! loads `mcp_servers` from config.yaml at startup. This module exposes
//! the latter so the settings page can show AND edit what the gateway
//! actually runs (e.g. `ssh-bridge`), which the store-based list never
//! reflects.
//!
//! `mcp_config_list(include_env=false)` returns the block for display,
//! omitting `env` values (they may hold secrets). `mcp_config_save` writes
//! the whole block back, preserving each server's existing `env` when the
//! incoming config omits it, so a save never silently drops secrets.

use crate::config::config_yaml_path;
use serde_json::{json, Map, Value};

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

/// Parse the `mcp_servers:` block of a config.yaml text.
///
/// Result: `{ <name>: { command?, args?, url?, headers?, env?, ... } }`.
/// Nested maps/lists (env, headers, tools, sampling, ...) are parsed
/// generically. When `include_env` is false the `env` key is stripped from
/// every entry (secrets stay out of the renderer's display path); the internal
/// parse always keeps it so `mcp_config_save` can carry env blocks over.
fn parse_mcp_servers(text: &str, include_env: bool) -> Map<String, Value> {
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

    if !include_env {
        for (_name, v) in servers.iter_mut() {
            if let Some(obj) = v.as_object_mut() {
                obj.remove("env");
            }
        }
    }
    servers
}

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

fn try_json_value(raw: &str) -> Option<Value> {
    let t = raw.trim();
    if t.starts_with('[') || t.starts_with('{') {
        serde_json::from_str(t).ok()
    } else {
        None
    }
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
        if line_indent < indent {
            break;
        }
        if line_indent > indent {
            // A deeper block that was not consumed by the previous key's
            // recursion is malformed YAML for this subset; stop rather than
            // misattributing it to this map.
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
        let line_indent = indent_of(line);
        if line_indent < indent {
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
            // List items under `args`/`include` are scalars, not YAML maps.
            // Treating a string like `D:\MCP\server.js` as `key: value` would
            // turn it into an object and later render as `[object Object]`.
            arr.push(parse_scalar(rest));
        }
    }
    Value::Array(arr)
}

/// Serialize a scalar value as a YAML plain/single-quoted scalar.
fn yaml_scalar(v: &Value) -> String {
    match v {
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            if s.is_empty() {
                return "''".to_string();
            }
            let safe = s.chars().all(|c| {
                c.is_ascii_alphanumeric()
                    || matches!(c, '_' | '.' | '/' | '\\' | '-' | ':' | '@' | '+' | '%' | '~')
            }) && !s.ends_with(':');
            if safe {
                s.clone()
            } else {
                format!("'{}'", s.replace('\'', "''"))
            }
        }
        _ => format!("'{}'", v.to_string().replace('\'', "''")),
    }
}

/// Write a nested YAML value (map / list / scalar) under `key` at `indent`.
fn push_yaml_field(out: &mut String, indent: &str, key: &str, value: &Value) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push_str(&format!("{indent}{key}:\n"));
            for item in items {
                if item.is_object() || item.is_array() {
                    out.push_str(&format!("{indent}  - {}\n", item.to_string()));
                } else {
                    out.push_str(&format!("{indent}  - {}\n", yaml_scalar(item)));
                }
            }
        }
        Value::Array(_) => {
            out.push_str(&format!("{indent}{key}: []\n"));
        }
        Value::Object(map) if !map.is_empty() => {
            out.push_str(&format!("{indent}{key}:\n"));
            for (k, v) in map {
                push_yaml_field(out, &format!("{indent}  "), k, v);
            }
        }
        Value::Object(_) => {
            out.push_str(&format!("{indent}{key}: {{}}\n"));
        }
        Value::Null => {
            out.push_str(&format!("{indent}{key}: null\n"));
        }
        _ => {
            out.push_str(&format!("{indent}{key}: {}\n", yaml_scalar(value)));
        }
    }
}

/// Serialize the full `mcp_servers:` block from a server map.
///
/// `old_servers` is the pre-edit parse (with env) so that any server whose
/// incoming config omits `env` keeps its previous env block — protects
/// secrets from being dropped by a display-only round trip.
fn serialize_mcp_servers(
    servers: &Map<String, Value>,
    old_servers: &Map<String, Value>,
) -> String {
    let mut out = String::from("mcp_servers:\n");
    for (name, cfg) in servers {
        out.push_str(&format!("  {}:\n", name));
        let obj = cfg.as_object().cloned().unwrap_or_default();

        // Transport: url (remote) vs command+args (stdio).
        if let Some(url) = obj.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            out.push_str(&format!("    url: {}\n", yaml_scalar(&json!(url))));
        } else {
            let cmd_str = obj.get("command").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            let cmd_arr = obj.get("command").and_then(|v| v.as_array());
            if let Some(cmd) = cmd_str {
                out.push_str(&format!("    command: {}\n", yaml_scalar(&json!(cmd))));
            } else if let Some(arr) = cmd_arr {
                if let Some(first) = arr.first().and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    out.push_str(&format!("    command: {}\n", yaml_scalar(&json!(first))));
                    let rest: Vec<&Value> = arr.iter().skip(1).collect();
                    if !rest.is_empty() {
                        out.push_str("    args:\n");
                        for a in rest {
                            out.push_str(&format!("      - {}\n", yaml_scalar(a)));
                        }
                    }
                }
            }
            if let Some(args) = obj.get("args").and_then(|v| v.as_array()) {
                if !args.is_empty() {
                    out.push_str("    args:\n");
                    for a in args {
                        out.push_str(&format!("      - {}\n", yaml_scalar(a)));
                    }
                }
            }
        }

        // headers (remote)
        if let Some(h) = obj.get("headers").and_then(|v| v.as_object()) {
            if !h.is_empty() {
                out.push_str("    headers:\n");
                for (k, v) in h {
                    out.push_str(&format!("      {}: {}\n", k, yaml_scalar(v)));
                }
            }
        }

        // env: incoming config wins; otherwise carry over the old block so a
        // save that never touched env can't clobber secrets.
        let env = obj.get("env").and_then(|v| v.as_object());
        let env_vals: Option<&Map<String, Value>> = env.or_else(|| {
            old_servers
                .get(name)
                .and_then(|o| o.as_object())
                .and_then(|o| o.get("env"))
                .and_then(|v| v.as_object())
        });
        if let Some(e) = env_vals {
            if !e.is_empty() {
                out.push_str("    env:\n");
                for (k, v) in e {
                    out.push_str(&format!("      {}: {}\n", k, yaml_scalar(v)));
                }
            }
        }

        // misc scalar overrides
        for key in ["enabled", "cwd", "timeout", "connect_timeout", "auth"] {
            if let Some(v) = obj.get(key) {
                if !v.is_null() {
                    out.push_str(&format!("    {}: {}\n", key, yaml_scalar(v)));
                }
            }
        }

        // Any other fields (transport, tools, lazy, sampling, ...) must
        // survive an edit round trip. Write unknown incoming keys, then carry
        // over old unknown keys the edit did not touch.
        const KNOWN: &[&str] = &[
            "url",
            "command",
            "args",
            "headers",
            "env",
            "enabled",
            "cwd",
            "timeout",
            "connect_timeout",
            "auth",
        ];
        for (key, value) in &obj {
            if !KNOWN.contains(&key.as_str()) && !value.is_null() {
                push_yaml_field(&mut out, "    ", key, value);
            }
        }
        if let Some(old_obj) = old_servers.get(name).and_then(|o| o.as_object()) {
            for (key, value) in old_obj {
                if !KNOWN.contains(&key.as_str()) && !obj.contains_key(key) && !value.is_null() {
                    push_yaml_field(&mut out, "    ", key, value);
                }
            }
        }
    }
    out
}

/// Replace the `mcp_servers:` block in `text` with `block` (which must end
/// with a newline). Appends the block when the key is absent.
fn replace_mcp_block(text: &str, block: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let start = lines.iter().position(|l| l.starts_with("mcp_servers:"));
    let mut end = start.map(|s| s + 1).unwrap_or(0);
    if start.is_some() {
        while end < lines.len() {
            let l = lines[end];
            if l.trim().is_empty() || l.starts_with(' ') || l.starts_with('\t') {
                end += 1;
            } else {
                break;
            }
        }
    }

    let mut out = String::new();
    match start {
        Some(s) => {
            out.push_str(&lines[..s].join("\n"));
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(block);
            if end < lines.len() {
                out.push('\n');
                out.push_str(&lines[end..].join("\n"));
            }
        }
        None => {
            out.push_str(text);
            if !text.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
            out.push_str(block);
        }
    }
    out
}

#[tauri::command]
pub fn mcp_config_list(include_env: Option<bool>) -> Value {
    let yaml_path = config_yaml_path();
    let text = match std::fs::read_to_string(&yaml_path) {
        Ok(t) => t,
        Err(_) => return json!({ "ok": true, "servers": {} }),
    };
    let servers = parse_mcp_servers(&text, include_env.unwrap_or(false));
    json!({ "ok": true, "servers": Value::Object(servers) })
}

/// Write the full `mcp_servers:` block from `servers` ({ name: cfg }) into
/// config.yaml. Everything outside the block is preserved verbatim.
/// Per-server `env` is carried over from the current file when the incoming
/// config omits it (see serialize_mcp_servers).
#[tauri::command]
pub fn mcp_config_save(servers: Value) -> Value {
    let obj = match servers.as_object() {
        Some(o) => o,
        None => return json!({ "ok": false, "error": "servers must be an object" }),
    };
    for name in obj.keys() {
        if name.is_empty()
            || name.contains(':')
            || name.contains('\n')
            || name.starts_with('-')
            || name.starts_with(' ')
        {
            return json!({ "ok": false, "error": format!("invalid server name: {name:?}") });
        }
    }

    let yaml_path = config_yaml_path();
    let text = match std::fs::read_to_string(&yaml_path) {
        Ok(t) => t,
        Err(_) => String::new(),
    };
    let old_servers = parse_mcp_servers(&text, true); // full parse incl. env
    let block = serialize_mcp_servers(obj, &old_servers);
    let out = replace_mcp_block(&text, &block);

    if let Some(dir) = yaml_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&yaml_path, &out) {
        return json!({ "ok": false, "error": format!("write failed: {e}") });
    }
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_round_trip_preserves_unknown_fields() {
        let yaml = r#"mcp_servers:
  demo:
    command: npx
    args:
      - -y
      - demo-server
    env:
      TOKEN: secret
    enabled: true
    lazy: true
    tools:
      include: ["beta"]
"#;
        let parsed = parse_mcp_servers(yaml, true);
        let servers = json!({ "demo": parsed["demo"] });
        let block = serialize_mcp_servers(servers.as_object().unwrap(), &parsed);
        assert!(block.contains("lazy: true"), "lazy should survive edit");
        assert!(block.contains("tools:"), "tools should survive edit");
        assert!(block.contains("include"), "tools block should survive edit");
        assert!(block.contains("TOKEN: secret"), "env should survive edit");
    }

    #[test]
    fn mcp_parse_supports_inline_json_values() {
        let yaml = "mcp_servers:\n  demo:\n    command: npx\n    args: [\"-y\", \"demo\"]\n";
        let parsed = parse_mcp_servers(yaml, true);
        let cfg = parsed["demo"].as_object().unwrap();
        let args = cfg["args"].as_array().unwrap();
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], json!("-y"));
    }

    #[test]
    fn mcp_parse_keeps_windows_path_args_as_strings() {
        let yaml = "mcp_servers:\n  demo:\n    command: D:\\nodejs\\node.EXE\n    args:\n      - D:\\MCP\\demo\\server.js\n";
        let parsed = parse_mcp_servers(yaml, true);
        let cfg = parsed["demo"].as_object().unwrap();
        assert_eq!(cfg["command"], json!("D:\\nodejs\\node.EXE"));
        let args = cfg["args"].as_array().unwrap();
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], json!("D:\\MCP\\demo\\server.js"));
    }
}
