//! Gateway MCP servers — read-only view of the `mcp_servers:` block in
//! Hermes config.yaml.
//!
//! The desktop app manages its OWN MCP list in the store (localStorage,
//! sent per-session via ACP `session/new`). Separately, the Hermes gateway
//! loads `mcp_servers` from config.yaml at startup. This command exposes
//! the latter so the settings page can show what the gateway actually has
//! (e.g. `ssh-bridge`), which the store-based list never reflects.

use crate::config::config_yaml_path;
use crate::state::AppState;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tauri::State;

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

#[tauri::command]
pub fn mcp_config_list(_state: State<'_, Arc<AppState>>) -> Value {
    let yaml_path = config_yaml_path();
    let text = match std::fs::read_to_string(&yaml_path) {
        Ok(t) => t,
        Err(_) => return json!({ "ok": true, "servers": {} }),
    };

    let mut servers: Map<String, Value> = Map::new();
    let mut in_mcp = false;
    let mut current: Option<(String, Map<String, Value>)> = None;
    let mut in_env = false;

    for line in text.split('\n') {
        let trimmed = line.trim_start();
        let indent = line.len() - line.trim_start().len();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if indent == 0 {
            in_mcp = trimmed.starts_with("mcp_servers:");
            if !in_mcp {
                current = None;
            }
            in_env = false;
            continue;
        }
        if !in_mcp {
            continue;
        }
        if indent == 2 {
            // server entry header: `  <name>:`
            if let Some((name, cfg)) = current.take() {
                servers.insert(name, Value::Object(cfg));
            }
            let name = trimmed.trim_end_matches(':').trim().to_string();
            if !name.is_empty() {
                current = Some((name, Map::new()));
            }
            in_env = false;
        } else if indent >= 4 {
            if let Some((_, cfg)) = current.as_mut() {
                if in_env {
                    if indent > 4 {
                        continue;
                    }
                    in_env = false;
                }
                if trimmed.starts_with("- ") {
                    // list item under the previous key (e.g. `args`)
                    if let Some((_, v)) = cfg.iter_mut().last() {
                        if let Some(arr) = v.as_array_mut() {
                            arr.push(json!(strip_quotes(
                                trimmed.trim_start_matches("- ").trim()
                            )));
                        }
                    }
                } else if let Some((key, val)) = split_key_value(trimmed) {
                    if key == "env" {
                        // env values may hold secrets — skip the whole block
                        in_env = true;
                        continue;
                    }
                    if key == "args" {
                        cfg.insert(key, json!([]));
                    } else {
                        cfg.insert(key, parse_scalar(&val));
                    }
                }
            }
        }
    }
    if let Some((name, cfg)) = current.take() {
        servers.insert(name, Value::Object(cfg));
    }

    json!({ "ok": true, "servers": Value::Object(servers) })
}
