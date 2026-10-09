//! 联网搜索（web-access 扩展）的配置面 —— 读写 `config.yaml` 的 `web_search:` 块。
//!
//! # 这一层存在的理由
//!
//! 搜索工具 `web_search` / `code_search` 由**第三方扩展** `pi-web-access` 注册
//! （`~/.pi/agent/extensions/web-access`），Helix 不拥有它的判定逻辑，只拥有
//! 它读的那份配置。它自己的文档写明取值优先级：
//!
//! 1. 环境变量 `TAVILY_API_KEY` / `PERPLEXITY_API_KEY`
//! 2. `config.yaml` 的 `web_search:` 块（本模块写这里）
//! 3. 遗留的 `~/.pi/web-search.json`
//!
//! 所以面板必须**只改自己那一份**，并且把「这一份可能被环境变量盖掉」如实说
//! 出来 —— 否则用户填了 key 却发现用的是另一个账号。
//!
//! # 绝不回显密钥
//!
//! 读命令只返回**来源类别**（literal / env / command / none）和「有没有」，从不
//! 返回值本身 —— 前端连掩码都不需要，因为一个都不显示。密钥只在这份文件里，
//! 测试调用时临时读进内存，用完即弃。
//!
//! # 键值可以是「凭据来源」而不是一串 key
//!
//! 扩展认这几种写法（`credential-source.ts`）：`!命令`（跑命令取 stdout）、
//! `$ENV_NAME` / `${ENV_NAME}`（读环境变量）、`$$` / `$!` 开头的转义字面量。
//! 这些都不是密钥本身，所以按字面量去打 API 一定失败 —— 测试命令遇到它们会明说
//! 「这条路由扩展在 pi 进程里解析，Helix 不代跑」，而不是伪造一次成功。
//!
//! # 改完要不要重启 pi
//!
//! 要。扩展的 `loadWebSearchConfig()` 和 `getSearchConfig()` 都是 module-level
//! 缓存，一个 pi 进程只在第一次调用时读文件。这与审批档位（每次 tool_call 重读）
//! 不同 —— 面板据此提示「下一次新会话/新 spawn 的 pi 才生效」。

use serde_json::{json, Value};

/// Helix 拥有的 `web_search:` 子键。**不含** `githubClone`：那是扩展自己的
/// 嵌套块，本模块一个字节都不碰（`set_yaml_key` 只写点分两级的标量键）。
const PROVIDER_KEY: &str = "searchProvider";
const SECRET_KEYS: [&str; 2] = ["tavilyApiKey", "perplexityApiKey"];
/// 扩展读 provider 时的兼容写法：`raw.searchProvider ?? raw.provider`。
/// 只读不写 —— 新值一律落 `searchProvider`，它优先级更高。
const LEGACY_PROVIDER_KEY: &str = "provider";

const SEARCH_PROVIDERS: [&str; 3] = ["auto", "tavily", "perplexity"];

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

    let provider = {
        let v = get(PROVIDER_KEY);
        if SEARCH_PROVIDERS.contains(&v.as_str()) {
            v
        } else {
            // 认不出的值在扩展侧一律回落 auto（`normalizeSearchProvider`），
            // 所以这里也必须显示 auto，否则「显示 X 实际 auto」又是一次分裂。
            "auto".to_string()
        }
    };
    let stored_provider = get(PROVIDER_KEY);
    let legacy_provider = get(LEGACY_PROVIDER_KEY);

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
                    None => match k {
                        "tavilyApiKey" => "TAVILY_API_KEY",
                        _ => "PERPLEXITY_API_KEY",
                    },
                }),
            }),
        );
    }

    let entry = extension_package_entry();
    json!({
        "ok": true,
        "config": {
            "searchProvider": provider,
            "storedSearchProvider": stored_provider,
            "legacyProvider": legacy_provider,
        },
        "secrets": Value::Object(secrets),
        "configPath": crate::config::config_yaml_path().to_string_lossy(),
        "extensionLoaded": entry.is_some(),
        "extensionPackage": entry,
        "restartNeeded": true,
    })
}

/// 写 `web_search:` 块。**字段缺省 = 不改这一项**，空串 = 清除，非空 = 写入。
/// 之所以要「缺省不改」：密钥从不回显，前端没法把旧值填回表单，若无这条约定，
/// 用户只改 provider 就会把 tavilyApiKey 清成空。
#[tauri::command]
pub fn web_search_config_save(config: Value) -> Value {
    let Some(obj) = config.as_object() else {
        return json!({ "ok": false, "error": "config 必须是对象" });
    };

    // 先全部校验，再动文件：一半写进去、一半被拒是最坏结果。
    let mut pending: Vec<(String, String)> = Vec::new();
    if let Some(v) = obj.get(PROVIDER_KEY) {
        let provider = v.as_str().unwrap_or("").trim().to_lowercase();
        if !SEARCH_PROVIDERS.contains(&provider.as_str()) {
            return json!({
                "ok": false,
                "error": format!("searchProvider 只能是 auto / tavily / perplexity，收到: {provider}"),
            });
        }
        pending.push((PROVIDER_KEY.to_string(), provider));
    }
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

/// 解析测试用 key：字面量直接用；`$ENV` 形态回落 Helix 进程环境（与 pi 同一份）。
fn resolve_test_key(raw: &str) -> Result<(String, &'static str), String> {
    match classify_credential(raw) {
        CredentialSource::None => Err("未配置 key".to_string()),
        CredentialSource::Literal => Ok((raw.trim().to_string(), "config.yaml")),
        CredentialSource::Env => match env_name_for(raw) {
            Some(name) => match std::env::var(&name) {
                Ok(v) if !v.trim().is_empty() => Ok((v.trim().to_string(), "环境变量")),
                _ => Err(format!("key 由环境变量 {name} 提供，但当前进程环境里没有它")),
            },
            None => Err("环境变量名写法无法解析".to_string()),
        },
        CredentialSource::Command => Err(
            "key 写成 `!命令` 形态，只有扩展在 pi 进程里能执行它；Helix 不代跑命令，\
             请在对话里让模型用一次 web_search 来验证"
                .to_string(),
        ),
    }
}

/// 把 key 从错误文本里抹掉（对齐扩展的 `redactCredential`）：401 响应体偶尔会
/// 回显请求头，那玩意儿一旦进日志就等于密钥外泄。
fn redact(text: &str, key: &str) -> String {
    if key.is_empty() {
        return text.to_string();
    }
    text.replace(key, "[redacted]")
}

/// 打一次**真实**的搜索请求，只回「通不通 + 哪一家 + 状态码」，不回内容。
///
/// 只测连通性，不做缓存/额度统计 —— Tavily 按 credit 计费，配额超了会直接以
/// HTTP 错误回来，这里把它原样转达。
#[tauri::command]
pub async fn web_search_test(provider: Option<String>) -> Value {
    let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).unwrap_or_default();
    let block = crate::config::read_yaml_block(&yaml, "web_search");
    let get = |k: &str| -> String {
        block
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };

    let configured = {
        let v = get(PROVIDER_KEY);
        if SEARCH_PROVIDERS.contains(&v.as_str()) {
            v
        } else {
            "auto".to_string()
        }
    };
    let requested = provider
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .to_string();
    let choice = if requested.is_empty() { configured } else { requested };
    if !SEARCH_PROVIDERS.contains(&choice.as_str()) {
        return json!({ "ok": false, "error": format!("未知 provider: {choice}") });
    }

    // auto = Tavily 优先、其次 Perplexity，都缺就报缺（与扩展 search.ts 同序）。
    let order: Vec<&str> = match choice.as_str() {
        "tavily" => vec!["tavily"],
        "perplexity" => vec!["perplexity"],
        _ => vec!["tavily", "perplexity"],
    };

    let mut attempts: Vec<String> = Vec::new();
    for name in order {
        let (key, key_from) = match resolve_test_key(
            &get(if name == "tavily" { "tavilyApiKey" } else { "perplexityApiKey" }),
        ) {
            Ok(v) => v,
            Err(e) => {
                attempts.push(format!("{name}: {e}"));
                continue;
            }
        };
        let started = std::time::Instant::now();
        let result = if name == "tavily" {
            call_tavily(&key).await
        } else {
            call_perplexity(&key).await
        };
        let latency_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(status) => {
                return json!({
                    "ok": true,
                    "provider": name,
                    "keyFrom": key_from,
                    "httpStatus": status,
                    "latencyMs": latency_ms,
                })
            }
            Err(e) => {
                let msg = redact(&e, &key);
                // 显式指定这一家时不回落到另一家（与扩展一致：静默换供应商会让
                // 「Tavily key 废了」看起来像「搜索能用」）。
                if choice != "auto" {
                    return json!({
                        "ok": false,
                        "provider": name,
                        "keyFrom": key_from,
                        "latencyMs": latency_ms,
                        "error": msg,
                    });
                }
                attempts.push(format!("{name}: {msg}"));
            }
        }
    }
    json!({
        "ok": false,
        "provider": choice,
        "error": format!("没有一家可用：{}", attempts.join(" | ")),
    })
}

/// Tavily `POST https://api.tavily.com/search`（扩展 tavily.ts 同一 endpoint）。
async fn call_tavily(key: &str) -> Result<u16, String> {
    let client = crate::proxy::proxy_aware_client().map_err(|e| e.to_string())?;
    let resp = client
        .post("https://api.tavily.com/search")
        .bearer_auth(key)
        // 最小请求体：连通性测试不该消耗配额去抓正文。
        .json(&json!({
            "query": "Helix 联网搜索连通性测试",
            "search_depth": "ultra-fast",
            "max_results": 1,
            "include_answer": false,
            "include_raw_content": false,
        }))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        return Ok(status.as_u16());
    }
    Err(format!("Tavily API {status}: {}", &text.chars().take(300).collect::<String>()))
}

/// Perplexity `POST https://api.perplexity.ai/chat/completions`，model 固定
/// `sonar`（扩展 perplexity.ts 里也是硬编码，没有可配项）。
async fn call_perplexity(key: &str) -> Result<u16, String> {
    let client = crate::proxy::proxy_aware_client().map_err(|e| e.to_string())?;
    let resp = client
        .post("https://api.perplexity.ai/chat/completions")
        .bearer_auth(key)
        .json(&json!({
            "model": "sonar",
            "messages": [{ "role": "user", "content": "Reply with exactly: ok" }],
            "max_tokens": 8,
        }))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        return Ok(status.as_u16());
    }
    Err(format!("Perplexity API {status}: {}", &text.chars().take(300).collect::<String>()))
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

    #[test]
    fn redact_removes_key_from_error_text() {
        assert_eq!(
            redact("401 unauthorized: Bearer SECRET123", "SECRET123"),
            "401 unauthorized: Bearer [redacted]"
        );
        assert_eq!(redact("no key here", ""), "no key here");
    }

    #[test]
    fn command_sourced_keys_are_not_executed_by_helix() {
        let err = resolve_test_key("!security find-generic-password").unwrap_err();
        assert!(err.contains("不代跑命令"), "{err}");
        assert!(resolve_test_key("").is_err());
        // 字面量直接可用
        assert_eq!(resolve_test_key("  tvly-x  ").unwrap().0, "tvly-x");
    }
}
