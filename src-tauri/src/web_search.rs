//! 联网搜索（web-access 扩展）的配置面 —— 读写 `config.yaml` 的 `web_search:` 块。
//!
//! # 这一层存在的理由
//!
//! 搜索工具 `web_search` / `code_search` 由**第三方扩展** `pi-web-access` 注册
//! （`~/.pi/agent/extensions/web-access`），Helix 不拥有它的判定逻辑，只拥有
//! 它读的那份配置。它自己的文档写明取值优先级：
//!
//! 1. 环境变量 `TAVILY_API_KEY`
//! 2. `config.yaml` 的 `web_search:` 块（本模块写这里）
//! 3. 遗留的 `~/.pi/web-search.json`
//!
//! 所以面板必须**只改自己那一份**，并且把「这一份可能被环境变量盖掉」如实说
//! 出来 —— 否则用户填了 key 却发现用的是另一个账号。
//!
//! # 绝不回显密钥
//!
//! 读命令只返回**来源类别**（literal / env / command / none）和「有没有」，从不
//! 返回值本身 —— 前端连掩码都不需要，因为一个都不显示。密钥只在这份文件里。
//!
//! # 键值可以是「凭据来源」而不是一串 key
//!
//! 扩展认这几种写法（`credential-source.ts`）：`!命令`（跑命令取 stdout）、
//! `$ENV_NAME` / `${ENV_NAME}`（读环境变量）、`$$` / `$!` 开头的转义字面量。
//! 这些都不是密钥本身，所以分类结果只用来告诉前端「这一项由什么提供」，
//! Helix 从不代跑命令、也从不把类别当成 key 去用。
//!
//! # 改完要不要重启 pi
//!
//! 要。扩展的 `loadWebSearchConfig()` 和 `getSearchConfig()` 都是 module-level
//! 缓存，一个 pi 进程只在第一次调用时读文件。这与审批档位（每次 tool_call 重读）
//! 不同 —— 所以读口回 `restartNeeded`，但卡片上没有再播报这条（页脚已删）。

use serde_json::{json, Value};

/// Helix 拥有的 `web_search:` 子键只有 key 本身。**不含** `githubClone`：那是扩展
/// 自己的嵌套块，本模块一个字节都不碰（`set_yaml_key` 只写点分两级的标量键）。
const SECRET_KEYS: [&str; 1] = ["tavilyApiKey"];

/// 下面两个**只读不写**：Helix 只支持 Tavily，没有档位可选，所以不再写
/// `searchProvider`。但文件里可能还存着「扩展认、Helix 不认」的值（遗留的
/// perplexity），必须如实报出去 —— 否则卡片说走 Tavily、扩展实际走别家，又是一次
/// 生效值分裂。扩展自己的读取顺序是 `raw.searchProvider ?? raw.provider`（`search.ts`）。
const PROVIDER_KEY: &str = "searchProvider";
const LEGACY_PROVIDER_KEY: &str = "provider";
/// 扩展 `normalizeSearchProvider` 仍认、但 Helix 不再配置的那一家。
const UNMANAGED_PROVIDER: &str = "perplexity";

/// 密钥这一项当前由什么提供（**永远不包含值本身**）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialSource {
    /// 没配。
    None,
    /// 文件里就是一串 key。
    Literal,
    /// `$ENV_NAME` / `${ENV_NAME}`：真值在 pi 进程的环境变量里。
    Env,
    /// `!命令`：真值由那条命令的 stdout 给出。
    Command,
}

impl CredentialSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Literal => "literal",
            Self::Env => "env",
            Self::Command => "command",
        }
    }
}

/// 镜像扩展 `credential-source.ts` 的判定顺序：`$$`/`$!` 转义 → `!命令` →
/// `$ENV`/`${ENV}` → 字面量。空串算没配（扩展 `normalize()` 也是这么收敛的）。
fn classify_credential(raw: &str) -> CredentialSource {
    let s = raw.trim();
    if s.is_empty() {
        return CredentialSource::None;
    }
    if s.starts_with("$$") || s.starts_with("$!") {
        return CredentialSource::Literal;
    }
    if s.starts_with('!') {
        return CredentialSource::Command;
    }
    if let Some(rest) = s.strip_prefix('$') {
        let ident = rest.strip_prefix('{').and_then(|r| r.strip_suffix('}')).unwrap_or(rest);
        let valid = !ident.is_empty()
            && !ident.chars().next().unwrap().is_ascii_digit()
            && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid {
            return CredentialSource::Env;
        }
    }
    CredentialSource::Literal
}

/// 环境变量名（`$X` / `${X}` 里的 X），供测试调用回落到 Helix 自己的进程环境。
fn env_name_for(raw: &str) -> Option<String> {
    let s = raw.trim();
    let rest = s.strip_prefix('$')?;
    let ident = rest
        .strip_prefix('{')
        .and_then(|r| r.strip_suffix('}'))
        .unwrap_or(rest);
    Some(ident.to_string())
}

/// 装没装扩展：settings.json 的 `packages` 里有没有 `web-access` 那一条。
/// 兼容三种写法：`extensions\web-access`、`extensions/web-access`、
/// `npm:pi-web-access`。取不到就报 unknown（不是 false —— 读不到文件不等于没装）。
fn extension_package_entry() -> Option<String> {
    let root = crate::config::read_pi_settings();
    let packages = root.get("packages").and_then(Value::as_array)?;
    packages
        .iter()
        .filter_map(Value::as_str)
        .find(|s| {
            let norm = s.replace('\\', "/").to_lowercase();
            norm.ends_with("web-access") || norm.ends_with("pi-web-access")
        })
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn web_search_config_list() -> Value {
    let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).unwrap_or_default();
    let block = crate::config::read_yaml_block(&yaml, "web_search");
    let get = |k: &str| -> String {
        block
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };

    // 扩展的生效值是 `searchProvider ?? provider` 再归一（`normalizeSearchProvider`），
    // 所以判断「管不到的那一家有没有在生效」得按这个顺序看，不能只看一个键。
    let effective_provider = if block.get(PROVIDER_KEY).is_some() {
        get(PROVIDER_KEY)
    } else {
        get(LEGACY_PROVIDER_KEY)
    }
    .trim()
    .to_lowercase();
    let unmanaged_search_provider = if effective_provider == UNMANAGED_PROVIDER {
        effective_provider
    } else {
        // 其余取值（包括空的和认不出的垃圾）在扩展侧一律回落 auto ⇒ 实际只有
        // Tavily ⇒ 与卡片说的一致，不必声张。
        String::new()
    };

    let mut secrets = serde_json::Map::new();
    for k in SECRET_KEYS {
        let raw = get(k);
        let source = classify_credential(&raw);
        let env_var = if source == CredentialSource::Env {
            env_name_for(&raw)
        } else {
            None
        };
        secrets.insert(
            k.to_string(),
            json!({
                "configured": source != CredentialSource::None,
                "source": source.as_str(),
                "envVar": env_var,
                // 环境变量优先级高于这份文件，所以必须单独说：Helix 与 pi 共用
                // 进程环境（spawn 时没有 clean_env），这里探到就等于 pi 也用得上。
                "processEnvSet": process_env_present(match env_var.as_deref() {
                    Some(name) => name,
                    None => "TAVILY_API_KEY",
                }),
            }),
        );
    }

    let entry = extension_package_entry();
    json!({
        "ok": true,
        "unmanagedSearchProvider": unmanaged_search_provider,
        "secrets": Value::Object(secrets),
        "configPath": crate::config::config_yaml_path().to_string_lossy(),
        "extensionLoaded": entry.is_some(),
        "extensionPackage": entry,
        "restartNeeded": true,
    })
}

/// 写 `web_search:` 块里的 Tavily key。**字段缺省 = 不改这一项**，空串 = 清除，
/// 非空 = 写入。之所以要「缺省不改」：密钥从不回显，前端没法把旧值填回表单，
/// 若无这条约定，用户随便改一项都会把 tavilyApiKey 清成空。
#[tauri::command]
pub fn web_search_config_save(config: Value) -> Value {
    let Some(obj) = config.as_object() else {
        return json!({ "ok": false, "error": "config 必须是对象" });
    };

    // 先全部校验，再动文件：一半写进去、一半被拒是最坏结果。
    let mut pending: Vec<(String, String)> = Vec::new();
    for k in SECRET_KEYS {
        if let Some(v) = obj.get(k) {
            let raw = v.as_str().unwrap_or("").to_string();
            let value = if raw.is_empty() {
                String::new()
            } else {
                // 去掉首尾空白：扩展 normalize() 也是 trim 后用，留着空白只会让
                // 「看着对、实际 401」这种错更难查。
                raw.trim().to_string()
            };
            pending.push((k.to_string(), value));
        }
    }

    let path = crate::config::config_yaml_path();
    let mut yaml = std::fs::read_to_string(&path).unwrap_or_default();
    for (k, v) in &pending {
        yaml = crate::config::set_yaml_key(&yaml, &format!("web_search.{k}"), &json!(v));
    }
    match crate::config::atomic_write(&path, &yaml) {
        Ok(()) => json!({
            "ok": true,
            "changedKeys": pending.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
            "configPath": path.to_string_lossy(),
        }),
        Err(e) => json!({ "ok": false, "error": e.to_string(), "configPath": path.to_string_lossy() }),
    }
}

fn process_env_present(name: &str) -> bool {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_credential_forms() {
        assert_eq!(classify_credential(""), CredentialSource::None);
        assert_eq!(classify_credential("   "), CredentialSource::None);
        assert_eq!(classify_credential("tvly-abc"), CredentialSource::Literal);
        assert_eq!(classify_credential("!op read op://x/y"), CredentialSource::Command);
        assert_eq!(classify_credential("$TAVILY_API_KEY"), CredentialSource::Env);
        assert_eq!(classify_credential("${TAVILY_API_KEY}"), CredentialSource::Env);
        // 转义字面量优先于 env/command 形态（扩展 escapedSource 同一顺序）。
        assert_eq!(classify_credential("$$LITERAL"), CredentialSource::Literal);
        assert_eq!(classify_credential("$!cmd"), CredentialSource::Literal);
        // `$` 开头但不是合法环境变量名 → 按字面量（扩展也这么落）。
        assert_eq!(classify_credential("$1BAD"), CredentialSource::Literal);
        assert_eq!(classify_credential("$"), CredentialSource::Literal);
    }

    #[test]
    fn extracts_env_names() {
        assert_eq!(env_name_for("$FOO_BAR").as_deref(), Some("FOO_BAR"));
        assert_eq!(env_name_for("${FOO.BAR}").as_deref(), Some("FOO.BAR"));
        assert_eq!(env_name_for("literal"), None);
    }

    #[test]
    fn writes_quoted_scalars_so_keys_survive_round_trip() {
        // set_yaml_key 用 JSON 序列化 ⇒ 带引号；扩展的 mini-YAML 会 unquote。
        let out = crate::config::set_yaml_key(
            "agent:\n  reasoning_effort: \"max\"\n",
            "web_search.tavilyApiKey",
            &json!("tvly-abc#1"),
        );
        assert!(out.contains("  tavilyApiKey: \"tvly-abc#1\""), "{out}");
        // 已有的块不被动到。
        assert!(out.contains("reasoning_effort"), "{out}");
        let back = crate::config::read_yaml_block(&out, "web_search");
        assert_eq!(back.get("tavilyApiKey").and_then(Value::as_str), Some("tvly-abc#1"));
    }

    #[test]
    fn clearing_writes_empty_string_which_the_extension_reads_as_absent() {
        let out = crate::config::set_yaml_key(
            "web_search:\n  tavilyApiKey: \"tvly-abc\"\n",
            "web_search.tavilyApiKey",
            &json!(""),
        );
        let back = crate::config::read_yaml_block(&out, "web_search");
        let raw = back.get("tavilyApiKey").and_then(Value::as_str).unwrap_or("");
        assert_eq!(classify_credential(raw), CredentialSource::None);
    }
}
