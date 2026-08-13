//! Channels IPC — dynamic channel catalog + per-channel env tokens.
//!
//! The catalog of *which* channels exist lives in `<hermes_data_dir>/channels.json`
//! (seeded with built-in defaults on first run). The UI can add / remove / rename
//! channels; each channel declares the env-var keys it manages (`envKeys`). Actual
//! token values are read from and written to `.env` (the location the gateway
//! expects), and the gateway is restarted when running in acp mode.

use crate::config::env_path;
use crate::gateway::{env_gateway_mode, kill_current, spawn_gateway};
use crate::paths::hermes_data_dir;
use crate::state::AppState;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tauri::State;

/// Built-in seed catalog used the first time `channels.json` is created.
/// `(id, display name, description, [env keys])`
const DEFAULT_CHANNELS: &[(&str, &str, &str, &[&str])] = &[
    ("telegram", "Telegram", "Telegram Bot API", &["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_HOME_CHANNEL"]),
    ("discord", "Discord", "Discord Bot", &["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS"]),
    ("slack", "Slack", "Slack Bot (Socket Mode)", &["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS"]),
    ("whatsapp", "WhatsApp", "WhatsApp Business API", &["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_ALLOWED_USERS"]),
    ("signal", "Signal", "Signal Messenger", &["SIGNALPhoneNumberID", "SIGNAL_AUTH_TOKEN"]),
    ("dingtalk", "钉钉", "钉钉企业应用", &["DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"]),
    ("feishu", "飞书", "飞书企业应用", &["FEISHU_APP_ID", "FEISHU_APP_SECRET"]),
    ("wecom", "企业微信", "企业微信应用", &["WECOM_CORP_ID", "WECOM_APP_SECRET"]),
    ("webhook", "Webhook", "通用 Webhook 接入", &["WEBHOOK_SECRET"]),
    ("api_server", "API Server", "OpenAI 兼容 API 服务", &["OPENAI_API_KEY"]),
];

fn channels_json_path() -> std::path::PathBuf {
    hermes_data_dir().join("channels.json")
}

/// Read the channel catalog. Seeds `channels.json` from defaults on first run.
fn load_definitions() -> Vec<Value> {
    let path = channels_json_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&content) {
            if let Some(arr) = v.get("channels").and_then(|c| c.as_array()) {
                if !arr.is_empty() {
                    return arr.clone();
                }
            }
        }
    }
    // First run — seed the catalog so it is no longer hardcoded in this file's logic.
    let seed: Vec<Value> = DEFAULT_CHANNELS
        .iter()
        .map(|(id, name, desc, keys)| {
            json!({
                "id": id,
                "name": name,
                "description": desc,
                "envKeys": keys,
            })
        })
        .collect();
    let _ = std::fs::create_dir_all(hermes_data_dir());
    let _ = std::fs::write(&path, json!({ "channels": seed }).to_string());
    seed
}

fn read_env_key(content: &str, key: &str) -> String {
    let needle = format!("{key}=");
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix(&needle) {
            return rest.trim().to_string();
        }
    }
    String::new()
}

#[tauri::command]
pub fn channels_list() -> Value {
    let env_path = env_path();
    let env_content = std::fs::read_to_string(&env_path).unwrap_or_default();
    let defs = load_definitions();

    let mut channels: Vec<Value> = Vec::new();
    for def in &defs {
        let id = def.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = def.get("name").and_then(|v| v.as_str()).unwrap_or(id);
        let description = def.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let env_keys: Vec<String> = def
            .get("envKeys")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        let mut config: Map<String, Value> = Map::new();
        for key in &env_keys {
            let val = read_env_key(&env_content, key);
            config.insert(key.clone(), Value::String(val));
        }
        let enabled = env_keys
            .first()
            .map(|k| !read_env_key(&env_content, k).is_empty())
            .unwrap_or(false);

        channels.push(json!({
            "id": id,
            "name": name,
            "description": description,
            "enabled": enabled,
            "envKeys": env_keys,
            "config": Value::Object(config),
        }));
    }

    json!({ "ok": true, "channels": channels })
}

#[tauri::command]
pub fn channels_save(state: State<'_, Arc<AppState>>, channels: Value) -> Value {
    let Some(arr) = channels.as_array() else {
        return json!({ "ok": false, "error": "invalid channels" });
    };

    // 1) Persist the catalog (definitions) to channels.json — this is what makes
    //    add / remove / rename durable across restarts.
    let defs: Vec<Value> = arr
        .iter()
        .map(|ch| {
            let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
            let description = ch.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let env_keys: Vec<String> = ch
                .get("envKeys")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .or_else(|| {
                    ch.get("config")
                        .and_then(|v| v.as_object())
                        .map(|o| o.keys().cloned().collect())
                })
                .unwrap_or_default();
            json!({
                "id": id,
                "name": name,
                "description": description,
                "envKeys": env_keys,
            })
        })
        .collect();
    let _ = std::fs::create_dir_all(hermes_data_dir());
    let _ = std::fs::write(channels_json_path(), json!({ "channels": defs }).to_string());

    // 2) Write env values for enabled channels to .env.
    let env_path = env_path();
    let env_lines: Vec<String> = if let Ok(env) = std::fs::read_to_string(&env_path) {
        env.lines().map(|s| s.to_string()).collect()
    } else {
        Vec::new()
    };

    // Collect every key currently managed (defs + incoming config) so stale ones
    // are purged — covers renamed/deleted channels and keys.
    let mut managed_keys: Vec<String> = Vec::new();
    for d in &defs {
        if let Some(keys) = d.get("envKeys").and_then(|v| v.as_array()) {
            for k in keys {
                if let Some(s) = k.as_str() {
                    if !managed_keys.iter().any(|x| x == s) {
                        managed_keys.push(s.to_string());
                    }
                }
            }
        }
    }
    for ch in arr {
        if let Some(cfg) = ch.get("config").and_then(|v| v.as_object()) {
            for k in cfg.keys() {
                if !managed_keys.iter().any(|x| x == k) {
                    managed_keys.push(k.clone());
                }
            }
        }
    }

    let mut out: Vec<String> = env_lines
        .into_iter()
        .filter(|l| !managed_keys.iter().any(|k| l.starts_with(&format!("{k}="))))
        .collect();

    for ch in arr {
        let enabled = ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        if !enabled {
            continue;
        }
        if let Some(cfg) = ch.get("config").and_then(|v| v.as_object()) {
            for (k, v) in cfg {
                if let Some(s) = v.as_str() {
                    if !s.is_empty() {
                        out.push(format!("{k}={s}"));
                    }
                }
            }
        }
    }

    if let Some(dir) = env_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&env_path, out.join("\n"));

    // Restart gateway in acp mode so new tokens take effect.
    if env_gateway_mode() != "serve" {
        kill_current(&state);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = spawn_gateway(&state);
    }

    json!({ "ok": true })
}
