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
const AUX_VISION_FILES: [(&str, &str); 8] = [
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
    ("footer.ts", include_str!("../vendor/pi-aux-vision/footer.ts")),
    (
        "footer-controller.ts",
        include_str!("../vendor/pi-aux-vision/footer-controller.ts"),
    ),
    (
        "test-image.ts",
        include_str!("../vendor/pi-aux-vision/test-image.ts"),
    ),
    (
        "package.json",
        include_str!("../vendor/pi-aux-vision/package.json"),
    ),
    ("LICENSE", include_str!("../vendor/pi-aux-vision/LICENSE")),
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

/// `packages` 收敛成唯一登记：绝对写法的自身条目归一成规范写法，npm 版等竞争条目清掉。
fn register_in_settings() -> bool {
    let mut settings = read_pi_settings();
    let obj = match settings.as_object_mut() {
        Some(o) => o,
        None => return false,
    };

    let existing: Vec<String> = obj
        .get("packages")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let had_packages = obj.contains_key("packages");
    // 自身条目就地归一（保持原有顺序，稳态启动不会产生差异），其余竞争条目删除。
    let mut kept_own = false;
    let mut next: Vec<String> = Vec::new();
    for entry in &existing {
        if is_rival_entry(entry) {
            continue;
        }
        if is_own_dir_entry(entry) {
            if kept_own {
                continue;
            }
            kept_own = true;
            next.push(canonical_entry());
            continue;
        }
        next.push(entry.clone());
    }
    if !kept_own {
        next.push(canonical_entry());
    }

    // 只有真的增删过才落盘，避免每次启动刷新 settings.json 的 mtime。
    let unchanged = had_packages && next == existing;
    if unchanged {
        return false;
    }

    obj.insert(
        "packages".to_string(),
        Value::Array(next.into_iter().map(Value::String).collect()),
    );
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
fn unregister_legacy_browser_from_settings() -> bool {
    let mut settings = read_pi_settings();
    let obj = match settings.as_object_mut() {
        Some(o) => o,
        None => return false,
    };
    let existing: Vec<String> = obj
        .get("packages")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let next: Vec<String> = existing
        .iter()
        .filter(|e| !is_legacy_browser_entry(e))
        .cloned()
        .collect();
    if next == existing {
        return false;
    }
    if next.is_empty() {
        // 清空后移除键，恢复 pi 的"未安装任何包"默认形态。
        obj.remove("packages");
    } else {
        obj.insert(
            "packages".to_string(),
            Value::Array(next.into_iter().map(Value::String).collect()),
        );
    }
    write_pi_settings(&settings);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
