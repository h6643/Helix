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
        // coding-standards lives in the pi user root
        assert!(skills
            .iter()
            .any(|s| s.name == "coding-standards" && s.source == "pi"));
        // pi-subagents bundles council-mode + pi-subagents skills
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
        println!(
            "ALL SKILLS: {:#?}",
            skills
                .iter()
                .map(|s| (s.name.as_str(), s.source.as_str()))
                .collect::<Vec<_>>()
        );
    }
}
