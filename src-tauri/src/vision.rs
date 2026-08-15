//! Vision model IPC — read/write the `auxiliary.vision:` block in Hermes
//! config.yaml. The vision API key is synced to `.env` (HELIX_VISION_API_KEY)
//! and referenced from YAML via `key_env`, mirroring how web_search handles
//! search keys (keeps secrets out of the committed yaml).

use crate::config::{config_yaml_path, env_path, remove_yaml_key_deep, set_yaml_key_deep};
use crate::gateway::{env_gateway_mode, kill_current, spawn_gateway};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn vision_config_list(_state: State<'_, Arc<AppState>>) -> Value {
    let yaml_path = config_yaml_path();
    let text = match std::fs::read_to_string(&yaml_path) {
        Ok(t) => t,
        Err(_) => {
            return json!({ "ok": true, "config": { "provider": "", "model": "", "baseUrl": "", "apiKey": "" } })
        }
    };

    let mut provider = String::new();
    let mut model = String::new();
    let mut base_url = String::new();
    let mut inline_api_key = String::new();
    let mut in_aux = false;
    let mut in_vision = false;

    for line in text.split('\n') {
        if !line.starts_with(' ') && line.starts_with("auxiliary:") {
            in_aux = true;
            continue;
        }
        if in_aux {
            if !line.starts_with(' ') {
                in_aux = false;
                in_vision = false;
                continue;
            }
            let trimmed = line.trim_start();
            if trimmed.starts_with("vision:") {
                in_vision = true;
                continue;
            }
            if in_vision {
                // vision children are indented 4 spaces deeper than top level
                if !line.starts_with("    ") {
                    in_vision = false;
                    continue;
                }
                if let Some(rest) = trimmed.strip_prefix("provider:") {
                    provider = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(rest) = trimmed.strip_prefix("model:") {
                    model = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(rest) = trimmed.strip_prefix("base_url:") {
                    base_url = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(rest) = trimmed.strip_prefix("api_key:") {
                    // Legacy configs stored the key inline. Keep it as a fallback
                    // so the UI isn't wiped on restart; saves migrate it to .env.
                    inline_api_key = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                }
            }
        }
    }

    // Read the vision API key from .env (written under HELIX_VISION_API_KEY),
    // falling back to a legacy inline api_key in config.yaml.
    let mut env_api_key = String::new();
    if let Ok(env) = std::fs::read_to_string(env_path()) {
        for line in env.lines() {
            if let Some(rest) = line.strip_prefix("HELIX_VISION_API_KEY=") {
                env_api_key = rest.trim().to_string();
            }
        }
    }
    let api_key = if !env_api_key.is_empty() {
        env_api_key
    } else {
        inline_api_key
    };

    json!({
        "ok": true,
        "config": {
            "provider": provider,
            "model": model,
            "baseUrl": base_url,
            "apiKey": api_key,
        }
    })
}

#[tauri::command]
pub fn vision_config_save(state: State<'_, Arc<AppState>>, config: Value) -> Value {
    if !config.is_object() {
        return json!({ "ok": false, "error": "invalid config" });
    }

    let provider = config.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let model = config.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let base_url = config.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = config.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");

    let yaml_path = config_yaml_path();
    let mut yaml = std::fs::read_to_string(&yaml_path).unwrap_or_default();

    yaml = set_yaml_key_deep(&yaml, "auxiliary.vision.provider", &json!(provider));
    yaml = set_yaml_key_deep(&yaml, "auxiliary.vision.model", &json!(model));
    yaml = set_yaml_key_deep(&yaml, "auxiliary.vision.base_url", &json!(base_url));
    // Point hermes at the env var that holds the key (auxiliary_client reads
    // `key_env` / `api_key_env`).
    yaml = set_yaml_key_deep(
        &yaml,
        "auxiliary.vision.key_env",
        &json!(if api_key.is_empty() { "" } else { "HELIX_VISION_API_KEY" }),
    );
    // Move the secret out of config.yaml: drop any legacy inline api_key now
    // that it lives in .env under HELIX_VISION_API_KEY (referenced via key_env).
    yaml = remove_yaml_key_deep(&yaml, "auxiliary.vision.api_key");

    if let Some(dir) = yaml_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&yaml_path, &yaml);

    // Sync the vision API key to .env
    let env_path = env_path();
    let mut env_lines: Vec<String> = if let Ok(env) = std::fs::read_to_string(&env_path) {
        env.lines().map(|s| s.to_string()).collect()
    } else {
        Vec::new()
    };
    env_lines.retain(|l| !l.starts_with("HELIX_VISION_API_KEY="));
    if !api_key.is_empty() {
        env_lines.push(format!("HELIX_VISION_API_KEY={api_key}"));
    }
    if let Some(dir) = env_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&env_path, env_lines.join("\n"));

    // Restart the gateway in non-serve modes so hermes picks up the new config.
    if env_gateway_mode() != "serve" {
        kill_current(&state);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = spawn_gateway(&state);
    }

    json!({ "ok": true })
}
