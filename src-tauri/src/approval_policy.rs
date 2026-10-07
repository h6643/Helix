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
//! 上游另有第四档 `approve`（规则匹配、无 AI 那一层）；本机装的是就地补丁版，
//! 扩展源码里已经删掉它，但 `pi update` 会带回来，所以这里的归一必须继续认得。
//! Helix 不提供这一档，也从不写它：它与 `auto` 的差别只是「要不要过 AI」，而 AI
//! 判定要额外一次模型调用，不该由一个下拉静默决定。万一磁盘上被人写成 `approve`，
//! 读路径落到 `_` → `auto` 显示；别指望这种文件只靠改名就对得上 —— 扩展把认不出的
//! mode 一律回落成它的 `DEFAULT_CONFIG.mode` = yolo，也就是实际全放行。
//!
//! # 生效时机
//!
//! **不需要重启网关**：扩展的 `tool_call` 处理器每次调用都
//! `loadAndWatchConfig()`（直接读文件，无缓存），改文件下一次调用即生效。
//! 已经打开的审批弹窗不受影响——它的超时在弹窗打开那一刻已按当时配置起算。
//!
//! # 审批卡超时（2026-10-07 本地补丁）
//!
//! 扩展侧的超时从「AI 落定后 5 分钟」改为「弹窗打开即起算、时长可配」：
//! `permission.approvalTimeoutSec`（30–3600 秒，默认 300，到期 fail-closed
//! 拒绝、不静默放行）。本模块读写这个字段；`pi_gateway.rs` 在审批卡的
//! `clarify_request` 上附带同一数值，前端据此渲染卡片倒计时。
//! `pi update --extensions` 会把就地补丁（本项 + 上面的 `approve` 档移除）
//! 一并还原，更新后需重新打。
//!
//! # 存储位置（2026-10-06 本地定制）
//!
//! pi-permission 扩展已改为读写 `settings.json` 顶层 `permission` 键
//! （不再用 `config/permission-ext-config.json`）。这里的读写必须与扩展一致，
//! 否则又是「两套系统」。旧路径 `config/permission-ext-config.json` 的目录
//! 曾因旧版 ensureConfigFile / 本模块旧路径反复重建，已废弃。
//!
//! 超时字段与档位同源同文件，但**只对本地实例生效**：远程工作区的 pi 读的是
//! 远端自己的 settings.json（与档位切换同一限制；本地值只作卡片倒计时的显示锚点，
//! 真正的到期拒绝在远端扩展侧执行）。

use serde_json::{json, Value};
use std::path::PathBuf;

/// 配置文件路径：`<pi 数据根>/settings.json`（顶层 `permission` 键）。
/// 与 pi-permission（本地定制版）的 src/config.ts 一致——扩展已改为读
/// settings.json，不再用 config/permission-ext-config.json。
fn config_path() -> PathBuf {
    crate::paths::pi_agent_dir().join("settings.json")
}

/// 从 settings.json 里取 `permission` 对象；缺键返回 None。
fn read_permission_block(root: &Value) -> Option<Value> {
    let p = root.get("permission")?;
    p.is_object().then(|| p.clone())
}

// ──────────────────────── 审批超时（approvalTimeoutSec） ────────────────────────
//
// 与 pi-permission 扩展 types.ts 的 DEFAULT/MIN/MAX_APPROVAL_TIMEOUT_SEC 同步；
// 归一语义也与扩展 config.ts 的 normalizeApprovalTimeoutSec 一致：缺失/非数字 →
// 默认 300；越界（含 0，不提供「关闭」档）→ 收敛到 [30, 3600]。

const DEFAULT_APPROVAL_TIMEOUT_SEC: u64 = 300;
const MIN_APPROVAL_TIMEOUT_SEC: u64 = 30;
const MAX_APPROVAL_TIMEOUT_SEC: u64 = 3600;

/// 归一审批超时秒数：None/非有限数 → 默认；小数四舍五入；越界收敛到边界。
fn clamp_approval_timeout(raw: Option<f64>) -> u64 {
    let Some(n) = raw.filter(|n| n.is_finite()) else {
        return DEFAULT_APPROVAL_TIMEOUT_SEC;
    };
    (n.round() as i64).clamp(MIN_APPROVAL_TIMEOUT_SEC as i64, MAX_APPROVAL_TIMEOUT_SEC as i64) as u64
}

/// 读审批卡超时秒数（settings.json → permission.approvalTimeoutSec，已归一）。
///
/// 读取失败一律回落默认 300：这个值只用于**展示锚点**（`clarify_request` 附带的
/// 秒数 → Helix 卡片倒计时）；真正的到期拒绝在扩展侧执行，显示值与实际值即便
/// 短暂不一致，也只是卡片早/晚消失（还有 `clarify_settled` 兜底收卡），
/// 不会放行任何工具。
pub(crate) fn read_approval_timeout_sec() -> u64 {
    let Some(block) = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|root| read_permission_block(&root))
    else {
        return DEFAULT_APPROVAL_TIMEOUT_SEC;
    };
    clamp_approval_timeout(block.get("approvalTimeoutSec").and_then(Value::as_f64))
}

/// permission 键缺失时的起底配置（与扩展 DEFAULT_CONFIG 对齐）。
fn default_permission_block() -> Value {
    json!({
        "mode": "auto",
        "enabled": true,
        "approvalTimeoutSec": DEFAULT_APPROVAL_TIMEOUT_SEC,
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
///
/// `approve`（Helix 不提供、也从不写的那一档）落到 `_` → `auto`。
fn from_extension_mode(mode: &str) -> &'static str {
    match mode {
        "strict" => "ask",
        "yolo" => "full",
        _ => "auto",
    }
}

/// 读当前档位。
///
/// 读不到时**不要**编一个档位回去：`ok:false` + `mode:null` + `exists`，让调用
/// 方自己决定怎么说实话。原因就写在下面那个历史 bug 里 —— 曾经这里坏 JSON 也
/// 返回 `mode:"auto"`，前端拿去显示「自动审批」，而扩展在文件缺失/坏 JSON 时
/// 一律回落它自己的 `DEFAULT_CONFIG`（`mode:"yolo"`，全放行）。显示会问、实际
/// 不问，是这一层最坏的错法。
#[tauri::command]
pub fn helix_get_permission_mode() -> Value {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            return json!({
                "ok": false,
                "mode": Value::Null,
                "approvalTimeoutSec": Value::Null,
                "exists": path.exists(),
                "reason": format!("settings.json 不可读: {e}"),
                "config_path": path.to_string_lossy(),
            })
        }
    };
    let root = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "ok": false,
                "mode": Value::Null,
                "approvalTimeoutSec": Value::Null,
                "exists": true,
                "reason": format!("settings.json JSON 解析失败: {e}"),
                "config_path": path.to_string_lossy(),
            })
        }
    };
    let Some(v) = read_permission_block(&root) else {
        // settings.json 里还没有 permission 键：如实说没有，不编档位。
        return json!({
            "ok": false,
            "mode": Value::Null,
            "approvalTimeoutSec": Value::Null,
            "exists": false,
            "reason": "settings.json 中尚无 permission 键",
            "config_path": path.to_string_lossy(),
        });
    };
    let m = v.get("mode").and_then(Value::as_str).unwrap_or("auto");
    json!({
        "ok": true,
        "mode": from_extension_mode(m),
        "extension_mode": m,
        "approvalTimeoutSec": clamp_approval_timeout(v.get("approvalTimeoutSec").and_then(Value::as_f64)),
        // enabled=false 等价 yolo（扩展自己的约定），必须一并读出来，
        // 否则前端显示「自动审批」而实际全放行。
        "enabled": v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "config_path": path.to_string_lossy(),
    })
}

/// 写档位。只改 `mode` 与 `enabled`，其余字段（`approvalTimeoutSec` /
/// `classifier` / `userRules`）原样保留 —— 用户在扩展里调过的 AI 模型和规则
/// 不能被前端一个下拉抹掉。
#[tauri::command]
pub fn helix_set_permission_mode(mode: String) -> Value {
    let ext_mode = to_extension_mode(&mode);
    let path = config_path();

    // 读 settings.json（保留全部键，defaultModel/packages 等不能被覆盖）；
    // permission 键缺失时用扩展默认值起一份。
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let mut cfg = read_permission_block(&root).unwrap_or_else(default_permission_block);

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
    if let Some(obj) = root.as_object_mut() {
        obj.insert("permission".into(), cfg);
    }

    let body = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".into());
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

/// 写审批卡超时秒数。只改 `approvalTimeoutSec`，其余字段原样保留；输入收敛到
/// [30, 3600]（不提供 0=关闭档），返回的是**生效值**（被收敛时与输入不同）。
///
/// 生效时机与档位相同：扩展每次 tool_call 重读 settings.json，已打开的弹窗
/// 不受影响（它的超时在弹窗打开那刻已按当时配置起算）。
///
/// 注意：写的是**本地** settings.json；远程工作区实例读远端自己的配置
/// （与档位切换同一限制，本地值只作卡片倒计时的展示锚点）。
#[tauri::command]
pub fn helix_set_approval_timeout_sec(seconds: i64) -> Value {
    let sec = seconds.clamp(MIN_APPROVAL_TIMEOUT_SEC as i64, MAX_APPROVAL_TIMEOUT_SEC as i64) as u64;
    let path = config_path();

    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let mut cfg = read_permission_block(&root).unwrap_or_else(default_permission_block);

    let prev = cfg.get("approvalTimeoutSec").and_then(Value::as_f64).map(|n| clamp_approval_timeout(Some(n)));
    {
        let obj = cfg.as_object_mut().expect("已是 object");
        obj.insert("approvalTimeoutSec".into(), json!(sec));
    }
    if let Some(obj) = root.as_object_mut() {
        obj.insert("permission".into(), cfg);
    }

    let body = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".into());
    if let Err(e) = crate::config::atomic_write(&path, &format!("{body}\n")) {
        return json!({
            "ok": false,
            "error": format!("写配置失败: {e}"),
            "config_path": path.to_string_lossy(),
        });
    }
    json!({
        "ok": true,
        "approvalTimeoutSec": sec,
        "changed": prev != Some(sec),
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
        // approve 是扩展侧 Helix 不提供的档位；和认不出的值一样落到 auto。
        assert_eq!(from_extension_mode("approve"), "auto");
        assert_eq!(from_extension_mode("garbage"), "auto");
    }

    #[test]
    fn roundtrip_is_stable() {
        for m in ["ask", "auto", "full"] {
            assert_eq!(from_extension_mode(to_extension_mode(m)), m);
        }
    }

    #[test]
    fn clamps_approval_timeout() {
        // 缺失 / 非有限数 → 默认
        assert_eq!(clamp_approval_timeout(None), 300);
        assert_eq!(clamp_approval_timeout(Some(f64::NAN)), 300);
        assert_eq!(clamp_approval_timeout(Some(f64::INFINITY)), 300);
        // 合法值原样；小数四舍五入
        assert_eq!(clamp_approval_timeout(Some(60.0)), 60);
        assert_eq!(clamp_approval_timeout(Some(90.6)), 91);
        // 0 / 负数 / 低于下界 → 收敛到 30（不提供关闭档）
        assert_eq!(clamp_approval_timeout(Some(0.0)), 30);
        assert_eq!(clamp_approval_timeout(Some(-5.0)), 30);
        assert_eq!(clamp_approval_timeout(Some(5.0)), 30);
        // 高于上界 → 收敛到 3600
        assert_eq!(clamp_approval_timeout(Some(99999.0)), 3600);
        // 边界值本身合法
        assert_eq!(clamp_approval_timeout(Some(30.0)), 30);
        assert_eq!(clamp_approval_timeout(Some(3600.0)), 3600);
    }

    #[test]
    fn default_block_matches_extension_default() {
        let b = default_permission_block();
        assert_eq!(b["mode"], "auto");
        assert_eq!(b["enabled"], true);
        assert_eq!(b["approvalTimeoutSec"], 300);
        assert_eq!(b["classifier"]["model"], "auto");
        assert_eq!(b["userRules"], json!([]));
    }
}
