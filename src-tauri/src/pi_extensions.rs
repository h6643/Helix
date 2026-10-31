//! Helix 自带的 pi 扩展安装器。两类扩展走两个通道：
//!
//! 1. 视觉读图 `describe_image`（第三方 `pi-aux-vision` 的 Helix 修改版）：
//!    写出到 `~/.pi/agent/extensions/pi-aux-vision/` 并在 pi 的 `settings.json`
//!    里单点登记 —— 它同时出现在终端 pi 里，属于"正常安装"的插件。但 Helix 改过它
//!    的配置来源（读 `config.yaml` 的 `vision:` 块，见 vendor/pi-aux-vision/index.ts
//!    头部说明），装在 npm 里的副本会被 `pi update` / 重装静默还原成上游行为，
//!    所以仓库里的 `src-tauri/vendor/pi-aux-vision/` 才是唯一权威副本，每次启动覆盖写出。
//!    登记必须唯一：npm 版和目录版都注册同名工具 `describe_image`，两份同时被 pi 加载
//!    会重名冲突，因此写文件之外还要把 `packages` 里指向 pi-aux-vision 的**其他**条目清掉。
//!
//! 2. 内置浏览器扩展 `browser_*`（`vendor/helix-browser.js`）：写出到
//!    `~/.pi/agent/helix-internal/`，**不登记** settings.json —— 只有 Helix 网关
//!    spawn 时附加的 `--extension <path>` 会加载它，终端里的 `pi` 看不到这些工具。
//!    旧版曾把同功能的 `pi-helix-browser` 装在 `extensions/` 下（终端 pi 可见），
//!    启动时移除其 settings.json 登记与目录。

use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::config::{atomic_write, read_pi_settings, write_pi_settings};
use crate::paths::pi_agent_dir;

/// 扩展目录名，写出的目录与 settings.json 的登记条目都由它派生。
const EXT_DIR_NAME: &str = "pi-aux-vision";

/// `include_str!` 让扩展源随二进制编译进包：dev 和打包后都能写出，不依赖资源路径。
/// 不含 footer.ts / footer-controller.ts —— Helix 分支已删除 TUI footer 展示（describe_image
/// 工具本身通过工具调用卡片自述所用模型，footer 冗余且会话内无法清除）。
/// 不含 test-image.ts —— `/vision test` 不再造默认测试图，只接受显式路径（见 index.ts）。
const AUX_VISION_FILES: [(&str, &str); 4] = [
    (
        "index.ts",
        include_str!("../vendor/pi-aux-vision/index.ts"),
    ),
    (
        "config.ts",
        include_str!("../vendor/pi-aux-vision/config.ts"),
    ),
    (
        "vision.ts",
        include_str!("../vendor/pi-aux-vision/vision.ts"),
    ),
    (
        "package.json",
        include_str!("../vendor/pi-aux-vision/package.json"),
    ),
];

/// 本安装器在 settings.json 里的登记写法（与 `pi install` 一致：Windows 用反斜杠，其他平台用斜杠）。
fn canonical_entry() -> String {
    if cfg!(windows) {
        format!("extensions\\{EXT_DIR_NAME}")
    } else {
        format!("extensions/{EXT_DIR_NAME}")
    }
}

/// 斜杠形式，用于识别同一目录的各种写法（相对、绝对、反斜杠）。
const CANONICAL_DIR: &str = "extensions/pi-aux-vision";

/// 启动时调用（在 pi 网关 spawn 之前）。稳态无写入则静默；修复过一次就打一行，便于发现被还原。
pub fn install_aux_vision() {
    let dir = pi_agent_dir().join("extensions").join(EXT_DIR_NAME);
    let files_changed = write_files(&dir, &AUX_VISION_FILES);
    let settings_changed = register_in_settings();
    if files_changed || settings_changed {
        eprintln!("[Helix] 已写出视觉读图扩展到 {}", dir.display());
    }
}

/// 内容不同才写（原子写），所以稳态启动不会碰磁盘。
fn write_files(dir: &Path, files: &[(&str, &str)]) -> bool {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[Helix] 无法创建扩展目录 {}: {e}", dir.display());
        return false;
    }
    let mut changed = false;
    for (name, content) in files {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(content) {
            continue;
        }
        match atomic_write(&path, content) {
            Ok(()) => changed = true,
            Err(e) => eprintln!("[Helix] 扩展文件写入失败 {}: {e}", path.display()),
        }
    }
    changed
}

/// 该条目是否指向目录版的自身（相对写法或指向同一目录的绝对写法）。
fn is_own_dir_entry(entry: &str) -> bool {
    let normalized = entry.replace('\\', "/").trim_end_matches('/').to_string();
    normalized == CANONICAL_DIR || normalized.ends_with(&format!("/{CANONICAL_DIR}"))
}

/// 该条目是否指向本扩展的**其他**副本（npm 包、node_modules 路径等）。
/// 按最后一段路径/包名精确比对，避免误删名字相近的无关扩展。
fn is_rival_entry(entry: &str) -> bool {
    if is_own_dir_entry(entry) {
        return false;
    }
    let normalized = entry.replace('\\', "/");
    let name = normalized.strip_prefix("npm:").unwrap_or(&normalized);
    name.rsplit('/').next() == Some(EXT_DIR_NAME)
}

/// 是否在顶层 `extensions` 数组里被禁用（pi-aux-vision 走本地扩展的
/// `!<dir>/**` / `-<dir>` 覆盖，而不是 packages 的过滤器条目）。
/// 命中核心路径即算命中；`+` 强制启用优先于 `!`/`-`。
fn is_aux_vision_disabled(settings: &Value) -> bool {
    let Some(arr) = settings.get("extensions").and_then(Value::as_array) else {
        return false;
    };
    let mut disabled = false;
    for raw in arr.iter().filter_map(Value::as_str) {
        let body = raw.trim_start_matches(['+', '-', '!']).trim_start_matches("./");
        if body.is_empty() {
            continue;
        }
        let core = body
            .replace('\\', "/")
            .trim_end_matches(|c: char| c == '*' || c == '/' || c == '?')
            .to_string();
        if core != CANONICAL_DIR {
            continue;
        }
        if raw.starts_with('+') {
            disabled = false;
        } else if raw.starts_with('!') || raw.starts_with('-') {
            disabled = true;
        }
    }
    disabled
}

/// `packages` 收敛成唯一登记：绝对写法的自身条目归一成规范写法，npm 版等竞争条目清掉。
///
/// 两条修复，让「禁用」真正生效且持久：
/// 1. 只读字符串条目会**剥掉所有对象条目**（资源过滤 / 禁用标记），导致
///    用户在面板里禁用的 npm 包在下次启动被重写成“加载全部”。现在对象条目原样保留。
/// 2. pi-aux-vision 被顶层 `extensions` 数组禁用时，绝不登记回 packages
///    （包加载路径无视 `extensions` 覆盖，登记回去会让禁用失效）。
fn register_in_settings() -> bool {
    let _guard = crate::config::config_write_lock();
    let mut settings = read_pi_settings();
    // 先读禁用状态再可变借用 settings，避免借用冲突。
    let disabled = is_aux_vision_disabled(&settings);
    let obj = match settings.as_object_mut() {
        Some(o) => o,
        None => return false,
    };

    let had_packages = obj.contains_key("packages");
    let existing: Vec<Value> = obj
        .get("packages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // 自身条目就地归一（保持原有顺序，稳态启动不会产生差异），其余竞争条目删除。
    let mut kept_own = false;
    let mut next: Vec<Value> = Vec::new();
    for entry in &existing {
        match entry {
            Value::String(s) => {
                if is_rival_entry(s) {
                    continue;
                }
                if is_own_dir_entry(s) {
                    if disabled {
                        continue;
                    }
                    if kept_own {
                        continue;
                    }
                    kept_own = true;
                    next.push(Value::String(canonical_entry()));
                    continue;
                }
                next.push(entry.clone());
            }
            Value::Object(_) => {
                // 对象条目原样保留（禁用标记、资源过滤），不能剥掉。
                // 但若对象条目源指向自身目录（异常形态），按字符串分支同样处理。
                let Some(src) = entry.get("source").and_then(Value::as_str) else {
                    next.push(entry.clone());
                    continue;
                };
                if is_rival_entry(src) {
                    continue;
                }
                if is_own_dir_entry(src) {
                    if disabled {
                        continue;
                    }
                    if kept_own {
                        continue;
                    }
                    kept_own = true;
                    next.push(Value::String(canonical_entry()));
                    continue;
                }
                next.push(entry.clone());
            }
            _ => next.push(entry.clone()),
        }
    }
    if !kept_own && !disabled {
        next.push(Value::String(canonical_entry()));
    }

    // 只有真的增删过才落盘，避免每次启动刷新 settings.json 的 mtime。
    let unchanged = had_packages && next == existing;
    if unchanged {
        return false;
    }

    obj.insert("packages".to_string(), Value::Array(next));
    write_pi_settings(&settings);
    true
}

// ── 内置浏览器扩展（browser_* 工具，经 `--extension` 注入 Helix 会话） ──────

/// 内置扩展的安装目录 / 文件名。目录刻意在 pi 的 `extensions/` 自动发现
/// 路径之外，也避开可迁移的 helix_data_dir：spawn 参数与文件位置必须始终
/// 一致，不能随数据目录搬家而漂移。
const INTERNAL_DIR_NAME: &str = "helix-internal";
const BROWSER_EXT_FILE_NAME: &str = "browser-extension.js";

/// 内置浏览器扩展的磁盘路径（`~/.pi/agent/helix-internal/browser-extension.js`）。
/// 只有 `pi_command()` 在 spawn 时把它作为 `--extension <path>` 传给 pi：
/// 终端里的 `pi` 看不到这些工具，Helix 会话全都有。
pub fn browser_extension_path() -> PathBuf {
    pi_agent_dir()
        .join(INTERNAL_DIR_NAME)
        .join(BROWSER_EXT_FILE_NAME)
}

/// 启动时调用（在 pi 网关 spawn 之前）：写出内置浏览器扩展。
/// 内容不同才写（原子写），稳态启动不碰磁盘。
pub fn install_browser_extension() {
    let path = browser_extension_path();
    let dir = pi_agent_dir().join(INTERNAL_DIR_NAME);
    let changed = write_files(
        &dir,
        &[(
            BROWSER_EXT_FILE_NAME,
            include_str!("../vendor/helix-browser.js"),
        )],
    );
    if changed {
        eprintln!("[Helix] 已写出内置浏览器扩展到 {}", path.display());
    }
}

/// 旧版外置浏览器扩展的目录名（曾作为普通 pi 扩展装在 extensions/ 下）。
const LEGACY_BROWSER_DIR_NAME: &str = "pi-helix-browser";

/// 该条目是否指向旧版外置 pi-helix-browser 扩展（相对/绝对/npm 各种写法）。
/// 按最后一段路径/包名精确比对，避免误删名字相近的无关扩展。
fn is_legacy_browser_entry(entry: &str) -> bool {
    let normalized = entry.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    let name = trimmed.strip_prefix("npm:").unwrap_or(trimmed);
    name.rsplit('/').next() == Some(LEGACY_BROWSER_DIR_NAME)
}

/// 启动时调用：移除旧版外置浏览器扩展（settings.json 登记 + 目录）。
/// 8 个浏览器工具已改由内置扩展经 `--extension` 注入；旧目录若还留着，
/// 终端 pi 会看到这些工具、Helix 会话还会因两份同名声明的加载顺序而冲突。
/// 每次启动都收敛（幂等），稳态无操作、不打日志。
pub fn remove_legacy_browser_extension() {
    let dir = pi_agent_dir()
        .join("extensions")
        .join(LEGACY_BROWSER_DIR_NAME);
    let dir_removed = if dir.is_dir() {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[Helix] 旧版浏览器扩展目录删除失败 {}: {e}", dir.display());
                false
            }
        }
    } else {
        false
    };
    let settings_changed = unregister_legacy_browser_from_settings();
    if dir_removed || settings_changed {
        eprintln!("[Helix] 已移除旧版外置浏览器扩展（工具已内置，仅 Helix 会话加载）");
    }
}

/// 从 settings.json 的 `packages` 里剔除指向旧版浏览器扩展的条目。
/// 只剔除命中的字符串条目；对象条目（禁用标记 / 资源过滤）原样保留，
/// 避免清理旧版浏览器扩展时连带剥掉用户配置的禁用状态。
fn unregister_legacy_browser_from_settings() -> bool {
    let _guard = crate::config::config_write_lock();
    let mut settings = read_pi_settings();
    let obj = match settings.as_object_mut() {
        Some(o) => o,
        None => return false,
    };
    let existing: Vec<Value> = obj
        .get("packages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next: Vec<Value> = existing
        .iter()
        .filter(|e| {
            e.as_str()
                .map(|s| !is_legacy_browser_entry(s))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    if next == existing {
        return false;
    }
    if next.is_empty() {
        // 清空后移除键，恢复 pi 的"未安装任何包"默认形态。
        obj.remove("packages");
    } else {
        obj.insert("packages".to_string(), Value::Array(next));
    }
    write_pi_settings(&settings);
    true
}

// ── 无效禁用模式的启动收敛 ──────────────────────────────────────────────

/// 迁移核心：把会误导 pi 的目录禁用条目重写为能命中的形态，返回新数组。
/// None = 无可改写（幂等稳态）。规则：
/// - `!dir/**` glob 保留（已是正确形态）；
/// - `+条目` 与裸条目是包含语义，永不改写；
/// - `-<目录>` / `!<目录>` 精确条目：目录在 agent 目录下可被 pi 装载
///   （index.ts/js 或 pi manifest）→ 重写 `!<目录>/**`；同一目录已有 glob
///   覆盖 → 直接剔除旧条目；其余（文件、不存在的路径）原样保留。
///   pi 的 `-<path>` 精确排除只命中实际装载的入口文件（目录里还可能是
///   manifest 声明的嵌套文件如 `src/index.ts`），目录名永远命不中。
fn migrate_disable_entries(
    entries: &[Value],
    is_loadable_dir: impl Fn(&str) -> bool,
) -> Option<Vec<Value>> {
    use std::collections::HashSet;

    // 条目核心：去 override 前缀与 "./"，反斜杠归一 "/";绝对路径剥到
    // ".pi/agent/" 之后，统一变成 agent 目录的相对 posix 路径。
    let core = |s: &str| -> String {
        let mut c = s.trim_start_matches(['+', '-', '!']);
        if let Some(rest) = c.strip_prefix("./") {
            c = rest;
        }
        let c = c.replace('\\', "/");
        match c.find(".pi/agent/") {
            Some(i) => c[i + ".pi/agent/".len()..].to_string(),
            None => c,
        }
    };

    // 已有的 glob 禁用目标：core → format 是 !<dir>/**（去掉尾部 */）。
    let mut covered: HashSet<String> = entries
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| s.starts_with('!'))
        .map(|s| {
            core(s)
                .trim_end_matches(['*', '/'])
                .to_string()
        })
        .collect();

    let mut next: Vec<Value> = Vec::with_capacity(entries.len());
    let mut rewritten = 0usize;
    let mut dropped = 0usize;
    for e in entries {
        let Some(s) = e.as_str() else {
            next.push(e.clone());
            continue;
        };
        if s.starts_with('+') || !(s.starts_with('-') || s.starts_with('!')) {
            next.push(e.clone());
            continue;
        }
        let c = core(s);
        if c.is_empty() {
            next.push(e.clone());
            continue;
        }
        if covered.contains(&c) {
            // 同一目录已被 glob 覆盖（或自身重复），精确旧条目直接删。
            dropped += 1;
            continue;
        }
        if s.starts_with('-') && is_loadable_dir(&c) {
            covered.insert(c.clone());
            next.push(Value::String(format!("!{c}/**")));
            rewritten += 1;
            continue;
        }
        next.push(e.clone());
    }
    let unchanged = rewritten == 0 && dropped == 0;
    if unchanged {
        return None;
    }
    Some(next)
}

/// 启动时调用（pi 网关 spawn 前）：把 settings.json `extensions` 里历史版本
/// 写出的无效目录禁用条目收敛成 `!<dir>/**`。幂等，稳态无写入不打日志。
pub fn migrate_extension_disable_patterns() {
    let _guard = crate::config::config_write_lock();
    let mut settings = crate::config::read_pi_settings();
    let Some(arr) = settings.get("extensions").and_then(Value::as_array).cloned() else {
        return;
    };
    let agent_dir = crate::paths::pi_agent_dir();
    let migrated = migrate_disable_entries(&arr, |rel| {
        let dir = agent_dir.join(rel);
        dir.is_dir()
            && (dir.join("index.ts").is_file()
                || dir.join("index.js").is_file()
                || std::fs::read_to_string(dir.join("package.json"))
                    .ok()
                    .and_then(|p| serde_json::from_str::<Value>(&p).ok())
                    .is_some_and(|v| v.get("pi").and_then(|p| p.get("extensions")).is_some()))
    });
    let Some(next) = migrated else { return };
    if let Some(obj) = settings.as_object_mut() {
        obj.insert(
            "extensions".to_string(),
            Value::Array(next),
        );
        crate::config::write_pi_settings(&settings);
        eprintln!("[Helix] 已把无效的目录禁用模式收敛为 !<目录>/**（pi 要求精确命中入口文件）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(items: &[&str]) -> Vec<Value> {
        items
            .iter()
            .map(|s| Value::String((*s).to_string()))
            .collect()
    }

    fn s(items: &[Value]) -> Vec<String> {
        items
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    const LOADABLE: &[&str] = &["extensions/btw"];

    #[test]
    fn exact_dir_disable_rewrites_to_glob() {
        let items = j(&["-extensions/btw", "-extensions/foo.ts", "!extensions/pi-cron/**"]);
        let out = migrate_disable_entries(&items, |c| LOADABLE.contains(&c)).unwrap();
        // 可装载目录重写为 glob；已有 glob 与文件目标原样保留。
        assert_eq!(
            s(&out),
            ["!extensions/btw/**", "-extensions/foo.ts", "!extensions/pi-cron/**"]
        );
    }

    #[test]
    fn existing_glob_dedupes_exact_dir_entries() {
        let items = j(&["!extensions/btw/**", "-extensions/btw"]);
        let out = migrate_disable_entries(&items, |c| LOADABLE.contains(&c)).unwrap();
        assert_eq!(s(&out), ["!extensions/btw/**"]);
    }

    #[test]
    fn nothing_to_migrate_is_stable() {
        // 已是 glob / 文件目标 / 不可装载目录 / 包含条目 / 空路径 → 不动。
        let items = j(&[
            "!extensions/btw/**",
            "-extensions/foo.ts",
            "-extensions/not-local",
            "+extensions/keep.ts",
            "extensions/plain-entry",
            "-extensions/btw/**",
        ]);
        let out = migrate_disable_entries(&items, |c| LOADABLE.contains(&c));
        assert!(out.is_none());
    }

    #[test]
    fn absolute_agent_dir_paths_normalize() {
        // 裸条目是显式包含，即便指向可装载目录也不能改写成排除。
        let bare = j(&["C:\\Users\\x\\.pi\\agent\\extensions\\btw"]);
        assert!(migrate_disable_entries(&bare, |c| LOADABLE.contains(&c)).is_none());
        // 带排除前缀的绝对写法才参与迁移。
        let excluded = j(&["-C:\\Users\\x\\.pi\\agent\\extensions\\btw"]);
        let out = migrate_disable_entries(&excluded, |c| LOADABLE.contains(&c)).unwrap();
        assert_eq!(s(&out), ["!extensions/btw/**"]);
    }

    #[test]
    fn npm_and_node_modules_entries_are_rivals() {
        assert!(is_rival_entry("npm:pi-aux-vision"));
        assert!(is_rival_entry("C:\\Users\\x\\.pi\\agent\\npm\\node_modules\\pi-aux-vision"));
    }

    #[test]
    fn own_dir_entries_recognize_both_write_forms() {
        assert!(is_own_dir_entry("extensions\\pi-aux-vision"));
        assert!(is_own_dir_entry("extensions/pi-aux-vision"));
        assert!(is_own_dir_entry(&canonical_entry()));
        assert!(is_own_dir_entry("extensions/pi-aux-vision/"));
        assert!(is_own_dir_entry(
            "C:\\Users\\x\\.pi\\agent\\extensions\\pi-aux-vision"
        ));
        assert!(!is_own_dir_entry("npm:pi-aux-vision"));
    }

    #[test]
    fn canonical_entry_matches_platform_separator() {
        if cfg!(windows) {
            assert_eq!(canonical_entry(), "extensions\\pi-aux-vision");
        } else {
            assert_eq!(canonical_entry(), "extensions/pi-aux-vision");
        }
    }

    #[test]
    fn unrelated_entries_survive() {
        assert!(!is_rival_entry("npm:pi-hermes-memory"));
        assert!(!is_rival_entry("extensions\\pi-helix-browser"));
        assert!(!is_rival_entry("npm:pi-aux-vision-plus"));
    }

    #[test]
    fn legacy_browser_entries_recognized_in_all_forms() {
        assert!(is_legacy_browser_entry("extensions\\pi-helix-browser"));
        assert!(is_legacy_browser_entry("extensions/pi-helix-browser"));
        assert!(is_legacy_browser_entry("extensions/pi-helix-browser/"));
        assert!(is_legacy_browser_entry("npm:pi-helix-browser"));
        assert!(is_legacy_browser_entry(
            "C:\\Users\\x\\.pi\\agent\\extensions\\pi-helix-browser"
        ));
        // 名字相近的无关扩展不能被误删。
        assert!(!is_legacy_browser_entry("extensions\\pi-helix-browser-plus"));
        assert!(!is_legacy_browser_entry("extensions\\pi-aux-vision"));
        assert!(!is_legacy_browser_entry("npm:pi-hermes-memory"));
    }

    #[test]
    fn browser_extension_lives_outside_pi_discovery() {
        let path = browser_extension_path();
        // 不能落在 pi 的 extensions/ 扫描目录下——否则 pi 会自动加载，
        // 终端里的 `pi` 也就能看到这些工具（用户要求只有 Helix 会话有）。
        assert!(
            !path.components().any(|c| c.as_os_str() == "extensions"),
            "内置扩展不能落在 pi 的发现路径下: {}",
            path.display()
        );
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some(BROWSER_EXT_FILE_NAME)
        );
    }

    #[test]
    fn aux_vision_disabled_detects_glob_exclusion() {
        let settings = serde_json::json!({ "extensions": ["!extensions/pi-aux-vision/**"] });
        assert!(is_aux_vision_disabled(&settings));
    }

    #[test]
    fn aux_vision_disabled_detects_exact_exclusion() {
        let settings = serde_json::json!({ "extensions": ["-extensions/pi-aux-vision"] });
        assert!(is_aux_vision_disabled(&settings));
    }

    #[test]
    fn aux_vision_disabled_force_include_wins() {
        // `+` 强制启用优先于更早的 `!`/`-`。
        let settings =
            serde_json::json!({ "extensions": ["!extensions/pi-aux-vision/**", "+extensions/pi-aux-vision"] });
        assert!(!is_aux_vision_disabled(&settings));
    }

    #[test]
    fn aux_vision_disabled_not_affected_by_other_entries() {
        let settings = serde_json::json!({ "extensions": ["!extensions/btw/**", "-extensions/foo.ts"] });
        assert!(!is_aux_vision_disabled(&settings));
    }

    #[test]
    fn aux_vision_disabled_empty_extensions_is_enabled() {
        let settings = serde_json::json!({ "extensions": [] });
        assert!(!is_aux_vision_disabled(&settings));
    }
}
