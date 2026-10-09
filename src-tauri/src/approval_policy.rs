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
//  - `auto`：层 1 AST → 层 2 规则（`[...12 条 builtin-danger, ...userRules]`，
//    last-match-wins）→ 未命中才进层 3（AI + 人工竞速）。
//  - bash 且 AST 判定「结构危险」（管道 / `&&` / 子 shell 等）时**跳过层 2**，
//    直接进层 3 —— 这类命令上用户规则不生效。
// 所以前端必须把「当前档位下规则到底生不生效」如实摆出来。

/// builtin-danger 快照的来源版本（`src/rules/builtins.ts` 抄录时对齐的那一版）。
const BUILTIN_SNAPSHOT_VERSION: &str = "1.5.0";

/// 内置危险规则快照（12 条，逐字抄自 pi-permission 的 `src/rules/builtins.ts`）。
///
/// **只读展示用**，Helix 从不写它 —— 真规则由扩展的 `getDefaultRules()` 在每次
/// 判定时现造。这一份存在的唯一理由是「让用户知道哪些是内置的、哪些是自己写的」；
/// 代价是它会随 `pi update --extensions` 过期，所以读取命令会拿安装目录里的
/// package.json 版本比对，不一致就显式告警。宁可提示过期，不要给过期安全感。
fn builtin_danger_snapshot() -> Vec<Value> {
    let rules: [(&str, &str, &str); 12] = [
        ("bd-001", "\\brm\\b.*(\\s-(?:[a-zA-Z]*r)|--recursive)", "recursive delete"),
        ("bd-002", "\\bsudo\\b", "sudo"),
        ("bd-003", "\\bchmod\\b.*(777|a\\+rwx|ugo\\+rwx|ugo=rwx)", "world-writable permissions"),
        (
            "bd-004",
            "(>\\s*/dev/(sd|hd|nvme|mmcblk|vd|xvd)[a-z0-9]+|of=/dev/(sd|hd|nvme|mmcblk|vd|xvd)[a-z0-9]+)",
            "raw device write",
        ),
        ("bd-005", "\\bgit\\s+push\\s+.*(-f\\b|--force\\b)", "force push"),
        ("bd-006", "\\bgit\\s+reset\\s+--hard\\b", "hard reset"),
        ("bd-007", "\\bgit\\s+clean\\b.*(\\s-(?:[a-zA-Z]*f)|--force)", "git clean --force"),
        ("bd-008", "\\bgit\\s+checkout\\s+(--\\s+)?\\.\\s*($|[;&|])", "git checkout . (discard all)"),
        ("bd-009", "\\bgit\\s+restore\\b", "git restore"),
        ("bd-010", "\\b(curl|wget)\\b.*\\|\\s*(ba)?sh\\b", "pipe to shell"),
        ("bd-011", "\\bgh\\s+repo\\s+(create|delete|rename|archive)\\b", "modify GitHub repo"),
        ("bd-012", "\\bgh\\s+release\\s+(create|delete|edit)\\b", "modify GitHub release"),
    ];
    rules
        .iter()
        .map(|(id, pattern, description)| {
            json!({
                "id": id,
                "tool": "bash",
                "pattern": pattern,
                "action": "deny",
                "source": "builtin-danger",
                "description": description,
                "regex": true,
            })
        })
        .collect()
}

/// 本机实际装着的扩展版本（读不到返回 None ⇒ 前端显示「未知」，不假装一致）。
fn installed_extension_version() -> Option<String> {
    let pkg = crate::paths::pi_agent_dir()
        .join("npm")
        .join("node_modules")
        .join("@zhushanwen")
        .join("pi-permission")
        .join("package.json");
    let raw = std::fs::read_to_string(pkg).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("version")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

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

/// 读用户规则 + 规则层当前是否参与判定 + 内置规则快照（只读）。
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

    let installed = installed_extension_version();
    let version_matches = installed.as_deref() == Some(BUILTIN_SNAPSHOT_VERSION);

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
        "builtinRules": builtin_danger_snapshot(),
        "builtinSnapshotVersion": BUILTIN_SNAPSHOT_VERSION,
        "installedVersion": installed,
        "builtinVersionDrift": !version_matches,
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
    let root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
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

    #[test]
    fn builtin_snapshot_has_twelve_deny_rules() {
        let rules = builtin_danger_snapshot();
        assert_eq!(rules.len(), 12);
        for r in &rules {
            assert_eq!(r["action"], "deny");
            assert_eq!(r["tool"], "bash");
            assert_eq!(r["source"], "builtin-danger");
            assert!(r["regex"].as_bool().unwrap());
            // 内置那份是 RegExp 源串：必须能被当成正则用（这里只查明显畸形）。
            let p = r["pattern"].as_str().unwrap();
            assert!(!p.is_empty() && p.matches('\\').count() < p.len(), "{p}");
        }
        // 抽查两条最容易抄错的（含 `\s-` 锚定，缺了就误吃 --verbose）。
        assert_eq!(
            rules[0]["pattern"],
            "\\brm\\b.*(\\s-(?:[a-zA-Z]*r)|--recursive)"
        );
        assert_eq!(rules[6]["pattern"], "\\bgit\\s+clean\\b.*(\\s-(?:[a-zA-Z]*f)|--force)");
    }
}
