//! HTTP 代理 — 模型、MCP、命令工具与应用渲染层的出口流量经此代理。
//!
//! 设置持久化在 pi 全局 `<agent_dir>/settings.json` 的 `httpProxy` 键
//! （`"http://…"`，单一配置来源；pi 自身启动时也读这个键）。
//! 旧的 `<helix_data_dir>/proxy.json` 只在升级遗留读取上兜底。
//! 留空 = 直连，不读取系统环境变量。
//!
//! 生效路径（修改后需重启应用）：
//! - 渲染层 webview：`lib.rs` 启动时用 `builder.proxy_url(load_proxy_url())`
//!   注入（Windows WebView2 → `--proxy-server`，macOS WKWebView 同理）。
//!   Linux WebKitGTK 另走 `apply_webview_proxy` 的 WebsiteDataManager，
//!   留空时设 `NoProxy`。
//! - Rust 侧出口 HTTP：`proxy_aware_client()` / `proxy_aware_blocking_client()`
//!   （需要 build 前配 redirect / UA / timeout 时用 `*_builder()` 变体），供
//!   page_fetch / vision / 模型列表 / npm 检查 / 生图使用。留空 = 直连。
//!   **所有新出口调用必须走这里**，裸 `reqwest::Client::new()` 会绕过代理。
//! - pi 子进程：`pi_gateway` 启动时注入 `proxy_env_pairs()`（`HTTP_PROXY` /
//!   `HTTPS_PROXY` / `ALL_PROXY` + 小写别名 + `NO_PROXY` + `NODE_USE_ENV_PROXY=1`），
//!   覆盖 pi 内模型 / MCP / 命令工具流量。`NODE_USE_ENV_PROXY` 缺了的话
//!   Node 24 的全局 fetch（undici）不读 env 代理，等于没配。

use crate::paths::{helix_data_dir, pi_agent_dir};
use serde_json::{json, Value};
use std::path::PathBuf;

/// 旧版代理配置文件名（已并入 pi 全局 settings.json，仅为兼容旧配置保留读取）。
pub const PROXY_FILE: &str = "proxy.json";
/// 代理 URL 在 pi 全局 settings.json 里的键名（pi 自身启动时也读这个键）。
pub const PROXY_SETTINGS_KEY: &str = "httpProxy";

fn proxy_path() -> PathBuf {
    helix_data_dir().join(PROXY_FILE)
}

/// pi 的全局 settings.json —— 代理配置的单一来源。
fn pi_settings_path() -> PathBuf {
    pi_agent_dir().join("settings.json")
}

/// 从 JSON 对象里取代理 URL（只认非空字符串）。
fn url_from(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|u| u.as_str())
        .map(str::trim)
        .map(String::from)
        .unwrap_or_default()
}

/// 本地回环绕过列表：dev server / 本地 MCP / 本地 serve 网关不该走代理。
const NO_PROXY_STR: &str = "localhost, 127.0.0.1, ::1";

/// 当前配置的代理（留空配置 → `None`，即不挂代理、也不读系统 env）。
///
/// `Proxy::all` 同时覆盖 http/https；`IntoProxy` 认 `socks5://` 等 scheme，
/// 所以 SOCKS 代理也能填。地址非法 → `None`（退化为直连，不阻断启动）。
fn make_proxy() -> Option<reqwest::Proxy> {
    let url = load_proxy_url();
    if url.is_empty() {
        return None;
    }
    let mut p = reqwest::Proxy::all(url).ok()?;
    if let Some(np) = reqwest::NoProxy::from_string(NO_PROXY_STR) {
        p = p.no_proxy(Some(np));
    }
    Some(p)
}

/// 异步 client builder —— 出口 HTTP 调用从这里起步，而不是裸 `Client::builder()`。
/// 调用方仍可在 build 前继续配 redirect / UA / timeout。
pub fn proxy_aware_client_builder() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder();
    if let Some(p) = make_proxy() {
        builder = builder.proxy(p);
    }
    builder
}

/// 阻塞 client builder（spawn_blocking 线程里用）。
pub fn proxy_aware_blocking_client_builder() -> reqwest::blocking::ClientBuilder {
    let mut builder = reqwest::blocking::Client::builder();
    if let Some(p) = make_proxy() {
        builder = builder.proxy(p);
    }
    builder
}

/// 共享的"代理感知"client：代理读 `load_proxy_url()`，留空则不挂代理。
pub fn proxy_aware_client() -> Result<reqwest::Client, reqwest::Error> {
    proxy_aware_client_builder().build()
}

/// 阻塞版（spawn_blocking 线程里用）。
pub fn proxy_aware_blocking_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    proxy_aware_blocking_client_builder().build()
}

/// pi 子进程应注入的代理 env：覆盖 pi 内模型 / MCP / 命令工具 / npx 的出口流量。
///
/// `NODE_USE_ENV_PROXY=1` 是必需的 —— Node 24 的全局 fetch（undici）默认
/// **不读** `HTTP_PROXY` 等 env，没这个开关 pi 内的 fetch 全走直连。
/// `NO_PROXY` 保本地 MCP / 本地 serve 网关直连。留空配置返回空 Vec。
pub fn proxy_env_pairs() -> Vec<(String, String)> {
    let url = load_proxy_url();
    if url.is_empty() {
        return Vec::new();
    }
    let np = NO_PROXY_STR.to_string();
    [
        ("HTTP_PROXY", url.clone()),
        ("HTTPS_PROXY", url.clone()),
        ("ALL_PROXY", url.clone()),
        ("http_proxy", url.clone()),
        ("https_proxy", url.clone()),
        ("NO_PROXY", np.clone()),
        ("no_proxy", np),
        ("NODE_USE_ENV_PROXY", "1".to_string()),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.clone()))
    .collect()
}

/// 当前配置的代理 URL（trim 后）。留空 / 未配置 / 文件不存在 → ""（直连）。
///
/// 优先读 pi 全局 `settings.json` 的 `httpProxy`（唯一配置来源，pi 自身启动
/// 时也读它）；该文件存在却没配 → 直接判为未配置，**不再**回退旧文件，避免
/// 残留的 `proxy.json` 悄悄复活。文件缺失或 JSON 损坏时才回退
/// `<helix_data_dir>/proxy.json`（旧安装升级上来还没点过设置面板的情况）。
pub fn load_proxy_url() -> String {
    match std::fs::read_to_string(pi_settings_path()) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(v) => url_from(&v, PROXY_SETTINGS_KEY),
            Err(_) => {
                // 设置文件暂时写坏了：不阻断启动，落到旧文件再试。
                legacy_proxy_url()
            }
        },
        Err(_) => legacy_proxy_url(),
    }
}

/// 旧版读取路径：`<helix_data_dir>/proxy.json` 的 `{"url": ...}`。
fn legacy_proxy_url() -> String {
    let Ok(content) = std::fs::read_to_string(proxy_path()) else {
        return String::new();
    };
    serde_json::from_str::<Value>(&content)
        .ok()
        .map(|v| url_from(&v, "url"))
        .unwrap_or_default()
}

/// 保存代理 URL（空 = 清除）。读改写 pi 全局 `settings.json` 的 `httpProxy`，
/// 原样保留 pi 自己的其他键（pi 的 SettingsManager 写入时也是这个语义）；
/// 同时删掉遗留的 `<helix_data_dir>/proxy.json`，保证代理只有一份配置。
fn save_proxy_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if !trimmed.is_empty() && !trimmed.contains("://") {
        return Err("代理地址需包含协议（例如 http://127.0.0.1:7890）".into());
    }
    let path = pi_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    // 解析失败不能静默覆盖——settings.json 里还有 pi 的模型 / 包等配置。
    let mut settings = match std::fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => serde_json::from_str::<Value>(&content)
            .map_err(|e| format!("解析代理配置失败（{path:?}）: {e}"))?,
        _ => json!({}),
    };
    let obj = settings.as_object_mut().ok_or_else(|| {
        format!("代理配置不是 JSON 对象（{path:?}）")
    })?;
    if trimmed.is_empty() {
        obj.remove(PROXY_SETTINGS_KEY);
    } else {
        obj.insert(PROXY_SETTINGS_KEY.to_string(), Value::String(trimmed.clone()));
    }
    // 临时文件 + rename：避免和 pi 并发写时留下半截 settings.json。
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化代理配置失败: {e}"))?;
    std::fs::write(&tmp, body)
        .map_err(|e| format!("写入代理配置失败: {e}"))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("写入代理配置失败: {e}"))?;
    let _ = std::fs::remove_file(proxy_path());
    Ok(())
}

/// 渲染层（WebKitGTK 主窗口）代理。**仅 Linux 生效** —— Windows WebView2 /
/// macOS WKWebView 走 `lib.rs` 启动时的 `builder.proxy_url()`，不走这里。
pub fn apply_webview_proxy() {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{
            NetworkProxyMode, NetworkProxySettings, WebContext, WebContextExt,
            WebsiteDataManagerExt,
        };
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
            let hosts: Vec<&str> = NO_PROXY_STR.split(',').map(str::trim).collect();
            let mut settings = NetworkProxySettings::new(Some(&url), &hosts);
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
