//! Vision model IPC — read/write `~/.codex/vision.json` and call the model.
//!
//! The vision model is invoked directly (OpenAI-compatible `/chat/completions`)
//! to turn an image into a text description before it reaches the main model
//! (mirrors the helix-era behaviour, saving the main model's multimodal tokens).
//! It is persisted in its own JSON file rather than config.yaml so it never
//! collides with the codex app-server's config and needs no YAML deep-merge.

use crate::paths::helix_data_dir;
use serde_json::{json, Value};
use std::path::PathBuf;

fn vision_json_path() -> PathBuf {
    helix_data_dir().join("vision.json")
}

fn read_config() -> Value {
    match std::fs::read_to_string(vision_json_path()) {
        Ok(t) => serde_json::from_str(&t).unwrap_or(json!({})),
        Err(_) => json!({}),
    }
}

#[tauri::command]
pub fn vision_config_list() -> Value {
    let c = read_config();
    json!({
        "ok": true,
        "config": {
            "provider": c.get("provider").and_then(|v| v.as_str()).unwrap_or(""),
            "model": c.get("model").and_then(|v| v.as_str()).unwrap_or(""),
            "baseUrl": c.get("baseUrl").and_then(|v| v.as_str()).unwrap_or(""),
            "apiKey": c.get("apiKey").and_then(|v| v.as_str()).unwrap_or(""),
        }
    })
}

#[tauri::command]
pub fn vision_config_save(config: Value) -> Value {
    if !config.is_object() {
        return json!({ "ok": false, "error": "invalid config" });
    }
    let out = json!({
        "provider": config.get("provider").and_then(|v| v.as_str()).unwrap_or(""),
        "model": config.get("model").and_then(|v| v.as_str()).unwrap_or(""),
        "baseUrl": config.get("baseUrl").and_then(|v| v.as_str()).unwrap_or(""),
        "apiKey": config.get("apiKey").and_then(|v| v.as_str()).unwrap_or(""),
    });
    let path = vision_json_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(
        &path,
        serde_json::to_string_pretty(&out).unwrap_or_default(),
    ) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Turn an image (data URL) into a text description using the configured
/// vision model. Returns the description string, or an error the frontend
/// treats as "fall back to native image_url".
#[tauri::command]
pub async fn vision_describe(image: String, prompt: Option<String>) -> Result<String, String> {
    let c = read_config();
    let base_url = c
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let api_key = c
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model = c
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if base_url.is_empty() || model.is_empty() {
        return Err("vision model not configured".into());
    }

    let prompt = prompt.filter(|p| !p.is_empty()).unwrap_or_else(|| {
        "Describe this image in detail, including any text, code, tables, and key data. \
             Output for an assistant that cannot see the image."
            .into()
    });

    let url = if base_url.ends_with('/') {
        format!("{base_url}chat/completions")
    } else {
        format!("{base_url}/chat/completions")
    };

    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image } }
            ]
        }],
        "max_tokens": 1024
    });

    let client = reqwest::Client::new();
    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("vision API {status}: {text}"));
    }

    // OpenAI-shaped response: choices[0].message.content
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err("vision API returned empty content".into());
    }
    Ok(content.to_string())
}
