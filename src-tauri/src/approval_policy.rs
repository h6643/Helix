//! `helix:*` 审批档位 ⇄ pi-permission 扩展的桥。
//!
//! # 为什么要这一层
//!
//! pi 官方**没有**工具级审批（`docs/security.md`：「it does not ask for approval
//! before every tool call」）。真正能阻断工具执行的只有扩展的 `tool_call` 钩子，
//! 而 `@zhushanwen/pi-permission` 就是干这个的：它按 `mode` 决定
//! allow / ask / deny，ask 走 `ctx.ui.select` → Helix 的 `clarify_request` →
//! ClarifyBar。
//!
//! 所以 Helix 前端那个「审批模式」下拉**必须写到这个扩展的配置里**，而不是
//! 维护一份自己的状态。历史上这里出过一次典型的分裂：前端三档只改
//! `classifyApproval`（一个 pi 永不触发的事件的分类器），而真弹窗在
//! ClarifyBar 上、只读扩展自己的配置 —— 于是「设置显示完全访问、实际照样弹窗」。
//!
//! # 档位映射
//!
//! | Helix 档位 | pi-permission mode | 语义 |
//! |---|---|---|
//! | 询问审批   | `strict` | 全部人工审批 |
//! | 自动审批   | `auto`   | 安全规则放行 + 非安全过 AI 风险判定，判定为风险才问 |
//! | 完全访问   | `yolo`   | 全放行 |
//!
//! pi-permission 还有第四档 `approve`（规则匹配、无 AI 那一层）。前端暂不
//! 暴露：它与 `auto` 的差别只是「要不要过 AI」，而 AI 判定要额外一次模型调用，
//! 不该由一个下拉静默决定。
//!
//! # 生效时机
//!
//! **不需要重启网关**：扩展的 `tool_call` 处理器每次调用都
//! `loadAndWatchConfig()`（mtime+size 缓存），改文件下一次调用即生效。

use serde_json::{json, Value};
use std::path::PathBuf;

/// 配置文件路径：`<pi 数据根>/config/permission-ext-config.json`。
/// 与 pi-permission 内部 `getAgentDir()/config/permission-ext-config.json`
/// 必须一致 —— 路径错了会写到一份没人读的文件，那就又变成「两套系统」。
fn config_path() -> PathBuf {
    crate::paths::pi_agent_dir()
        .join("config")
        .join("permission-ext-config.json")
}

/// Helix 档位 → 扩展 mode。未知值一律落到 `auto`（最保守的「会问」档，
/// 绝不因为解析失败就悄悄全放行）。
fn to_extension_mode(mode: &str) -> &'static str {
    match mode {
        "ask" | "strict" => "strict",
        "full" | "yolo" => "yolo",
        _ => "auto",
    }
}

/// 扩展 mode → Helix 档位（读回时用）。
fn from_extension_mode(mode: &str) -> &'static str {
    match mode {
        "strict" => "ask",
        "yolo" => "full",
        // `approve` 与 `auto` 都归到「自动审批」：对用户而言都是「只在有风险时问」
        "approve" | "auto" => "auto",
        _ => "auto",
    }
}

/// 读当前档位。文件不存在 / 坏 JSON → 返回 `auto` 并说明原因。
#[tauri::command]
pub fn helix_get_permission_mode() -> Value {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            return json!({
                "ok": false,
                "mode": "auto",
                "reason": format!("配置文件不可读: {e}"),
                "config_path": path.to_string_lossy(),
            })
        }
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => {
            let m = v.get("mode").and_then(Value::as_str).unwrap_or("auto");
            json!({
                "ok": true,
                "mode": from_extension_mode(m),
                "extension_mode": m,
                // enabled=false 等价 yolo（扩展自己的约定），必须一并读出来，
                // 否则前端显示「自动审批」而实际全放行。
                "enabled": v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "config_path": path.to_string_lossy(),
            })
        }
        Err(e) => json!({
            "ok": false,
            "mode": "auto",
            "reason": format!("配置 JSON 解析失败: {e}"),
            "config_path": path.to_string_lossy(),
        }),
    }
}

/// 写档位。只改 `mode` 与 `enabled`，其余字段（`classifier` / `userRules`）
/// 原样保留 —— 用户在扩展里调过的 AI 模型和规则不能被前端一个下拉抹掉。
#[tauri::command]
pub fn helix_set_permission_mode(mode: String) -> Value {
    let ext_mode = to_extension_mode(&mode);
    let path = config_path();

    // 读现有配置；不存在就用扩展自己的默认值起一份。
    let mut cfg: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| {
            json!({
                "mode": "auto",
                "enabled": true,
                "classifier": {
                    "enabled": true,
                    "model": "auto",
                    "timeout": 90,
                    "autoApproveLowRisk": true,
                    "autoDenyHighRisk": true,
                    "thinkingLevel": "off"
                },
                "userRules": []
            })
        });
    if !cfg.is_object() {
        cfg = json!({});
    }

    let prev = cfg.get("mode").and_then(Value::as_str).unwrap_or("").to_string();
    // 只有 yolo 档才把 enabled 置 false（等价语义）；其余档必须 enabled=true，
    // 否则扩展按「enabled=false 等同 yolo」直接全放行 —— 那是「设置显示会问、
    // 实际全放行」的最隐蔽一种分裂。
    let enabled = ext_mode != "yolo";
    {
        let obj = cfg.as_object_mut().expect("已是 object");
        obj.insert("mode".into(), Value::String(ext_mode.into()));
        obj.insert("enabled".into(), Value::Bool(enabled));
    }

    let body = serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".into());
    if let Err(e) = crate::config::atomic_write(&path, &format!("{body}\n")) {
        return json!({
            "ok": false,
            "error": format!("写配置失败: {e}"),
            "config_path": path.to_string_lossy(),
        });
    }
    json!({
        "ok": true,
        "mode": from_extension_mode(ext_mode),
        "extension_mode": ext_mode,
        "enabled": enabled,
        "changed": prev != ext_mode,
        "config_path": path.to_string_lossy(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_helix_modes_to_extension_modes() {
        assert_eq!(to_extension_mode("ask"), "strict");
        assert_eq!(to_extension_mode("auto"), "auto");
        assert_eq!(to_extension_mode("full"), "yolo");
        // 历史值（accept_edits/dont_ask）与未知值都落到 auto，绝不放行。
        assert_eq!(to_extension_mode("accept_edits"), "auto");
        assert_eq!(to_extension_mode("dont_ask"), "auto");
        assert_eq!(to_extension_mode("???"), "auto");
        assert_eq!(to_extension_mode(""), "auto");
    }

    #[test]
    fn maps_extension_modes_back() {
        assert_eq!(from_extension_mode("strict"), "ask");
        assert_eq!(from_extension_mode("yolo"), "full");
        assert_eq!(from_extension_mode("auto"), "auto");
        assert_eq!(from_extension_mode("approve"), "auto");
        assert_eq!(from_extension_mode("garbage"), "auto");
    }

    #[test]
    fn roundtrip_is_stable() {
        for m in ["ask", "auto", "full"] {
            assert_eq!(from_extension_mode(to_extension_mode(m)), m);
        }
    }
}
