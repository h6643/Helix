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

/// 转录底座契约 —— **必须与 `vendor/pi-aux-vision/vision.ts` 的 SYSTEM_PROMPT 逐字一致**。
///
/// 2026-10-06 起这份实现只剩两个调用方（浏览器截图转述、设置页连通性测试），
/// 粘贴图的自动转述已删（统一走 `describe_image` 工具）。但既然还在，就不能比
/// 扩展那份差：同一个视觉模型、同一份配置，两条路给出的描述质量应该一致。
/// 两处 SYSTEM_PROMPT 任何一处改动都要同步另一处 —— 这正是「同一判定/清单写
/// 两份必然对不上」那个坑的最小变体。
const SYSTEM_PROMPT: &str = concat!(
    "You are a precise image analysis assistant. Regardless of the question, ALWAYS begin ",
    "with an exhaustive transcription base: ",
    "1) classify the image type (terminal screenshot, log output, error dialog, UI/screenshot, ",
    "photo, diagram, or other); ",
    "2) transcribe verbatim ALL visible text, code, and error messages — every line, in the ",
    "original language, untranslated; note the layout and reading order (top to bottom, blocks, ",
    "highlighted items); ",
    "3) coordinates, colors, and non-text visual details are best-effort only. ",
    "If the image contains no readable text, state that explicitly and describe the visual content ",
    "instead. ",
    "Then, in a section headed 'Answer', answer the user's question factually and precisely using ",
    "the transcription base. ",
    "End with a completeness attestation in the response language, using exactly one of: ",
    "'I have exhaustively transcribed all visible text.' or 'No readable text was found — I ",
    "described the visual content instead.' ",
    "Respond in the same language as the user's question (the transcription itself stays verbatim ",
    "in the original language)."
);

/// 撞 `max_tokens` 时在结果头部显式声明截断（与扩展的 ADR-0002 同一处理）。
/// 不做的话，调用方会把半截转写当完整结果用 —— 那比报错更坏。
fn truncation_notice(finish_reason: &str) -> Option<&'static str> {
    if finish_reason == "length" {
        Some(
            "[注意：本次输出撞到 max_tokens 上限而被截断，下面的转写**不完整**。\n\
             如需完整内容，请缩小提问范围后重试。]\n\n",
        )
    } else {
        None
    }
}

/// Turn an image (data URL) into a text description using the configured
/// vision model.
///
/// # 调用方（2026-10-06 起只剩两个）
/// - `browser-automation.tsx`：浏览器截图转述（前端要**同步拿到字符串**回传主
///   模型，扩展的 `describe_image` 只暴露给模型、`/vision` 命令是 notify
///   fire-and-forget，都拿不到返回值 ⇒ 只能走本函数）
/// - 设置页「视觉模型」的连通性测试
///
/// 粘贴图**不再**走这里（`pi_gateway.rs::session/prompt` 里已改成落盘 + 提示模型
/// 调 `describe_image`）。网关自动转述与扩展工具是同一件事的两份实现，删掉一份。
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

    let question = prompt.filter(|p| !p.is_empty()).unwrap_or_else(|| {
        "Describe this image in detail, including any text, code, tables, and key data."
            .into()
    });

    let url = if base_url.ends_with('/') {
        format!("{base_url}chat/completions")
    } else {
        format!("{base_url}/chat/completions")
    };

    // 与扩展一致：system 承载转录底座契约，user 承载具体问题 + 图。
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": question },
                    { "type": "image_url", "image_url": { "url": image } }
                ]
            }
        ],
        "max_tokens": 1024
    });

    let client = crate::proxy::proxy_aware_client().map_err(|e| e.to_string())?;
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

    // OpenAI-shaped response: choices[0].message.content + choices[0].finish_reason
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err("vision API returned empty content".into());
    }
    let finish_reason = v["choices"][0]["finish_reason"].as_str().unwrap_or("");
    Ok(match truncation_notice(finish_reason) {
        Some(notice) => format!("{notice}{content}"),
        None => content.to_string(),
    })
}

/// Tauri command wrapper — keeps the old command name `vision_describe`
/// for the frontend.
#[tauri::command]
pub async fn vision_describe(image: String, prompt: Option<String>) -> Result<String, String> {
    vision_describe_core(image, prompt).await
}
