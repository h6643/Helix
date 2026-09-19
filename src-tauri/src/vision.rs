//! Vision model IPC — read/write the `vision:` block in config.yaml and call
//! the model.
//!
//! The vision model is invoked directly (OpenAI-compatible `/chat/completions`)
//! to turn an image into a text description before it reaches the main model
//! (mirrors the helix-era behaviour, saving the main model's multimodal tokens).
//! Config lives in config.yaml's `vision:` block (provider / model / baseUrl /
//! apiKey) alongside the rest of Helix's non-model settings; a legacy
//! standalone `vision.json` is folded in on first read.

use crate::config::{atomic_write, config_yaml_path, read_yaml_block, set_yaml_key};
use serde_json::{json, Value};

const VISION_KEYS: [&str; 4] = ["provider", "model", "baseUrl", "apiKey"];

fn read_config() -> Value {
    let yaml = std::fs::read_to_string(config_yaml_path()).unwrap_or_default();
    let block = read_yaml_block(&yaml, "vision");

    // One-time migration: fold a legacy standalone vision.json into the
    // `vision:` block, then remove the old file so it can't drift again.
    if block.is_empty() {
        let legacy_path = crate::paths::helix_data_dir().join("vision.json");
        if let Ok(raw) = std::fs::read_to_string(&legacy_path) {
            if let Ok(old) = serde_json::from_str::<Value>(&raw) {
                if old.get("provider").and_then(|v| v.as_str()).is_some() {
                    let mut yaml = yaml;
                    for k in VISION_KEYS {
                        if let Some(v) = old.get(k).and_then(|v| v.as_str()) {
                            if !v.is_empty() {
                                yaml = set_yaml_key(&yaml, &format!("vision.{k}"), &json!(v));
                            }
                        }
                    }
                    let _ = atomic_write(&config_yaml_path(), &yaml);
                    let _ = std::fs::remove_file(&legacy_path);
                    return read_yaml_block(&yaml, "vision")
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<serde_json::Map<String, Value>>()
                        .into();
                }
            }
        }
    }

    // Serialize the block map into a JSON object (`read_yaml_block` values
    // are scalar strings; missing keys default to "").
    let mut obj = serde_json::Map::new();
    for k in VISION_KEYS {
        let v = block
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        obj.insert(k.to_string(), Value::String(v));
    }
    Value::Object(obj)
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
    let yaml_path = config_yaml_path();
    let mut yaml = std::fs::read_to_string(&yaml_path).unwrap_or_default();
    for k in VISION_KEYS {
        let v = config
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        yaml = set_yaml_key(&yaml, &format!("vision.{k}"), &json!(v));
    }
    match atomic_write(&yaml_path, &yaml) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Turn an image (data URL) into a text description using the configured
/// vision model. Returns the description string, or an error the frontend
/// treats as "fall back to native image_url".
///
/// Core logic — callable directly from Rust (e.g. pi_gateway) or via the
/// tauri command `vision_describe_command` below.
pub async fn vision_describe_core(image: String, prompt: Option<String>) -> Result<String, String> {
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

/// Tauri command wrapper — keeps the old command name `vision_describe`
/// for the frontend.
#[tauri::command]
pub async fn vision_describe(image: String, prompt: Option<String>) -> Result<String, String> {
    vision_describe_core(image, prompt).await
}

/// Convert a pi ImageContent value (`{type:"image", data, mimeType}`) back to
/// a `data:` URL for the vision model. Returns None for non-image values.
pub fn image_to_data_url(img: &serde_json::Value) -> Option<String> {
    let data = img.get("data")?.as_str()?;
    let mime = img.get("mimeType").and_then(Value::as_str).unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}
