//! Subagent settings — canonical storage in `~/.pi/agent/config.yaml`.
//!
//! The `pi-subagents` extension only reads `~/.pi/agent/subagents.json`
//! (global, never written by the extension itself — it writes project-level
//! `<cwd>/.pi/subagents.json` via its own `/agents → Settings` UI) and
//! `loadSettings` merges project over global.
//!
//! Helix owns the global settings copy in the `subagents:` block of
//! `~/.pi/agent/config.yaml` (the same file as vision/web_search/image/
//! mcp_servers). On every read and on every save this module mirrors that
//! block into `~/.pi/agent/subagents.json` so the running extension picks
//! the values up on respawn without Helix having to patch the extension.
//!
//! One-time migration: when config.yaml has no `subagents:` block yet and
//! `subagents.json` does, its contents are imported into config.yaml and
//! the file is deleted (config.yaml becomes the single source of truth).
//!
//! Renderer contract (same as `mcp_config_save`):
//! - `list` returns the effective global settings (yaml block → legacy json
//!   → empty), stripping `env`-style secrets is irrelevant here — every
//!   subagent settings key is a plain number/bool/enum.
//! - `save` replaces the whole `subagents:` block, mirrors it to
//!   `subagents.json`, and restarts the gateway so the extension re-reads.

use crate::config::{atomic_write, config_yaml_path};
use crate::gateway;
use crate::paths::pi_agent_dir;
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn legacy_subagents_json_path() -> std::path::PathBuf {
    pi_agent_dir().join("subagents.json")
}

/// Read the `subagents:` block from config.yaml (full form, JSON value for
/// each key; scalars / arrays / nested objects all supported).
fn read_yaml_subagents(include_legacy_fallback: bool) -> Map<String, Value> {
    let text = std::fs::read_to_string(config_yaml_path()).unwrap_or_default();
    let map = parse_yaml_top_block(&text, "subagents");
    if !map.is_empty() {
        return map;
    }
    // Fallback: legacy subagents.json (adapter shape = same JSON object the
    // extension writes; keys are flat).
    if include_legacy_fallback {
        read_legacy_subagents_json().unwrap_or_default()
    } else {
        Map::new()
    }
}

/// Read the legacy `~/.pi/agent/subagents.json` as-is (flat JSON object).
fn read_legacy_subagents_json() -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(legacy_subagents_json_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some(v.as_object()?.clone())
}

/// Load the effective global subagent settings for the renderer: prefer the
/// config.yaml block, fall back to the legacy file. When the legacy file is
/// used and config.yaml is writable, migrate it into config.yaml and delete
/// the file (one-time, guarded by `migrate_legacy=true`).
///
/// Exposed as `load_subagents_settings` for callers that only want the
/// merged global view (skills.rs) without the one-time migration side
/// effect.
pub(crate) fn load_subagents_settings() -> Map<String, Value> {
    let yaml = read_yaml_subagents(false);
    if !yaml.is_empty() {
        return yaml;
    }
    read_legacy_subagents_json().unwrap_or_default()
}

/// Migration-capable load: when only the legacy file is present, import it
/// into config.yaml and delete the file. `subagents_settings_list` uses
/// this so the user's UI reflects the canonical location after the first
/// launch post-upgrade.
fn load_subagents_migrate() -> Map<String, Value> {
    let yaml = read_yaml_subagents(false);
    if !yaml.is_empty() {
        return yaml;
    }
    let legacy = read_legacy_subagents_json().unwrap_or_default();
    if legacy.is_empty() {
        return Map::new();
    }
    // Write into config.yaml now; config.yaml is authoritative from here on.
    let _ = save_yaml_block(&legacy);
    // Delete the legacy file — config.yaml now holds the data.
    let _ = std::fs::remove_file(legacy_subagents_json_path());
    legacy
}

/// Write the full settings map into config.yaml's `subagents:` block,
/// replacing the whole block in place and preserving every other part of
/// the file (vision/web_search/image/agent/mcp_servers blocks, etc.).
/// The value shape is the extension's flat JSON settings object
/// (workflowsEnabled / schedulingEnabled / toolDescriptionMode / ...).
fn save_yaml_block(servers: &Map<String, Value>) -> Result<(), String> {
    save_yaml_block_at(&config_yaml_path(), servers)
}

fn save_yaml_block_at(path: &std::path::Path, servers: &Map<String, Value>) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = existing.lines().collect();

    // Find the existing `subagents:` top-level block (line-oriented, same
    // convention as `save_mcp_servers`).
    let block_start = lines.iter().position(|l| {
        !l.starts_with(' ')
            && l.starts_with("subagents")
            && l["subagents".len()..].trim_start().starts_with(':')
    });
    let block_end = match block_start {
        Some(i) => {
            let mut i = i + 1;
            while i < lines.len()
                && lines[i].starts_with(' ')
                && !lines[i].trim().is_empty()
            {
                i += 1;
            }
            i
        }
        None => lines.len(),
    };

    let body = if servers.is_empty() {
        // Empty map: drop the block entirely (if present).
        let start = block_start.unwrap_or(lines.len());
        let before = &lines[..start];
        let after = &lines[block_end..];
        let mut all: Vec<String> = before.iter().map(|s| s.to_string()).collect();
        all.extend(after.iter().map(|s| s.to_string()));
        all.join("\n")
    } else {
        // block_start is None (no existing block) → out starts with all
        // existing lines; block_end = lines.len() so the extend below is a
        // no-op, and the subagents block lands at end-of-file.
        let mut out: Vec<String> = match block_start {
            Some(start) => lines[..start].iter().map(|s| s.to_string()).collect(),
            None => lines.iter().map(|s| s.to_string()).collect(),
        };
        out.push("subagents:".into());
        for (key, value) in servers {
            out.push(format!(
                "  {key}: {}",
                serialize_yaml_value(value)
            ));
        }
        out.extend(lines[block_end..].iter().map(|s| s.to_string()));
        out.join("\n")
    };

    atomic_write(&path, &(body + "\n")).map_err(|e| e.to_string())
}

/// Serialize a JSON value into the flat single-line YAML scalar style that
/// the existing config.yaml uses (`string`, `number`, `bool`, or a
/// JSON-encoded object/array for nested values).
fn serialize_yaml_value(v: &Value) -> String {
    match v {
        Value::String(s) => format!("{s}"),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        // Nested object / array: emit as compact JSON (the parser in
        // `parse_yaml_top_block` understands JSON values via `try_json_value`).
        _ => v.to_string(),
    }
}

/// Parse a top-level `key:` block from a config.yaml text into a flat JSON
/// object. Reuses the subset parser already in `crate::mcp` via a local
/// copy to avoid a cross-module dep (mcp.rs's parser is `pub(crate)` but
/// importing it here would couple the two config-block writers; a small
/// local parser keeps this module self-contained and testable).
///
/// Scalars:
/// - `true` / `false` → JSON bool
/// - a JSON value (`{...}` or `[...]`) → parsed as JSON (number/object/array)
/// - `~` / empty → null
/// - bare / quoted string → JSON string
///
/// Nested keys under the block are also read (one level deep).
fn parse_yaml_top_block(text: &str, top_key: &str) -> Map<String, Value> {
    let lines: Vec<&str> = text.lines().collect();
    // Find the top-level `subagents:` line.
    let start = lines.iter().position(|l| {
        !l.starts_with(' ')
            && l.starts_with(top_key)
            && l[top_key.len()..].trim_start().starts_with(':')
    });
    let Some(mut i) = start else {
        return Map::new();
    };
    i += 1;

    let mut out: Map<String, Value> = Map::new();
    // Track the last top-level sub-key we saw so we can decide when the
    // block ends (a line at column 0 that isn't blank/comment).
    while i < lines.len() {
        let line = lines[i];
        if !line.starts_with(' ') {
            // Left the block.
            break;
        }
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }
        // Nested (indented) keys: `  key: value`.
        let indent = line.len() - trimmed.len();
        if indent != 2 {
            // We only parse one level of nesting; skip deeper lines (rare).
            i += 1;
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            i += 1;
            continue;
        };
        let key = trimmed[..colon].trim();
        let raw = trimmed[colon + 1..].trim();
        if key.is_empty() {
            i += 1;
            continue;
        }
        let val: Value = if raw.is_empty() {
            // `key:` with nothing — could be an empty map or a nested block.
            // Look ahead for deeper-indented lines to decide.
            let mut j = i + 1;
            while j < lines.len() {
                let next = lines[j];
                if !next.starts_with(' ') {
                    break;
                }
                let next_trim = next.trim_start();
                if next_trim.is_empty() || next_trim.starts_with('#') {
                    j += 1;
                    continue;
                }
                break;
            }
            // `j` is the first significant next line. If it is indented more
            // than 2, treat as nested map; otherwise it's an empty value.
            if j < lines.len()
                && lines[j].starts_with(' ')
                && (lines[j].len() - lines[j].trim_start().len()) > 2
            {
                // Nested map: parse it recursively (one more level).
                parse_yaml_top_block_nested(&lines, i, 4)
            } else {
                Value::Null
            }
        } else if raw.starts_with('{') || raw.starts_with('[') {
            serde_json::from_str(raw).unwrap_or(Value::String(raw.to_string()))
        } else if raw == "true" {
            Value::Bool(true)
        } else if raw == "false" {
            Value::Bool(false)
        } else if raw == "null" || raw == "~" {
            Value::Null
        } else if let Ok(n) = raw.parse::<i64>() {
            Value::Number(n.into())
        } else if let Ok(n) = raw.parse::<f64>() {
            Value::Number(serde_json::Number::from_f64(n).unwrap_or(serde_json::Number::from(0)))
        } else {
            let s = raw.trim_matches('"').trim_matches('\'');
            Value::String(s.to_string())
        };
        out.insert(key.to_string(), val);
        i += 1;
    }
    out
}

/// Parse a nested (one-level) map under an empty `key:` line. Indent 4.
fn parse_yaml_top_block_nested(
    lines: &[&str],
    i: usize,
    indent: usize,
) -> Value {
    let mut map: Map<String, Value> = Map::new();
    let mut j = i + 1;
    while j < lines.len() {
        let line = lines[j];
        if !line.starts_with(' ') {
            break;
        }
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            j += 1;
            continue;
        }
        let cur_indent = line.len() - trimmed.len();
        if cur_indent < indent {
            break;
        }
        if cur_indent > indent {
            // Skip deeper lines (not our level).
            j += 1;
            continue;
        }
        if trimmed.starts_with("- ") || trimmed == "-" {
            // List under a nested key — flatten to a JSON array of scalars.
            let mut arr: Vec<Value> = Vec::new();
            while j < lines.len() {
                let l2 = lines[j];
                let t2 = l2.trim_start();
                let ind2 = l2.len() - t2.len();
                if ind2 < indent || (!t2.starts_with("- ") && t2 != "-") {
                    break;
                }
                let rest = t2.trim_start_matches("-").trim();
                if rest.is_empty() {
                    arr.push(Value::Null);
                } else if rest.starts_with('{') || rest.starts_with('[') {
                    arr.push(serde_json::from_str(rest).unwrap_or(Value::String(
                        rest.to_string(),
                    )));
                } else {
                    let s = rest.trim_matches('"').trim_matches('\'');
                    arr.push(Value::String(s.to_string()));
                }
                j += 1;
            }
            // We consumed a list but the key is the one that preceded it.
            // Since this branch is hit after a `key:` with a nested list,
            // treat the last-inserted key's value as this list.
            if let Some(last_key) = map.iter().rev().find_map(|(k, _)| Some(k.clone())) {
                let key = last_key.clone();
                map.insert(key, Value::Array(arr));
            }
            continue;
        }
        let Some(colon) = trimmed.find(':') else {
            j += 1;
            continue;
        };
        let key = trimmed[..colon].trim();
        let raw = trimmed[colon + 1..].trim();
        if key.is_empty() {
            j += 1;
            continue;
        }
        let val: Value = if raw.is_empty() {
            Value::Null
        } else if raw.starts_with('{') || raw.starts_with('[') {
            serde_json::from_str(raw).unwrap_or(Value::String(raw.to_string()))
        } else if raw == "true" {
            Value::Bool(true)
        } else if raw == "false" {
            Value::Bool(false)
        } else if raw == "null" || raw == "~" {
            Value::Null
        } else if let Ok(n) = raw.parse::<i64>() {
            Value::Number(n.into())
        } else {
            let s = raw.trim_matches('"').trim_matches('\'');
            Value::String(s.to_string())
        };
        map.insert(key.to_string(), val);
        j += 1;
    }
    Value::Object(map)
}

/// Mirror the canonical settings (yaml shape, flat) into the extension's
/// `subagents.json` so the running extension sees them on respawn.
fn mirror_to_subagents_json(settings: &Map<String, Value>) {
    let path = legacy_subagents_json_path();
    if settings.is_empty() {
        // Empty settings: drop the mirror file so no server lingers.
        let _ = std::fs::remove_file(&path);
        return;
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")));
    if let Ok(text) = serde_json::to_string_pretty(&Value::Object(settings.clone())) {
        let _ = std::fs::write(&path, text + "\n");
    }
}

#[tauri::command]
pub fn subagents_settings_list() -> Value {
    let settings = load_subagents_migrate();
    json!({ "ok": true, "settings": Value::Object(settings) })
}

#[tauri::command]
pub fn subagents_settings_save(
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    settings: Value,
) -> Value {
    let Some(obj) = settings.as_object() else {
        return json!({ "ok": false, "error": "settings must be an object" });
    };
    for key in obj.keys() {
        // Settings keys are camelCase identifiers; reject anything odd.
        if key.is_empty()
            || key.chars().any(|c| c.is_whitespace() || c.is_control())
            || key.contains(':')
        {
            return json!({ "ok": false, "error": format!("invalid settings key: {key:?}") });
        }
    }

    if let Err(e) = save_yaml_block(obj) {
        return json!({ "ok": false, "error": format!("write failed: {e}") });
    }
    // Mirror into subagents.json so the extension picks the values up.
    mirror_to_subagents_json(obj);
    // The extension reads subagents.json at process start — respawn pi so
    // the change takes effect for the running agent.
    gateway::restart_gateway_soon(&Arc::clone(&state));
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serialize_yaml_value_shapes() {
        assert_eq!(serialize_yaml_value(&json!(true)), "true");
        assert_eq!(serialize_yaml_value(&json!(42)), "42");
        assert_eq!(serialize_yaml_value(&json!("x")), "x");
        assert_eq!(serialize_yaml_value(&Value::Null), "null");
        // Nested object stays JSON-encoded.
        assert!(serialize_yaml_value(&json!({"a": 1})).contains("a"));
    }

    #[test]
    fn parse_yaml_top_block_reads_flat_scalars() {
        let text = concat!(
            "agent:\n",
            "  service_tier: \"default\"\n",
            "\n",
            "subagents:\n",
            "  workflowsEnabled: false\n",
            "  schedulingEnabled: false\n",
            "  toolDescriptionMode: compact\n",
            "  worktreeIsolation: false\n",
            "  maxConcurrent: 3\n",
            "  agentMentions: direct\n",
        );
        let m = parse_yaml_top_block(text, "subagents");
        assert_eq!(m.get("workflowsEnabled"), Some(&json!(false)));
        assert_eq!(m.get("schedulingEnabled"), Some(&json!(false)));
        assert_eq!(m.get("toolDescriptionMode"), Some(&json!("compact")));
        assert_eq!(m.get("worktreeIsolation"), Some(&json!(false)));
        assert_eq!(m.get("maxConcurrent"), Some(&json!(3)));
        assert_eq!(m.get("agentMentions"), Some(&json!("direct")));
        // Keys from other top-level blocks must not leak in.
        assert!(!m.contains_key("service_tier"));
    }

    #[test]
    fn parse_yaml_top_block_empty_when_missing() {
        let m = parse_yaml_top_block("agent:\n  x: 1\n", "subagents");
        assert!(m.is_empty());
    }

    #[test]
    fn save_yaml_block_replaces_existing_block() {
        // Simulate config.yaml with an existing subagents block + other blocks.
        let original = concat!(
            "agent:\n",
            "  service_tier: \"default\"\n",
            "subagents:\n",
            "  workflowsEnabled: true\n",
            "  schedulingEnabled: true\n",
            "vision:\n",
            "  provider: zai\n",
        );
        let tmp = std::env::temp_dir().join("helix_subagents_save_test.yaml");
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(&tmp, original).unwrap();

        let mut servers: Map<String, Value> = Map::new();
        servers.insert("workflowsEnabled".into(), json!(false));
        servers.insert("toolDescriptionMode".into(), json!("compact"));
        save_yaml_block_at(&tmp, &servers).unwrap();

        let result = std::fs::read_to_string(&tmp).unwrap();
        assert!(result.contains("agent:"), "agent block missing");
        assert!(result.contains("vision:"), "vision block missing");
        assert!(result.contains("subagents:"), "subagents block missing");
        assert!(!result.contains("schedulingEnabled: true"), "old value should be replaced");
        assert!(result.contains("workflowsEnabled: false"));
        assert!(result.contains("toolDescriptionMode: compact"));

        // Round-trip: parse back and compare.
        let re_parsed = parse_yaml_top_block(&result, "subagents");
        assert_eq!(re_parsed.get("workflowsEnabled"), Some(&json!(false)));
        assert_eq!(
            re_parsed.get("toolDescriptionMode"),
            Some(&json!("compact"))
        );
        // Removed key must not appear.
        assert!(!re_parsed.contains_key("schedulingEnabled"));

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn save_yaml_block_appends_when_missing() {
        // No existing subagents block: the new block lands at end-of-file
        // after all other blocks, which is fine for YAML validity.
        let original = concat!(
            "agent:
",
            "  service_tier: \"default\"
",
            "vision:
",
            "  provider: zai
",
        );
        let tmp = std::env::temp_dir().join("helix_subagents_append_test.yaml");
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(&tmp, original).unwrap();

        let mut servers: Map<String, Value> = Map::new();
        servers.insert("workflowsEnabled".into(), json!(true));
        save_yaml_block_at(&tmp, &servers).unwrap();

        let result = std::fs::read_to_string(&tmp).unwrap();
        assert!(result.contains("subagents:"), "subagents block not appended");
        assert!(result.contains("workflowsEnabled: true"));
        assert!(result.contains("agent:"), "agent block missing");
        assert!(result.contains("vision:"), "vision block missing");

        let re_parsed = parse_yaml_top_block(&result, "subagents");
        assert_eq!(re_parsed.get("workflowsEnabled"), Some(&json!(true)));

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn save_yaml_block_empty_removes_block() {
        let original = concat!(
            "agent:\n",
            "  service_tier: \"default\"\n",
            "subagents:\n",
            "  workflowsEnabled: true\n",
            "vision:\n",
            "  provider: zai\n",
        );
        let tmp = std::env::temp_dir().join("helix_subagents_empty_test.yaml");
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(&tmp, original).unwrap();

        save_yaml_block_at(&tmp, &Map::new()).unwrap();

        let result = std::fs::read_to_string(&tmp).unwrap();
        assert!(!result.contains("subagents:"), "subagents block should be removed");
        assert!(result.contains("agent:"), "agent block missing");
        assert!(result.contains("vision:"), "vision block missing");

        let _ = std::fs::remove_file(&tmp);
    }
}
