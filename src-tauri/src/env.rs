//! Shared environment-cleaning utility for hermes subprocess calls.

/// Build a sanitized environment map for spawning hermes sub-processes.
/// Strips npm/node lifecycle variables and rewrites PATH to include the
/// hermes binary's directory while excluding `node_modules/.bin`.
pub(crate) fn build_clean_env(hermes_bin: &std::path::Path) -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.retain(|k, _| {
        if k == "PATH" || k == "Path" || k == "path" {
            return true;
        }
        !(k.starts_with("npm_")
            || k == "INIT_CWD"
            || k == "NODE"
            || k == "NODE_EXE"
            || k == "NPM_CLI_JS"
            || k == "NPM_PREFIX_JS"
            || k == "NPM_PREFIX_NPM_CLI_JS"
            || k == "npm_command"
            || k == "npm_execpath"
            || k == "npm_node_execpath"
            || k == "npm_lifecycle_event"
            || k == "npm_lifecycle_script"
            || k == "COLOR"
            || k == "FORCE_COLOR"
            || k == "EFC_8920")
    });
    let hermes_bin_dir = hermes_bin
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let path_sep = if cfg!(windows) { ';' } else { ':' };
    let mut clean_path: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(path_sep)
        .filter(|p| !p.is_empty())
        .filter(|p| !p.to_lowercase().contains("node_modules/.bin") && !p.to_lowercase().contains("npm/node_modules"))
        .map(|s| s.to_string())
        .collect();
    if !hermes_bin_dir.is_empty() && !clean_path.contains(&hermes_bin_dir) {
        clean_path.insert(0, hermes_bin_dir);
    }
    env.insert("PATH".to_string(), clean_path.join(&path_sep.to_string()));
    env
}
