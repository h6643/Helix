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
//!   - Scene::Handoff —— Agent 把侧栏浏览器页交给人工登录/验证
//!     （前端 browser-automation 经 `helix_notify_scene` 报上来；这条事件只有
//!     前端知道，pi 网关看不见）
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
    /// 在等用户在侧栏浏览器上人工登录/过验证码。
    Handoff,
}

impl Scene {
    /// 严格解析：前端传来的场景字符串只认下面四个（与 config.yaml 的子键同名），
    /// 未知值返回 None。
    pub fn parse_exact(s: &str) -> Option<Self> {
        match s {
            "turn_end" => Some(Self::TurnEnd),
            "approval" => Some(Self::Approval),
            "clarify" => Some(Self::Clarify),
            "handoff" => Some(Self::Handoff),
            _ => None,
        }
    }
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

/// 设置页里那四个开关的当前值。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Prefs {
    pub turn_end: TurnEndMode,
    pub approval: bool,
    pub clarify: bool,
    pub handoff: bool,
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
            // 审批 / 等待回答 / 人工接管只在人不在前台时提醒：卡片或横幅本身已经
            // 摆在界面上，前台再弹一条 toast 只是重复噪音。
            Scene::Approval => self.approval && !focused,
            Scene::Clarify => self.clarify && !focused,
            Scene::Handoff => self.handoff && !focused,
        }
    }
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            turn_end: TurnEndMode::Unfocused,
            approval: true,
            clarify: true,
            handoff: true,
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
        handoff: read_bool(&block, "handoff", d.handoff),
    }
}

fn read_bool(block: &serde_json::Map<String, Value>, key: &str, default: bool) -> bool {
    match block.get(key).and_then(Value::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

/// 用户此刻是不是「正看着 Helix」：可见 + 未最小化 + 拿到焦点，三者同时成立。
///
/// 为什么不只信 `is_focused`：最小化和隐藏到托盘是「人走了」的两种主要形态，
/// 而焦点查询偶尔会把焦点仍记在刚收起的窗口上（尤其是托盘 hide 之后），那样
/// 两条路径下通知会被当成前台噪音丢掉。三条都要，宁可多弹不误关。
///
/// 第二个返回值是逐窗口原始状态位（`main[f=1,v=1,min=0] …`），只为诊断存在：
/// 门判成前台、人却说自己不在时，只有这三位能指出是哪一位在撒谎（例如 hide
/// 到托盘之后 `is_visible` 仍返回 true）。
fn in_foreground(app: &tauri::AppHandle) -> (bool, String) {
    let mut foreground = false;
    let mut trace = String::new();
    for (label, w) in app.webview_windows() {
        let focused = w.is_focused().unwrap_or(false);
        let visible = w.is_visible().unwrap_or(false);
        let minimized = w.is_minimized().unwrap_or(false);
        if !trace.is_empty() {
            trace.push(' ');
        }
        trace.push_str(&format!(
            "{label}[f={},v={},min={}]",
            focused as u8, visible as u8, minimized as u8
        ));
        foreground |= focused && visible && !minimized;
    }
    (foreground, trace)
}

/// 按场景弹系统通知；开关关掉或用户正在前台时静默跳过。
///
/// 每个决定都落一行 `helix-recover.log`：不弹（连原因和当时的生效偏好一起）和
/// 弹了但系统失败（连错误体）原本是同一种「什么都没发生」，没有这行日志就再也
/// 分不开。日志本身失败照旧吞掉——通知链路绝不允许影响事件主链路。
pub fn notify(scene: Scene, title: &str, body: &str) {
    let Some(app) = crate::state::APP_HANDLE.get() else {
        crate::pi_gateway::log_spawn_diag(&format!(
            "notify scene={scene:?} skipped=no_app_handle"
        ));
        return;
    };
    let (foreground, windows) = in_foreground(app);
    let p = prefs();
    if !p.allows(scene, foreground) {
        crate::pi_gateway::log_spawn_diag(&format!(
            "notify scene={scene:?} skipped=gate foreground={foreground} windows={windows} turn_end={} approval={} clarify={} handoff={}",
            p.turn_end.as_str(),
            p.approval,
            p.clarify,
            p.handoff,
        ));
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let shown = app
        .notification()
        .builder()
        .title(clip(title, 40))
        .body(clip(body, 180))
        .show();
    match shown {
        Ok(()) => crate::pi_gateway::log_spawn_diag(&format!(
            "notify scene={scene:?} foreground={foreground} windows={windows} show=ok title=\"{title}\""
        )),
        Err(e) => crate::pi_gateway::log_spawn_diag(&format!(
            "notify scene={scene:?} windows={windows} show=err {e:?}"
        )),
    }
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
        "handoffEnabled": p.handoff,
        "configPath": crate::config::config_yaml_path().to_string_lossy(),
    })
}

/// 读通知偏好（设置页回显用；真相是 config.yaml，不是前端 state）。
#[tauri::command]
pub fn helix_notification_config() -> Value {
    config_json(prefs())
}

/// 写通知偏好。前端键名 → yaml 子键：turnEndMode→turn_end、
/// approvalEnabled→approval、clarifyEnabled→clarify、handoffEnabled→handoff。
/// 先全部校验再动文件，一半写进去、一半被拒是最坏结果。返回值里的四个字段是
/// **回读到的生效值**（写失败时 UI 因此不会撒谎）。
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
        ("handoffEnabled", "handoff"),
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
        let _guard = crate::config::config_write_lock();
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

/// 前端报上来的一条通知（目前只有「人工接管」用得到：那条横幅只有界面知道，
/// pi 网关看不见）。要不要弹仍然只由本模块的门决定 —— 调用方声明场景与文案，
/// 不自判时机，所以前台噪音规则不会在各处界面代码里长歪。
/// 做成 async：与网关那几个调用点保持同一条线程形态，窗口状态查询与 toast 都不
/// 落在主线程上（碰窗口的那条老规矩）。
#[tauri::command]
pub async fn helix_notify_scene(scene: String, title: String, body: String) -> Value {
    let Some(parsed) = Scene::parse_exact(&scene) else {
        return json!({ "ok": false, "error": format!("未知的通知场景: {scene}") });
    };
    notify(parsed, &title, &body);
    json!({ "ok": true })
}

/// dev 下 toast 实际带出去的身份：`tauri-plugin-notification` 不设 app_id 时，
/// notify-rust 兜底用的就是这个 AUMID（`tauri-winrt-notification` 的
/// `Toast::POWERSHELL_APP_ID`，逐字抄来）。注册表里它以反斜杠分段，落在
/// `Notifications\Settings\` 下面。
const POWERSHELL_AUMID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/// 这条 toast 会以谁的身份出现 —— 判断必须和插件里那段 `show()` 一字不差地同构：
/// 它在 exe 目录以 `\target\debug` / `\target\release` 结尾时**不设** app_id。
/// 所以 dev 下去查 `com.helix.desktop` 的开关是查一个根本没用上的身份，答案必然
/// 对不上；这里跟着插件走，界面才能说真话。大小写也照插件：它用的是大小写敏感的
/// `ends_with`。
fn toast_aumid(exe_dir: &str, identifier: &str) -> String {
    if exe_dir.ends_with("\\target\\debug") || exe_dir.ends_with("\\target\\release") {
        POWERSHELL_AUMID.to_string()
    } else {
        identifier.to_string()
    }
}

/// 读 HKCU 下的一个 DWORD。键或值不存在都返回 None —— Windows 只在用户**手动**
/// 关掉时才写这个值，所以「查不到」的正确解释是「没人关过」，不是出错。
#[cfg(windows)]
fn hkcu_dword(subkey: &str, value: &str) -> Option<u32> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, RRF_RT_DWORD,
    };

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let sub = wide(subkey);
    let val = wide(value);
    let mut buf: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            PCWSTR(val.as_ptr()),
            RRF_RT_DWORD,
            None,
            Some(&mut buf as *mut u32 as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    status.is_ok().then_some(buf)
}

#[cfg(not(windows))]
fn hkcu_dword(_subkey: &str, _value: &str) -> Option<u32> {
    None
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

/// 系统侧到底让不让弹。界面拿它回答「日志写着 show=ok，我怎么没看见」：
/// - `PushNotifications\ToastEnabled = 0` —— 系统的 toast 总闸被关了；
/// - `Notifications\Settings\<AUMID>\Enabled = 0` —— 这一**个身份**被关了。
/// 两处都缺省为开。`aumid` 一并回给界面，好让 dev 下把「查的是 PowerShell」这件事
/// 说明白，而不是拿一个 Helix 的名字去冒充系统里的那一项。
#[tauri::command]
pub fn helix_notification_status(app: tauri::AppHandle) -> Value {
    let exe_dir = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()))
        .unwrap_or_default();
    let aumid = toast_aumid(&exe_dir, &app.config().identifier);
    let read = |subkey: &str, value: &str| match hkcu_dword(subkey, value) {
        Some(v) => json!(v != 0),
        None => Value::Null,
    };
    json!({
        "ok": true,
        "aumid": aumid,
        "dev": aumid == POWERSHELL_AUMID,
        "systemEnabled": read(
            r"Software\Microsoft\Windows\CurrentVersion\PushNotifications",
            "ToastEnabled",
        ),
        "appEnabled": read(
            &format!(
                r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{aumid}"
            ),
            "Enabled",
        ),
    })
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
    fn approval_clarify_and_handoff_are_gated_by_switch_and_focus() {
        let off = Prefs {
            approval: false,
            clarify: false,
            handoff: false,
            ..Prefs::default()
        };
        assert!(!off.allows(Scene::Approval, false));
        assert!(!off.allows(Scene::Clarify, false));
        assert!(!off.allows(Scene::Handoff, false));
        let on = Prefs::default();
        assert!(on.allows(Scene::Approval, false));
        assert!(!on.allows(Scene::Approval, true));
        // 人工接管同样只在不前台时弹：横幅已经挂在侧栏上，前台再弹一条是重复噪音。
        assert!(on.allows(Scene::Handoff, false));
        assert!(!on.allows(Scene::Handoff, true));
    }

    #[test]
    fn scene_names_round_trip_and_unknowns_are_rejected() {
        for (raw, want) in [
            ("turn_end", Scene::TurnEnd),
            ("approval", Scene::Approval),
            ("clarify", Scene::Clarify),
            ("handoff", Scene::Handoff),
        ] {
            assert_eq!(Scene::parse_exact(raw), Some(want));
        }
        // 前端只能报这四个名字：拼错或报来别的东西一律拒绝，而不是悄悄落到某个
        // 默认场景上 —— 那会让「哪个开关管着这条 toast」变得说不清。
        for bad in ["", "Handoff", "hand off", "browser_handoff", "approval\n"] {
            assert_eq!(Scene::parse_exact(bad), None, "{bad:?}");
        }
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

    #[test]
    fn dev_builds_report_the_powershell_identity_and_installed_ones_their_own() {
        // 必须跟 tauri-plugin-notification 那段 ends_with 判断同构：查错身份的开关
        // 比不查更糟 —— 界面会拿一个干净的答案替一个根本没用的身份背书。
        assert_eq!(
            toast_aumid(r"D:\Project\Helix\src-tauri\target\debug", "com.helix.desktop"),
            POWERSHELL_AUMID
        );
        assert_eq!(
            toast_aumid(r"D:\Project\Helix\src-tauri\target\release", "com.helix.desktop"),
            POWERSHELL_AUMID
        );
        assert_eq!(
            toast_aumid(r"C:\Program Files\Helix", "com.helix.desktop"),
            "com.helix.desktop"
        );
        // 插件用的是大小写敏感的 ends_with，这里跟着一起敏感。
        assert_eq!(
            toast_aumid(r"D:\Project\Helix\Target\Debug", "com.helix.desktop"),
            "com.helix.desktop"
        );
    }
}
