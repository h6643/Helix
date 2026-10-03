//! pi-permission-system 策略文件的读写。
//!
//! # 为什么需要这一层
//!
//! pi 官方**没有**权限/审批体系（见 pi 的 `docs/security.md`：
//! "Pi … does not ask for approval before every tool call"）。工具级权限要靠扩展
//! 自己注册 `tool_call` 实现，生态里现成的是 `@gotgenes/pi-permission-system`。
//!
//! Helix 的「设置 → 权限」页要把策略读写到**那个扩展的配置文件**，而不是另搞
//! 一套自己的规则 —— 两套并存会出现「设置里放行了、实际仍弹窗」这类无法排查的
//! 分裂。所以这里只做一件事：把 `~/.pi/agent/extensions/pi-permission-system/
//! config.json` 里的 `permission` 对象读出来 / 写回去，其余字段原样保留。
//!
//! # 边界
//!
//! - 只碰 `permission` 与少数运行时开关，**其余键原样保留**（扩展还有
//!   `permissionDialogKeys` / `promptNotifications` / `authorizerChain` 等几十项，
//!   前端不认得也不能弄丢）。
//! - 写盘用 `config::atomic_write`（tmp + rename），避免半截文件被扩展读到。
//! - **不改扩展的语义**：写回去的 JSON 原样交给扩展校验，Helix 不做二次解释。
//!   扩展自己的 fail-closed 规则（非全局 scope 校验失败 ⇒ 全部 allow 降级为 ask）
//!   仍然生效，这正是我们想要的默认行为。

use serde_json::{json, Map, Value};

/// 扩展 id —— 同时是 `~/.pi/agent/extensions/` 下的目录名。
const EXTENSION_ID: &str = "pi-permission-system";

/// 扩展是否已安装（Helix 启动时用它决定「权限」页显示安装引导还是策略编辑）。
pub fn is_installed() -> bool {
    let p = config_path();
    p.exists() || extension_root().join("package.json").is_file()
}

pub fn config_path() -> std::path::PathBuf {
    crate::paths::pi_agent_dir()
        .join("extensions")
        .join(EXTENSION_ID)
        .join("config.json")
}

fn extension_root() -> std::path::PathBuf {
    crate::paths::pi_agent_dir()
        .join("extensions")
        .join(EXTENSION_ID)
}

/// Helix 默认策略：首次写盘时使用。
///
/// 语义（`permission` 对象，**后匹配覆盖先匹配**）：
/// - `"*": "ask"` —— 未列出的工具一律询问（least privilege，与扩展默认值一致）
/// - 读文件放行，但 `.env` / 密钥类禁读（`.env.example` 放行）
/// - 项目内写/改放行，锁文件禁改
/// - bash 逐条：只读查询放行；`git push` / `sudo` / 删改类询问；
///   `rm -rf` / `mkfs` / `diskpart` 等破坏性直接拒绝
/// - 越界访问一律询问
pub fn default_policy() -> Value {
    json!({
        "*": "ask",
        "path": {
            "*": "allow",
            "*.env": "deny",
            "*.env.*": "deny",
            "*.env.example": "allow"
        },
        "read": "allow",
        "write": "allow",
        "edit": {
            "*": "allow",
            "*.lock": "deny",
            "package-lock.json": "deny"
        },
        "bash": {
            "*": "ask",
            "ls*": "allow",
            "cat *": "allow",
            "head *": "allow",
            "tail *": "allow",
            "wc *": "allow",
            "grep *": "allow",
            "rg *": "allow",
            "find *": "allow",
            "git status*": "allow",
            "git diff*": "allow",
            "git log*": "allow",
            "git show*": "allow",
            "git branch": "allow",
            "pwd": "allow",
            "which *": "allow",
            "node --version": "allow",
            "cargo --version": "allow",
            "rm -rf *": "deny",
            "rm -fr *": "deny",
            "mkfs*": "deny",
            "diskpart*": "deny",
            "format *": "deny",
            "dd if=*": "deny",
            "curl * -T *": "deny",
            "curl * -F *": "deny",
            "git push*": "ask"
        },
        "external_directory": "ask"
    })
}

/// 读策略：`{ installed, configPath, policy, yoloMode, raw }`
///
/// `raw` 是整个配置文件对象（前端只在「高级」区展示/编辑用）。
/// 文件不存在时返回 `policy: null`，让前端显示安装引导而不是假装有配置。
pub fn read_policy() -> Value {
    let path = config_path();
    let installed = is_installed();
    let raw: Value = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let policy = raw
        .get("permission")
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "installed": installed,
        "configPath": path.display().to_string(),
        "policy": policy,
        "yoloMode": raw.get("yoloMode").and_then(Value::as_bool).unwrap_or(false),
        "raw": raw,
    })
}

/// 写策略。
///
/// - `policy` 替换整个 `permission` 对象（`null` = 用 Helix 默认策略）
/// - `yoloMode` 为 `Some` 时同步写入
/// - **未提供的键一律保留原值**（`policy: null` 且无 `yoloMode` 时是 no-op 读改写）
///
/// 写前会做一次最小形状校验：`policy` 必须是对象（扩展的 schema 允许
/// `permission` 是 map，不允许是数组/标量）。形状明显不对时拒绝写入，
/// 免得把扩展的配置写坏导致它整份 fail-closed 降级成「全部询问」。
pub fn write_policy(policy: Option<Value>, yolo_mode: Option<bool>) -> Result<Value, String> {
    let path = config_path();
    let mut raw: Map<String, Value> = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<Value>(&s)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default(),
        Err(_) => Map::new(),
    };

    if let Some(p) = policy {
        let p = if p.is_null() {
            default_policy()
        } else {
            if !p.is_object() {
                return Err("策略必须是一个对象（形如 {\"bash\": {\"*\": \"ask\"}}）".into());
            }
            p
        };
        // 逐键形状校验：permission 的每个值必须是 string 或 object
        for (k, v) in p.as_object().unwrap() {
            let ok = v.is_string() || v.is_object();
            if !ok {
                return Err(format!(
                    "规则 \"{k}\" 的值必须是 \"allow\"/\"deny\"/\"ask\" 或一个规则表对象"
                ));
            }
        }
        raw.insert("permission".into(), p);
    }
    if let Some(y) = yolo_mode {
        raw.insert("yoloMode".into(), Value::Bool(y));
    }
    // 扩展要求这两个键存在才有可观测的审计轨迹
    let key: String = "permissionReviewLog".into();
    raw.entry(key).or_insert(Value::Bool(true));

    let text = serde_json::to_string_pretty(&Value::Object(raw))
        .map_err(|e| format!("序列化策略失败: {e}"))?;
    crate::config::atomic_write(&path, &text)
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;

    Ok(json!({ "ok": true, "configPath": path.display().to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_is_an_object_with_universal_fallback() {
        let p = default_policy();
        assert!(p.is_object());
        assert_eq!(p["*"], "ask", "缺省必须是 ask（least privilege）");
    }

    #[test]
    fn default_policy_keeps_env_readable_only_for_examples() {
        let p = default_policy();
        assert_eq!(p["path"]["*.env"], "deny");
        assert_eq!(p["path"]["*.env.example"], "allow");
    }

    #[test]
    fn default_policy_destructive_bash_is_denied_not_ask() {
        let p = default_policy();
        for pat in ["rm -rf *", "mkfs*", "diskpart*", "dd if=*"] {
            assert_eq!(p["bash"][pat], "deny", "{pat} 必须直接拒绝");
        }
    }

    #[test]
    fn default_policy_denies_never_shadowed_by_wide_ask() {
        // 后匹配覆盖先匹配 ⇒ deny 必须排在 `*: ask` 之后才可达。
        // 依赖 preserve_order（serde_json 用 IndexMap 而非 BTreeMap），
        // 否则写盘重排成字母序会把宽规则挪到 deny 后面，deny 直接失效。
        let text = serde_json::to_string_pretty(&default_policy()).unwrap();
        let bash_seg = &text[text.find("\"bash\"").unwrap()..];
        let wide = bash_seg.find("\"*\": \"ask\"").unwrap();
        let deny = bash_seg.find("\"rm -rf *\"").unwrap();
        assert!(
            wide < deny,
            "宽规则必须在 deny 之前，否则 deny 会被影子覆盖（last-match-wins）"
        );
    }

    #[test]
    fn policy_json_keeps_insertion_order() {
        // 直接锁死「写出去的 JSON 保序」这个前提：哪天有人把 preserve_order
        // 关掉，这条会先于上面的语义测试崩。
        let text = serde_json::to_string(&default_policy()).unwrap();
        let bash = text.find("\"bash\"").unwrap();
        let seg = &text[bash..];
        assert!(
            seg.find("\"ls*\"").unwrap() < seg.find("\"rm -rf *\"").unwrap(),
            "bash 规则应保持声明顺序"
        );
    }

}
