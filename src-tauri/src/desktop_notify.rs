//! 系统通知（Windows toast）：只在没有 Helix 窗口处于前台时弹。
//!
//! 单点拥有「何时弹」这条事实，调用方只管给标题和正文。触发场景：
//!   - 审批 / 澄清弹窗到达（pi_gateway 的 extension_ui_request 各分支）
//!   - 回合结束 / 出错（pi_gateway 的 agent_settled）
//!   - 定时任务派发（scheduled_tasks 的 dispatch_scheduled_task）
//!
//! 尽力而为：任何失败都被吞掉 —— 弹不出的 toast 绝不允许影响事件主链路。

use tauri::Manager;

/// 无任何 Helix 窗口在前台时弹系统通知；有前台窗口则静默跳过。
///
/// 「前台」按全部 webview 窗口算（主窗 + 内置浏览器子窗），任一聚焦即视为
/// 用户正看着 Helix。窗口最小化 / 隐藏到托盘时 is_focused 为 false → 照弹。
pub fn notify_unfocused(title: &str, body: &str) {
    let Some(app) = crate::state::APP_HANDLE.get() else {
        return;
    };
    let any_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if any_focused {
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
