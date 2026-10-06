//! 内置浏览器的真网页视图：每个浏览器页一条无边框子窗口（native overlay）。
//!
//! 为什么不是 iframe：Helix 跑在 Tauri 上，主 webview 里的 `<iframe>` 对绝大多数
//! 外网站会被 `X-Frame-Options` / CSP `frame-ancestors` 直接拒掉，只能退回
//! `page_fetch` 抓来的静态快照 —— 于是「能看、点不动」。
//!
//! 为什么不用真内嵌视图（`Window::add_child`）：那是 `unstable` feature，它会把进程里
//! **每一条** webview 都切成 WindowChild 模式（不只新建的那条），官方自己标注「未来
//! minor 版本可能破坏」，而 Windows 上多 webview 定位错乱、只有最后一个 child 渲染的
//! issue 至今没关。这里用 **owned 子窗口**：`parent(main)` 在 Windows 上是 owner 关系
//! （跟着主窗移动/最小化一起走）、macOS 上是 child window；前端只报面板矩形的 CSS
//! 像素，物理坐标换算全留在这里，React 侧不需要任何新权限。
//!
//! 已知取舍（前端负责规避）：原生窗口永远浮在 DOM 之上，所以「面板被 Helix 自己的
//! 浮层盖住」时不能只靠 z-index —— 必须显式 hide（见 `browser_webview_set_rect` 的
//! `visible`，以及 preview-rail.tsx 里的遮挡检测）。导航状态由 webview 自己持有，
//! 地址栏靠 `on_page_load` 回传：外部页面拿不到 Tauri IPC（capabilities 只信任应用
//! origin），这是唯一可靠的 URL 来源。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

/// 前端事件名：页面开始/完成加载时回传真实 URL，供地址栏跟随。
pub const NAV_EVENT: &str = "helix:browser-nav";

/// 前端事件名：一次 `browser_webview_eval` 的完成值。
pub const EVAL_EVENT: &str = "helix:browser-eval";

/// 已创建的浏览器页 → 窗口 label 的登记表。
///
/// 为什么不直接用 page id 当 label：label 只允许 `a-zA-Z0-9-/:_`，而 page id 的
/// 生成格式不属于本模块的契约，所以这里做一层 sanitize + 映射，并保证唯一 ——
/// 两条不同页面映射到同一个 label，就等于共用一条 webview、URL 互相踩踏。
static BROWSER_WINDOWS: Mutex<Option<BrowserWindows>> = Mutex::new(None);

#[derive(Default)]
struct BrowserWindows {
    /// page id → 窗口 label。
    by_page: HashMap<String, String>,
    /// 已用过的 label，保证唯一。
    used_labels: HashSet<String>,
}

fn registry() -> std::sync::MutexGuard<'static, Option<BrowserWindows>> {
    BROWSER_WINDOWS.lock().unwrap_or_else(|e| e.into_inner())
}

fn label_for(reg: &mut BrowserWindows, page: &str) -> String {
    if let Some(existing) = reg.by_page.get(page) {
        return existing.clone();
    }
    let base: String = page
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut candidate = format!("helix-browser-{base}");
    let mut n = 1;
    while reg.used_labels.contains(&candidate) {
        candidate = format!("helix-browser-{base}-{n}");
        n += 1;
    }
    reg.used_labels.insert(candidate.clone());
    reg.by_page.insert(page.to_string(), candidate.clone());
    candidate
}

fn http_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw).map_err(|e| format!("非法 URL {raw}: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("只支持 http/https 地址，收到 {}", url.scheme()));
    }
    Ok(url)
}

/// CSS 像素矩形（相对主 webview 视口）+ devicePixelRatio → 屏幕物理像素。
///
/// 视口原点不等于屏幕原点：主窗口无边框，其内容区左上角在屏幕上由
/// `inner_position()` 给出。用 `outer_position()` 会错 —— Windows 上最大化窗口的
/// outer rect 含一圈不可见的 resize border，覆盖层会整体偏移好几个像素。
fn to_physical(
    app: &AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    dpr: f64,
) -> Result<(i32, i32, u32, u32), String> {
    let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    let scale = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    Ok((
        origin.x + (x * scale).round() as i32,
        origin.y + (y * scale).round() as i32,
        (w * scale).round().max(1.0) as u32,
        (h * scale).round().max(1.0) as u32,
    ))
}

/// 打开（或复用）某个浏览器页的真 webview。创建时是隐藏的，等前端报矩形。
#[tauri::command]
pub fn browser_webview_open(app: AppHandle, page: String, url: String) -> Result<(), String> {
    let target = http_url(&url)?;
    let label = {
        let mut reg = registry();
        let reg = reg.get_or_insert_with(BrowserWindows::default);
        label_for(reg, &page)
    };

    if let Some(win) = app.get_webview_window(&label) {
        return win.navigate(target).map_err(|e| e.to_string());
    }

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
        .title("Helix 浏览器")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .inner_size(1.0, 1.0)
        // 前端还没报矩形，先甩到屏幕外，避免创建瞬间在白纸上闪一下。
        .position(-10000.0, -10000.0)
        .on_page_load({
            let app = app.clone();
            let page = page.clone();
            move |win: tauri::WebviewWindow, payload| {
                let _ = app.emit(
                    NAV_EVENT,
                    serde_json::json!({
                        "page": page,
                        "label": win.label(),
                        "url": payload.url().to_string(),
                        "started": matches!(payload.event(), PageLoadEvent::Started),
                    }),
                );
            }
        });

    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    builder
        .build()
        .map_err(|e| format!("创建浏览器子窗口失败: {e}"))?;
    Ok(())
}

/// 把 webview 对齐到面板矩形；`visible=false` 时直接隐藏（面板收起、切到别的
/// tab、被 Helix 浮层盖住、进入元素选取都走这里）。
#[tauri::command]
pub fn browser_webview_set_rect(
    app: AppHandle,
    page: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    dpr: f64,
    visible: bool,
) -> Result<(), String> {
    let win = window_of(&app, &page)?;

    if !visible || w < 1.0 || h < 1.0 {
        let _ = win.hide();
        return Ok(());
    }

    let (px, py, pw, ph) = to_physical(&app, x, y, w, h, dpr)?;
    win.set_size(PhysicalSize::new(pw, ph)).map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(px, py)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_webview_navigate(app: AppHandle, page: String, url: String) -> Result<(), String> {
    let target = http_url(&url)?;
    window_of(&app, &page)?.navigate(target).map_err(|e| e.to_string())
}

/// 后退/前进/刷新。历史由 webview 自己持有，所以直接 eval 历史 API —— 比让前端记
/// 访问栈更可靠（页面自身的 302、`location.replace` 都算在里面）。
#[tauri::command]
pub fn browser_webview_history(
    app: AppHandle,
    page: String,
    dir: String,
) -> Result<(), String> {
    let js = match dir.as_str() {
        "back" => "window.history.back()",
        "forward" => "window.history.forward()",
        "reload" => "window.location.reload()",
        other => return Err(format!("未知的历史操作 {other}")),
    };
    window_of(&app, &page)?.eval(js).map_err(|e| e.to_string())
}

/// 在真页面里执行 JS，完成值通过 `helix:browser-eval` 事件回传（带上调用方给的
/// reqId，前端用它配对）。
///
/// 为什么是「发出即返回、结果走事件」：结果回调由主线程事件循环投递，而命令本身
/// 就跑在主线程上 —— 在这里 channel 等结果就是自锁。超时交给前端（它本来就有
/// EXEC_TIMEOUT_MS 那套）。
///
/// 注入脚本的硬约束（Windows 侧就是 `ICoreWebView2::ExecuteScript`，wry 原话
/// "Exception is ignored because of the limitation on windows"）：不 await Promise、
/// 异常不回报。所以脚本必须**同步** return 一个值，并自己 try/catch 成错误 JSON；
/// 真正的异步操作（截图）走「先启动、再轮询全局变量」两步。
#[tauri::command]
pub fn browser_webview_eval(
    app: AppHandle,
    page: String,
    js: String,
    req_id: String,
) -> Result<(), String> {
    let win = window_of(&app, &page)?;
    win.eval_with_callback(js, move |value| {
        let _ = app.emit(
            EVAL_EVENT,
            serde_json::json!({
                "page": page,
                "reqId": req_id,
                "value": peel_json_string(&value),
            }),
        );
    })
    .map_err(|e| e.to_string())
}

/// 关闭页面时销毁子窗口（并清掉映射，允许 page id 复用）。
#[tauri::command]
pub fn browser_webview_close(app: AppHandle, page: String) -> Result<(), String> {
    let label = {
        let mut reg = registry();
        match reg.as_mut().and_then(|r| r.by_page.remove(&page)) {
            Some(label) => {
                if let Some(r) = reg.as_mut() {
                    r.used_labels.remove(&label);
                }
                label
            }
            None => return Ok(()),
        }
    };
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    Ok(())
}

fn window_of(app: &AppHandle, page: &str) -> Result<tauri::WebviewWindow, String> {
    let label = registry()
        .as_ref()
        .and_then(|reg| reg.by_page.get(page).cloned())
        .ok_or("该页面还没有真浏览器视图")?;
    app.get_webview_window(&label).ok_or("浏览器子窗口已关闭".to_string())
}

/// WebView2 / WKWebView 会把脚本完成值再 JSON 编码一层：`JSON.stringify(x)` 得到的
/// 字符串变成 `"\"{…}\""`。剥掉这一层；剥不掉（返回值不是字符串字面量，比如对象被
/// 直接序列化、或 `undefined`→"null"）就原样返回，让前端按 JSON 解析。
fn peel_json_string(raw: &str) -> String {
    serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_urls() {
        assert!(http_url("file:///etc/passwd").is_err());
        assert!(http_url("javascript:alert(1)").is_err());
        assert!(http_url("not a url").is_err());
        assert!(http_url("https://example.com/a?b=1").is_ok());
    }

    #[test]
    fn labels_are_sanitized_and_unique() {
        let mut reg = BrowserWindows::default();
        let a = label_for(&mut reg, "page/one");
        assert_eq!(a, "helix-browser-page-one");
        // 同一个 page 再问一次拿到同一个 label（复用同一条 webview）。
        assert_eq!(label_for(&mut reg, "page/one"), a);
        // 不同 page 即使 sanitize 后同名也不能撞车。
        let b = label_for(&mut reg, "page-one");
        assert_ne!(a, b);
    }

    #[test]
    fn peels_exactly_one_json_string_layer() {
        // 正常路径：脚本 return JSON.stringify({...}) → 外层是 JSON 字符串字面量。
        assert_eq!(
            peel_json_string("\"{\\\"ok\\\":true}\""),
            "{\"ok\":true}"
        );
        // 不是字符串字面量时原样交给前端解析。
        assert_eq!(peel_json_string("{\"ok\":true}"), "{\"ok\":true}");
        assert_eq!(peel_json_string("null"), "null");
        assert_eq!(peel_json_string(""), "");
    }
}
