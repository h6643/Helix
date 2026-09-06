//! File-based skills: SKILL.md directories under `<data_dir>/skills`.
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
    helix_data_dir().join("skills")
}

fn plugins_dir() -> PathBuf {
    helix_data_dir().join("plugins")
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
    pub description: String,
    #[serde(rename = "isBuiltin")]
    pub is_builtin: bool,
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
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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

/// List every `SKILL.md` directory under the skills dir.
///
/// The skills dir uses a two-level layout (helix/claude skills convention):
/// `<skills>/<category>/<skill>/SKILL.md`, plus `<skills>/<skill>/SKILL.md`
/// for top-level skills. Directories starting with `.` (e.g. `.system`) hold
/// runtime-managed builtin skills — they are listed with `isBuiltin: true`.
///
/// Frontmatter fields are simple `name:` / `description:` single-line values;
/// anything missing falls back to the directory name / empty string.
#[tauri::command]
pub fn helix_list_skills() -> Vec<SkillEntry> {
    let root = skills_dir();
    let usage = read_usage();
    let Ok(top) = std::fs::read_dir(&root) else {
        return vec![];
    };
    let mut out: Vec<SkillEntry> = Vec::new();
    for entry in top.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let builtin = dir_name.starts_with('.');
        // Depth 1: <skills>/<skill>/SKILL.md
        if let Some(skill) = read_skill_dir(&entry.path(), &dir_name, &dir_name, builtin, &usage) {
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
            if let Some(skill) = read_skill_dir(&child.path(), &id, &child_name, builtin, &usage) {
                out.push(skill);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Build a SkillEntry if `dir` contains a SKILL.md.
/// `id` — stable identifier (relative path); `fallback_name` — dir name used
/// when frontmatter has no `name:`; `builtin` — dot-directory flag.
fn read_skill_dir(
    dir: &Path,
    id: &str,
    fallback_name: &str,
    builtin: bool,
    usage: &HashMap<String, u64>,
) -> Option<SkillEntry> {
    let content = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (name, description) = parse_skill_frontmatter(&content);
    let name = name.unwrap_or_else(|| fallback_name.to_string());
    let call_count = usage.get(&name).copied().unwrap_or(0);
    Some(SkillEntry {
        id: id.to_string(),
        name,
        description: description.unwrap_or_default(),
        is_builtin: builtin,
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
