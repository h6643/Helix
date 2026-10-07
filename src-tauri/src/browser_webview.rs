//! 内置浏览器的真网页视图：每个浏览器页一条无边框子窗口（native overlay）。
//!
//! 为什么不是 iframe：Helix 跑在 Tauri 上，主 webview 里的 `<iframe>` 对绝大多数
//! 外网站会被 `X-Frame-Options` / CSP `frame-ancestors` 直接拒掉，只能退回
//! `page_fetch` 抓来的静态快照 —— 于是「能看、点不动」。
//!
//! 为什么不用真内嵌视图（`Window::add_child`）：那是 `unstable` feature，它会把进程里
//! **每一条** webview 都切成 WindowChild 模式（不只新建的那条），官方自己标注「未来
//! minor 版本可能破坏」，而 Windows 上多 webview 定位错乱、只有最后一个 child 渲染的
//! issue 至今没关。这里用 **owned 子窗口**：`parent(main)` 在 Windows 上是 owner
//! 关系（最小化/关闭跟主窗走，**移动不会自动跟**，见 LAST_RECTS）、macOS 上是
//! child window；前端只报面板矩形的 CSS
//! 像素，物理坐标换算全留在这里，React 侧不需要任何新权限。
//!
//! 已知取舍（前端负责规避）：原生窗口永远浮在 DOM 之上，所以「面板被 Helix 自己的
//! 浮层盖住」时不能只靠 z-index —— 必须显式 hide（见 `browser_webview_set_rect` 的
//! `visible`，以及 preview-rail.tsx 里的遮挡检测）。导航状态由 webview 自己持有，
//! 地址栏靠 `on_page_load` 回传：外部页面拿不到 Tauri IPC（capabilities 只信任应用
//! origin），这是唯一可靠的 URL 来源。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

/// 前端事件名：页面开始/完成加载时回传真实 URL，供地址栏跟随。
pub const NAV_EVENT: &str = "helix:browser-nav";

/// 前端事件名：一次 `browser_webview_eval` 的完成值。
pub const EVAL_EVENT: &str = "helix:browser-eval";

/// 前端事件名：一次 `browser_webview_screenshot` 的 PNG（data URL），或失败原因。
pub const SHOT_EVENT: &str = "helix:browser-shot";

/// 注入到每条浏览器子窗口的脚本：把「另开一个窗口」的意图就地变成同页导航。
///
/// 为什么需要它：这条视图是**单页**的 —— 没有地方放「新窗口」。而只靠
/// `on_new_window` 实测不可靠（点百度的搜索结果时，请求压根没到达我们的 handler，
/// 所以连诊断事件都没发出来；wry 侧没有 handler 时更是直接 `SetHandled(true)` 丢弃）。
/// 于是在文档最开始就把意图抹掉：`a[target=_blank]` 在**捕获阶段**被改成 `_self`
/// （默认动作在所有监听器之后才计算，所以改属性就够用），`window.open` 则直接
/// 导航当前页。这样绝大多数链接根本不会产生新窗口请求。
///
/// 约束：脚本在页面自己的脚本之前执行、每个新文档都跑一次，所以必须可重入
/// （`__helixSameTab` 标志），且任何一步都不许抛异常 —— 初始化脚本没有回报通道。
/// 按住修饰键的点击不改写：那是用户明确要「在别处打开」，交给系统/回退路径处理。
const SAME_TAB_SCRIPT: &str = r#"
(() => {
  if (window.__helixSameTab) return;
  window.__helixSameTab = true;
  const SELF = "_self";
  try {
    document.addEventListener("click", (e) => {
      try {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const el = e.target && e.target.closest ? e.target.closest("a[target],area[target]") : null;
        if (!el || !el.getAttribute) return;
        const t = (el.getAttribute("target") || "").toLowerCase();
        if (t && t !== SELF && t !== "_top") el.setAttribute("target", SELF);
      } catch (err) {}
    }, true);
  } catch (err) {}
  try {
    window.open = function (url) {
      try {
        if (typeof url === "string" && url && url !== "about:blank") window.location.href = url;
      } catch (err) {}
      return window;
    };
  } catch (err) {}
})();
"#;

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

/// 每条子窗口最近一次上报的 CSS 像素矩形（相对主 webview 视口）。
///
/// 为什么必须缓存：Windows 上子窗口是 **owner** 关系（tauri-runtime-wry 用
/// `with_owner_window`），而 Win32 的 owned 窗口**不会**跟着 owner 移动。
/// 前端的几何同步只在「DOM 矩形变化」时推送 —— 拖动主窗口时面板在视口里的
/// 矩形一点没变，一次 IPC 都不会发，子窗口就留在屏幕原地，视觉上整个浏览器
/// 「浮」在窗外。主窗口 `Moved` 时用这里的缓存矩形 + 新视口原点重算物理位置
/// （见 `reflow_on_main_moved`）。隐藏时移除缓存：看不见的窗口不参与重排。
static LAST_RECTS: Mutex<Option<HashMap<String, CachedRect>>> = Mutex::new(None);

#[derive(Clone, Copy)]
struct CachedRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    dpr: f64,
    /// 客户区原点相对窗口矩形原点的偏移（frame 内缩）。`set_position` 定位的是
    /// 窗口矩形原点，所以摆放时必须减掉它；实测值随窗口样式/DWM 状态变化，
    /// 不写死，每次 set_rect 现量。
    inset_x: i32,
    inset_y: i32,
}

/// 临时诊断：把覆盖层的几何真相写进 `%TEMP%\helix-webview-diag.log`。
///
/// 为什么需要：DOM 矩形 → 屏幕物理矩形这一段跨了「WebView2 DOM / WebView2 客户区
/// / DWM frame / tao 尺寸补偿」四层，哪一层错位都表现为「边没覆盖上」，看代码
/// 推不出来，只能把窗口矩形、客户区原点、样式位一起打出来对账。定位完即删。
fn diag(line: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("helix-webview-diag.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ms}] {line}");
    }
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

/// 覆盖层四条边向外扩的 CSS 像素：把面板自己的边框一起盖掉。
///
/// 面板左缘有 1px `border-left`（`.helix-sidebar-right`），网页内容从边框**内侧**
/// 起算，严格贴合就等于在左边留了 1px 面板底色（用户看到的「左边还有一点没覆盖
/// 到」）。原生窗口永远在 DOM 之上，多盖住的这 1px 只会盖掉面板自己的边框，不会
/// 碰到左边的对话卡片，所以直接外扩，而不是去改面板的 border。
const BLEED_CSS_PX: f64 = 1.0;

/// CSS 像素矩形（相对主 webview 视口）+ devicePixelRatio → 屏幕物理像素。
///
/// 视口原点不等于屏幕原点：主窗口无边框，其内容区左上角在屏幕上由
/// `inner_position()` 给出。用 `outer_position()` 会错 —— Windows 上最大化窗口的
/// outer rect 含一圈不可见的 resize border，覆盖层会整体偏移好几个像素。
///
/// 取整用 **floor / ceil**（左上是 floor、右下是 ceil），不用 round：round 会让
/// 位置和尺寸各自独立取整，两次误差在最坏情况下叠加成 1 物理像素的缝 —— DPR=1.5
/// 的半像素位置上必然出现，表现就是边缘漏出面板底色。floor/ceil 保证覆盖范围
/// 永远不小于面板矩形，只可能多出亚像素到 1px，方向朝外（被自己的边框吃掉）。
///
/// 外扩（`BLEED_CSS_PX`）刻意做在**这一个换算点**：`browser_webview_set_rect`
/// 与 `reflow_on_main_moved` 都走这里，两条路径的覆盖范围天然一致，不会出现
/// 「拖窗口后边缘又缩回去」。
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
    // 贴到视口边缘的面板不往外扩（否则坐标会跑到视口外，白色边框反而更明显）。
    let left = BLEED_CSS_PX.min(x.max(0.0));
    let top = BLEED_CSS_PX.min(y.max(0.0));
    let x0 = ((x - left) * scale).floor();
    let y0 = ((y - top) * scale).floor();
    let x1 = ((x + w + BLEED_CSS_PX) * scale).ceil();
    let y1 = ((y + h + BLEED_CSS_PX) * scale).ceil();
    Ok((
        origin.x + x0 as i32,
        origin.y + y0 as i32,
        (x1 - x0).max(1.0) as u32,
        (y1 - y0).max(1.0) as u32,
    ))
}

/// 打开（或复用）某个浏览器页的真 webview。创建时是隐藏的，等前端报矩形。
///
/// **必须 `async`**：建窗/导航/取位置都是「把任务丢给主线程事件循环、再等 channel
/// 回话」，而同步命令就跑在这条事件循环线程上 —— 等自己处理完就是死锁（实测整个
/// 应用卡死）。上游同样注明："this must be called from a separate thread,
/// otherwise the channel will introduce a deadlock"
/// （tauri-runtime-wry/src/lib.rs 的 `create_webview`）。
#[tauri::command]
pub async fn browser_webview_open(
    app: AppHandle,
    page: String,
    url: String,
) -> Result<(), String> {
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
        // **必须显式关掉阴影**（tauri 默认 true）。tao 的 WM_NCCALCSIZE 处理里，
        // `MARKER_UNDECORATED_SHADOW`（= shadow 且无边框）会把客户区**四边内缩**
        // `calculate_window_insets()` 给 DWM 留出画阴影的位置：实测本机
        // dpr=2.4 时左 13 / 上 2 物理像素。而 `set_position` 定位的是窗口矩形原点，
        // 网页画在客户区里 —— 于是网页整体右移 13px，左边露出 13px 面板底色
        //（截图实测 11-12 图像px × dpr 2.4 ≈ 5 CSS px，与 CSS 无关的绝对量）。
        // tao 只在 `set_inner_size` 里为这个 inset 补了尺寸、没补位置，所以从
        // 窗口边框样式下手是白费劲（实测摘掉 WS_CAPTION 后 inset 依然是 13/2）。
        // 覆盖层要的就是「窗口矩形 == 客户区」，不需要任何系统阴影。
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .inner_size(1.0, 1.0)
        // 前端还没报矩形，先甩到屏幕外，避免创建瞬间在白纸上闪一下。
        .position(-10000.0, -10000.0)
        // 先注入「同页导航」脚本，新窗口请求基本不会再发生；下面的 handler 只兜住
        // 漏网的（点击时才动态设 target、或页面自己缓存了旧的 window.open）。
        .initialization_script(SAME_TAB_SCRIPT)
        // `target="_blank"` / `window.open` 的新窗口请求。
        //
        // 不注册处理器的默认行为是**静默丢弃**：wry 在没有 handler 时只执行
        // `args.SetHandled(true)` 就返回（wry/src/webview2/mod.rs 的
        // NewWindowRequested 分支），页面以为窗口开出来了，用户什么也看不见 ——
        // 而真实网站上大量链接都是 `_blank`，表现就是「页面能看、点不动」。
        //
        // 为什么是「自己导航 + Deny」而不是 `Create { window: 本窗口 }`：后者要求
        // WebView2 接受把**发起请求的那条 webview**当作新窗口（`SetNewWindow(sender)`），
        // 实测不生效。自己导航则确定可行，但**必须排到本次回调之后**：handler 就跑在
        // WebView2 处理这次请求的过程中（wry 用 `dispatch_handler` 把回调甩到消息循环，
        // 正是为了避开它的 reentrancy 限制），在这里同步调 `navigate` 会和紧随其后的
        // `SetHandled(true)` + `deferral.Complete()` 抢同一条 webview，谁赢不确定 ——
        // 实测症状就是「有时跳有时不跳」。从别的线程调 `navigate` 会走事件循环代理投递
        // （tauri-runtime-wry `send_user_message` 的非主线程分支），因此严格落在
        // `deferral.Complete()` 之后；同时它不阻塞、也不会撞上「同步命令 + 建窗」那条
        // 死锁路径。`Deny` 保证不会冒出我们没登记的野窗口。
        //
        // `features` 的 size/position 有意忽略：覆盖层矩形只能由前端上报的面板矩形
        // 决定（见 `browser_webview_set_rect`），交给外部网站等于让它把窗口摆到别处。
        // 目标地址同样要过 `http_url`：不让页面用 `window.open("file://…")` 把这条
        // 视图导航到本地盘。
        .on_new_window({
            let app = app.clone();
            let label = label.clone();
            move |url, _features| {
                if let (Some(win), Ok(target)) =
                    (app.get_webview_window(&label), http_url(url.as_str()))
                {
                    tauri::async_runtime::spawn(async move {
                        let _ = win.navigate(target);
                    });
                }
                NewWindowResponse::Deny
            }
        })
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
    // 抹掉「独立窗口」外观：Win11 会给**所有顶层窗口**自动画圆角 + 投影 + 1px
    // 描边，哪怕 decorations(false) 也没有例外。这条视图是 owned 顶层窗口（不是
    // WS_CHILD，见文件头），于是侧边栏里的网页看着像一张浮在面板上的卡片。
    // 顺序有讲究：先摘 frame 样式（客户区才会铺满窗口矩形），再关 DWM 的
    // non-client 渲染。
    #[cfg(target_os = "windows")]
    if let Some(win) = app.get_webview_window(&label) {
        if let Ok(hwnd) = win.hwnd() {
            let before = window_geometry(hwnd);
            strip_frame_styles(hwnd);
            flatten_native_window(hwnd);
            let after = window_geometry(hwnd);
            diag(&format!(
                "open label={label} before={before} after={after} (格式: style|win_rect|client_rect|client_origin)"
            ));
        }
    }
    Ok(())
}

/// 覆盖层窗口的实测几何 + 样式位，写给 `diag` 对账用。
#[cfg(target_os = "windows")]
fn window_geometry(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowLongPtrW, GetWindowRect, GWL_STYLE,
    };
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let mut wr = RECT::default();
        let mut cr = RECT::default();
        let mut pt = POINT { x: 0, y: 0 };
        let _ = GetWindowRect(hwnd, &mut wr);
        let _ = GetClientRect(hwnd, &mut cr);
        let _ = ClientToScreen(hwnd, &mut pt);
        format!(
            "style=0x{style:08X} win=({},{},{},{}) client=({},{},{},{}) client_origin=({},{})",
            wr.left,
            wr.top,
            wr.right - wr.left,
            wr.bottom - wr.top,
            cr.left,
            cr.top,
            cr.right - cr.left,
            cr.bottom - cr.top,
            pt.x,
            pt.y
        )
    }
}

/// 客户区原点相对窗口矩形原点的偏移（frame 内缩量）。
///
/// `set_position` 定位的是**窗口矩形**原点，而网页画在**客户区**里，两者差一个
/// frame 内缩（tao 建的无边框窗口带 `WS_CAPTION`，客户区被 DWM border 内缩；tao 只在
/// `set_inner_size` 里为这个 "hidden offset" 补了尺寸，没补位置）。不量化这个偏移、
/// 只想靠改样式位消除它，是靠不住的做法：这里每次现量现用，样式怎么变都对得上。
#[cfg(target_os = "windows")]
fn client_inset(hwnd: windows::Win32::Foundation::HWND) -> (i32, i32) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};
    unsafe {
        let mut cr = RECT::default();
        if GetClientRect(hwnd, &mut cr).is_err() {
            return (0, 0);
        }
        let mut pt = POINT { x: cr.left, y: cr.top };
        if !ClientToScreen(hwnd, &mut pt).as_bool() {
            return (0, 0);
        }
        let mut wr = RECT::default();
        if GetWindowRect(hwnd, &mut wr).is_err() {
            return (0, 0);
        }
        (pt.x - wr.left, pt.y - wr.top)
    }
}

#[cfg(not(target_os = "windows"))]
fn client_inset(_hwnd: ()) -> (i32, i32) {
    (0, 0)
}

/// 去掉这条窗口的圆角 / 投影 / 描边，让它和面板里的 DOM 看起来是同一块平面。
///
/// 为什么不能「改成真正的子窗口」了事：`Window::add_child` 是 unstable（会把进程里
/// 每一条 webview 切成 WindowChild 模式），而 `parent()` 在 Windows 上只给到 owner
/// 关系（tauri-runtime-wry → tao `with_owner_window`），owner 仍是顶层窗口，DWM 照样
/// 按「一扇独立的窗」来画。剩下的唯一手段就是关掉这条窗口的 non-client 渲染 ——
/// 网页内容由 WebView2 画在客户区里，不走 DWM，所以不受影响。
#[cfg(target_os = "windows")]
fn flatten_native_window(hwnd: windows::Win32::Foundation::HWND) {
    use std::mem::size_of;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMNCRENDERINGPOLICY, DWM_WINDOW_CORNER_PREFERENCE,
        DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_NCRENDERING_POLICY,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMNCRP_DISABLED, DWMWCP_DONOTROUND,
    };

    fn set<T>(hwnd: windows::Win32::Foundation::HWND, attr: windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE, v: &T) {
        // DwmSetWindowAttribute 收裸指针 + 字节数（不是泛型 Param），所以这里手动传。
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attr,
                v as *const T as *const std::ffi::c_void,
                size_of::<T>() as u32,
            )
        };
    }

    // 1) 关掉 non-client 渲染：圆角与投影都是 DWM 的非客户区产物，一起消失。
    set(hwnd, DWMWA_NCRENDERING_POLICY, &DWMNCRENDERINGPOLICY(DWMNCRP_DISABLED.0));
    // 2) 双保险：显式表态「不要圆角」「边框色 none」。个别 Win11 版本即使关了
    //    NCRendering 也仍留 1px 描边。
    set(
        hwnd,
        DWMWA_WINDOW_CORNER_PREFERENCE,
        &DWM_WINDOW_CORNER_PREFERENCE(DWMWCP_DONOTROUND.0),
    );
    set(hwnd, DWMWA_BORDER_COLOR, &DWMWA_COLOR_NONE);
}

/// 摘掉窗口的 frame 样式，让**客户区 == 窗口矩形**。
///
/// 这才是「左边一条没覆盖到」的真正根因（实测 12 物理像素 ≈ 8 CSS 像素，远超
/// 取整误差能解释的量级）：tao 建无边框窗口时只发 `WS_CAPTION | WS_SYSMENU |
/// WS_CLIPSIBLINGS`（见 tao `WindowFlags::to_window_styles`，只有
/// `to_adjusted_window_styles` 那条路径才去掉 frame 样式，而它只用于尺寸计算）。
/// tao 自己是知道这件事的 —— `set_inner_size` 里有 `undecorated_with_shadows`
/// 的 "hidden offsets" 补偿（tao window.rs），但那只补了**尺寸**，没补**位置**：
/// `set_position` 定位的仍是窗口矩形原点，而客户区被 DWM 的 border 内缩了
/// `SM_CXSIZEFRAME + SM_CXPADDEDBORDER`（Win10/11 = 8px，左右各一份）。
///
/// 后果有两层，都很糟：
///  1. 视觉：网页内容从窗口矩形右侧 8px 才开始 → 左边一条面板底色的空隙；
///  2. 交互：那 8px frame 带仍属于本窗口，**照样吃鼠标事件** —— 侧边栏左缘的
///     拖拽把手（`-left-1 w-2`，正好 8px 宽）会被它抢走。
///
/// 摘掉 frame 样式后客户区铺满整个窗口矩形，两个问题一起消失；顺带 DWM 也再没有
/// frame 可画，前一个函数里的圆角/投影处理仍然保留（Win11 对顶层窗口的圆角偏好
/// 与 frame 样式无关）。
#[cfg(target_os = "windows")]
fn strip_frame_styles(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_BORDER, WS_CAPTION,
        WS_DLGFRAME, WS_THICKFRAME,
    };

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let stripped =
            style & !(WS_BORDER.0 | WS_CAPTION.0 | WS_DLGFRAME.0 | WS_THICKFRAME.0);
        if stripped == style {
            return;
        }
        let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, stripped as isize);
        // 改完样式必须 SWP_FRAMECHANGED 走一遍 WM_NCCALCSIZE，客户区才会真的重算
        // （否则窗口矩形变了、客户区还是老尺寸，WebView2 也不会收到 WM_SIZE）。
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// 把 webview 对齐到面板矩形；`visible=false` 时直接隐藏（面板收起、切到别的
/// tab、被 Helix 浮层盖住、进入元素选取都走这里）。
#[tauri::command]
pub async fn browser_webview_set_rect(
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
        // 隐藏即清缓存：Moved 重排只服务「当前看得见」的窗口。
        let label = win.label().to_string();
        if let Some(m) = LAST_RECTS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            m.remove(&label);
        }
        let _ = win.hide();
        return Ok(());
    }

    let (px, py, pw, ph) = to_physical(&app, x, y, w, h, dpr)?;
    // 客户区 ≠ 窗口矩形：网页画在客户区里，而 set_position 定位的是窗口矩形原点。
    // 现量这个偏移（见 client_inset）并减掉它，样式/DWM 怎么变都能对上。
    #[cfg(target_os = "windows")]
    let (inset_x, inset_y) = win.hwnd().map(client_inset).unwrap_or((0, 0));
    #[cfg(not(target_os = "windows"))]
    let (inset_x, inset_y) = (0, 0);

    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = win.hwnd() {
        diag(&format!(
            "set_rect label={} dom=({x:.2},{y:.2},{w:.2},{h:.2}) dpr={dpr} phys=({px},{py},{pw},{ph}) inset=({inset_x},{inset_y}) {}",
            win.label(),
            window_geometry(hwnd)
        ));
    }

    // 先尺寸后位置：tao 的 set_size 是「设客户区尺寸」（内部会自己把 frame 内缩补
    // 进窗口尺寸），所以尺寸调完之后再摆位置，量到的 inset 才是最终态。
    win.set_size(PhysicalSize::new(pw, ph)).map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(px - inset_x, py - inset_y))
        .map_err(|e| e.to_string())?;
    // 物理坐标落定后再记 CSS 矩形：Moved 重排用「CSS 矩形 × 新原点」重算，
    // 所以这里存原始入参而不是换算结果（DPI 变化时重算会用对的新缩放）。
    {
        let mut guard = LAST_RECTS.lock().unwrap_or_else(|e| e.into_inner());
        guard.get_or_insert_with(HashMap::new).insert(
            win.label().to_string(),
            CachedRect {
                x,
                y,
                w,
                h,
                dpr,
                inset_x,
                inset_y,
            },
        );
    }
    win.show().map_err(|e| e.to_string())?;

    // 摆好之后再打一次：核对「客户区实际落点」是否等于目标 phys（对账用）。
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = win.hwnd() {
        diag(&format!(
            "placed  label={} want_phys=({px},{py},{pw},{ph}) {}",
            win.label(),
            window_geometry(hwnd)
        ));
    }
    Ok(())
}

/// 主窗口移动时把所有可见的浏览器子窗口拖回来。
///
/// 由 lib.rs 的 `on_window_event`（`WindowEvent::Moved`，仅 main）调用。owner
/// 窗口不跟 owner 走（见 `LAST_RECTS` 注释），不在这里补位的话拖一次主窗、
/// 浏览器就永远留在屏幕原地。只重算位置不改尺寸：CSS 矩形没变，尺寸也不会变。
/// Moved 在拖动中每像素触发一次，SetWindowPos 很便宜，不需要节流。
pub fn reflow_on_main_moved(app: &AppHandle) {
    let rects: Vec<(String, CachedRect)> = {
        let guard = LAST_RECTS.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(m) if !m.is_empty() => m.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            _ => return,
        }
    };
    for (label, r) in rects {
        let Some(win) = app.get_webview_window(&label) else {
            continue;
        };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        if let Ok((px, py, _, _)) = to_physical(app, r.x, r.y, r.w, r.h, r.dpr) {
            let _ = win.set_position(PhysicalPosition::new(px - r.inset_x, py - r.inset_y));
        }
    }
}

#[tauri::command]
pub async fn browser_webview_navigate(app: AppHandle, page: String, url: String) -> Result<(), String> {
    let target = http_url(&url)?;
    window_of(&app, &page)?.navigate(target).map_err(|e| e.to_string())
}

/// 后退/前进/刷新。历史由 webview 自己持有，所以直接 eval 历史 API —— 比让前端记
/// 访问栈更可靠（页面自身的 302、`location.replace` 都算在里面）。
#[tauri::command]
pub async fn browser_webview_history(
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
/// 为什么是「发出即返回、结果走事件」而不是在这里等 channel：一次 eval 的成败不
/// 等于页面的状态（脚本可以只滚动、不返回值），把超时权留给前端更合适 —— 它本来
/// 就有 EXEC_TIMEOUT_MS 那套，而且能按 reqId 精确判定哪一条没回。
///
/// 注入脚本的硬约束（Windows 侧就是 `ICoreWebView2::ExecuteScript`，wry 原话
/// "Exception is ignored because of the limitation on windows"）：不 await Promise、
/// 异常不回报。所以脚本必须**同步** return 一个值，并自己 try/catch 成错误 JSON；
/// 真正的异步操作（截图）走「先启动、再轮询全局变量」两步。
#[tauri::command]
pub async fn browser_webview_eval(
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

/// 截图：取 WebView2 的**真像素**（`ICoreWebView2::CapturePreview`，只有 PNG 一种格
/// 式），完成后用 `helix:browser-shot` 事件按 reqId 配对回传。
///
/// 为什么不在页面里画 canvas 自己拍：前端那套「DOM → SVG foreignObject → canvas」
/// 拍不到外部样式表和图片（SVG-as-image 的加载限制），出来是「无排版的文字版」。
/// CapturePreview 拿的是合成后的位图 —— 样式、字体、图片都在。
///
/// 同样是「发出即返回、结果走事件」（见 `browser_webview_eval`）：完成回调由 WebView2
/// 在它自己的线程上调用，在这里等它等于占住事件循环。另外两条线程约束：
/// - 闭包由 `with_webview` 代理到 webview 所在线程执行，WebView2 的 COM 调用必须在
///   那条线程上发起；
/// - 承接图片字节的 `IStream` 不是 `Send`，只能由同一条线程上的完成回调去读，所以
///   读流和 base64 编码都留在回调里做。
#[tauri::command]
pub async fn browser_webview_screenshot(
    app: AppHandle,
    page: String,
    req_id: String,
) -> Result<(), String> {
    let win = window_of(&app, &page)?;

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&win, &app, &page, &req_id);
        return Err("网页截图目前只在 Windows 上实现".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        win.with_webview(move |webview| capture_preview(webview, app, page, req_id))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 在 webview 自己的线程上发起一次 CapturePreview。不管失败在哪一步，都 emit 一条带
/// `error` 的事件，前端不会干等到超时。
#[cfg(target_os = "windows")]
fn capture_preview(
    webview: tauri::webview::PlatformWebview,
    app: AppHandle,
    page: String,
    req_id: String,
) {
    use base64::Engine;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    // 完成回调要自己持有一份上下文：它跑起来时本函数的栈早就没了。
    let (cb_app, cb_page, cb_req) = (app.clone(), page.clone(), req_id.clone());
    let started: Result<(), String> = (move || {
        let core = unsafe { webview.controller().CoreWebView2() }
            .map_err(|e| format!("取不到 WebView2 核心对象: {e}"))?;
        // fDeleteOnRelease = true：这块内存随流接口一起释放，回调里不用手动 GlobalFree。
        let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
            .map_err(|e| format!("建截图缓冲流失败: {e}"))?;
        // Clone = COM AddRef，同一个流的两个句柄：一个交给 CapturePreview，一个进回调
        // 读字节（`&stream` 在闭包捕获之后就不能再借出去了）。
        let shot_stream = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(
            move |code: windows::core::Result<()>| -> windows::core::Result<()> {
                let payload = match code {
                    Ok(()) => read_stream_png(&shot_stream).map(|bytes| {
                        format!(
                            "data:image/png;base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(&bytes)
                        )
                    }),
                    Err(e) => Err(format!("截图失败: {e}")),
                };
                emit_shot(&cb_app, &cb_page, &cb_req, payload);
                Ok(())
            },
        ));
        unsafe {
            core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        }
        .map_err(|e| format!("发起截图失败: {e}"))
    })();
    if let Err(e) = started {
        emit_shot(&app, &page, &req_id, Err(e));
    }
}

/// 把流里的 PNG 全部读出来（回调已经在 webview 线程上，流也只在这条线程上读）。
#[cfg(target_os = "windows")]
fn read_stream_png(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;

    const CHUNK: usize = 64 * 1024;
    let mut buf = Vec::new();
    let mut part = [0u8; CHUNK];
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| format!("回到流开头失败: {e}"))?;
        loop {
            let mut got: u32 = 0;
            stream
                .Read(part.as_mut_ptr().cast(), CHUNK as u32, Some(&mut got))
                .ok()
                .map_err(|e| format!("读截图流失败: {e}"))?;
            if got == 0 {
                break;
            }
            buf.extend_from_slice(&part[..got as usize]);
        }
    }
    if buf.is_empty() {
        return Err("截图结果是空的（页面可能还没渲染完）".to_string());
    }
    Ok(buf)
}

#[cfg(target_os = "windows")]
fn emit_shot(app: &AppHandle, page: &str, req_id: &str, payload: Result<String, String>) {
    let (image, error) = match payload {
        Ok(url) => (Some(url), None),
        Err(e) => (None, Some(e)),
    };
    let _ = app.emit(
        SHOT_EVENT,
        serde_json::json!({
            "page": page,
            "reqId": req_id,
            "image": image,
            "error": error,
        }),
    );
}

/// 关闭页面时销毁子窗口（并清掉映射，允许 page id 复用）。
#[tauri::command]
pub async fn browser_webview_close(app: AppHandle, page: String) -> Result<(), String> {
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
