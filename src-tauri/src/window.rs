//! `window:*` commands — window management. Port of `electron/ipc/window.js`.

use crate::state::app_handle;
use tauri::Window;

#[tauri::command]
pub fn minimize(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn maximize(window: Window) {
    let _ = window.maximize();
}

#[tauri::command]
pub fn unmaximize(window: Window) {
    let _ = window.unmaximize();
}

#[tauri::command]
pub fn close(window: Window) {
    let _ = window.close();
}

#[tauri::command]
pub fn is_maximized(window: Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
pub fn toggle_devtools(window: Window) {
    // Devtools live on the webview, not the window. Use the first webview.
    if let Some(wv) = window.webviews().first() {
        if wv.is_devtools_open() {
            wv.close_devtools();
        } else {
            wv.open_devtools();
        }
    }
}

#[tauri::command]
pub fn new_window() {
    let handle = app_handle();
    let _ = tauri::WebviewWindowBuilder::new(
        handle,
        format!(
            "helix-win-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
        tauri::WebviewUrl::App("/".into()),
    )
    .title("Helix")
    .inner_size(1400.0, 900.0)
    .min_inner_size(800.0, 600.0)
    .decorations(false)
    .visible(false)
    .build()
    .and_then(|win| {
        let _ = win.maximize();
        let _ = win.show();
        let _ = win.set_focus();
        Ok(())
    });
}

#[tauri::command]
pub fn start_drag(window: Window) {
    // No-op: handled by CSS -webkit-app-region: drag (mirror electron behavior).
    let _ = window.start_dragging();
}
