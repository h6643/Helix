//! Hooks IPC — read/write the `hooks:` block + `hooks_auto_accept` in Hermes
//! config.yaml. Port of `electron/ipc/hooks.js`. Hermes registers hooks at
//! GATEWAY STARTUP, so a save restarts the gateway (acp mode only).
//!
//! NOTE: This file is byte-level YAML editing (no js-yaml dep) so the rest of
//! the config file is preserved untouched.

use crate::config::config_yaml_path;
use crate::gateway::{env_gateway_mode, kill_current, spawn_gateway};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

const HOOK_EVENTS: &[&str] = &[
    "pre_tool_call",
    "post_tool_call",
    "pre_verify",
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
    "subagent_start",
    "subagent_stop",
    "pre_llm_call",
    "post_llm_call",
];

fn unyaml_scalar(s: &str) -> String {
    if s.len() >= 2 {
        if s.starts_with('"') && s.ends_with('"') {
            if let Ok(v) = serde_json::from_str::<String>(s) {
                return v;
            }
            return s[1..s.len() - 1].to_string();
        }
        if s.starts_with('\'') && s.ends_with('\'') {
            return s[1..s.len() - 1].replace("''", "'");
        }
    }
    s.to_string()
}

fn yaml_string(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| format!("\"{v}\""))
}

/// Remove a top-level `key:` block (and its indented children).
fn strip_top_level(yaml_text: &str, key: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut skip = false;
    for line in yaml_text.split('\n') {
        let at_top = line.starts_with(key)
            && line[key.len()..].starts_with(|c: char| c == ':' || c.is_whitespace());
        if !skip && at_top {
            skip = true;
            continue;
        }
        if skip {
            if line.starts_with(|c: char| !c.is_whitespace()) {
                skip = false;
                out.push(line.to_string());
            }
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

fn parse_hooks(text: &str) -> Value {
    let mut in_hooks = false;
    let mut hooks: Vec<Value> = Vec::new();
    let mut cur_event: Option<String> = None;
    let mut cur_item_idx: Option<usize> = None;
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        if !in_hooks {
            if line == "hooks: {}" {
                return json!({});
            }
            if line == "hooks:" {
                in_hooks = true;
                continue;
            }
            continue;
        }
        if line.starts_with(|c: char| !c.is_whitespace()) {
            break;
        }
        let trimmed = line.trim();
        // event: "  ev:" (exactly one trailing colon)
        if trimmed.ends_with(':') && !trimmed.starts_with('-') {
            let ev = trimmed[..trimmed.len() - 1].to_string();
            if !ev.is_empty()
                && ev.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            {
                cur_event = Some(ev);
                cur_item_idx = None;
                continue;
            }
        }
        // item: "    - command: ..."
        if let Some(rest) = trimmed.strip_prefix("- command:") {
            if let Some(ev) = &cur_event {
                let cmd = unyaml_scalar(rest.trim());
                let mut replaced = false;
                for e in hooks.iter_mut() {
                    if e.get("event").and_then(|v| v.as_str()) == Some(ev.as_str()) {
                        let arr = e.get_mut("items").and_then(|v| v.as_array_mut()).unwrap();
                        arr.push(json!({ "command": cmd }));
                        cur_item_idx = Some(arr.len() - 1);
                        replaced = true;
                        break;
                    }
                }
                if !replaced {
                    hooks.push(json!({ "event": ev, "items": [{ "command": cmd }] }));
                    cur_item_idx = Some(0);
                }
            }
            continue;
        }
        // matcher / timeout (attach to the last item of the current event)
        if let Some(rest) = trimmed.strip_prefix("matcher:") {
            if let (Some(ev), Some(idx)) = (&cur_event, cur_item_idx) {
                for e in hooks.iter_mut() {
                    if e.get("event").and_then(|v| v.as_str()) == Some(ev.as_str()) {
                        if let Some(arr) = e.get_mut("items").and_then(|v| v.as_array_mut()) {
                            if let Some(item) = arr.get_mut(idx) {
                                item["matcher"] = json!(unyaml_scalar(rest.trim()));
                            }
                        }
                        break;
                    }
                }
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("timeout:") {
            if let (Some(ev), Some(idx)) = (&cur_event, cur_item_idx) {
                if let Ok(n) = rest.trim().parse::<u64>() {
                    for e in hooks.iter_mut() {
                        if e.get("event").and_then(|v| v.as_str()) == Some(ev.as_str()) {
                            if let Some(arr) = e.get_mut("items").and_then(|v| v.as_array_mut()) {
                                if let Some(item) = arr.get_mut(idx) {
                                    item["timeout"] = json!(n);
                                }
                            }
                            break;
                        }
                    }
                }
            }
            continue;
        }
    }
    let mut map = serde_json::Map::new();
    for e in hooks {
        let ev = e.get("event").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let items = e.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        map.insert(ev, json!(items));
    }
    json!(map)
}

#[tauri::command]
pub fn hooks_list() -> Value {
    let yaml_path = config_yaml_path();
    let text = match std::fs::read_to_string(&yaml_path) {
        Ok(t) => t,
        Err(_) => return json!({ "ok": true, "config": { "enabled": false, "autoAccept": false, "hooks": {} } }),
    };
    let hooks = parse_hooks(&text);
    let enabled = hooks.as_object().map(|m| !m.is_empty()).unwrap_or(false);
    let mut auto_accept = false;
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("hooks_auto_accept:") {
            auto_accept = rest.trim() == "true";
        }
    }
    json!({ "ok": true, "config": { "enabled": enabled, "autoAccept": auto_accept, "hooks": hooks } })
}

#[tauri::command]
pub fn hooks_save(state: State<'_, Arc<AppState>>, config: Value) -> Value {
    if !config.is_object() {
        return json!({ "ok": false, "error": "invalid hooks config" });
    }
    let hooks_v = config.get("hooks");
    if !hooks_v.map(|h| h.is_object()).unwrap_or(false) {
        return json!({ "ok": false, "error": "invalid hooks config" });
    }
    let enabled = config.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    let hooks_map = if enabled { hooks_v.unwrap().clone() } else { json!({}) };

    let yaml_path = config_yaml_path();
    let text = std::fs::read_to_string(&yaml_path).unwrap_or_default();
    let mut merged = strip_top_level(&text, "hooks");
    merged = strip_top_level(&merged, "hooks_auto_accept");
    let block = serialize_hooks(&hooks_map, enabled);
    let merged = merged.trim_end().to_string() + "\n" + &block;
    let tmp = yaml_path.with_extension("yaml.tmp");
    if std::fs::write(&tmp, &merged).is_err() {
        return json!({ "ok": false, "error": "write failed" });
    }
    if std::fs::rename(&tmp, &yaml_path).is_err() {
        return json!({ "ok": false, "error": "rename failed" });
    }
    // Hermes registers hooks at gateway startup — restart to apply (acp only).
    if env_gateway_mode() != "serve" {
        kill_current(&state);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = spawn_gateway(&state);
    }
    json!({ "ok": true })
}

fn serialize_hooks(hooks_map: &Value, auto_accept: bool) -> String {
    let mut lines = vec![format!("hooks_auto_accept: {}", if auto_accept { "true" } else { "false" })];
    lines.push("hooks:".to_string());
    if let Some(map) = hooks_map.as_object() {
        let mut wrote = false;
        for ev in HOOK_EVENTS {
            if let Some(arr) = map.get(*ev).and_then(|v| v.as_array()) {
                if arr.is_empty() {
                    continue;
                }
                lines.push(format!("  {ev}:"));
                for h in arr {
                    if !h.is_object() {
                        continue;
                    }
                    let cmd = h.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    if cmd.trim().is_empty() {
                        continue;
                    }
                    lines.push(format!("    - command: {}", yaml_string(cmd)));
                    if let Some(m) = h.get("matcher").and_then(|v| v.as_str()) {
                        if !m.trim().is_empty() {
                            lines.push(format!("      matcher: {}", yaml_string(m)));
                        }
                    }
                    if let Some(t) = h.get("timeout").and_then(|v| v.as_u64()) {
                        if t > 0 {
                            lines.push(format!("      timeout: {t}"));
                        }
                    }
                }
                wrote = true;
            }
        }
        if !wrote {
            lines.push("  {}".to_string());
        }
    } else {
        lines.push("  {}".to_string());
    }
    lines.join("\n") + "\n"
}
