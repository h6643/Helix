// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK (Tauri's Linux renderer) probes EGL/DRI2 hardware acceleration on
    // startup. In VMs / headless hosts (VMware without 3D acceleration) that probe
    // fails and spams stderr:
    //   libEGL warning: DRI2: failed to authenticate
    //   libEGL warning: egl: failed to create dri2 screen
    //   VMware: No 3D enabled (0, 成功).
    // These are harmless (the webview falls back to software rendering) but noisy.
    // Forcing the software path up front makes WebKit skip the GL probe entirely.
    // Must be set BEFORE tauri::Builder initializes GTK. No functional loss on VMs.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("GDK_GL", "disable");
        // The WebKit env vars above only disable WebKit's own compositor.
        // Mesa/GTK still probes EGL/DRI2 hardware accel at startup, which in a
        // VMware guest (no 3D) emits "DRI2: failed to authenticate" /
        // "egl: failed to create dri2 screen" / "VMware: No 3D enabled".
        // LIBGL_ALWAYS_SOFTWARE makes Mesa pick swrast/llvmpipe up front and
        // skip the failing hardware probe entirely.
        std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        // Improve font rendering on Linux.
        std::env::set_var("GDK_DPI_SCALE", "1");
    }
    helix_lib::run()
}
