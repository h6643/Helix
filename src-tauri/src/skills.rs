//! File-based skills: SKILL.md directories under pi's skill roots.
//!
//! Tauri port of the Electron `helixSkills` bridge (main.js). The renderer's
//! slash-command picker (`/…`) and the skill management panel both consume
//! these commands; without them `invoke('helix_list_skills')` rejects and no
//! skills show up in the composer.

use crate::paths::helix_data_dir;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn skills_dir() -> PathBuf {
    // The user-managed skills root pi actually loads. (Legacy Helix used
    // `<helix_data_dir>/skills`; pi never reads that, so listing it only showed
    // phantom entries.)
    pi_user_skills_dir()
}

/// `~/.pi/agent/skills/` — pi's user skill root.
fn pi_user_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("skills")
}

/// `~/.pi/agent/pi-hermes-memory/skills/` — skills the pi-hermes-memory
/// extension registers at runtime (created via its skill_manage tool).
fn pi_memory_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("pi-hermes-memory")
        .join("skills")
}

/// `~/.pi/agent/npm/` — pi's package store (`pi install` target).
fn pi_npm_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("npm")
}

fn plugins_dir() -> PathBuf {
    // pi's user extension root (what the installed-plugins list reflects).
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("extensions")
}

/// Per-skill invocation counters, persisted outside the skills dir so user
/// deletions/edits of skill folders never wipe usage history.
fn usage_path() -> PathBuf {
    helix_data_dir().join("skill_usage.json")
}

fn read_usage() -> HashMap<String, u64> {
    std::fs::read_to_string(usage_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

#[derive(Serialize)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "commandName")]
    pub command_name: String,
    pub description: String,
    #[serde(rename = "isBuiltin")]
    pub is_builtin: bool,
    /// Where the skill is loaded from: "pi" (user root ~/.pi/agent/skills),
    /// "memory" (pi-hermes-memory extension managed), or the bundling npm package
    /// name (e.g. "pi-subagents").
    pub source: String,
    pub path: String,
    #[serde(rename = "callCount")]
    pub call_count: u64,
}

#[tauri::command]
pub fn helix_get_skills_dir() -> Option<String> {
    skills_dir().to_str().map(str::to_string)
}

#[tauri::command]
pub fn helix_get_plugins_dir() -> Option<String> {
    plugins_dir().to_str().map(str::to_string)
}

#[tauri::command]
pub fn helix_read_dir(dir_path: String) -> Vec<DirEntryInfo> {
    let Ok(entries) = std::fs::read_dir(&dir_path) else {
        return vec![];
    };
    let mut out: Vec<DirEntryInfo> = entries
        .filter_map(|e| e.ok())
        .map(|e| DirEntryInfo {
            is_directory: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            name: e.file_name().to_string_lossy().into_owned(),
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// Read a text file. Unrestricted (mirrors the Electron bridge): the renderer
/// also uses it to import Chrome bookmarks from outside the skills dir.
#[tauri::command]
pub fn helix_read_file(file_path: String) -> Option<String> {
    std::fs::read_to_string(&file_path).ok()
}

/// Delete a skill directory. Guarded: only paths inside the skills dir may be
/// removed (its sole renderer use is deleting a listed skill folder), and
/// dot-directories (builtin skills like `.system`) are protected.
#[tauri::command]
pub fn helix_delete_dir(dir_path: String) -> bool {
    let target = Path::new(&dir_path);
    let root = skills_dir();
    match (target.canonicalize(), root.canonicalize()) {
        (Ok(t), Ok(r)) if t.starts_with(&r) && t != r => {
            let is_builtin = t
                .strip_prefix(&r)
                .ok()
                .and_then(|rel| rel.components().next())
                .map(|c| c.as_os_str().to_string_lossy().starts_with('.'))
                .unwrap_or(true);
            !is_builtin && std::fs::remove_dir_all(t).is_ok()
        }
        _ => false,
    }
}

/// List every SKILL.md directory pi actually loads:
///   ~/.pi/agent/skills/<skill>/ (and <category>/<skill>/) — user root
///   ~/.pi/agent/pi-hermes-memory/skills/… — memory-extension managed
///   ~/.pi/agent/npm/node_modules/<pkg>/<pi.skills paths>/… — package-bundled
/// Directories starting with `.` are listed with `isBuiltin: true`.
#[tauri::command]
pub fn helix_list_skills() -> Vec<SkillEntry> {
    let usage = read_usage();
    let mut out: Vec<SkillEntry> = Vec::new();

    // ── Pi user skills (~/.pi/agent/skills/) ──
    if let Ok(top) = std::fs::read_dir(skills_dir()) {
        collect_skills_from_dir(top, &mut out, &usage, "pi", false);
    }

    // ── Memory-extension managed skills ──
    if let Ok(top) = std::fs::read_dir(pi_memory_skills_dir()) {
        collect_skills_from_dir(top, &mut out, &usage, "memory", true);
    }

    // ── Skills bundled with pi npm packages ──
    collect_package_skills(&mut out, &usage);

    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// Scan `~/.pi/agent/npm/node_modules/<dep>/` for skills declared via the
/// `pi.skills` manifest field (same rule pi itself uses — undeclared `skills/`
/// directories are NOT loaded, so they are not listed either).
fn collect_package_skills(out: &mut Vec<SkillEntry>, usage: &HashMap<String, u64>) {
    let npm = pi_npm_dir();
    let Ok(content) = std::fs::read_to_string(npm.join("package.json")) else {
        return;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(deps) = pkg
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let node_modules = npm.join("node_modules");
    for dep_name in deps.keys() {
        let pkg_dir = node_modules.join(dep_name);
        let Ok(meta_raw) = std::fs::read_to_string(pkg_dir.join("package.json")) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) else {
            continue;
        };
        // Only declared paths (glob/exclusion entries are skipped — the
        // directory scan below covers what a plain dir glob would match).
        let Some(roots) = meta
            .pointer("/pi/skills")
            .and_then(serde_json::Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| !s.contains('*') && !s.starts_with('!'))
                    .map(|s| pkg_dir.join(s.trim_start_matches("./")))
                    .collect::<Vec<_>>()
            })
        else {
            continue;
        };
        for root in roots {
            if let Ok(top) = std::fs::read_dir(&root) {
                collect_skills_from_dir(top, out, usage, dep_name, true);
            }
        }
    }
}

fn collect_skills_from_dir(
    top: std::fs::ReadDir,
    out: &mut Vec<SkillEntry>,
    usage: &HashMap<String, u64>,
    source: &str,
    builtin: bool,
) {
    for entry in top.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let builtin = builtin || dir_name.starts_with('.');
        // Depth 1: <skills>/<skill>/SKILL.md
        if let Some(skill) =
            read_skill_dir(&entry.path(), &dir_name, &dir_name, builtin, source, usage)
        {
            out.push(skill);
            continue;
        }
        // Depth 2: <skills>/<category>/<skill>/SKILL.md
        let Ok(children) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        for child in children.filter_map(|e| e.ok()) {
            if !child.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let child_name = child.file_name().to_string_lossy().into_owned();
            let id = format!("{dir_name}/{child_name}");
            if let Some(skill) =
                read_skill_dir(&child.path(), &id, &child_name, builtin, source, usage)
            {
                out.push(skill);
            }
        }
    }
}

/// Build a SkillEntry if `dir` contains a SKILL.md.
/// `id` — stable identifier (relative path); `fallback_name` — dir name used
/// when frontmatter has no `name:`; `builtin` — non-user-managed flag (dot
/// directory, memory-managed, or package-bundled).
fn read_skill_dir(
    dir: &Path,
    id: &str,
    fallback_name: &str,
    builtin: bool,
    source: &str,
    usage: &HashMap<String, u64>,
) -> Option<SkillEntry> {
    let content = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (name, description) = parse_skill_frontmatter(&content);
    let name = name.unwrap_or_else(|| fallback_name.to_string());
    let call_count = usage.get(&name).copied().unwrap_or(0);
    Some(SkillEntry {
        id: id.to_string(),
        name: name.clone(),
        // Slash-command invocation name for the pi skill engine
        // (`/skill:<name>`), serialized to the frontend as commandName.
        command_name: name,
        description: description.unwrap_or_default(),
        is_builtin: builtin,
        source: source.to_string(),
        path: dir.to_string_lossy().into_owned(),
        call_count,
    })
}

/// Record one invocation of `skill_name`; returns the new call count.
#[tauri::command]
pub fn helix_track_skill_call(skill_name: String) -> u64 {
    let mut usage = read_usage();
    let count = usage.entry(skill_name).or_insert(0);
    *count += 1;
    let new_count = *count;
    if let Ok(raw) = serde_json::to_string(&usage) {
        let _ = std::fs::write(usage_path(), raw);
    }
    new_count
}

/// Extract `name` / `description` from a SKILL.md YAML frontmatter block.
fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if in_frontmatter {
                break; // closing delimiter
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("name:") {
            name = Some(clean_yaml_scalar(v));
        } else if let Some(v) = trimmed.strip_prefix("description:") {
            description = Some(clean_yaml_scalar(v));
        }
    }
    (name, description)
}

fn clean_yaml_scalar(v: &str) -> String {
    let v = v.trim();
    let v = v.trim_matches(|c| c == '"' || c == '\'');
    v.trim().to_string()
}

/// A subagent preset bundled with the `pi-subagents` pi extension
/// (`~/.pi/agent/npm/node_modules/pi-subagents/agents/<name>.md`).
///
/// These are pi's own delegation personas — richer than helix's
/// `delegation.identities` (which only carry name + system_prompt). The
/// Subagent settings page surfaces them read-only so the user can see what the
/// extension makes available alongside their own configured identities.
#[derive(Serialize)]
pub struct SubagentPreset {
    pub id: String,
    pub name: String,
    #[serde(rename = "description")]
    pub description: String,
    #[serde(rename = "tools")]
    pub tools: Vec<String>,
    pub thinking: String,
    #[serde(rename = "aliases")]
    pub aliases: Vec<String>,
    #[serde(rename = "systemPromptMode")]
    pub system_prompt_mode: String,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    pub path: String,
    /// True when the preset lives in the package's `.helix-disabled` folder
    /// (moved out of `agents/`) and is therefore skipped by pi at runtime.
    #[serde(rename = "disabled")]
    pub disabled: bool,
}

/// Split a YAML scalar that is a comma-separated list into trimmed items.
fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

/// Parse an `agents/<name>.md` file: frontmatter map + the body (system prompt).
fn parse_subagent_md(content: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut fm = std::collections::HashMap::new();
    let mut body = String::new();
    let mut in_frontmatter = false;
    let mut after_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if !in_frontmatter {
                in_frontmatter = true;
                continue;
            }
            after_frontmatter = true;
            continue;
        }
        if in_frontmatter && !after_frontmatter {
            if let Some((k, v)) = trimmed.split_once(':') {
                fm.insert(k.trim().to_string(), v.trim().to_string());
            }
        } else if after_frontmatter {
            body.push_str(line);
            body.push('\n');
        }
    }
    (fm, body.trim().to_string())
}

/// Scan a directory of `*.md` subagent presets, tagging each with `disabled`.
fn scan_subagents(dir: &Path, disabled: bool) -> Vec<SubagentPreset> {
    let mut out: Vec<SubagentPreset> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&p) else {
            continue;
        };
        let (fm, body) = parse_subagent_md(&content);
        let id = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm.get("name").cloned().unwrap_or_else(|| id.clone());
        out.push(SubagentPreset {
            id,
            name,
            description: fm.get("description").cloned().unwrap_or_default(),
            tools: fm.get("tools").map(|s| split_csv(s)).unwrap_or_default(),
            thinking: fm.get("thinking").cloned().unwrap_or_default(),
            aliases: fm.get("aliases").map(|s| split_csv(s)).unwrap_or_default(),
            system_prompt_mode: fm.get("systemPromptMode").cloned().unwrap_or_default(),
            system_prompt: body,
            path: p.to_string_lossy().into_owned(),
            disabled,
        });
    }
    out
}

/// List the subagent presets shipped by the installed `pi-subagents` extension.
/// Enabled presets live in `agents/`; disabled ones live in `.helix-disabled/`.
/// Returns an empty list when the package is not installed, so the renderer can
/// simply skip the section.
#[tauri::command]
pub fn helix_list_subagents() -> Vec<SubagentPreset> {
    let pkg = pi_npm_dir()
        .join("node_modules")
        .join("pi-subagents");
    let mut out = scan_subagents(&pkg.join("agents"), false);
    out.extend(scan_subagents(&pkg.join(".helix-disabled"), true));
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// Enable or disable a bundled pi-subagents preset by moving its `agents/<name>.md`
/// into / out of the `.helix-disabled` folder.
///
/// - `enabled = false` → move `agents/<name>.md` → `.helix-disabled/<name>.md`
///   (pi only scans `agents/*.md`, so the preset is skipped at runtime).
/// - `enabled = true`  → move it back.
///
/// This is a fully reversible alternative to `helix_delete_subagent`: the file is
/// never destroyed, just parked outside pi's scan root.
///
/// Safety: `name` is restricted to `[A-Za-z0-9_-]`, and the resolved source path
/// is canonicalized and asserted to stay inside either `agents/` or
/// `.helix-disabled/` (defends against traversal / symlink escape).
#[tauri::command]
pub fn helix_set_subagent_enabled(name: String, enabled: bool) -> Result<(), String> {
    let pkg = pi_npm_dir()
        .join("node_modules")
        .join("pi-subagents");
    if !pkg.is_dir() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("非法的预设名".to_string());
    }
    let agents_dir = pkg.join("agents");
    let disabled_dir = pkg.join(".helix-disabled");
    let agents_canon = std::fs::canonicalize(&agents_dir).map_err(|e| e.to_string())?;
    let (src, dst) = if enabled {
        (disabled_dir.join(format!("{name}.md")), agents_dir.join(format!("{name}.md")))
    } else {
        (agents_dir.join(format!("{name}.md")), disabled_dir.join(format!("{name}.md")))
    };
    if !src.is_file() {
        return Err(format!("预设 {name} 在源位置不存在"));
    }
    let src_canon = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
    let mut ok = src_canon.starts_with(&agents_canon);
    if !ok && disabled_dir.is_dir() {
        let disabled_canon = std::fs::canonicalize(&disabled_dir).map_err(|e| e.to_string())?;
        ok = src_canon.starts_with(&disabled_canon);
    }
    if !ok {
        return Err("路径越界".to_string());
    }
    std::fs::create_dir_all(&disabled_dir).map_err(|e| e.to_string())?;
    std::fs::rename(&src_canon, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

/// Permanently remove a subagent preset bundled by the `pi-subagents` extension
/// by moving its `<name>.md` out of the scanned directory (whether it currently
/// lives in `agents/` or `.helix-disabled/`).
///
/// Safety:
/// - The `name` is restricted to `[A-Za-z0-9_-]` so it can never escape the
///   package folder via path traversal.
/// - Even after validation we canonicalize the resolved path and assert it is
///   still inside `agents_dir` or `.helix-disabled/` (defends against symlinks).
/// - The file is **moved** (not deleted) to `<package>/.helix-deleted/<name>.md`
///   so the removal is recoverable; pi never scans that folder.
#[tauri::command]
pub fn helix_delete_subagent(name: String) -> Result<(), String> {
    let pkg = pi_npm_dir()
        .join("node_modules")
        .join("pi-subagents");
    if !pkg.is_dir() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("非法的预设名".to_string());
    }
    let agents_dir = pkg.join("agents");
    let disabled_dir = pkg.join(".helix-disabled");
    let agents_canon = std::fs::canonicalize(&agents_dir).map_err(|e| e.to_string())?;
    let candidates = [
        agents_dir.join(format!("{name}.md")),
        disabled_dir.join(format!("{name}.md")),
    ];
    let mut found: Option<PathBuf> = None;
    for c in candidates {
        if c.is_file() {
            let c_canon = std::fs::canonicalize(&c).map_err(|e| e.to_string())?;
            let mut inside = c_canon.starts_with(&agents_canon);
            if !inside && disabled_dir.is_dir() {
                let disabled_canon =
                    std::fs::canonicalize(&disabled_dir).map_err(|e| e.to_string())?;
                inside = c_canon.starts_with(&disabled_canon);
            }
            if inside {
                found = Some(c_canon);
                break;
            }
        }
    }
    let target = found.ok_or_else(|| format!("预设 {name} 不存在"))?;
    let backup_dir = pkg.join(".helix-deleted");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    std::fs::rename(&target, backup_dir.join(format!("{name}.md"))).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_skills_matches_pi_load_roots() {
        let skills = helix_list_skills();
        for s in &skills {
            // No phantom ~/.codex entries may leak through
            assert!(!s.path.contains(".codex"), "phantom skill: {}", s.path);
            assert!(std::path::Path::new(&s.path).join("SKILL.md").exists());
        }
        // The pi user root (~/.pi/agent/skills) is machine-specific — only
        // assert on it when the reference skill actually exists on disk,
        // otherwise the test breaks on any machine without that skill.
        let coding_standards_dir = pi_user_skills_dir()
            .join("coding-standards")
            .join("SKILL.md");
        if coding_standards_dir.is_file() {
            assert!(skills
                .iter()
                .any(|s| s.name == "coding-standards" && s.source == "pi"));
        }
        // pi-subagents bundles council-mode + pi-subagents skills. The bundle
        // scan only runs when the package is installed on this machine.
        let subagents_pkg = pi_npm_dir()
            .join("node_modules")
            .join("pi-subagents")
            .join("package.json");
        if subagents_pkg.is_file() {
            let bundled: Vec<_> = skills
                .iter()
                .filter(|s| s.source == "pi-subagents")
                .map(|s| s.name.clone())
                .collect();
            assert!(
                bundled.contains(&"council-mode".to_string()),
                "bundled: {bundled:?}"
            );
            assert!(
                bundled.contains(&"pi-subagents".to_string()),
                "bundled: {bundled:?}"
            );
        }
        println!(
            "ALL SKILLS: {:#?}",
            skills
                .iter()
                .map(|s| (s.name.as_str(), s.source.as_str()))
                .collect::<Vec<_>>()
        );
    }
}
