//! Helix Tauri backend crate.

mod app;
mod bootstrap;
mod channels;
mod config;
mod delegations;
mod diagnostics;
mod external;
mod fs;
mod gateway;
mod git;
mod hermes;
mod hooks;
mod kanban;
mod kernel;
mod memory;
mod paths;
mod profile;
mod proxy;
mod scheduled_tasks;
mod security;
mod state;
mod terminal;
mod web_search;
mod vision;
mod mcp;
mod window;

use crate::state::{AppState, APP_HANDLE};
use std::sync::Arc;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
.plugin(
    tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // A second Helix process was launched. Instead of opening another
        // window, focus the already-running one (mirror tray "show").
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }),
)
        .manage(app_state.clone())
        .setup(move |app| {
            // Expose the AppHandle globally so background gateway threads can
            // emit `hermes:event` without threading a handle through every call.
            let _ = APP_HANDLE.set(app.handle().clone());

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

            // Boot the Hermes gateway (serve mode by default).
            // First-run bootstrap: extract hermes-agent from resources if needed.
            if let Err(e) = bootstrap::ensure_hermes_agent(app.handle()) {
                eprintln!("[Helix] bootstrap failed: {e}");
            }
            // Apply the HTTP proxy to the renderer (WebKitGTK default context)
            // BEFORE the gateway spawns so the webview fetches already honor it.
            crate::proxy::apply_webview_proxy();
            if let Err(e) = gateway::spawn_gateway(&app_state) {
                eprintln!("[Helix] gateway failed to start: {e}");
            }

            // ── System tray ──────────────────────────────────────────────
            use tauri::Manager;
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;

            let show_item = MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let new_item = MenuItemBuilder::with_id("new", "新建对话").build(app)?;
            let recent_item = MenuItemBuilder::with_id("recent", "最近对话").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &new_item, &recent_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .tooltip("Helix")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "quit" => {
                            if let Some(state) = app.try_state::<std::sync::Arc<crate::state::AppState>>() {
                                crate::gateway::shutdown(&state);
                            }
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "new" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = app.emit("tray:new-conversation", ());
                            }
                        }
                        "recent" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = app.emit("tray:show-recent", ());
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::{Emitter, WindowEvent};
            match event {
                WindowEvent::Resized(_) => {
                    let maximized = window.is_maximized().unwrap_or(false);
                    let _ = window.emit("window:maximized-changed", maximized);
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // Minimize to tray instead of closing.
                    let _ = window.hide();
                    api.prevent_close();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // hermes gateway
            hermes::hermes_send,
            hermes::hermes_notify,
            hermes::hermes_interrupt,
            hermes::hermes_status,
            hermes::hermes_get_gateway_info,
            hermes::hermes_set_gateway_mode,
            hermes::hermes_fetch_models,
            hermes::hermes_get_raw_config,
            hermes::hermes_set_raw_config,
            hermes::hermes_get_memory_status,
            hermes::hermes_get_memory_provider_config,
            hermes::hermes_set_memory_provider_config,
            hermes::hermes_memory_provider_setup,
            hermes::hermes_get_config,
            hermes::hermes_set_config,
            hermes::hermes_set_yaml_key,
            hermes::hermes_set_delegation_identities,
            hermes::hermes_set_agent_config,
            hermes::hermes_set_reasoning_effort,
            hermes::hermes_set_config_key_value,
            hermes::hermes_approval_respond,
            hermes::hermes_list_personalities,
            hermes::hermes_update,
            hermes::hermes_install_plugin,
            hermes::hermes_set_personality,
            hermes::hermes_set_model,
            hermes::hermes_get_skills_dir,
            hermes::hermes_get_plugins_dir,
            hermes::hermes_read_dir,
            hermes::hermes_read_file,
            hermes::hermes_list_memories,
            hermes::hermes_add_memory_entry,
            hermes::hermes_remove_memory_entry,
            hermes::hermes_list_skills,
            hermes::hermes_track_skill_call,
            hermes::hermes_delete_dir,
            hermes::hermes_cron_list,
            hermes::hermes_cron_create,
            hermes::hermes_cron_delete,
            hermes::hermes_cron_run,
            hermes::hermes_doctor,
            // fs
            fs::read,
            fs::write,
            fs::edit,
            fs::readdir,
            fs::stat,
            fs::rename,
            fs::delete,
            fs::scan_tree,
            fs::hermes_memory_dir,
            fs::allow_root,
            // window
            window::minimize,
            window::maximize,
            window::unmaximize,
            window::close,
            window::is_maximized,
            window::toggle_devtools,
            window::new_window,
            window::start_drag,
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
            // git
            git::status,
            git::diff,
            git::diff_head,
            git::diff_numstat,
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
            // app
            app::get_info,
            app::sync_work_dir,
            app::get_hermes_version,
            app::set_work_dir,
            app::get_data_root,
            app::set_data_root,
            // proxy
            proxy::proxy_get,
            proxy::proxy_set,
            app::restart_gateway,
            app::quit,
            // profile
            profile::cache_config,
            profile::activate_profile,
            profile::profile_list,
            // external
            external::test_connection,
            // scheduled tasks
            scheduled_tasks::scheduled_tasks_list,
            scheduled_tasks::create,
            scheduled_tasks::update,
            scheduled_tasks::remove,
            // hooks
            hooks::hooks_list,
            hooks::hooks_save,
            // web search
            web_search::web_search_list,
            web_search::web_search_save,
            // vision model
            vision::vision_config_list,
            vision::vision_config_save,
            // gateway MCP servers (config.yaml mcp_servers, read-only)
            mcp::mcp_config_list,
            // channels
            channels::channels_list,
            channels::channels_save,
            // kanban
            kanban::command,
            // delegations
            delegations::delegations_list,
            delegations::delegations_read_log,
            // diagnostics
            diagnostics::get_status,
            diagnostics::dbg_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
