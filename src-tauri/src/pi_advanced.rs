//! 高级 pi 设置（`~/.pi/agent/settings.json`）读/写 + 项目信任 spawn flag。
//!
//! Helix 之前只碰了 settings.json 的极少数键（defaultModel / defaultProvider /
//! defaultTools 里的 codemode 项 / codemode.* / httpProxy），pi 其余可配项在
//! 界面上完全没有入口 —— 用户只能在编辑器里手改 JSON。这个模块把「稳定、
//! 值得暴露」的那一批收口成两个命令：
//!
//! * `helix_pi_advanced_get` — 一次性回读，缺省值按 pi 文档补齐（UI 不必自己
//!   记默认值，也不用猜「空 = 用内置默认」）。
//! * `helix_pi_advanced_set` — 点路径白名单写入。白名单是刻意的：settings.json
//!   是 pi 的主配置，一次拼错键名就能让 pi 启动行为漂移（例如把
//!   `defaultTools` 写成一个非数组会让 pi 忽略整份工具选择）。未知键一律
//!   拒绝并回报错，而不是静默写进去。
//!
//! 写完后 `restart_gateway_soon`（与 MCP/模型配置同一套去抖重放）：pi 在实例
//! 启动时快照 settings.json，运行中的实例不会自动重读。
//!
//! 项目信任（`helix_project_trust_*`）刻意**不**写 pi 的 `defaultProjectTrust`
//! —— 那会影响用户在终端里跑的 `pi`（`never`→`always` 等于把本机所有目录
//! 变成自动信任）。这里只决定 Helix spawn pi 时加不加 `--approve`/`--no-approve`
//! ，作用域限在 Helix 自己拉起的进程。

use crate::config::{
    config_write_lock, read_pi_settings, set_config_yaml_key, write_pi_settings,
};
use crate::gateway::restart_gateway_soon;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

/// 项目信任二档：
/// `always` = `--approve`（加载项目 settings/mcp/extensions/skills/prompts/themes）；
/// `never`（缺省）= `--no-approve`（一律跳过）。
///
/// 历史上还有个 `ask`（不传 flag），但 RPC 模式弹不出 pi 的交互信任提示，
/// 效果等同 `never`，只是更不透明。用户看到「我在项目里配了 .pi 却不生效」
/// 时不会往信任上想。所以直接删掉，只保留两个行为真的不同的档位。
const TRUST_ALWAYS: &str = "always";
const TRUST_NEVER: &str = "never";

/// 读 config.yaml 的 `agent.project_trust`。任何解析失败、或历史遗留的
/// `ask` 值（现在删档），都按 `never` 处理——保持最保守，不会因为配置
/// 损坏或过期键就变成自动信任。
pub fn configured_project_trust() -> String {
    let path = crate::config::config_yaml_path();
    let yaml = match std::fs::read_to_string(&path) {
        Ok(y) => y,
        Err(_) => return TRUST_NEVER.to_string(),
    };
    let v: serde_yaml::Value = match serde_yaml::from_str(&yaml) {
        Ok(v) => v,
        Err(_) => return TRUST_NEVER.to_string(),
    };
    let raw = v
        .get("agent")
        .and_then(|a| a.get("project_trust"))
        .and_then(|t| t.as_str())
        .unwrap_or(TRUST_NEVER);
    match raw {
        TRUST_ALWAYS | TRUST_NEVER => raw.to_string(),
        // 旧的 `ask` / 其它未知值一律降级到 never，不改配置。
        _ => TRUST_NEVER.to_string(),
    }
}

#[tauri::command]
pub fn helix_project_trust_get() -> Value {
    json!({ "ok": true, "mode": configured_project_trust() })
}

#[tauri::command]
pub fn helix_project_trust_set(state: tauri::State<'_, Arc<AppState>>, mode: String) -> Value {
    let mode = mode.trim();
    if !matches!(mode, TRUST_ALWAYS | TRUST_NEVER) {
        return json!({
            "ok": false,
            "error": format!("unknown mode: {mode:?} (expected always/never)")
        });
    }
    let changed = set_config_yaml_key("agent.project_trust", &json!(mode));
    // spawn 参数变了，需要重放 pi 进程才生效。
    restart_gateway_soon(
        &Arc::clone(&state),
        &format!("项目信任档位切换（{mode}）"),
    );
    json!({ "ok": true, "changed": changed, "mode": mode })
}

/// 默认值表（pi docs/settings.md 的默认，用于把 UI 显示补成有效值）。
const DEFAULTS: &[(&str, &str)] = &[
    ("retry.enabled", "true"),
    ("retry.maxRetries", "3"),
    ("retry.baseDelayMs", "2000"),
    ("retry.maxAgentDelayMs", "60000"),
    ("retry.provider.maxRetries", "0"),
    ("compaction.enabled", "true"),
    ("compaction.reserveTokens", "16384"),
    ("compaction.keepRecentTokens", "20000"),
    ("compaction.modelOverrides", "{}"),
    ("defaultThinkingLevel", "medium"),
    ("modelThinkingLevels", "{}"),
    ("cacheWarming", "streaming"),
    ("showCacheMissNotices", "false"),
    ("hideThinkingBlock", "false"),
    ("steeringMode", "one-at-a-time"),
    ("followUpMode", "one-at-a-time"),
];

/// 所有可写的点路径（含只读展示但允许覆盖的）。未知键一律拒绝。
const WRITABLE_PATHS: &[&str] = &[
    "retry.enabled",
    "retry.maxRetries",
    "retry.baseDelayMs",
    "retry.maxAgentDelayMs",
    "retry.provider.timeoutMs",
    "retry.provider.maxRetries",
    "compaction.enabled",
    "compaction.reserveTokens",
    "compaction.keepRecentTokens",
    "compaction.modelOverrides",
    "defaultThinkingLevel",
    "modelThinkingLevels",
    "cacheWarming",
    "showCacheMissNotices",
    "hideThinkingBlock",
    "steeringMode",
    "followUpMode",
];

fn one_of(v: &str, set: &[&str]) -> bool {
    set.iter().any(|x| *x == v)
}

fn as_bool(v: &Value, path: &str) -> Result<bool, String> {
    v.as_bool()
        .ok_or_else(|| format!("{path} must be a boolean"))
}

fn as_int(v: &Value, path: &str, max: i64) -> Result<i64, String> {
    let n = v
        .as_i64()
        .ok_or_else(|| format!("{path} must be an integer"))?;
    if n < 0 || n > max {
        return Err(format!("{path} must be within 0..={max}"));
    }
    Ok(n)
}

/// 校验单个点路径的值。返回要写入的规范值；`None` 表示「删除该键」。
fn validate(path: &str, v: &Value) -> Result<Option<Value>, String> {
    // 显式 null = 删除该键（回到 pi 内置默认）。先判空，否则后面的类型
    // 校验会先报错，null 就永远清不掉键了。
    if v.is_null() {
        return Ok(None);
    }
    let result = match path {
        "retry.enabled" | "compaction.enabled" | "showCacheMissNotices"
        | "hideThinkingBlock" => {
            json!(as_bool(v, path)?)
        }
        "retry.maxRetries" => json!(as_int(v, path, 20)?),
        "retry.baseDelayMs" => json!(as_int(v, path, 600_000)?),
        "retry.maxAgentDelayMs" => json!(as_int(v, path, 3_600_000)?),
        "retry.provider.timeoutMs" => match v.as_i64() {
            Some(n) if (0..=3_600_000).contains(&n) => json!(n),
            _ => return Err(format!("{path} must be within 0..=3600000")),
        },
        "retry.provider.maxRetries" => json!(as_int(v, path, 10)?),
        "compaction.reserveTokens" => json!(as_int(v, path, 500_000)?),
        "compaction.keepRecentTokens" => json!(as_int(v, path, 1_000_000)?),
        // 按「provider/modelId」精确键给单模型调压缩预算（1M 窗口的模型用
        // 同一个 16k reserve 会提前压缩）。只接受对象，内部两个字段独立校验。
        "compaction.modelOverrides" => {
            let Some(obj) = v.as_object() else {
                return Err(format!("{path} must be an object"));
            };
            let mut out = serde_json::Map::new();
            for (k, entry) in obj {
                if k.trim().is_empty() {
                    return Err(format!("{path}: empty model key"));
                }
                let Some(eo) = entry.as_object() else {
                    return Err(format!("{path}[{k}] must be an object"));
                };
                let mut eo2 = serde_json::Map::new();
                for (f, fv) in eo {
                    if f == "reserveTokens" || f == "keepRecentTokens" {
                        let n = as_int(fv, &format!("{path}[{k}].{f}"), 1_000_000)?;
                        eo2.insert(f.clone(), json!(n));
                    } else {
                        return Err(format!("{path}[{k}]: unknown field {f}"));
                    }
                }
                if eo2.is_empty() {
                    return Err(format!(
                        "{path}[{k}] must have reserveTokens and/or keepRecentTokens"
                    ));
                }
                out.insert(k.clone(), Value::Object(eo2));
            }
            json!(out)
        }
        "defaultThinkingLevel" => {
            let s = v.as_str().ok_or_else(|| format!("{path} must be a string"))?;
            let set = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
            if !one_of(s, &set) {
                return Err(format!("{path} must be one of {}", set.join("/")));
            }
            json!(s)
        }
        "cacheWarming" => {
            let s = v.as_str().ok_or_else(|| format!("{path} must be a string"))?;
            let set = ["off", "streaming", "idle"];
            if !one_of(s, &set) {
                return Err(format!("{path} must be one of {}", set.join("/")));
            }
            json!(s)
        }
        "steeringMode" | "followUpMode" => {
            let s = v.as_str().ok_or_else(|| format!("{path} must be a string"))?;
            let set = ["all", "one-at-a-time"];
            if !one_of(s, &set) {
                return Err(format!("{path} must be one of {}", set.join("/")));
            }
            json!(s)
        }
        "modelThinkingLevels" => {
            let obj = v.as_object().ok_or_else(|| {
                format!("{path} must be an object of provider/modelId -> level")
            })?;
            let set = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
            let mut out = serde_json::Map::new();
            for (k, level) in obj {
                let s = level.as_str().ok_or_else(|| {
                    format!("{path}.{k} must be a string thinking level")
                })?;
                if !one_of(s, &set) {
                    return Err(format!("{path}.{k} must be one of {}", set.join("/")));
                }
                out.insert(k.clone(), json!(s));
            }
            Value::Object(out)
        }
        // 显式传 null = 删除该键（回到 pi 内置默认）。
        _ => return Err(format!("unknown setting path: {path:?}")),
    };
    Ok(Some(result))
}

fn set_dotted(root: &mut Value, path: &str, value: Option<Value>) -> bool {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.is_empty() {
        return false;
    }
    let last = *parts.last().unwrap();
    if value.is_none() {
        if parts.len() == 1 {
            return root.as_object_mut().map(|m| m.remove(last).is_some()).unwrap_or(false);
        }
        let prefix = format!("/{}", parts[..parts.len() - 1].join("/"));
        return match root.pointer_mut(&prefix).and_then(Value::as_object_mut) {
            Some(obj) => obj.remove(last).is_some(),
            None => false,
        };
    }
    let mut cur = match root.as_object_mut() {
        Some(m) => m,
        None => return false,
    };
    for part in &parts[..parts.len() - 1] {
        cur = {
            let map = cur;
            // 目标位置不存在、或已被写成一个非对象值（例如 retry 被写成了一个
            // 字符串）—— 重建为对象，而不是 panic 或静默失败。
            if !map.get(*part).map(|v| v.is_object()).unwrap_or(false) {
                map.insert(part.to_string(), Value::Object(serde_json::Map::new()));
            }
            map.get_mut(*part)
                .and_then(Value::as_object_mut)
                .expect("just inserted an object")
        };
    }
    let before = cur.get(last).cloned();
    cur.insert(last.to_string(), value.unwrap());
    before != Some(cur.get(last).cloned().unwrap())
}


/// 回读高级设置。值取自 settings.json，缺省按 pi 文档补齐；另附 `rawPresent`
/// 标出哪些键是文件里真的写了（UI 可以用来区分「用户改过」和「显示的是默认值」）。
#[tauri::command]
pub fn helix_pi_advanced_get() -> Value {
    let settings = read_pi_settings();
    let mut out = serde_json::Map::new();
    let mut present = serde_json::Map::new();
    for (path, default_json) in DEFAULTS {
        let parsed: Value =
            serde_json::from_str(default_json).unwrap_or_else(|_| Value::Null);
        let actual = settings.pointer(path.replace('.', "/").as_str());
        let value = actual.cloned().unwrap_or(parsed);
        present.insert(path.to_string(), json!(actual.is_some()));
        out.insert(path.to_string(), value);
    }
    out.insert("__present".to_string(), Value::Object(present));
    json!({ "ok": true, "settings": Value::Object(out) })
}

/// 写入一批点路径。逐条校验，全部合法才落盘（不留下半写状态）；写盘后重放 pi。
#[tauri::command]
pub fn helix_pi_advanced_set(
    state: tauri::State<'_, Arc<AppState>>,
    updates: Value,
) -> Value {
    let Some(obj) = updates.as_object() else {
        return json!({ "ok": false, "error": "updates must be an object" });
    };
    if obj.is_empty() {
        return json!({ "ok": false, "error": "updates is empty" });
    }
    // 1) 全量校验（不写盘）。任何一条不合法就整体拒绝，避免用户看到「已保存」
    //    却发现一半没生效。
    let mut validated: Vec<(String, Option<Value>)> = Vec::with_capacity(obj.len());
    let mut errors: Vec<String> = Vec::new();
    for (path, v) in obj {
        if !WRITABLE_PATHS.contains(&path.as_str()) {
            errors.push(format!("unknown setting path: {path:?}"));
            continue;
        }
        match validate(path, v) {
            Ok(value) => validated.push((path.clone(), value)),
            Err(e) => errors.push(e),
        }
    }
    if !errors.is_empty() {
        return json!({ "ok": false, "error": errors.join("; "), "errors": errors });
    }

    // 2) 落盘。
    let _guard = config_write_lock();
    let mut settings = read_pi_settings();
    if !settings.is_object() {
        settings = json!({});
    }
    let mut changed = false;
    for (path, value) in &validated {
        if set_dotted(&mut settings, path, value.clone()) {
            changed = true;
        }
    }
    if changed {
        write_pi_settings(&settings);
        restart_gateway_soon(&Arc::clone(&state), "高级设置写入（pi settings.json）");
    }
    json!({ "ok": true, "changed": changed, "written": validated.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_unknown_path() {
        assert!(validate("defaultModel", &json!("x")).is_err());
        assert!(validate("retry.bogus", &json!(true)).is_err());
    }

    #[test]
    fn validate_enums_and_ranges() {
        assert!(validate("defaultThinkingLevel", &json!("xhigh")).is_ok());
        assert!(validate("defaultThinkingLevel", &json!("ultra")).is_err());
        assert!(validate("retry.maxRetries", &json!(5)).is_ok());
        assert!(validate("retry.maxRetries", &json!(-1)).is_err());
        assert!(validate("retry.maxRetries", &json!(21)).is_err());
        assert!(validate("retry.maxRetries", &json!("3")).is_err());
        assert!(validate("cacheWarming", &json!("idle")).is_ok());
        assert!(validate("cacheWarming", &json!("hot")).is_err());
    }

    #[test]
    fn validate_null_clears() {
        let r = validate("compaction.reserveTokens", &json!(null)).unwrap();
        assert_eq!(r, None);
    }

    #[test]
    fn validate_object_maps() {
        assert!(validate(
            "modelThinkingLevels",
            &json!({ "anthropic/claude-x": "high" })
        )
        .is_ok());
        assert!(validate("modelThinkingLevels", &json!({ "a/b": "nope" })).is_err());
    }

    #[test]
    fn validate_model_overrides() {
        // 正常：两个字段可以只给一个。
        let ok = validate(
            "compaction.modelOverrides",
            &json!({ "openai/gpt-5.1-codex-max": { "reserveTokens": 400000 } }),
        )
        .unwrap();
        assert_eq!(ok.as_ref().unwrap()["openai/gpt-5.1-codex-max"]["reserveTokens"], json!(400000));
        // 缺字段 / 多余字段 / 非对象条目 / 空键 都要被拒。
        assert!(validate("compaction.modelOverrides", &json!({ "a/b": {} })).is_err());
        assert!(validate(
            "compaction.modelOverrides",
            &json!({ "a/b": { "reserveTokens": 1, "unknown": 2 } })
        )
        .is_err());
        assert!(validate(
            "compaction.modelOverrides",
            &json!({ "a/b": 123 })
        )
        .is_err());
        assert!(validate("compaction.modelOverrides", &json!({ "  ": {} })).is_err());
        // 不是对象也不行。
        assert!(validate("compaction.modelOverrides", &json!([])).is_err());
        // null = 删除整个键。
        assert!(validate("compaction.modelOverrides", &json!(null)).is_ok());
    }

    #[test]
    fn set_dotted_creates_and_replaces() {
        let mut root = json!({ "retry": { "enabled": true } });
        let changed = set_dotted(&mut root, "retry.maxRetries", Some(json!(7)));
        assert!(changed);
        assert_eq!(root["retry"]["maxRetries"], json!(7));
        assert_eq!(root["retry"]["enabled"], json!(true));
        // 同一键再写同值 = 没变化。
        assert!(!set_dotted(&mut root, "retry.maxRetries", Some(json!(7))));
    }

    #[test]
    fn set_dotted_removes_key() {
        let mut root = json!({ "compaction": { "reserveTokens": 1 } });
        let changed = set_dotted(&mut root, "compaction.reserveTokens", None);
        assert!(changed);
        assert!(root["compaction"]["reserveTokens"].is_null());
    }

    #[test]
    fn set_dotted_over_non_object_is_tolerated() {
        // retry 被写成一个字符串时重建为对象，而不是 panic。
        let mut root = json!({ "retry": "oops" });
        let changed = set_dotted(&mut root, "retry.enabled", Some(json!(false)));
        assert!(changed);
        assert_eq!(root["retry"]["enabled"], json!(false));
    }

    #[test]
    fn trust_mode_validation() {
        assert_eq!(configured_project_trust(), TRUST_NEVER); // 只读解析，测试环境无 config
    }
}
