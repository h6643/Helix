//! HTTP 代理 — 模型、MCP、命令工具与应用渲染层的出口流量经此代理。
//!
//! 设置持久化在 `<hermes_data_dir>/proxy.json`（`{"url": "http://…"}`）。
//! 留空 = 直连，不读取系统环境变量。
//!
//! 生效路径（修改后需重启应用）：
//! - 网关子进程：`gateway::build_hermes_env` 启动时读代理文件，注入
//!   `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（覆盖 python httpx、MCP、命令工具
//!   的出口流量）。
//! - 渲染层：`apply_webview_proxy`（仅 Linux WebKitGTK）把代理设到默认
//!   WebContext 的 WebsiteDataManager；留空时设 `NoProxy` 确保不读系统 env。

use crate::paths::hermes_data_dir;
use serde_json::{json, Value};
use std::path::PathBuf;

pub const PROXY_FILE: &str = "proxy.json";

fn proxy_path() -> PathBuf {
    hermes_data_dir().join(PROXY_FILE)
}

/// 当前配置的代理 URL（trim 后）。留空 / 文件不存在 → ""（直连）。
pub fn load_proxy_url() -> String {
    let Ok(content) = std::fs::read_to_string(proxy_path()) else {
        return String::new();
    };
    serde_json::from_str::<Value>(&content)
        .ok()
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::trim).map(String::from))
        .unwrap_or_default()
}

/// 保存代理 URL（空 = 清除）。写 `<hermes_data_dir>/proxy.json`。
fn save_proxy_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if !trimmed.is_empty() && !trimmed.contains("://") {
        return Err("代理地址需包含协议（例如 http://127.0.0.1:7890）".into());
    }
    let path = proxy_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&path, json!({ "url": trimmed }).to_string())
        .map_err(|e| format!("写入代理配置失败: {e}"))
}

/// 渲染层（WebKitGTK 主窗口）代理。仅 Linux 生效；Windows/macOS 的 WebView2 /
/// WKWebView 无对应 API，渲染层出口流量不走此代理（模型/工具等其余层不受影响）。
pub fn apply_webview_proxy() {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{NetworkProxyMode, NetworkProxySettings, WebContext, WebContextExt, WebsiteDataManagerExt};
        let url = load_proxy_url();
        let Some(context) = WebContext::default() else {
            return;
        };
        let Some(manager) = context.website_data_manager() else {
            return;
        };
        if url.is_empty() {
            // 留空 = 直连：显式 NoProxy，不读取系统环境变量。
            manager.set_network_proxy_settings(NetworkProxyMode::NoProxy, None);
        } else {
            // 本地回环绕过，保证 dev server / 本地 MCP 不受影响。
            let mut settings = NetworkProxySettings::new(Some(&url), &["localhost", "127.0.0.1", "[::1]"]);
            manager.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut settings));
        }
    }
}

/// 设置面板读取当前代理配置。
#[tauri::command]
pub fn proxy_get() -> Value {
    json!({ "url": load_proxy_url() })
}

/// 设置面板保存代理配置（重启应用后生效）。
#[tauri::command]
pub fn proxy_set(url: String) -> Result<Value, String> {
    save_proxy_url(&url)?;
    Ok(json!({ "success": true, "url": url.trim().to_string() }))
}
