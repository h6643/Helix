//! Channels IPC — read/write messaging platform tokens in .env.
//! Platforms: Telegram, Discord, Slack, WhatsApp, Signal, DingTalk, Feishu, WeCom, Webhook.

use crate::config::env_path;
use crate::gateway::{env_gateway_mode, kill_current, spawn_gateway};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

const CHANNEL_ENV_KEYS: &[(&str, &str, &[&str])] = &[
    ("telegram", "TELEGRAM_BOT_TOKEN", &["TELEGRAM_ALLOWED_USERS", "TELEGRAM_HOME_CHANNEL"]),
    ("discord", "DISCORD_BOT_TOKEN", &["DISCORD_ALLOWED_USERS"]),
    ("slack", "SLACK_BOT_TOKEN", &["SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS"]),
    ("whatsapp", "WHATSAPP_ACCESS_TOKEN", &["WHATSAPP_ALLOWED_USERS"]),
    ("signal", "SIGNALPhoneNumberID", &["SIGNAL_AUTH_TOKEN"]),
    ("dingtalk", "DINGTALK_APP_KEY", &["DINGTALK_APP_SECRET"]),
    ("feishu", "FEISHU_APP_ID", &["FEISHU_APP_SECRET"]),
    ("wecom", "WECOM_CORP_ID", &["WECOM_APP_SECRET"]),
    ("webhook", "WEBHOOK_SECRET", &[]),
    ("api_server", "OPENAI_API_KEY", &[]),
];

#[tauri::command]
pub fn channels_list() -> Value {
    let env_path = env_path();
    let env_content = std::fs::read_to_string(&env_path).unwrap_or_default();

    let mut channels: Vec<Value> = Vec::new();

    for (id, main_key, extra_keys) in CHANNEL_ENV_KEYS {
        let mut config: serde_json::Map<String, Value> = serde_json::Map::new();

        // Read main key
        let main_val = read_env_key(&env_content, main_key);
        config.insert(main_key.to_string(), Value::String(main_val.clone()));

        // Read extra keys
        for key in *extra_keys {
            let val = read_env_key(&env_content, key);
            config.insert(key.to_string(), Value::String(val));
        }

        let enabled = !main_val.is_empty();

        channels.push(json!({
            "id": id,
            "name": channel_name(id),
            "description": channel_description(id),
            "enabled": enabled,
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

    let env_path = env_path();
    let mut env_lines: Vec<String> = if let Ok(env) = std::fs::read_to_string(&env_path) {
        env.lines().map(|s| s.to_string()).collect()
    } else {
        Vec::new()
    };

    // Collect all keys we manage
    let all_keys: Vec<&str> = CHANNEL_ENV_KEYS
        .iter()
        .flat_map(|(_, main, extras)| {
            std::iter::once(*main).chain(extras.iter().copied())
        })
        .collect();

    // Remove all managed keys
    env_lines.retain(|l| {
        !all_keys.iter().any(|k| l.starts_with(&format!("{k}=")))
    });

    // Add back from channels
    for ch in arr {
        let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let enabled = ch.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let config = ch.get("config").cloned().unwrap_or(Value::Object(serde_json::Map::new()));

        if !enabled {
            continue;
        }

        // Find the main key for this channel
        if let Some((_, main_key, extra_keys)) = CHANNEL_ENV_KEYS.iter().find(|(i, _, _)| *i == id) {
            if let Some(v) = config.get(*main_key).and_then(|v| v.as_str()) {
                if !v.is_empty() {
                    env_lines.push(format!("{main_key}={v}"));
                }
            }
            for key in *extra_keys {
                if let Some(v) = config.get(*key).and_then(|v| v.as_str()) {
                    if !v.is_empty() {
                        env_lines.push(format!("{key}={v}"));
                    }
                }
            }
        }
    }

    if let Some(dir) = env_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&env_path, env_lines.join("\n"));

    // Restart gateway in acp mode
    if env_gateway_mode() != "serve" {
        kill_current(&state);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = spawn_gateway(&state);
    }

    json!({ "ok": true })
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

fn channel_name(id: &str) -> &str {
    match id {
        "telegram" => "Telegram",
        "discord" => "Discord",
        "slack" => "Slack",
        "whatsapp" => "WhatsApp",
        "signal" => "Signal",
        "dingtalk" => "钉钉",
        "feishu" => "飞书",
        "wecom" => "企业微信",
        "webhook" => "Webhook",
        "api_server" => "API Server",
        _ => id,
    }
}

fn channel_description(id: &str) -> &str {
    match id {
        "telegram" => "Telegram Bot API",
        "discord" => "Discord Bot",
        "slack" => "Slack Bot (Socket Mode)",
        "whatsapp" => "WhatsApp Business API",
        "signal" => "Signal Messenger",
        "dingtalk" => "钉钉企业应用",
        "feishu" => "飞书企业应用",
        "wecom" => "企业微信应用",
        "webhook" => "通用 Webhook 接入",
        "api_server" => "OpenAI 兼容 API 服务",
        _ => "",
    }
}
