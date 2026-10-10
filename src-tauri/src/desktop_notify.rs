//! 系统通知（Windows toast）。
//!
//! 「弹不弹」由两处决定：用户在 设置 → 常规 → 通知 里定的场景开关，加上窗口
//! 是否在前台。调用方只声明场景、标题、正文，不自己判断时机。
//!
//! 开关的真相在 config.yaml 的 `notifications:` 块（Helix 自有配置，不像审批
//! 档位那样要迁就第三方扩展），每次弹之前现读 —— 改完即生效，不用重启。
//!
//!   - Scene::Approval / Scene::Clarify —— 审批、澄清弹窗到达
//!     （pi_gateway 的 extension_ui_request 各分支）
//!   - Scene::TurnEnd —— 回合结束 / 出错（pi_gateway 的 agent_settled）、
//!     定时任务与渠道签到派发（scheduled_tasks）
//!
//! 尽力而为：任何失败都被吞掉 —— 弹不出的 toast 绝不允许影响事件主链路。

use serde_json::{json, Value};
use tauri::Manager;

/// 一次通知属于哪个场景，对应设置页「通知」里的一个开关。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scene {
    /// 一轮结束：完成、出错，以及定时任务派发结果。
    TurnEnd,
    /// 需要用户授权才能继续。
    Approval,
    /// 在等用户回答问题。
    Clarify,
}

/// 「轮次完成通知」的三档。默认 `Unfocused`，与本模块改造前的行为一致。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TurnEndMode {
    Never,
    Unfocused,
    Always,
}

impl TurnEndMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::Unfocused => "unfocused",
            Self::Always => "always",
        }
    }

    /// 严格解析：未知值返回 None，供写入侧拒绝。
    pub fn parse_exact(s: &str) -> Option<Self> {
        match s {
            "never" => Some(Self::Never),
            "unfocused" => Some(Self::Unfocused),
            "always" => Some(Self::Always),
            _ => None,
        }
    }
}

/// 设置页里那三个开关的当前值。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Prefs {
    pub turn_end: TurnEndMode,
    pub approval: bool,
    pub clarify: bool,
}

impl Prefs {
    /// 该场景此刻该不该弹。`focused` = 有任一 Helix 窗口在前台。
    fn allows(self, scene: Scene, focused: bool) -> bool {
        match scene {
            Scene::TurnEnd => match self.turn_end {
                TurnEndMode::Never => false,
                TurnEndMode::Unfocused => !focused,
                TurnEndMode::Always => true,
            },
            // 审批 / 等待回答只在人不在前台时提醒：卡片本身已经摆在界面上，
            // 前台再弹一条 toast 只是重复噪音。
            Scene::Approval => self.approval && !focused,
            Scene::Clarify => self.clarify && !focused,
        }
    }
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            turn_end: TurnEndMode::Unfocused,
            approval: true,
            clarify: true,
        }
    }
}

/// 现读 config.yaml 的 `notifications:` 块。读不到 / 值不认识一律回落默认，
/// 一个写坏的配置文件不该让通知链路报错。
pub fn prefs() -> Prefs {
    let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).unwrap_or_default();
    let block = crate::config::read_yaml_block(&yaml, "notifications");
    let d = Prefs::default();
    Prefs {
        turn_end: block
            .get("turn_end")
            .and_then(Value::as_str)
            .and_then(TurnEndMode::parse_exact)
            .unwrap_or(d.turn_end),
        approval: read_bool(&block, "approval", d.approval),
        clarify: read_bool(&block, "clarify", d.clarify),
    }
}

fn read_bool(block: &serde_json::Map<String, Value>, key: &str, default: bool) -> bool {
    match block.get(key).and_then(Value::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

/// 按场景弹系统通知；开关关掉或不满足前台条件时静默跳过。
pub fn notify(scene: Scene, title: &str, body: &str) {
    let Some(app) = crate::state::APP_HANDLE.get() else {
        return;
    };
    // 「前台」按全部 webview 窗口算（主窗 + 内置浏览器子窗），任一聚焦即视为
    // 用户正看着 Helix。窗口最小化 / 隐藏到托盘时 is_focused 为 false → 照弹。
    let focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if !prefs().allows(scene, focused) {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(clip(title, 40))
        .body(clip(body, 180))
        .show();
}

/// 按字符截断（不会砍出半个 UTF-8 字符），超长补省略号。
fn clip(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn config_json(p: Prefs) -> Value {
    json!({
        "ok": true,
        "turnEndMode": p.turn_end.as_str(),
        "approvalEnabled": p.approval,
        "clarifyEnabled": p.clarify,
        "configPath": crate::config::config_yaml_path().to_string_lossy(),
    })
}

/// 读通知偏好（设置页回显用；真相是 config.yaml，不是前端 state）。
#[tauri::command]
pub fn helix_notification_config() -> Value {
    config_json(prefs())
}

/// 写通知偏好。前端键名 → yaml 子键：turnEndMode→turn_end、
/// approvalEnabled→approval、clarifyEnabled→clarify。先全部校验再动文件，
/// 一半写进去、一半被拒是最坏结果。返回值里的三个字段是**回读到的生效值**
/// （写失败时 UI 因此不会撒谎）。
#[tauri::command]
pub fn helix_set_notification_config(updates: Value) -> Value {
    let Some(obj) = updates.as_object() else {
        return json!({ "ok": false, "error": "updates 必须是对象" });
    };
    let mut pending: Vec<(&str, Value)> = Vec::new();
    if let Some(v) = obj.get("turnEndMode") {
        let Some(raw) = v.as_str().and_then(TurnEndMode::parse_exact) else {
            return json!({ "ok": false, "error": format!("未知的轮次完成通知档位: {v}") });
        };
        pending.push(("turn_end", json!(raw.as_str())));
    }
    for (front_key, yaml_key) in [
        ("approvalEnabled", "approval"),
        ("clarifyEnabled", "clarify"),
    ] {
        if let Some(v) = obj.get(front_key) {
            let Some(b) = v.as_bool() else {
                return json!({ "ok": false, "error": format!("{front_key} 必须是布尔") });
            };
            pending.push((yaml_key, json!(b)));
        }
    }

    let path = crate::config::config_yaml_path();
    if !pending.is_empty() {
        let mut yaml = std::fs::read_to_string(&path).unwrap_or_default();
        for (k, v) in &pending {
            yaml = crate::config::set_yaml_key(&yaml, &format!("notifications.{k}"), v);
        }
        if let Err(e) = crate::config::atomic_write(&path, &yaml) {
            return json!({ "ok": false, "error": e.to_string(), "configPath": path.to_string_lossy() });
        }
    }
    let mut out = config_json(prefs());
    out["changed"] = json!(pending.iter().map(|(k, _)| *k).collect::<Vec<_>>());
    out
}

/// 打开系统的通知设置页。Windows 走 ms-settings URI；其它系统没有可跳转的
/// 通知面板，明说而不是默默开一个无关的窗口。
#[tauri::command]
pub fn helix_open_notification_settings() -> Value {
    #[cfg(windows)]
    let target = "ms-settings:notifications";
    #[cfg(target_os = "macos")]
    let target = "x-apple.systempreferences:com.apple.preference.notifications";
    #[cfg(not(any(windows, target_os = "macos")))]
    let target = "";

    if target.is_empty() {
        return json!({ "ok": false, "error": "当前系统没有可跳转的通知设置页" });
    }
    match tauri_plugin_opener::open_url(target, None::<&str>) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_end_modes_respect_focus() {
        for (mode, focused, want) in [
            (TurnEndMode::Never, false, false),
            (TurnEndMode::Never, true, false),
            (TurnEndMode::Unfocused, false, true),
            (TurnEndMode::Unfocused, true, false),
            (TurnEndMode::Always, false, true),
            (TurnEndMode::Always, true, true),
        ] {
            let p = Prefs {
                turn_end: mode,
                ..Prefs::default()
            };
            assert_eq!(
                p.allows(Scene::TurnEnd, focused),
                want,
                "{mode:?} focused={focused}"
            );
        }
    }

    #[test]
    fn approval_and_clarify_are_gated_by_switch_and_focus() {
        let off = Prefs {
            approval: false,
            clarify: false,
            ..Prefs::default()
        };
        assert!(!off.allows(Scene::Approval, false));
        assert!(!off.allows(Scene::Clarify, false));
        let on = Prefs::default();
        assert!(on.allows(Scene::Approval, false));
        assert!(!on.allows(Scene::Approval, true));
    }

    #[test]
    fn unknown_config_values_fall_back_to_defaults() {
        let yaml = "notifications:\n  turn_end: sometimes\n  approval: maybe\n";
        let block = crate::config::read_yaml_block(yaml, "notifications");
        assert_eq!(
            block
                .get("turn_end")
                .and_then(Value::as_str)
                .and_then(TurnEndMode::parse_exact),
            None
        );
        assert_eq!(read_bool(&block, "approval", true), true);
        assert_eq!(read_bool(&block, "missing", false), false);
    }

    #[test]
    fn written_keys_round_trip_through_the_yaml_reader() {
        let mut yaml = String::new();
        yaml = crate::config::set_yaml_key(&yaml, "notifications.turn_end", &json!("always"));
        yaml = crate::config::set_yaml_key(&yaml, "notifications.approval", &json!(false));
        let block = crate::config::read_yaml_block(&yaml, "notifications");
        assert_eq!(
            block.get("turn_end").and_then(Value::as_str),
            Some("always")
        );
        assert_eq!(read_bool(&block, "approval", true), false);
    }

    /// 对着**真** config.yaml 验一遍写入（只在内存里改，不落盘）：现网文件里
    /// 块很多，追加的 `notifications:` 必须只多出那几行，别的块一个字节不动。
    #[test]
    fn appending_the_block_leaves_the_live_config_otherwise_untouched() {
        let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).unwrap_or_default();
        let mut out = yaml.clone();
        for (k, v) in [
            ("turn_end", json!("always")),
            ("approval", json!(false)),
            ("clarify", json!(true)),
        ] {
            out = crate::config::set_yaml_key(&out, &format!("notifications.{k}"), &v);
        }
        let added = out.lines().count() - yaml.lines().count();
        let had_block = yaml.lines().any(|l| l.starts_with("notifications:"));
        if had_block {
            assert_eq!(added, 0, "已有块时不应加行");
        } else {
            // 4 = 1 行父键 + 3 行子键。以换行结尾的文件会再多 1 行：
            // norm_lines 的 split('\n') 保留尾部空串，顶插 push 把它
            // join 回成块前的空行（无害，也更可读），故 4/5 都合法。
            assert!(
                added == 4 || added == 5,
                "应只追加 1 行父键 + 3 行子键（文件尾换行时允许 +1 空行），实得 {added}"
            );
            if added == 5 {
                let lines: Vec<&str> = out.lines().collect();
                let idx = lines
                    .iter()
                    .position(|l| *l == "notifications:")
                    .expect("追加后必须有 notifications:");
                assert!(idx > 0 && lines[idx - 1].is_empty(), "多出的应是块前空行");
            }
        }
        let block = crate::config::read_yaml_block(&out, "notifications");
        assert_eq!(
            block.get("turn_end").and_then(Value::as_str),
            Some("always")
        );
        assert_eq!(read_bool(&block, "approval", true), false);
        assert_eq!(read_bool(&block, "clarify", false), true);
        // 原文件的每个顶层键都还在（没被追加的块吃掉）。
        for l in yaml.lines() {
            if !l.starts_with(' ') && !l.starts_with('#') && l.contains(':') {
                let top = l.split(':').next().unwrap();
                assert!(
                    out
                        .lines()
                        .any(|o| !o.starts_with(' ') && o.split(':').next() == Some(top)),
                    "顶层键 {top} 在写入后消失了"
                );
            }
        }
    }
}
