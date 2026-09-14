//! Image-generation model IPC — read/write the `image:` block in config.yaml.
//!
//! Mirrors `vision.rs`: the block holds provider / model / baseUrl / apiKey for
//! the image-generation model configured in the frontend settings panel.
//! The block is intentionally not consumed by any runtime yet — this is a
//! settings-only store, ready to be wired to actual image-generation calls
//! later.

use crate::config::{atomic_write, config_yaml_path, read_yaml_block, set_yaml_key};
use serde_json::{json, Value};

const IMAGE_KEYS: [&str; 4] = ["provider", "model", "baseUrl", "apiKey"];

fn read_config() -> Value {
    let yaml = std::fs::read_to_string(config_yaml_path()).unwrap_or_default();
    let block = read_yaml_block(&yaml, "image");

    // Serialize the block map into a JSON object (`read_yaml_block` values
    // are scalar strings; missing keys default to "").
    let mut obj = serde_json::Map::new();
    for k in IMAGE_KEYS {
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
pub fn image_config_list() -> Value {
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
pub fn image_config_save(config: Value) -> Value {
    if !config.is_object() {
        return json!({ "ok": false, "error": "invalid config" });
    }
    let yaml_path = config_yaml_path();
    let mut yaml = std::fs::read_to_string(&yaml_path).unwrap_or_default();
    for k in IMAGE_KEYS {
        let v = config
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        yaml = set_yaml_key(&yaml, &format!("image.{k}"), &json!(v));
    }
    match atomic_write(&yaml_path, &yaml) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}
