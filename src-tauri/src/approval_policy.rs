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
//! 判定要额外一次模型调用，不该由一个下拉静默决定。
//!
//! 磁盘上被人写成 `approve`（或任何认不出的值）时：扩展把它认不出 ⇒ 回落它的
//! `DEFAULT_CONFIG.mode` = **yolo，实际全放行**，所以读路径必须照样报「完全访问」
//! 并把 `globalModeUnparsable` 摆给前端。这里曾经报 `auto`（显示会问、实际不问），
//! 是本模块最坏那一类错法；覆盖表里的坏值同理 —— 逐条当作不存在，绝不自己发明档位。
//!
//! # 按项目 / 按会话覆盖（2026-10-10 本地定制）
//!
//! 同一个 settings.json 的 `permission` 块里另有两张覆盖表：
//!
//! ```json
//! "modeByProject": { "d:/project/helix": "strict" },
//! "modeBySession": { "01a123df-02ea-70f4-bfdd-f4598bbd6241": "yolo" }
//! ```
//!
//! 生效档 = **会话覆盖 → 项目覆盖 → 全局 `mode`**，由**扩展自己**解析
//! （`config.ts::resolvePermissionMode`，闸门与 footer 都走它），所以「面板显示
//! 的档」与「真正拦工具的档」是同一个函数的同一个返回值。这正是这个模块一直要的
//! 单一真相：覆盖状态绝不只放在前端（旧 `approvalModeBySession` 就是这么坏的）。
//!
//! 由此对写入侧的三条硬约束：
//!  - **项目键归一必须逐字复刻扩展**（反斜杠→正斜杠、去尾斜杠、Windows 转小写）。
//!  - **认不出的值当作不存在**（扩展 `isValidPermissionMode` 只收 yolo/auto/strict，
//!    坏条目逐个丢弃而不是回落默认），否则 Helix 写出一份扩展不消费的表。
//!  - **`enabled` 是总开关，一关连覆盖表都不跑**，所以任何写档动作都把它置 true；
//!    yolo 本身已经是放行档，不需要再借 `enabled=false` 表达「关闭」。
//!
//! 远程工作区不在这套机制的作用范围里：远端的 pi 读**远端**自己的 settings.json，
//! 本机的覆盖表对它一点影响都没有，所以远程会话的 scoped 写入一律拒绝并说明原因。
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

/// permission 键缺失时的起底配置（与扩展 DEFAULT_CONFIG 对齐，另加两张空的覆盖表）。
fn default_permission_block() -> Value {
    json!({
        "mode": "auto",
        "enabled": true,
        "approvalTimeoutSec": DEFAULT_APPROVAL_TIMEOUT_SEC,
        "modeByProject": {},
        "modeBySession": {},
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

// ──────────────────────── 作用域档位（全局 / 项目 / 会话） ────────────────────────

/// 扩展 `normalizeConfig` 认不出 `mode` 时回落的值 —— 也就是「实际全放行」。
/// 读路径必须报同一个值，否则显示会问、实际不问。
const EXTENSION_FALLBACK_MODE: &str = "yolo";

/// 项目键归一：**必须与扩展 `config.ts::normalizeProjectKey` 逐字一致**
/// （反斜杠 → 正斜杠、去尾斜杠、Windows 大小写不敏感）。两侧任何一处不同，就会
/// 造出「UI 说本项目已收紧、实际按全局放行」。
fn normalize_project_key(cwd: &str) -> String {
    let forward = cwd.replace('\\', "/");
    let trimmed = forward.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// 扩展 `isValidPermissionMode` 的同集合。不在里面的值在扩展侧一律**当作不存在**，
/// 这里也必须一样跳过，不能自己发明档位。
fn is_extension_mode(value: &str) -> bool {
    matches!(value, "yolo" | "auto" | "strict")
}

/// 写命令的作用域。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    Global,
    Project,
    Session,
}

fn parse_scope(raw: Option<&str>) -> Result<Scope, String> {
    match raw.unwrap_or("global").trim().to_lowercase().as_str() {
        "global" => Ok(Scope::Global),
        "project" => Ok(Scope::Project),
        "session" => Ok(Scope::Session),
        other => Err(format!("未知作用域: {other}（只支持 global / project / session）")),
    }
}

/// 一次调用的作用域身份（对应扩展侧 `readScopeIdentity`：拿不到就回落全局）。
#[derive(Clone, Default)]
struct ScopeTarget {
    session_id: Option<String>,
    cwd: Option<String>,
    remote: bool,
}

impl ScopeTarget {
    /// 前端给 sid 与/或 cwd（草稿可能两个都没有），缺的从网关实例和 jsonl 头补。
    ///
    /// `remote://…` 这类虚拟键**不能**当项目目录写进覆盖表：扩展收到的是 pi 报的
    /// 真实 cwd，写一个本机路径都命不中的键等于藏一条永不生效的规则。
    fn resolve(session_id: Option<&str>, cwd: Option<&str>) -> Self {
        let clean = |v: &str| -> Option<String> {
            let t = v.trim();
            (!t.is_empty() && !t.contains("://")).then(|| t.to_string())
        };
        let sid = session_id.and_then(clean);
        let remote = sid
            .as_deref()
            .map(crate::pi_gateway::session_is_remote)
            .unwrap_or(false);
        // 远程会话的项目在**远端机器**上：本机覆盖表里按远端路径建的键永远不会被
        // 远端的扩展读到，所以这里干脆不带 cwd —— 解析只会落到全局，而
        // `scope.remote = true` 让前端把「这条跑在远端，档位由远端 settings.json
        // 决定」说明白。（`remote://…` 虚拟键同样被 clean 挡掉，绝不入库。）
        let cwd = if remote {
            None
        } else {
            // 显式参数优先：面板那条流的目录是用户看得见的项目，比实例残值更权威。
            cwd.and_then(clean).or_else(|| {
                sid.as_deref().and_then(|s| {
                    crate::pi_gateway::peek_session_cwd(s)
                        .or_else(|| crate::pi_gateway::session_jsonl_cwd(s))
                })
            })
        };
        Self {
            session_id: sid,
            cwd,
            remote,
        }
    }

    fn project_key(&self) -> Option<String> {
        let cwd = self.cwd.as_deref()?;
        let key = normalize_project_key(cwd);
        (!key.is_empty()).then_some(key)
    }
}

/// 读一张覆盖表，只留「键非空 + 值合法」的条目（与扩展 `normalizeModeOverrides`
/// 同）。`project = true` 时键再归一一次 —— 扩展也只对 `modeByProject` 归一，
/// 手改文件写成的反斜杠路径因此仍能命中 pi 报来的正斜杠 cwd。
fn read_override_table(block: &Value, field: &str, project: bool) -> Vec<(String, String)> {
    let Some(map) = block.get(field).and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(map.len());
    for (key, value) in map {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(mode) = value.as_str().filter(|m| is_extension_mode(m)) else {
            continue;
        };
        out.push((
            if project {
                normalize_project_key(trimmed)
            } else {
                trimmed.to_string()
            },
            mode.to_string(),
        ));
    }
    out
}

/// 生效档解析：会话覆盖 → 项目覆盖 → 全局 `mode`。优先级、坏值处理、默认回落
/// 都逐字对齐扩展 `config.ts::resolvePermissionMode`。
///
/// 返回 `(扩展 mode, 来源, 命中键)`；`source` 是给前端看的实话，不是判定输入。
fn resolve_effective_mode(
    block: &Value,
    session_id: Option<&str>,
    cwd: Option<&str>,
) -> (String, &'static str, Option<String>) {
    if let Some(sid) = session_id {
        if let Some((key, mode)) = read_override_table(block, "modeBySession", false)
            .into_iter()
            .find(|(k, _)| k.as_str() == sid)
        {
            return (mode, "session", Some(key));
        }
    }
    let usable_cwd = cwd.map(str::trim).filter(|c| !c.is_empty() && !c.contains("://"));
    if let Some(cwd) = usable_cwd {
        let key = normalize_project_key(cwd);
        if let Some((stored, mode)) = read_override_table(block, "modeByProject", true)
            .into_iter()
            .find(|(stored, _)| *stored == key)
        {
            return (mode, "project", Some(stored));
        }
    }
    match block.get("mode").and_then(Value::as_str).filter(|m| is_extension_mode(m)) {
        Some(mode) => (mode.to_string(), "global", None),
        None => (EXTENSION_FALLBACK_MODE.to_string(), "global", None),
    }
}

/// 把 permission 块 + 作用域身份装配成前端要的那一份视图。
///
/// get / set / clear 三条命令共用同一个构造，免得「写入返回的形状」和「读回来的
/// 形状」又是两套。`mode` 顶层键**一直是生效档**（旧前端只读它，语义保持兼容）。
fn permission_mode_view(block: &Value, target: &ScopeTarget, path: &std::path::Path) -> Value {
    // enabled=false 是扩展的总开关：它一关，连覆盖表都不跑（实际全放行）。
    let enabled = block.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let (mode, source, key) = resolve_effective_mode(block, target.session_id.as_deref(), target.cwd.as_deref());
    let global_mode = block
        .get("mode")
        .and_then(Value::as_str)
        .filter(|m| is_extension_mode(m))
        .unwrap_or(EXTENSION_FALLBACK_MODE);
    let (mode, source) = if enabled {
        (mode, source)
    } else {
        (EXTENSION_FALLBACK_MODE.to_string(), "disabled")
    };
    let session_hit = read_override_table(block, "modeBySession", false)
        .into_iter()
        .find(|(k, _)| Some(k.as_str()) == target.session_id.as_deref());
    let project_hit = target.project_key().and_then(|want| {
        read_override_table(block, "modeByProject", true)
            .into_iter()
            .find(|(k, _)| *k == want)
    });
    let scoped = |entry: Option<(String, String)>| -> Option<Value> {
        entry.map(|(k, m)| json!({ "key": k, "mode": from_extension_mode(&m), "extension_mode": m }))
    };
    json!({
        "ok": true,
        "mode": from_extension_mode(&mode),
        "extension_mode": mode,
        "effective": {
            "mode": from_extension_mode(&mode),
            "extension_mode": mode,
            "source": source,
            "key": key,
        },
        "global": {
            "mode": from_extension_mode(global_mode),
            "extension_mode": global_mode,
            // 全局 mode 缺失/打错 ⇒ 扩展按 yolo 放行，而 Helix 从没写过这种值。
            // 前端要能指出「这不是你选的档，是文件里的值认不出来」。
            "unparsable": !block.get("mode").and_then(Value::as_str).is_some_and(is_extension_mode),
        },
        "session": scoped(session_hit),
        "project": scoped(project_hit),
        "override_active": matches!(source, "session" | "project"),
        "scope": {
            "session_id": target.session_id,
            "cwd": target.cwd,
            "remote": target.remote,
        },
        "approvalTimeoutSec": clamp_approval_timeout(block.get("approvalTimeoutSec").and_then(Value::as_f64)),
        "enabled": enabled,
        "config_path": path.to_string_lossy(),
    })
}

/// 失败视图：读不到 settings.json 时**不要编一个档位回去**。
///
/// 原因就写在下面那个历史 bug 里 —— 曾经这里坏 JSON 也返回 `mode:"auto"`，前端
/// 拿去显示「自动审批」，而扩展在文件缺失/坏 JSON 时一律回落它自己的
/// `DEFAULT_CONFIG`（`mode:"yolo"`，全放行）。显示会问、实际不问，是这一层最坏的错法。
fn permission_mode_read_error(path: &std::path::Path, exists: bool, reason: String) -> Value {
    json!({
        "ok": false,
        "mode": Value::Null,
        "effective": Value::Null,
        "global": Value::Null,
        "session": Value::Null,
        "project": Value::Null,
        "approvalTimeoutSec": Value::Null,
        "exists": exists,
        "reason": reason,
        "config_path": path.to_string_lossy(),
    })
}

/// 读档位（可选带上作用域身份，前端传 sid 就能拿到这条会话真正生效的那一档）。
#[tauri::command]
pub fn helix_get_permission_mode(session_id: Option<String>, cwd: Option<String>) -> Value {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            return permission_mode_read_error(&path, path.exists(), format!("settings.json 不可读: {e}"))
        }
    };
    let root = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v,
        Err(e) => return permission_mode_read_error(&path, true, format!("settings.json JSON 解析失败: {e}")),
    };
    let Some(v) = read_permission_block(&root) else {
        // settings.json 里还没有 permission 键：如实说没有，不编档位。
        return permission_mode_read_error(&path, false, "settings.json 中尚无 permission 键".into());
    };
    let target = ScopeTarget::resolve(session_id.as_deref(), cwd.as_deref());
    permission_mode_view(&v, &target, &path)
}

/// 读整份 settings.json 供写入。**文件存在但解析失败时必须中止**：
///
/// 这条路径写的是整份 pi 配置（`defaultModel` / `packages` / 各扩展的键都在里面）。
/// 旧实现坏 JSON 也当「空配置」继续写，等于前端点一下审批下拉就把用户整份
/// settings.json 抹了 —— 那是数据丢失，不是显示分歧。
fn load_root_for_write(path: &std::path::Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("settings.json 解析失败，已中止写入以免覆盖整份配置: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("settings.json 不可读，已中止写入: {e}")),
    }
}

/// 目标那一格**现在**的值（已按扩展的口径校验：认不出的值 = 没有覆盖）。
/// 用于写入返回的 `changed`，也用于「清除」前的对照。
fn prev_scope_value(cfg: &Value, scope: Scope, key: &str) -> Option<String> {
    match scope {
        Scope::Global => cfg
            .get("mode")
            .and_then(Value::as_str)
            .filter(|m| is_extension_mode(m))
            .map(str::to_string),
        Scope::Project => read_override_table(cfg, "modeByProject", true)
            .into_iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, m)| m),
        Scope::Session => read_override_table(cfg, "modeBySession", false)
            .into_iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, m)| m),
    }
}

/// 把档位写进目标那一格，返回改之前那格的值。
///
/// 只碰目标：另一张覆盖表、`approvalTimeoutSec`、`classifier`、`userRules` 一律
/// 原样留着（用户在扩展里调过的东西不能被前端一个下拉抹掉）。
/// 末尾把 `enabled` 置回 true —— 它在扩展侧是「整个扩展关闭」的总开关，一关连
/// 覆盖表都不跑；而这里写的是**某一格的档位**，写成不生效的状态就是撒谎。
/// yolo 本身已经是放行档，不需要再借 `enabled=false` 表达。
fn apply_scope_mode(cfg: &mut Value, scope: Scope, key: &str, ext_mode: &str) -> Option<String> {
    let prev = prev_scope_value(cfg, scope, key);
    match scope {
        Scope::Global => cfg["mode"] = Value::String(ext_mode.to_string()),
        Scope::Project | Scope::Session => {
            let field = if scope == Scope::Project {
                "modeByProject"
            } else {
                "modeBySession"
            };
            let project = scope == Scope::Project;
            let obj = cfg.as_object_mut().expect("已是 object");
            // 表不存在时建一张空表；存在则原地改，别的条目不动。
            let table = obj
                .entry(field)
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if !table.is_object() {
                // 被人写成数组/字符串：整张丢掉重建 —— 扩展认不出这张表就等于
                // 没有覆盖，而 UI 会显示「本项目已收紧」，那正是显示与闸门分叉。
                *table = Value::Object(serde_json::Map::new());
            }
            let map = table.as_object_mut().expect("刚确保是 object");
            if project {
                // 归一后同键的旧写法（手改成的反斜杠 / 大小写）一并换掉：同一个
                // 项目留两条不同档位的条目，两侧迭代顺序可能不同，判定就成了掷硬币。
                let dupes: Vec<String> = map
                    .keys()
                    .filter(|k| {
                        normalize_project_key(k.trim()) == key && k.as_str() != key
                    })
                    .cloned()
                    .collect();
                for k in dupes {
                    map.remove(&k);
                }
            } else {
                // 会话表同理清掉「同一 sid 的带空格写法」，否则两条同会话条目
                // 会让 UI 的「已覆盖」与扩展实际命中的那条不一致。
                let dupes: Vec<String> = map
                    .keys()
                    .filter(|k| k.trim() == key && k.as_str() != key)
                    .cloned()
                    .collect();
                for k in dupes {
                    map.remove(&k);
                }
            }
            map.insert(key.to_string(), Value::String(ext_mode.to_string()));
        }
    }
    cfg["enabled"] = Value::Bool(true);
    prev
}

/// 删掉目标那一格，返回被删掉的键（项目表可能有多于一种拼法）。
///
/// `global` 走不到这里（它是兜底那一层，没有「清除」，见 `helix_clear_permission_override`）。
fn remove_scope_override(cfg: &mut Value, scope: Scope, key: &str) -> Vec<String> {
    let project = scope == Scope::Project;
    let field = if project { "modeByProject" } else { "modeBySession" };
    let Some(map) = cfg
        .as_object_mut()
        .and_then(|c| c.get_mut(field))
        .and_then(Value::as_object_mut)
    else {
        return Vec::new();
    };
    let hits: Vec<String> = map
        .keys()
        .filter(|k| {
            if project {
                normalize_project_key(k.trim()) == key
            } else {
                k.trim() == key
            }
        })
        .cloned()
        .collect();
    for k in &hits {
        map.remove(k);
    }
    hits
}

/// 写档位。`scope` 决定写到哪一层：
///  - `global` → `mode`（旧前端不传 scope，走这一档，行为不变）
///  - `project` → `modeByProject[归一后的项目键]`
///  - `session` → `modeBySession[pi 会话 id]`
///
/// 写入本身收在 `apply_scope_mode` 里（纯函数，可测）；这条命令只负责把身份
/// 解析成键、拒绝写不进的作用域，再把结果按 `permission_mode_view` 的形状回传。
#[tauri::command]
pub fn helix_set_permission_mode(
    mode: String,
    scope: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
) -> Value {
    let scope = match parse_scope(scope.as_deref()) {
        Ok(s) => s,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let ext_mode = to_extension_mode(&mode);
    let target = if scope == Scope::Global {
        ScopeTarget::default()
    } else {
        ScopeTarget::resolve(session_id.as_deref(), cwd.as_deref())
    };
    let path = config_path();

    // 目标格子的键（顺带把「这个作用域现在根本写不了」挡在写之前）。
    let key: Result<String, String> = match scope {
        Scope::Global => Ok(String::new()),
        Scope::Project => {
            if target.remote {
                Err("远程会话的项目在**远端机器**上，它的 pi 读远端自己的 settings.json：本机覆盖表对它无效。".into())
            } else {
                target.project_key().ok_or_else(|| {
                    "写「本项目」档需要项目目录：这条会话还没有本地目录（草稿？）。请先选项目，或改用「本会话」/「全局」。".into()
                })
            }
        }
        Scope::Session => {
            if target.remote {
                Err("远程会话的审批档由远端配置决定：本机的 modeBySession 不会被远端的扩展读到。".into())
            } else {
                target
                    .session_id
                    .clone()
                    .ok_or_else(|| "写「本会话」档需要会话 id：这条对话还没建起来（草稿）。请先发一轮，或改用「本项目」/「全局」。".into())
            }
        }
    };
    let key = match key {
        Ok(k) => k,
        Err(e) => return json!({ "ok": false, "error": e, "config_path": path.to_string_lossy() }),
    };

    let mut root = match load_root_for_write(&path) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e, "config_path": path.to_string_lossy() }),
    };
    if !root.is_object() {
        root = json!({});
    }
    let mut cfg = read_permission_block(&root).unwrap_or_else(default_permission_block);
    let prev_scope_mode = apply_scope_mode(&mut cfg, scope, &key, ext_mode);

    // 会话档是临时意图：对话早被删掉的条目留着只会无界增长，按本机存活情况清一次。
    let pruned = if scope == Scope::Session {
        prune_session_overrides(&mut cfg, crate::pi_gateway::session_override_alive)
    } else {
        Vec::new()
    };

    if let Some(map) = root.as_object_mut() {
        map.insert("permission".into(), cfg.clone());
    }

    let body = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".into());
    if let Err(e) = crate::config::atomic_write(&path, &format!("{body}\n")) {
        return json!({
            "ok": false,
            "error": format!("写配置失败: {e}"),
            "config_path": path.to_string_lossy(),
        });
    }
    let mut view = permission_mode_view(&cfg, &target, &path);
    if let Some(obj) = view.as_object_mut() {
        obj.insert("scope_written".into(), json!({
            "scope": scope_name(scope),
            "key": if scope == Scope::Global { Value::Null } else { Value::String(key) },
            "mode": from_extension_mode(ext_mode),
            "extension_mode": ext_mode,
            "previous": prev_scope_mode.as_ref().map(|m| json!({ "mode": from_extension_mode(m), "extension_mode": m })),
            "changed": prev_scope_mode.as_deref() != Some(ext_mode),
        }));
        if !pruned.is_empty() {
            obj.insert("prunedSessions".into(), json!(pruned));
        }
    }
    view
}

fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::Global => "global",
        Scope::Project => "project",
        Scope::Session => "session",
    }
}

/// 删掉「本机已经不存在的会话」的覆盖条目，返回被删的 sid。
///
/// 判活口径由调用方给（生产用 `pi_gateway::session_override_alive`：本机有 jsonl /
/// 实例还在跑 / 被记为远程会话 —— 任一即活），这样纯函数可测。
/// 表清空后保留空对象键：扩展读空表与读不到等价，而稳定的形状便于用户手改。
fn prune_session_overrides(cfg: &mut Value, alive: impl Fn(&str) -> bool) -> Vec<String> {
    let Some(map) = cfg
        .as_object_mut()
        .and_then(|c| c.get_mut("modeBySession"))
        .and_then(Value::as_object_mut)
    else {
        return Vec::new();
    };
    let dead: Vec<String> = map.keys().filter(|k| !alive(k)).cloned().collect();
    for k in &dead {
        map.remove(k);
    }
    dead
}

/// 清除某一层的覆盖，回到「下一层说了算」。
///
/// `global` 没有「清除」这一说（它就是兜底那一层），要改请直接选档。
#[tauri::command]
pub fn helix_clear_permission_override(
    scope: String,
    session_id: Option<String>,
    cwd: Option<String>,
) -> Value {
    let scope = match parse_scope(Some(scope.as_str())) {
        Ok(s) => s,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let path = config_path();
    if scope == Scope::Global {
        return json!({
            "ok": false,
            "error": "全局档没有「清除」（它本来就是兜底那一层）；要改请直接选一个档位。",
            "config_path": path.to_string_lossy(),
        });
    }
    let target = ScopeTarget::resolve(session_id.as_deref(), cwd.as_deref());
    let key = if scope == Scope::Project {
        target.project_key()
    } else {
        target.session_id.clone()
    };
    let Some(key) = key else {
        return json!({
            "ok": false,
            "error": if scope == Scope::Project {
                "清除「本项目」覆盖需要项目目录（这条会话还没有本地目录）。"
            } else {
                "清除「本会话」覆盖需要会话 id（这条对话还没建起来）。"
            },
            "config_path": path.to_string_lossy(),
        })
    };

    let mut root = match load_root_for_write(&path) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e, "config_path": path.to_string_lossy() }),
    };
    if !root.is_object() {
        root = json!({});
    }
    let mut cfg = read_permission_block(&root).unwrap_or_else(default_permission_block);
    let removed = remove_scope_override(&mut cfg, scope, &key);

    if let Some(map) = root.as_object_mut() {
        map.insert("permission".into(), cfg.clone());
    }
    let body = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".into());
    if let Err(e) = crate::config::atomic_write(&path, &format!("{body}\n")) {
        return json!({
            "ok": false,
            "error": format!("写配置失败: {e}"),
            "config_path": path.to_string_lossy(),
        });
    }
    let mut view = permission_mode_view(&cfg, &target, &path);
    if let Some(obj) = view.as_object_mut() {
        obj.insert(
            "cleared".into(),
            json!({ "scope": scope_name(scope), "key": key, "removed": removed }),
        );
    }
    view
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

    let mut root = match load_root_for_write(&path) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e, "config_path": path.to_string_lossy() }),
    };
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

// ──────────────────────── 用户规则（userRules） ────────────────────────
//
// 规则由扩展的 `src/config.ts::normalizeRule` 消费，语义**必须与它逐字对齐**，
// 否则就是「Helix 存了一份扩展不认的规则」——文件里看着有，判定里根本没有。
// 对齐要点（源码核实于 @zhushanwen/pi-permission 1.5.0）：
//  - `action` 只认 "allow" | "deny" | "ask"；别的值 ⇒ **整条规则被静默丢弃**。
//    所以 Helix 这一层宁可拒写也不能放过：写进去等于没写，而 UI 会显示它存在。
//  - `tool` / `pattern` 缺省为 "*"；但**空串是合法字符串**，会编成 `^$` 这种
//    永不命中的正则 —— 缺省能救，空串救不了，只能拒。
//  - `source` 只认 user / builtin-safe / builtin-danger，其余回落 "user"。
//    Helix 一律写 "user"：`builtin-danger` 的 pattern 是按**正则**编译的
//    （`resolvePattern` 按 source 分发），把这一格交给前端等于开一条正则注入。
//  - `id` 仅用于展示与 reason 文案，重复不会让判定出错，但会让「denied by rule
//    user-3」指错行，所以照样去重。
//
// 生效范围（`pipeline.ts::checkPermission`）：
//  - `yolo`：直接放行，规则层根本不跑。
//  - `strict`：全部人工审批，规则层也不跑 —— 连 deny 规则都不生效，最严也只是
//    弹窗问一次。
//  - `auto`：层 1 AST → 层 2 规则（`[...getDefaultRules(), ...userRules]`，
//    内置侧现是四组（只读放行 / builtin-danger / 密钥路径 / 额外 bash deny），
//    last-match-wins）→ 未命中才进层 3（AI + 人工竞速）。
//  - bash 且 AST 判定「结构危险」（管道 / `&&` / 子 shell 等）时**跳过层 2**，
//    直接进层 3 —— 这类命令上用户规则不生效。
// 所以前端必须把「当前档位下规则到底生不生效」如实摆出来。

/// 校验并归一一条规则；返回可扩展消费的 JSON 形状。错误信息面向 UI（会原样显示）。
fn normalize_rule(raw: &Value, fallback_id: &str) -> Result<Value, String> {
    let Some(obj) = raw.as_object() else {
        return Err("规则必须是对象".into());
    };

    let tool = match obj.get("tool") {
        None | Some(Value::Null) => "*".to_string(),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return Err("工具名不能是空串：空串会编成「永不命中」的规则".into());
            }
            if t.contains(['\n', '\r', '\0']) {
                return Err("工具名不能含换行".into());
            }
            t.to_string()
        }
        Some(_) => return Err("工具名必须是字符串".into()),
    };
    let pattern = match obj.get("pattern") {
        None | Some(Value::Null) => "*".to_string(),
        Some(Value::String(s)) => {
            if s.trim().is_empty() {
                return Err("匹配模式不能是空串：空串会编成「永不命中」的规则".into());
            }
            if s.contains(['\n', '\r', '\0']) {
                return Err("匹配模式不能含换行".into());
            }
            s.clone()
        }
        Some(_) => return Err("匹配模式必须是字符串".into()),
    };
    let action = match obj.get("action").and_then(Value::as_str) {
        Some("allow") | Some("deny") | Some("ask") => obj["action"].as_str().unwrap().to_string(),
        Some(other) => {
            return Err(format!(
                "动作只能是 allow / deny / ask，收到: {other}（其他值会被扩展整条丢弃）"
            ))
        }
        None => return Err("缺少动作（allow / deny / ask）".into()),
    };
    let id = match obj.get("id").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => fallback_id.to_string(),
    };

    let mut out = serde_json::Map::new();
    out.insert("id".into(), Value::String(id));
    out.insert("tool".into(), Value::String(tool));
    out.insert("pattern".into(), Value::String(pattern));
    out.insert("action".into(), Value::String(action));
    // 来源恒为 user（见文件头注释：builtin-danger 的 pattern 走正则编译）。
    out.insert("source".into(), Value::String("user".into()));
    if let Some(Value::String(desc)) = obj.get("description") {
        let d = desc.trim();
        if !d.is_empty() {
            out.insert("description".into(), Value::String(d.to_string()));
        }
    }
    Ok(Value::Object(out))
}

/// 归一整个数组：任意一条非法 ⇒ 整体失败（拒写），并带回每条错误。
///
/// 不做「丢掉坏的那条、写好的那些」：那等于悄悄改了用户的规则集，而前端刚刚
/// 显示的就是完整那一份。
fn normalize_rule_list(rules: &[Value]) -> Result<Vec<Value>, Vec<(usize, String)>> {
    let mut errs: Vec<(usize, String)> = Vec::new();
    let mut out: Vec<Value> = Vec::with_capacity(rules.len());
    let mut used_ids: Vec<String> = Vec::with_capacity(rules.len());
    let mut next = 1usize;
    for (i, raw) in rules.iter().enumerate() {
        // 自动补的 id：与扩展 `makeNextIdCounter` 同样的 `user-<n>` 形状，且跳过
        // 已经用掉的号，免得把两条规则显示成同一条。
        let fresh_id = loop {
            let id = format!("user-{next}");
            next += 1;
            if !used_ids.contains(&id) {
                break id;
            }
        };
        match normalize_rule(raw, &fresh_id) {
            Ok(v) => {
                let id = v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let (final_id, final_value) = if used_ids.contains(&id) {
                    let mut renamed = v;
                    renamed["id"] = Value::String(fresh_id.clone());
                    (fresh_id, renamed)
                } else {
                    (id, v)
                };
                used_ids.push(final_id);
                out.push(final_value);
            }
            Err(e) => errs.push((i, e)),
        }
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(errs)
    }
}

/// 纯函数内核：把归一好的规则数组装回整份 settings.json，其余键原样保留。
///
/// `permission` 键缺失时用扩展默认值起一份（与 `helix_set_permission_mode` 同一
/// 起底），否则扩展在下次读文件时会用它的 DEFAULT_CONFIG 覆盖用户其它意图。
fn apply_user_rules_to_root(root: &Value, rules: Vec<Value>) -> Value {
    let mut root = if root.is_object() { root.clone() } else { json!({}) };
    let mut cfg = read_permission_block(&root).unwrap_or_else(default_permission_block);
    {
        let obj = cfg.as_object_mut().expect("已是 object");
        obj.insert("userRules".into(), Value::Array(rules));
    }
    if let Some(obj) = root.as_object_mut() {
        obj.insert("permission".into(), cfg);
    }
    root
}

/// 读用户规则 + 当前档位 / enabled / classifier 开关 + 规则层是否参与判定。
#[tauri::command]
pub fn helix_get_permission_rules() -> Value {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) => {
            return json!({
                "ok": false,
                "rules": Value::Null,
                "unparsable": Value::Null,
                "exists": path.exists(),
                "reason": format!("settings.json 不可读: {e}"),
                "configPath": path.to_string_lossy(),
            })
        }
    };
    let root = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "ok": false,
                "rules": Value::Null,
                "unparsable": Value::Null,
                "exists": true,
                "reason": format!("settings.json JSON 解析失败: {e}"),
                "configPath": path.to_string_lossy(),
            })
        }
    };
    let block = read_permission_block(&root);
    let ext_mode = block
        .as_ref()
        .and_then(|b| b.get("mode").and_then(Value::as_str))
        .unwrap_or("auto")
        .to_string();
    let enabled = block
        .as_ref()
        .and_then(|b| b.get("enabled").and_then(Value::as_bool))
        .unwrap_or(true);
    let classifier_enabled = block
        .as_ref()
        .and_then(|b| b.get("classifier").and_then(|c| c.get("enabled").and_then(Value::as_bool)))
        .unwrap_or(true);

    let stored: Vec<Value> = block
        .as_ref()
        .and_then(|b| b.get("userRules").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();

    // 逐条试归一：坏的那条会被**扩展**静默丢弃，必须在 UI 上点名，否则用户以为
    // 规则在生效。这里不修文件，只报告。
    let mut good: Vec<Value> = Vec::new();
    let mut unparsable: Vec<Value> = Vec::new();
    for (i, r) in stored.iter().enumerate() {
        match normalize_rule(r, &format!("user-{}", i + 1)) {
            Ok(v) => good.push(v),
            Err(e) => unparsable.push(json!({ "index": i, "reason": e, "raw": r })),
        }
    }

    json!({
        "ok": true,
        "rules": good,
        "storedCount": stored.len(),
        "unparsable": unparsable,
        "mode": from_extension_mode(&ext_mode),
        "extension_mode": ext_mode,
        "enabled": enabled,
        "classifierEnabled": classifier_enabled,
        // 只有 auto + enabled 才跑规则层（见文件头）。
        "rulesActive": ext_mode == "auto" && enabled,
        "configPath": path.to_string_lossy(),
    })
}

/// 写用户规则（整组替换）。校验失败一条都不写。
#[tauri::command]
pub fn helix_set_permission_rules(rules: Vec<Value>) -> Value {
    let normalized = match normalize_rule_list(&rules) {
        Ok(v) => v,
        Err(errs) => {
            return json!({
                "ok": false,
                "error": "规则校验未通过，未写入任何改动",
                "errors": errs
                    .into_iter()
                    .map(|(i, m)| json!({ "index": i, "message": m }))
                    .collect::<Vec<_>>(),
            })
        }
    };

    let path = config_path();
    let root = match load_root_for_write(&path) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "error": e, "configPath": path.to_string_lossy() }),
    };
    let merged = apply_user_rules_to_root(&root, normalized);

    let body = serde_json::to_string_pretty(&merged).unwrap_or_else(|_| "{}".into());
    if let Err(e) = crate::config::atomic_write(&path, &format!("{body}\n")) {
        return json!({
            "ok": false,
            "error": format!("写配置失败: {e}"),
            "configPath": path.to_string_lossy(),
        });
    }
    let written = merged
        .get("permission")
        .and_then(|p| p.get("userRules"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "ok": true,
        "rules": written,
        "count": written.len(),
        "configPath": path.to_string_lossy(),
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

    // ── 用户规则归一（对齐扩展 normalizeRule 的丢弃/默认语义）──────────────

    #[test]
    fn normalizes_a_valid_rule_and_forces_user_source() {
        let r = normalize_rule(
            &json!({
                "tool": "write",
                "pattern": "D:/Project/Helix/docs/*",
                "action": "allow",
                "source": "builtin-danger",
                "id": "  keep-me  ",
                "description": "  文档目录放开  ",
                "extra": "扩展不认识，不该带进文件"
            }),
            "user-1",
        )
        .unwrap();
        assert_eq!(r["tool"], "write");
        assert_eq!(r["pattern"], "D:/Project/Helix/docs/*");
        assert_eq!(r["action"], "allow");
        // 声称 builtin-danger 也必须被改回 user：那条 pattern 走正则编译，
        // 交给前端等于开一个正则注入口。
        assert_eq!(r["source"], "user");
        assert_eq!(r["id"], "keep-me");
        assert_eq!(r["description"], "文档目录放开");
        assert!(r.get("extra").is_none());
    }

    #[test]
    fn missing_tool_and_pattern_default_to_star() {
        let r = normalize_rule(&json!({ "action": "deny" }), "user-7").unwrap();
        assert_eq!(r["tool"], "*");
        assert_eq!(r["pattern"], "*");
        assert_eq!(r["id"], "user-7");
        assert!(r.get("description").is_none());
    }

    #[test]
    fn rejects_actions_the_extension_would_silently_drop() {
        // 扩展 normalizeRule 只认 allow/deny/ask，别的值 ⇒ 整条规则消失。
        for bad in ["always", "approve", "", "ALLOW"] {
            let e = normalize_rule(&json!({ "tool": "bash", "pattern": "git *", "action": bad }), "user-1")
                .unwrap_err();
            assert!(e.contains("动作"), "{bad} → {e}");
        }
        assert!(normalize_rule(&json!({ "tool": "bash", "pattern": "git *" }), "user-1").is_err());
    }

    #[test]
    fn rejects_empty_strings_because_they_compile_to_never_match() {
        // 缺省会补 `*`，空串是合法字符串 ⇒ 编成 `^$`，永不命中。必须拒。
        assert!(normalize_rule(&json!({ "tool": "", "pattern": "x", "action": "ask" }), "u")
            .unwrap_err()
            .contains("工具名"));
        assert!(normalize_rule(&json!({ "tool": "bash", "pattern": "  ", "action": "ask" }), "u")
            .unwrap_err()
            .contains("匹配模式"));
        // 首尾空白会被 trim 掉（扩展不 trim，`"bash\n"` 到它那儿编成 `^bash\n$`
        // 永不命中 ⇒ 一条死规则）。内部换行仍拒。
        assert_eq!(
            normalize_rule(&json!({ "tool": "bash\n", "pattern": "x", "action": "ask" }), "u")
                .unwrap()["tool"],
            "bash"
        );
        assert!(normalize_rule(&json!({ "tool": "ba\nsh", "pattern": "x", "action": "ask" }), "u").is_err());
    }

    #[test]
    fn list_normalization_assigns_unique_ids_and_reports_every_bad_row() {
        let ok = normalize_rule_list(&[
            json!({ "tool": "bash", "pattern": "git push *", "action": "deny" }),
            json!({ "tool": "read", "pattern": "~/.ssh/*", "action": "deny" }),
        ])
        .unwrap();
        assert_eq!(ok[0]["id"], "user-1");
        assert_eq!(ok[1]["id"], "user-2");

        // 用户自带 id 占号：自动补的必须跳过，不能生成两个 user-1。
        let mixed = normalize_rule_list(&[
            json!({ "id": "user-1", "tool": "bash", "pattern": "a", "action": "allow" }),
            json!({ "tool": "bash", "pattern": "b", "action": "allow" }),
        ])
        .unwrap();
        assert_eq!(mixed[0]["id"], "user-1");
        assert_eq!(mixed[1]["id"], "user-2");
        // 重复 id 被改名（只影响 reason 文案，不改判定）。
        let dup = normalize_rule_list(&[
            json!({ "id": "same", "tool": "bash", "pattern": "a", "action": "allow" }),
            json!({ "id": "same", "tool": "bash", "pattern": "b", "action": "allow" }),
        ])
        .unwrap();
        assert_ne!(dup[0]["id"], dup[1]["id"]);

        // 一条坏 ⇒ 整体拒，并带回每条错误（不做「丢坏的写好的」）。
        let errs = normalize_rule_list(&[
            json!({ "tool": "bash", "pattern": "ok", "action": "allow" }),
            json!({ "tool": "bash", "pattern": "bad", "action": "always" }),
        ])
        .unwrap_err();
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].0, 1);
    }

    #[test]
    fn write_preserves_every_other_key() {
        // 只有 userRules 变；档位/超时/classifier 与 settings.json 的其它顶层键
        // （defaultModel、packages…）都必须逐字留下 —— 前端一个「保存」按钮不该
        // 抹掉用户在扩展里调过的东西。
        let root = json!({
            "defaultProvider": "tokenroute",
            "defaultModel": "glm-5.2",
            "packages": ["extensions\\web-access"],
            "permission": {
                "mode": "auto",
                "enabled": true,
                "approvalTimeoutSec": 90,
                "classifier": { "enabled": false, "model": "deepseek" },
                "userRules": []
            },
            "someFutureKey": { "keep": true }
        });
        let out = apply_user_rules_to_root(
            &root,
            vec![json!({ "id": "user-1", "tool": "bash", "pattern": "git push *", "action": "deny", "source": "user" })],
        );
        assert_eq!(out["defaultProvider"], "tokenroute");
        assert_eq!(out["defaultModel"], "glm-5.2");
        assert_eq!(out["packages"], root["packages"]);
        assert_eq!(out["someFutureKey"]["keep"], true);
        assert_eq!(out["permission"]["mode"], "auto");
        assert_eq!(out["permission"]["approvalTimeoutSec"], 90);
        assert_eq!(out["permission"]["classifier"]["model"], "deepseek");
        assert_eq!(out["permission"]["userRules"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn write_seeds_default_block_when_permission_key_absent() {
        // permission 键缺失时起的默认档必须是 auto（会问），不能是 yolo。
        let out = apply_user_rules_to_root(&json!({ "defaultModel": "x" }), vec![]);
        assert_eq!(out["permission"]["mode"], "auto");
        assert_eq!(out["permission"]["enabled"], true);
        assert_eq!(out["permission"]["userRules"], json!([]));
    }

    // ──────────────── 作用域档位（与扩展 resolvePermissionMode 同步） ────────────────

    fn target(sid: Option<&str>, cwd: Option<&str>) -> ScopeTarget {
        ScopeTarget {
            session_id: sid.map(str::to_string),
            cwd: cwd.map(str::to_string),
            remote: false,
        }
    }

    #[test]
    fn project_key_matches_the_extensions_normalization() {
        // 反斜杠 → 正斜杠、去尾斜杠；扩展只在 win32 转小写。两侧任何一处不同，
        // 就会造出「UI 说本项目已收紧、实际按全局放行」。
        let key = normalize_project_key("D:\\Project\\Helix\\");
        assert!(!key.contains('\\'), "反斜杠必须折成正斜杠: {key}");
        assert!(!key.ends_with('/'), "尾斜杠必须去掉: {key}");
        if cfg!(windows) {
            assert_eq!(key, "d:/project/helix", "Windows 上大小写不敏感");
            // 同一项目的两种拼法归一到同一个键 —— 覆盖表去重全靠这条。
            assert_eq!(normalize_project_key("d:/project/helix"), key);
        } else {
            assert_eq!(key, "D:/Project/Helix", "非 Windows 保留大小写");
        }
    }

    #[test]
    fn effective_mode_priority_is_session_then_project_then_global() {
        let block = json!({
            "mode": "auto",
            "enabled": true,
            "modeByProject": { "d:/project/helix": "strict" },
            "modeBySession": { "sid-1": "yolo" },
        });
        // 会话覆盖最优先，并且盖住同项目的项目覆盖。
        let hit = resolve_effective_mode(&block, Some("sid-1"), Some("D:\\Project\\Helix"));
        assert_eq!((hit.0.as_str(), hit.1), ("yolo", "session"));
        assert_eq!(hit.2.as_deref(), Some("sid-1"));
        // 别的会话落回项目档：存的键与 pi 报来的 cwd 拼法不同也算命中（两侧都归一）。
        let hit = resolve_effective_mode(&block, Some("sid-2"), Some("D:/Project/Helix/"));
        assert_eq!((hit.0.as_str(), hit.1), ("strict", "project"));
        assert_eq!(hit.2.as_deref(), Some("d:/project/helix"));
        // 没有目录就跳过项目档，只会落到全局。
        let hit = resolve_effective_mode(&block, None, None);
        assert_eq!((hit.0.as_str(), hit.1), ("auto", "global"));
        // `remote://…` 虚拟键不参与本地解析（它永远命不中 pi 报来的真实 cwd）。
        let hit = resolve_effective_mode(&block, None, Some("remote://box/D:/Project/Helix"));
        assert_eq!(hit.1, "global");
    }

    #[test]
    fn unparsable_modes_are_skipped_not_invented() {
        // 覆盖表里的坏值：扩展逐条丢弃，这里也必须当作不存在 —— 否则 Helix 写出
        // 一份扩展不消费的表，UI 显示「已收紧」而判定里根本没有。
        let block = json!({
            "mode": "auto",
            "modeByProject": { "d:/p": "approve", "d:/q": "strict" },
            "modeBySession": { "s1": "ALLOW" },
        });
        assert_eq!(resolve_effective_mode(&block, Some("s1"), Some("d:/q")).0, "strict");
        assert_eq!(resolve_effective_mode(&block, Some("s1"), None).0, "auto");
        assert_eq!(resolve_effective_mode(&block, None, Some("d:/p")).0, "auto");

        // 全局 mode 认不出 ⇒ 扩展回落它的 DEFAULT_CONFIG.mode = yolo（实际全放行）。
        // 显示必须跟到同一个值，并把「这不是你选的档，是文件里的值认不出来」摆出来。
        let view = permission_mode_view(
            &json!({ "mode": "approve" }),
            &target(None, None),
            std::path::Path::new("settings.json"),
        );
        assert_eq!(view["extension_mode"], "yolo");
        assert_eq!(view["mode"], "full");
        assert_eq!(view["global"]["unparsable"], true);
    }

    #[test]
    fn master_switch_off_reports_no_gate_at_all() {
        // enabled=false 时扩展连覆盖表都不跑。生效档必须直接报「完全访问」，
        // 否则又是「卡片写本项目询问审批、工具照样跑」。
        let block = json!({
            "mode": "auto",
            "enabled": false,
            "modeByProject": { "d:/p": "strict" },
        });
        let view = permission_mode_view(
            &block,
            &target(None, Some("D:\\p")),
            std::path::Path::new("settings.json"),
        );
        assert_eq!(view["extension_mode"], "yolo");
        assert_eq!(view["effective"]["source"], "disabled");
        assert_eq!(view["override_active"], false);
        assert_eq!(view["enabled"], false);
        // 那一格本身仍然如实报出来（它确实在文件里，只是当前不生效）。
        assert_eq!(view["project"]["extension_mode"], "strict");
    }

    #[test]
    fn scope_write_touches_only_its_own_cell() {
        let mut cfg = json!({
            "mode": "auto",
            "enabled": true,
            "approvalTimeoutSec": 90,
            "classifier": { "enabled": false, "model": "deepseek" },
            "userRules": [{ "id": "user-1", "tool": "bash", "pattern": "git push *", "action": "deny", "source": "user" }],
            "modeByProject": { "D:\\Other\\Proj": "yolo", "d:/project/helix": "auto" },
        });
        let rules_before = cfg["userRules"].clone();
        let project_before = cfg["modeByProject"].clone();
        let prev = apply_scope_mode(&mut cfg, Scope::Project, "d:/project/helix", "strict");
        assert_eq!(prev.as_deref(), Some("auto"));
        assert_eq!(cfg["modeByProject"]["d:/project/helix"], "strict");
        // 归一后同键的旧拼法被换掉：同一项目留两条不同档位，两侧迭代顺序就是掷硬币。
        assert_eq!(cfg["modeByProject"].as_object().unwrap().len(), 2);
        assert_eq!(
            cfg["modeByProject"]["D:\\Other\\Proj"],
            project_before["D:\\Other\\Proj"]
        );
        // 其余字段逐字留下：全局档、超时、classifier、userRules 都不该被一个下拉抹掉。
        assert_eq!(cfg["mode"], "auto");
        assert_eq!(cfg["approvalTimeoutSec"], 90);
        assert_eq!(cfg["classifier"]["model"], "deepseek");
        assert_eq!(cfg["userRules"], rules_before);
        // 写档即启用：enabled=false 会让整张覆盖表失效，不能写成不生效的状态。
        assert_eq!(cfg["enabled"], true);
    }

    #[test]
    fn session_write_keeps_global_cell_and_prunes_dead_sessions() {
        let mut cfg = json!({ "mode": "yolo", "enabled": false });
        let prev = apply_scope_mode(&mut cfg, Scope::Session, "s1", "strict");
        assert_eq!(prev, None);
        assert_eq!(cfg["modeBySession"]["s1"], "strict");
        assert_eq!(cfg["mode"], "yolo", "scoped 写入不能顺手改全局档");
        assert_eq!(cfg["enabled"], true, "总开关关着，这条覆盖根本不跑");

        cfg["modeBySession"]["dead"] = json!("auto");
        let pruned = prune_session_overrides(&mut cfg, |sid| sid == "s1");
        assert_eq!(pruned, vec!["dead".to_string()]);
        assert_eq!(cfg["modeBySession"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn clear_removes_every_spelling_of_the_project() {
        let mut cfg = json!({
            "modeByProject": { "D:\\P\\Helix": "strict", "d:/p/helix": "yolo", "d:/other": "auto" },
        });
        let removed = remove_scope_override(&mut cfg, Scope::Project, "d:/p/helix");
        assert_eq!(removed.len(), 2, "手改出来的同项目拼法要一并清掉，否则「清了还在」");
        assert_eq!(cfg["modeByProject"].as_object().unwrap().len(), 1);
        assert_eq!(cfg["modeByProject"]["d:/other"], "auto");
        // 清不存在的键 / 不存在的表：返回空，不报错（幂等）。
        assert!(remove_scope_override(&mut cfg, Scope::Project, "d:/none").is_empty());
        assert!(remove_scope_override(&mut cfg, Scope::Session, "s1").is_empty());
    }

    #[test]
    fn default_block_seeds_both_override_tables() {
        // permission 键缺失时起的形状要带空覆盖表：扩展读空表与读不到等价，
        // 但稳定形状便于用户手改，也让「清除后还剩什么」有确定答案。
        let cfg = default_permission_block();
        assert_eq!(cfg["modeByProject"], json!({}));
        assert_eq!(cfg["modeBySession"], json!({}));
        assert_eq!(resolve_effective_mode(&cfg, Some("s1"), Some("d:/p")).0, "auto");
    }
}
