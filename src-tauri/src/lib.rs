//! Helix Tauri backend crate.

mod app;
mod config;
mod delegations;
mod external;
mod fs;
mod gateway;
mod git;
mod helix;
mod hooks;
mod mcp;
mod memory;
mod page_fetch;
mod paths;
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
mod profile;
mod proxy;
mod scheduled_tasks;
mod security;
mod skills;
pub mod ssh;
mod state;
mod terminal;
mod vision;
mod web_search;
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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second Helix process was launched. Instead of opening another
            // window, focus the already-running one (mirror tray "show").
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
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

            // One-time migration: legacy ~/.codex / ~/.helix → ~/.pi/agent/helix
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

            // Apply the HTTP proxy to the renderer (WebKitGTK default context)
            // BEFORE the gateway spawns so the webview fetches already honor it.
            crate::proxy::apply_webview_proxy();
            std::thread::spawn(move || {
                if let Err(e) = pi_gateway::spawn(&app_state) {
                    eprintln!("[Helix] pi agent failed to start: {e}");
                }
            });

            // ── System tray ──────────────────────
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;
            use tauri::Manager;

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
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => {
                        if let Some(state) =
                            app.try_state::<std::sync::Arc<crate::state::AppState>>()
                        {
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
            // agent backend (helix:* protocol → pi adapter)
            helix::helix_send,
            helix::helix_notify,
            helix::helix_interrupt,
            helix::helix_status,
            helix::helix_get_gateway_info,
            helix::helix_fetch_models,
            helix::helix_get_config,
            helix::helix_set_config,
            helix::helix_set_yaml_key,
            helix::helix_set_delegation_identities,
            helix::helix_set_config_key_value,
            helix::helix_set_reasoning_effort,
            helix::helix_approval_respond,
            helix::helix_set_model,
            helix::helix_set_agent_config,
            helix::helix_list_memories,
            helix::helix_add_memory_entry,
            helix::helix_remove_memory_entry,
            // Memory status
            helix::helix_get_memory_status,
            // Personality management
            helix::helix_list_personalities,
            helix::helix_set_personality,
            // Plugin installation
            helix::helix_install_plugin,
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
            // file-based skills (slash-command picker / skill panel)
            skills::helix_get_skills_dir,
            skills::helix_get_plugins_dir,
            skills::helix_read_dir,
            skills::helix_read_file,
            skills::helix_delete_dir,
            skills::helix_list_skills,
            skills::helix_track_skill_call,
            // auxiliary vision model (image → description)
            vision::vision_config_list,
            vision::vision_config_save,
            vision::vision_describe,
            // SSH connections
            ssh::ssh_connect,
            ssh::ssh_exec,
            ssh::ssh_status,
            ssh::ssh_disconnect,
            // hooks (hooks: block in config.yaml)
            hooks::hooks_list,
            hooks::hooks_save,
            // web search (web: block + provider API keys in .env)
            web_search::web_search_list,
            web_search::web_search_save,
            // delegations (subagent live transcript browser)
            delegations::delegations_list,
            delegations::delegations_read_log,
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
            // page fetch (browser pick-element)
            page_fetch::page_fetch,
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
            app::read_env_key,
            app::get_helix_version,
            app::get_status,
            app::helix_get_raw_config,
            app::helix_set_raw_config,
            app::helix_doctor,
            app::helix_update,
            // external (TCP probe, SSH)
            external::test_connection,
            app::sync_work_dir,
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
            // scheduled tasks
            scheduled_tasks::scheduled_tasks_list,
            scheduled_tasks::create,
            scheduled_tasks::update,
            scheduled_tasks::remove,
            // cron aliases
            scheduled_tasks::helix_cron_list,
            scheduled_tasks::helix_cron_create,
            scheduled_tasks::helix_cron_delete,
            scheduled_tasks::helix_cron_run,
            // Pi agent commands (extensions/skills/prompts listing)
            helix::pi_get_commands,
            helix::pi_list_installed,
            helix::pi_set_package_enabled,
            helix::pi_get_available_models,
            helix::pi_get_state,
            helix::pi_set_model,
            helix::pi_set_thinking_level,
            helix::pi_set_thinking_level_all,
            helix::pi_compact,
            helix::pi_get_session_stats,
            helix::pi_search_packages,
            helix::pi_install_package,
            helix::pi_uninstall_package,
            helix::pi_check_updates,
            helix::pi_package_latest,
            // gateway MCP servers (config.yaml mcp_servers, read/write)
            mcp::mcp_config_list,
            mcp::mcp_config_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
