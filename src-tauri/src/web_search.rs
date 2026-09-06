//! Web Search IPC — read/write `web:` block in Helix config.yaml.
//! Also syncs API keys to .env for runtime access.

use crate::config::{config_yaml_path, env_path, set_yaml_key};
use crate::gateway::{kill_current, spawn_gateway};
use crate::paths::{helix_data_dir, standalone_python};
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// Find every directory that may contain Helix web-search provider plugins.
/// Helix loads built-in providers from its runtime's `site-packages/plugins/web`
/// and user providers from `~/.helix/plugins/web`. We scan all known locations
/// and merge, so the UI can show exactly what is actually installed.
fn web_provider_search_dirs(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();

    // 1) Runtime helix (standalone_python → lib/python3.x/site-packages/plugins/web).
    let py = standalone_python();
    if let Some(lib) = py.parent().map(|p| p.join("lib")) {
        // Hard-coded python3.12 fallback (Helix pins this — see paths.rs).
        dirs.push(
            lib.join("python3.12")
                .join("site-packages")
                .join("plugins")
                .join("web"),
        );
        // Be resilient to version bumps: also walk any lib/python3.x.
        if let Ok(entries) = std::fs::read_dir(&lib) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("python3.") && e.path().is_dir() {
                    dirs.push(e.path().join("site-packages").join("plugins").join("web"));
                }
            }
        }
    }

    // 2) User plugins: ~/.helix/plugins/web
    dirs.push(helix_data_dir().join("plugins").join("web"));
    // 3) Bundled resources: <resource_dir>/helix-runtime/python/lib/python3.12/site-packages/plugins/web
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(
            res.join("helix-runtime")
                .join("python")
                .join("lib")
                .join("python3.12")
                .join("site-packages")
                .join("plugins")
                .join("web"),
        );
    }

    dirs
}

/// Returns the set of web-search provider plugin names actually present on disk.
fn scan_web_providers(app: &AppHandle) -> Vec<String> {
    let mut found: BTreeSet<String> = BTreeSet::new();
    for dir in web_provider_search_dirs(app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                // Skip dunder dirs like __pycache__.
                if name.starts_with("__") {
                    continue;
                }
                found.insert(name);
            }
        }
    }
    found.into_iter().collect()
}

#[tauri::command]
pub fn web_search_list(app: AppHandle, _state: State<'_, Arc<AppState>>) -> Value {
    let yaml_path = config_yaml_path();
    let text = match std::fs::read_to_string(&yaml_path) {
        Ok(t) => t,
        Err(_) => {
            return json!({ "ok": true, "config": { "backend": "", "search_backend": "", "apiKeys": {} } })
        }
    };

    let mut backend = String::new();
    let mut search_backend = String::new();
    let mut in_web = false;

    for line in text.split('\n') {
        if !line.starts_with(' ') && line.starts_with("web:") {
            in_web = true;
            continue;
        }
        if in_web {
            if !line.starts_with(' ') {
                break;
            }
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("backend:") {
                backend = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            } else if let Some(rest) = trimmed.strip_prefix("search_backend:") {
                search_backend = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }
    }

    // Read API keys from .env
    let mut api_keys: serde_json::Map<String, Value> = serde_json::Map::new();
    let search_env_keys = [
        ("TAVILY_API_KEY", "tavily"),
        ("BRAVE_SEARCH_API_KEY", "brave"),
        ("EXA_API_KEY", "exa"),
    ];
    if let Ok(env) = std::fs::read_to_string(env_path()) {
        for line in env.lines() {
            for (env_key, provider) in &search_env_keys {
                if let Some(rest) = line.strip_prefix(&format!("{env_key}=")) {
                    let val = rest.trim().to_string();
                    if !val.is_empty() {
                        api_keys.insert(provider.to_string(), Value::String(val));
                    }
                }
            }
        }
    }

    json!({
        "ok": true,
        "config": {
            "backend": backend,
            "search_backend": search_backend,
            "apiKeys": Value::Object(api_keys),
        },
        "availableProviders": Value::Array(
            scan_web_providers(&app).into_iter().map(Value::String).collect()
        ),
    })
}

#[tauri::command]
pub fn web_search_save(state: State<'_, Arc<AppState>>, config: Value) -> Value {
    if !config.is_object() {
        return json!({ "ok": false, "error": "invalid config" });
    }

    let backend = config.get("backend").and_then(|v| v.as_str()).unwrap_or("");
    let search_backend = config
        .get("search_backend")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let api_keys = config
        .get("apiKeys")
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    let yaml_path = config_yaml_path();
    let mut yaml = std::fs::read_to_string(&yaml_path).unwrap_or_default();

    // Update web: block in config.yaml
    yaml = set_yaml_key(&yaml, "web.backend", &Value::String(backend.to_string()));
    yaml = set_yaml_key(
        &yaml,
        "web.search_backend",
        &Value::String(search_backend.to_string()),
    );

    if let Some(dir) = yaml_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&yaml_path, &yaml);

    // Sync API keys to .env
    let env_path = env_path();
    let mut env_lines: Vec<String> = if let Ok(env) = std::fs::read_to_string(&env_path) {
        env.lines().map(|s| s.to_string()).collect()
    } else {
        Vec::new()
    };

    // Remove old search-related keys
    env_lines.retain(|l| {
        !l.starts_with("TAVILY_API_KEY=")
            && !l.starts_with("BRAVE_SEARCH_API_KEY=")
            && !l.starts_with("EXA_API_KEY=")
    });

    // Add new keys
    if let Some(v) = api_keys.get("tavily").and_then(|v| v.as_str()) {
        if !v.is_empty() {
            env_lines.push(format!("TAVILY_API_KEY={v}"));
        }
    }
    if let Some(v) = api_keys.get("brave").and_then(|v| v.as_str()) {
        if !v.is_empty() {
            env_lines.push(format!("BRAVE_SEARCH_API_KEY={v}"));
        }
    }
    if let Some(v) = api_keys.get("exa").and_then(|v| v.as_str()) {
        if !v.is_empty() {
            env_lines.push(format!("EXA_API_KEY={v}"));
        }
    }

    if let Some(dir) = env_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&env_path, env_lines.join("\n"));

    // Restart gateway so the new keys take effect.
    kill_current(&state);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let _ = spawn_gateway(&state);

    json!({ "ok": true })
}
