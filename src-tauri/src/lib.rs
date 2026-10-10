//! Helix Tauri backend crate.

mod app;
mod approval_policy;
mod background_tasks;
mod browser_webview;
mod browser_import;
mod config;
mod delegations;
mod desktop_notify;
mod diagnostics;
mod exec;
mod fs;
mod gateway;
mod git;
mod github;
mod helix;
mod hooks;
mod mcp;
mod memory;
mod page_fetch;
mod paths;
mod pi_catalog;
mod pi_connect;
mod pi_extensions;
mod pi_gateway;
/// Test-only re-exports of pi_gateway's session-trim helpers (integration
/// tests in tests/trim_session.rs). Not part of the app surface.
/// NOT #[cfg(test)]: integration tests compile this crate as a dependency,
/// where the lib's own test cfg is not set.
#[doc(hidden)]
pub mod pi_gateway_test_hooks {
    pub use crate::pi_gateway::{
        estimate_active_branch, estimate_message_tokens, trim_session_if_oversized,
        TRIM_MARGIN_TOKENS,
    };
}
mod image_model;
mod profile;
mod proxy;
mod remote_connect;
mod scheduled_tasks;
mod security;
mod skills;
mod subagents;
pub mod ssh;
mod state;
mod terminal;
mod vision;
mod web_search;
mod window;

use crate::state::{AppState, APP_HANDLE};
use std::sync::Arc;
use tauri::Emitter;

/// 把主窗口唤回前台（托盘左键、托盘菜单、二次启动共用这一条路径）。
///
/// 为什么收成一个函数：浏览器子窗口是独立 HWND，`main.hide()` 不会跟着收起
/// （见 browser_webview::set_pages_visible），所以「显示主窗」这件事必须连带把
/// 页面放回来。与其在 5 处 `show()` 各记一遍，不如只有一个出口。
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    crate::browser_webview::set_pages_visible(app, true);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second Helix process was launched. Instead of opening another
            // window, focus the already-running one (mirror tray "show").
            show_main_window(app);
        }))
        .manage(app_state.clone())
        .setup(move |app| {
            // Expose the AppHandle globally so background gateway threads can
            // emit `helix:event` without threading a handle through every call.
            let _ = APP_HANDLE.set(app.handle().clone());

            // Global AppState for async code paths (pi_gateway::send) that
            // have no Tauri State<> parameter — must be set before the
            // gateway spawns.
            let _ = crate::state::APP_STATE.set(app_state.clone());

            // One-time migration: legacy ~/.helix → ~/.pi/agent/helix
            // (rename/copy, best effort, only when no override is configured).
            crate::paths::migrate_legacy_data_dir();

            // Re-assert the Helix model selection into Pi's own config so a
            // gateway respawn picks up the intended defaults (heals drift
            // from manual edits to ~/.pi/agent/*.json).
            // NOTE: with pi's files as the single source of truth this is no
            // longer needed — read/write paths both point at pi directly.

            // Main window is created manually here (config has "create": false)
            // so we can attach the HTTP proxy to the renderer at creation time.
            // proxy_url is cross-platform: WebKitGTK (Linux) / WebView2
            // --proxy-server (Windows) / WKWebView (macOS). Empty → no override
            // (Linux explicitly sets NoProxy below in apply_webview_proxy).
            let proxy_url = crate::proxy::load_proxy_url();
            for window_config in app.config().app.windows.iter() {
                let mut builder =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?;
                if !proxy_url.is_empty() {
                    if let Ok(url) = tauri::Url::parse(&proxy_url) {
                        builder = builder.proxy_url(url);
                    }
                }
                // On Windows the webview's native drag-drop handler (on by
                // default) swallows every drag, so the frontend's HTML5 DnD —
                // dropping files into the chat and reordering sessions in the
                // sidebar — never fires. `tauri.conf.json`'s `dragDropEnabled`
                // is not read by the builder path, so it must be set per window.
                builder = builder.disable_drag_drop_handler();
                builder.build()?;
            }

            // Restore the persisted work dir (mirror getPersistedWorkDir).
            if let Some(dir) = crate::app::persisted_work_dir() {
                *app_state.work_dir.write().unwrap() = dir;
            }
            // Apply the active-profile cache before spawning the gateway
            // (mirror applyActiveProfileCache) so the backend matches the
            // user's last saved model choice.
            crate::profile::apply_active_profile_cache();
            // Write out Helix's forked pi-aux-vision (its vision model comes
            // from config.yaml's `vision:` block) before the gateway spawns, so
            // the first pi session already loads this copy instead of an
            // upstream one `pi update` may have restored.
            pi_extensions::install_aux_vision();
            // Built-in browser extension (browser_* tools): write it to the
            // internal path before the gateway spawns — pi_command() passes it
            // to local sessions via `--extension` — and remove the superseded
            // user-level pi-helix-browser install in the same pass (a leftover
            // copy would leak the tools into terminal `pi` and double-register
            // names in Helix sessions).
            pi_extensions::install_browser_extension();
            pi_extensions::remove_legacy_browser_extension();

            // Apply the HTTP proxy to the renderer (WebKitGTK default context)
            // BEFORE the gateway spawns so the webview fetches already honor it.
            crate::proxy::apply_webview_proxy();
            std::thread::spawn(move || {
                if let Err(e) = pi_gateway::spawn(&app_state) {
                    eprintln!("[Helix] pi agent failed to start: {e}");
                }
            });
            // Spawned after the
            // gateway so the pi child is ready before the first dispatch.
            // 先播种内置任务（每日 11:00 渠道签到），再启动轮询。
            scheduled_tasks::seed_channel_checkin_job();
            scheduled_tasks::start_scheduled_events_poller();

            // ── System tray ──────────────────────
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;
            use tauri::Manager;

            let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                // 左键 = 唤回窗口，右键才出菜单。Tauri 的
                // `show_menu_on_left_click` 默认是 true，所以之前左键点托盘弹的是
                // 那个只有「显示窗口 / 退出」两项的菜单，而不是直接打开软件。
                .show_menu_on_left_click(false)
                .tooltip("Helix")
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
                    if !matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        return;
                    }
                    show_main_window(tray.app_handle());
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => {
                        if let Some(state) =
                            app.try_state::<std::sync::Arc<crate::state::AppState>>()
                        {
                            crate::gateway::shutdown(&state);
                        }
                        app.exit(0);
                    }
                    "show" => show_main_window(app),
                    "new" => {
                        show_main_window(app);
                        let _ = app.emit("tray:new-conversation", ());
                    }
                    "recent" => {
                        show_main_window(app);
                        let _ = app.emit("tray:show-recent", ());
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager, WindowEvent};
            match event {
                WindowEvent::Resized(_) => {
                    let maximized = window.is_maximized().unwrap_or(false);
                    let _ = window.emit("window:maximized-changed", maximized);
                }
                // owned 子窗口（内置浏览器）在 Windows 上不跟 owner 移动，
                // 拖主窗时用缓存的 CSS 矩形 + 新原点把它们拖回来。
                WindowEvent::Moved(_) => {
                    if window.label() == "main" {
                        crate::browser_webview::reflow_on_main_moved(window.app_handle());
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // 只有主窗口的「关闭」是收进托盘。浏览器子窗口不拦：它们必须
                    // 真的销毁，否则 `browser_webview_close` 变成「隐藏」，每关一个
                    // 标签留一个活 WebView2（隐藏的那片还浮在桌面上看不见）。
                    if window.label() == "main" {
                        // 子窗口是独立 HWND，hide 主窗不会带走它们（图二那个
                        // 「Helix 关了、网页还在」就是这里漏的）。
                        crate::browser_webview::set_pages_visible(window.app_handle(), false);
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
                WindowEvent::Destroyed => {
                    if window.label() != "main" {
                        crate::browser_webview::forget_window(window.label());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // agent backend (helix:* protocol → pi adapter)
            helix::helix_send,
            helix::helix_notify,
            helix::helix_interrupt,
            helix::helix_status,
            helix::helix_get_gateway_info,
            helix::helix_fetch_models,
            helix::helix_get_config,
            helix::helix_set_config,
            helix::helix_set_provider_models,
            helix::helix_set_yaml_key,
            helix::helix_set_delegation_identities,
            helix::helix_set_config_key_value,
            helix::helix_approval_respond,
            // 审批档位 ⇄ pi-permission 扩展配置（真正阻断工具执行的那一层）
            // 档位可按全局 / 项目 / 会话覆盖，覆盖表就在这份 settings.json 里，
            // 由扩展自己解析 —— 面板显示的档与拦工具的档是同一个返回值。
            approval_policy::helix_get_permission_mode,
            approval_policy::helix_set_permission_mode,
            approval_policy::helix_clear_permission_override,
            approval_policy::helix_set_approval_timeout_sec,
            // 用户规则（settings.json → permission.userRules）读写口
            approval_policy::helix_get_permission_rules,
            approval_policy::helix_set_permission_rules,
            // 系统通知开关（config.yaml → notifications: 块）+ 跳转系统通知设置
            desktop_notify::helix_notification_config,
            desktop_notify::helix_set_notification_config,
            desktop_notify::helix_open_notification_settings,
            // embedded sidebar browser
            helix::poll_browser_requests,
            helix::browser_write_result,
            helix::helix_set_model,
            helix::helix_register_provider_models,
            helix::helix_list_memories,
            helix::helix_add_memory_entry,
            helix::helix_remove_memory_entry,
            helix::helix_memory_overview,
            helix::helix_set_memory_enabled,
            helix::helix_delete_memory,
            helix::helix_memory_config,
            helix::helix_set_memory_config,
            helix::helix_codemode_config,
            helix::helix_set_codemode_config,
            // Memory status
            // Personality management
            // Plugin installation
            // fs
            fs::read,
            fs::write,
            fs::edit,
            fs::readdir,
            fs::stat,
            fs::rename,
            fs::delete,
            fs::scan_tree,
            fs::allow_root,
            fs::helix_memory_dir,
            // 会话级文件快照：一轮 run 前存「改动前」的内容，可整轮回滚
            fs::snapshot_save,
            fs::snapshot_restore,
            fs::snapshot_discard,
            // file-based skills (slash-command picker / skill panel)
            skills::helix_get_skills_dir,
            skills::helix_read_dir,
            skills::helix_read_file,
            skills::helix_delete_dir,
            skills::helix_list_skills,
            skills::helix_list_subagents,
            skills::helix_set_subagent_enabled,
            skills::helix_set_subagent_model,
            skills::helix_delete_subagent,
            // auxiliary vision model (image → description)
            vision::vision_config_list,
            vision::vision_config_save,
            vision::vision_describe,
            image_model::image_config_list,
            image_model::image_config_save,
            // 联网搜索（web-access 扩展的 web_search: 配置块）
            web_search::web_search_config_list,
            web_search::web_search_config_save,
            // SSH connections
            ssh::ssh_connect,
            // 一键远程连接（agent 远程跑）
            remote_connect::remote_connect,
            remote_connect::remote_disconnect,
            remote_connect::remote_tunnel_status,
            remote_connect::remote_list_paths,
            remote_connect::remote_preflight,
            // hooks (hooks: block in config.yaml)
            hooks::hooks_list,
            hooks::hooks_save,
            // delegations (subagent live transcript browser)
            delegations::delegations_list,
            delegations::delegations_read_log,
            delegations::subagent_timeline,
            pi_gateway::subagent_map,
            // background tasks (pi-background-tasks extension registry)
            background_tasks::tasks_list,
            background_tasks::tasks_read,
            background_tasks::tasks_kill,
            // window
            window::minimize,
            window::maximize,
            window::unmaximize,
            window::close,
            window::is_maximized,
            window::toggle_devtools,
            window::new_window,
            // shell / dialog / security
            security::open,
            security::show_item_in_folder,
            security::open_path,
            security::exec,
            security::secure_available,
            security::secure_encrypt,
            security::secure_decrypt,
            security::open_directory,
            security::open_file,
            security::save_file,
            // terminal
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            // page fetch (browser pick-element) + iframe 嵌入能力探测
            page_fetch::page_fetch,
            page_fetch::page_frame_policy,
            browser_webview::browser_webview_open,
            browser_webview::browser_webview_set_rect,
            browser_webview::browser_webview_navigate,
            browser_webview::browser_webview_history,
            browser_webview::browser_webview_eval,
            browser_webview::browser_webview_screenshot,
            browser_webview::browser_webview_close,
            browser_webview::browser_webview_focus,
            browser_webview::browser_storage_usage,
            browser_webview::browser_clear_data,
            browser_webview::browser_read_upload_file,
            browser_import::browser_import_detect,
            browser_import::browser_import_passwords,
            // git
            git::status,
            git::diff,
            git::diff_head,
            git::diff_numstat,
            git::diff_numstat_full,
            git::revert,
            git::stage,
            git::unstage,
            git::commit,
            git::branch_list,
            git::branch_switch,
            git::branch_create,
            git::current_branch,
            git::log,
            git::worktree_list,
            git::worktree_add,
            git::worktree_remove,
            git::worktree_lock,
            git::worktree_unlock,
            git::worktree_prune,
            git::push,
            git::pull,
            git::fetch,
            // github pr
            github::gh_status,
            github::gh_repo,
            github::pr_create,
            github::pr_list,
            // diagnostics（跑项目自带的类型检查/lint）
            diagnostics::diagnostics_detect,
            diagnostics::diagnostics_run,
            // app
            app::get_info,
            app::get_sessions_dir,
            app::get_workspace_default_dir,
            app::get_status,
            app::helix_update,
            app::helix_update_install,
            app::sync_work_dir,
            app::set_work_dir,
            app::get_data_root,
            app::set_data_root,
            // proxy
            proxy::proxy_get,
            proxy::proxy_set,
            // profile
            profile::cache_config,
            // scheduled tasks
            scheduled_tasks::scheduled_tasks_list,
            scheduled_tasks::create,
            scheduled_tasks::update,
            scheduled_tasks::remove,
            // cron aliases
            // Pi agent commands (extensions/skills/prompts listing)
            helix::pi_list_installed,
            helix::pi_set_package_enabled,
            helix::pi_get_available_models,
            helix::pi_read_custom_providers,
            helix::pi_set_thinking_level_all,
            // 渠道中心：一次性 pi RPC 进程执行 pi-connect 的 /connect 命令
            pi_connect::pi_connect_query,
            helix::pi_search_packages,
            helix::pi_install_package,
            helix::pi_uninstall_package,
            helix::pi_check_updates,
            // gateway MCP servers (config.yaml mcp_servers, read/write)
            mcp::mcp_config_list,
            mcp::mcp_config_save,
            // subagents settings (config.yaml `subagents:` block, read/write,
            // mirrored into the extension's settings.json on save)
            subagents::subagents_settings_list,
            subagents::subagents_settings_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
