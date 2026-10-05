//! Helix 自带的 pi 扩展安装器：把随仓库编译的扩展写出到 `~/.pi/agent/extensions/`
//! 并在 pi 的 `settings.json` 里单点登记。
//!
//! 为什么需要：`describe_image`（视觉读图工具）来自第三方 `pi-aux-vision`，但 Helix
//! 改过它的配置来源（读 `config.yaml` 的 `vision:` 块，见 vendor/pi-aux-vision/index.ts
//! 头部说明）。装在 npm 里的副本会被 `pi update` / 重装静默还原成上游行为，
//! 所以仓库里的 `src-tauri/vendor/pi-aux-vision/` 才是唯一权威副本，每次启动覆盖写出。
//!
//! 登记必须唯一：npm 版和目录版都注册同名工具 `describe_image`，两份同时被 pi 加载
//! 会重名冲突，因此写文件之外还要把 `packages` 里指向 pi-aux-vision 的**其他**条目清掉。

use serde_json::Value;
use std::path::Path;

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
}
