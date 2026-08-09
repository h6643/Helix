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
mod scheduled_tasks;
mod security;
mod state;
mod terminal;
mod web_search;
mod window;

use crate::state::{AppState, APP_HANDLE};
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state.clone())
        .setup(move |app| {
            // Expose the AppHandle globally so background gateway threads can
            // emit `hermes:event` without threading a handle through every call.
            let _ = APP_HANDLE.set(app.handle().clone());

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
            if let Err(e) = gateway::spawn_gateway(&app_state) {
                eprintln!("[Helix] gateway failed to start: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::{Emitter, WindowEvent};
            // Notify renderer of maximize state changes (custom titlebar buttons).
            if let WindowEvent::Resized(_) = event {
                let maximized = window.is_maximized().unwrap_or(false);
                let _ = window.emit("window:maximized-changed", maximized);
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
            hermes::hermes_transcribe,
            hermes::hermes_record_start,
            hermes::hermes_record_stop,
            hermes::hermes_tts_speak,
            hermes::hermes_tts_stop,
            hermes::hermes_tts_speak_stream,
            hermes::hermes_wake_start,
            hermes::hermes_wake_control,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
