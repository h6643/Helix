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

/// 装没装扩展：按 **pi 自己的发现规则**判断，而不是只看 settings.json 的 packages。
///
/// pi 加载用户级扩展有两条互不相干的通路（`core/package-manager.js`）：
///
/// 1. `collectAutoExtensionEntries(~/.pi/agent/extensions)` —— 目录里有
///    `index.ts`/`index.js`，或其 package.json 声明了 `pi.extensions`，就自动
///    加载，**完全不经过 packages 列表**（`package-manager.js` 的
///    `addResources("extensions", collectAutoExtensionEntries(userDirs.extensions), …)`）；
/// 2. `packages` 里的显式条目（`npm:pi-web-access`、`extensions/web-access`）。
///
/// 本机的 web-access 走的是第 1 条（目录直接 clone 在 `extensions/web-access`，
/// package.json 里 `pi.extensions = ["./index.ts"]`，packages 列表里一个字节都没有）。
/// 旧实现只查第 2 条，于是把它判成「没装」并挂出「这里的 key 配好了也没有
/// web_search 工具」的横幅 —— 而工具明明正在跑。纯误报，修。
#[derive(Clone, Debug, PartialEq, Eq)]
struct ExtensionProbe {
    /// 能不能判定。读不到扩展根目录时是 false —— 不等于没装。
    known: bool,
    /// pi 会不会加载它（发现 + 未被 override 关掉）。
    loaded: bool,
    /// 在哪发现的（人话，给横幅/排查用）；没发现时为空。
    source: String,
}

/// 给面板的四态。横幅文案不能只拿「没装载」一个布尔：磁盘上已经有、只是被
/// `settings.json 的 extensions` 关掉的扩展，让用户去「安装」是错建议 ——
/// 他要按的是打开那个开关。未知态不报警（见 `web_search_config_list`）。
fn extension_status_of(probe: &ExtensionProbe) -> &'static str {
    if !probe.known {
        "unknown"
    } else if probe.loaded {
        "loaded"
    } else if probe.source.is_empty() {
        "absent"
    } else {
        "disabled"
    }
}

/// 目录名候选：本机 clone 下来叫 `web-access`，`pi install npm:` 的包名是
/// `pi-web-access`，两种都得认。
const EXTENSION_DIR_NAMES: [&str; 2] = ["web-access", "pi-web-access"];

/// 判定一个目录是不是 pi 会自动加载的扩展包（镜像 `resolveExtensionEntries`：
/// package.json 的 `pi.extensions` 优先，其次 `index.ts`/`index.js`）。
/// 返回 pi 实际会加载的、相对该目录的入口文件名。
fn discovered_extension_entry(dir: &std::path::Path) -> Option<Vec<String>> {
    let pkg_json = dir.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&pkg_json) {
        if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
            if let Some(list) = pkg.pointer("/pi/extensions").and_then(Value::as_array) {
                let mut hits = Vec::new();
                for entry in list.iter().filter_map(Value::as_str) {
                    // 只取入口文件名（去掉 `./` 与嵌套路径）：候选已经带上目录前缀，
                    // 而 override 模式也是按 `extensions/<name>/<file>` 写的。
                    let name = entry
                        .trim_start_matches("./")
                        .rsplit(['/', '\\'])
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if !name.is_empty() && dir.join(&name).exists() {
                        hits.push(name);
                    }
                }
                if !hits.is_empty() {
                    return Some(hits);
                }
            }
        }
    }
    for index in ["index.ts", "index.js"] {
        if dir.join(index).exists() {
            return Some(vec![index.to_string()]);
        }
    }
    None
}

/// 纯函数形态：把三个外部输入（扩展根目录、packages 表、override 模式）都收进来，
/// 好让判定能脱开真实 home 目录被测。
fn extension_probe(
    ext_root: &std::path::Path,
    packages: &[(String, bool)],
    patterns: &[String],
) -> ExtensionProbe {
    // 第 1 条通路：自动发现。候选路径与 helix 的扩展列表行保持同一套
    // （目录本身 + 它的入口文件），这样 `!extensions/web-access/**` 这类
    // 关掉本地扩展的写法能被同一个规则命中。
    if ext_root.is_dir() {
        for name in EXTENSION_DIR_NAMES {
            let dir = ext_root.join(name);
            if dir.is_dir() {
                if let Some(entries) = discovered_extension_entry(&dir) {
                    let rel_dir = format!("extensions/{name}");
                    let mut candidates = vec![rel_dir.clone()];
                    candidates.extend(entries.iter().map(|e| format!("{rel_dir}/{e}")));
                    return ExtensionProbe {
                        known: true,
                        loaded: crate::helix::local_extension_enabled(&candidates, patterns),
                        source: rel_dir,
                    };
                }
            }
            // 单文件形态：extensions/web-access.ts|js。
            for ext in ["ts", "js"] {
                let file = ext_root.join(format!("{name}.{ext}"));
                if file.is_file() {
                    let rel = format!("extensions/{name}.{ext}");
                    return ExtensionProbe {
                        known: true,
                        loaded: crate::helix::local_extension_enabled(&[rel.clone()], patterns),
                        source: rel,
                    };
                }
            }
        }
    }

    // 第 2 条通路：packages 显式条目（兼容 `extensions\web-access`、
    // `extensions/web-access`、`npm:pi-web-access` 三种写法）。bool 是启用态
    // （对象形态把所有资源类型过滤成 [] 时为 false）。
    if let Some((source, enabled)) = packages.iter().find(|(s, _)| {
        let norm = s.replace('\\', "/").to_lowercase();
        norm.ends_with("web-access") || norm.ends_with("pi-web-access")
    }) {
        return ExtensionProbe {
            known: true,
            loaded: *enabled,
            source: source.clone(),
        };
    }

    // 两条路都没有：只有当扩展根目录确实读得动时才敢下「没装」的结论。
    ExtensionProbe {
        known: ext_root.is_dir(),
        loaded: false,
        source: String::new(),
    }
}

/// 收集真实输入并判定。扩展根目录不存在（用户从没装过任何东西）时返回
/// `known: false`，面板因此不会对着一个空目录喊「没装」。
fn extension_probe_from_disk() -> ExtensionProbe {
    let agent_dir = crate::paths::pi_agent_dir();
    let ext_root = agent_dir.join("extensions");
    // packages 的启用态由 helix 的统一映射给出（字符串条目 = 启用；对象把所有
    // 资源类型过滤成 [] = 停用）。
    let packages_enabled = crate::helix::pi_packages_enabled_map();
    let packages: Vec<(String, bool)> = packages_enabled
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let patterns = crate::helix::pi_local_extension_patterns();
    extension_probe(&ext_root, &packages, &patterns)
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

    let probe = extension_probe_from_disk();
    json!({
        "ok": true,
        "unmanagedSearchProvider": unmanaged_search_provider,
        "secrets": Value::Object(secrets),
        "configPath": crate::config::config_yaml_path().to_string_lossy(),
        // 判不准（扩展根目录都读不到）时不喊「没装」：宁可不提醒，也不要对着
        // 正在工作的工具说它不存在 —— 那正是这次误报的形态。
        "extensionLoaded": !probe.known || probe.loaded,
        "extensionStatus": extension_status_of(&probe),
        "extensionPackage": if probe.source.is_empty() { Value::Null } else { json!(probe.source) },
        "extensionKnown": probe.known,
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

    // ── 扩展是否装载：必须按 pi 的发现规则判，不能只看 packages ──────────

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "helix-websearch-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 本机现状的回归用例：目录 clone 在 extensions/web-access，package.json
    /// 声明了 pi.extensions，settings.json 的 packages 里一个字节都没有。
    /// 旧实现把这种形态判成「没装」，横幅于是对着正在工作的工具喊不存在。
    #[test]
    fn auto_discovered_dir_counts_as_installed_even_with_empty_packages() {
        let root = temp_root("auto-discovered");
        let ext = root.join("extensions").join("web-access");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("index.ts"), "export default () => {}").unwrap();
        std::fs::write(
            ext.join("package.json"),
            r#"{"name":"pi-web-access-lean","pi":{"extensions":["./index.ts"]}}"#,
        )
        .unwrap();

        let probe = extension_probe(&root.join("extensions"), &[], &[]);
        assert!(probe.known, "扩展根目录存在 ⇒ 可判");
        assert!(probe.loaded, "自动发现即装载，与 packages 无关：{:?}", probe);
        assert_eq!(probe.source, "extensions/web-access");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn disable_override_takes_it_back_off() {
        let root = temp_root("disabled");
        let ext = root.join("extensions").join("web-access");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("index.ts"), "export default () => {}").unwrap();

        let patterns = vec!["!extensions/web-access/**".to_string()];
        let probe = extension_probe(&root.join("extensions"), &[], &patterns);
        assert!(probe.known);
        assert!(!probe.loaded, "glob 关掉 ⇒ 没装载");

        // 关掉的是别家时不能误伤。
        let other = vec!["!extensions/pi-cron/**".to_string()];
        assert!(extension_probe(&root.join("extensions"), &[], &other).loaded);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn npm_packages_entry_still_counts() {
        let root = temp_root("packages-only");
        // 扩展根目录不存在，只有 packages 条目 —— 旧行为要保住。
        let probe = extension_probe(
            &root.join("extensions"),
            &[("npm:pi-web-access".to_string(), true)],
            &[],
        );
        assert!(probe.loaded, "packages 条目仍然算装：{:?}", probe);
        assert_eq!(probe.source, "npm:pi-web-access");

        // 对象形态把所有资源过滤成 [] ⇒ 停用，要如实报。
        let disabled = extension_probe(
            &root.join("extensions"),
            &[("npm:pi-web-access".to_string(), false)],
            &[],
        );
        assert!(!disabled.loaded);
        std::fs::remove_dir_all(&root).ok();
    }

    /// 读不到扩展根目录 ≠ 没装：known=false，面板不许下结论。
    #[test]
    fn unreadable_root_is_unknown_not_absent() {
        let root = temp_root("no-ext-dir");
        let probe = extension_probe(&root.join("extensions"), &[], &[]);
        assert!(!probe.known, "目录不存在 ⇒ 不可判");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bare_index_dir_without_manifest_is_discovered() {
        let root = temp_root("bare-index");
        let ext = root.join("extensions").join("pi-web-access");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("index.js"), "export default () => {}").unwrap();
        // 目录名两种写法都得认：pi install 的包名形态。
        let probe = extension_probe(&root.join("extensions"), &[], &[]);
        assert!(probe.loaded, "index.js + pi-web-access 目录名：{:?}", probe);
        std::fs::remove_dir_all(&root).ok();
    }

    /// 四态划分要准确：磁盘上有但被关掉 = disabled（去打开），不是 absent（去安装）。
    #[test]
    fn distinguishes_disabled_from_absent() {
        let root = temp_root("status-matrix");
        let ext = root.join("extensions").join("web-access");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("index.ts"), "export default () => {}").unwrap();
        let ext_root = root.join("extensions");

        assert_eq!(
            extension_status_of(&extension_probe(&ext_root, &[], &[])),
            "loaded"
        );
        assert_eq!(
            extension_status_of(&extension_probe(
                &ext_root,
                &[],
                &["-extensions/web-access/index.ts".to_string()]
            )),
            "disabled",
            "已存在只是被 override 关掉 ⇒ 不该喊去安装"
        );
        // packages 里有条目但被过滤成空 ⇒ 同样是 disabled。
        assert_eq!(
            extension_status_of(&extension_probe(
                &root.join("nothing"),
                &[("npm:pi-web-access".to_string(), false)],
                &[]
            )),
            "disabled"
        );
        assert_eq!(
            extension_status_of(&extension_probe(&root.join("nothing"), &[], &[])),
            "unknown",
            "读不到目录 ⇒ 不可判，不报警"
        );
        assert_eq!(
            extension_status_of(&extension_probe(
                &ext_root,
                &[],
                &["+extensions/other".to_string()]
            )),
            "loaded"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}

