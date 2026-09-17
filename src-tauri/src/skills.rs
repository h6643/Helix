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
    /// Where the skill is loaded from: "pi" (user root ~/.pi/agent/skills) or
    /// the bundling npm package name (e.g. "pi-subagents").
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
/// directory, or package-bundled).
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

/// A subagent type as the `pi-subagents` extension actually resolves it.
///
/// The extension merges three compiled defaults (general-purpose / Explore /
/// Plan, src/default-agents.ts) with `<work_dir>/.pi/agents/*.md`,
/// `<work_dir>/.agents/agents/*.md` and `~/.pi/agent/agents/*.md`
/// (src/custom-agents.ts — project overrides global). Disabling an agent is
/// an `enabled: false` line in its frontmatter; the extension never moves
/// files, so this bridge edits frontmatter the same way its `/agents`
/// command does (src/agent-file-toggle.ts).
#[derive(Serialize)]
pub struct SubagentPreset {
    /// Registry key: the `subagent_type` the model passes to the Agent tool.
    pub id: String,
    /// Display label (`display_name:`), falling back to the type.
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub model: String,
    pub thinking: String,
    /// `prompt_mode:` ("replace" | "append"); absent means "replace".
    #[serde(rename = "systemPromptMode")]
    pub system_prompt_mode: String,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    /// Absolute path of the defining .md (empty for compiled defaults).
    pub path: String,
    #[serde(rename = "disabled")]
    pub disabled: bool,
    /// "default" | "project" | "workspace" | "global".
    pub source: String,
}

/// Split a YAML scalar that is a comma-separated list into trimmed items.
fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn fm_scalar(fm: &HashMap<String, String>, key: &str) -> String {
    fm.get(key)
        .map(|v| clean_yaml_scalar(v))
        .unwrap_or_default()
}

/// `~/.pi/agent/agents/` — the extension's personal agent dir
/// (`getAgentDir()/agents`).
fn global_agents_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("agents")
}

/// The extension is installed under one of these roots (this machine uses
/// `extensions/pi-subagents-master`). Without it the Agent tool doesn't
/// exist, so the settings section stays hidden.
fn subagents_extension_installed() -> bool {
    let ext = plugins_dir();
    ext.join("pi-subagents").is_dir()
        || ext.join("pi-subagents-master").is_dir()
        || pi_npm_dir()
            .join("node_modules")
            .join("pi-subagents")
            .is_dir()
}

/// Helix's current work dir — the cwd pi instances run with, and therefore
/// the root the extension resolves project agents from.
fn subagents_work_dir() -> PathBuf {
    crate::state::app_state()
        .map(|s| s.work_dir.read().unwrap().clone())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

/// Merged pi-subagents settings: Helix's config.yaml `subagents:` block
/// (canonical, via `crate::subagents`) overlaid by `<work_dir>/.pi/subagents.json`
/// (the extension's own project-level file, highest precedence).
fn merged_subagents_settings(cwd: &Path) -> HashMap<String, serde_json::Value> {
    let mut out: HashMap<String, serde_json::Value> =
        crate::subagents::load_subagents_settings().into_iter().collect();
    let project = cwd.join(".pi").join("subagents.json");
    if let Ok(raw) = std::fs::read_to_string(&project) {
        if let Ok(serde_json::Value::Object(o)) = serde_json::from_str(&raw) {
            for (k, v) in o {
                out.insert(k, v);
            }
        }
    }
    out
}

/// The three agent dirs in load precedence order (project highest), plus the
/// extension's own bundled agents dir (lowest precedence — these are fallback
/// agent types shipped with pi-subagents, e.g. claude.md / codex.md in
/// `~/.pi/agent/extensions/pi-subagents-master/agents/`).
fn subagent_agent_roots() -> Vec<PathBuf> {
    let cwd = subagents_work_dir();
    let ext = plugins_dir();
    let ext_dir = ext
        .join("pi-subagents-master")
        .join("agents")
        .clone();
    let mut roots = vec![
        cwd.join(".pi").join("agents"),
        cwd.join(".agents").join("agents"),
        global_agents_dir(),
    ];
    if ext_dir.is_dir() {
        roots.push(ext_dir);
    }
    roots
}

struct ParsedAgent {
    type_name: String,
    display_name: String,
    description: String,
    tools: Vec<String>,
    model: String,
    thinking: String,
    prompt_mode: String,
    system_prompt: String,
    disabled: bool,
}

/// Parse an `agents/<name>.md` file the way src/custom-agents.ts does:
/// frontmatter map (tolerating a leading UTF-8 BOM) + body as the system
/// prompt. The type is the declared `name:`, falling back to the filename;
/// a name containing `:` is skipped (reserved for plugin-scoped ids).
/// Disabling is `enabled: false` — only the literal spelling, matching what
/// the extension writes and what pi's frontmatter parser keeps as boolean.
fn parse_agent_md(content: &str, filename_stem: &str) -> Option<ParsedAgent> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut fm: HashMap<String, String> = HashMap::new();
    let mut body: Vec<&str> = Vec::new();
    let mut in_frontmatter = false;
    let mut closed = false;
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed == "---" && !closed {
            if i == 0 {
                in_frontmatter = true;
                continue;
            }
            if in_frontmatter {
                closed = true;
                continue;
            }
        }
        if in_frontmatter && !closed {
            if let Some((k, v)) = trimmed.split_once(':') {
                fm.insert(k.trim().to_string(), v.trim().to_string());
            }
        } else {
            body.push(line);
        }
    }
    let declared = fm.get("name").map(|v| clean_yaml_scalar(v));
    if declared.as_deref().is_some_and(|d| d.contains(':')) {
        return None;
    }
    let type_name = declared
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| filename_stem.to_string());
    let prompt_mode = match fm_scalar(&fm, "prompt_mode").to_lowercase().as_str() {
        "append" => "append".to_string(),
        _ => "replace".to_string(),
    };
    let description = {
        let d = fm_scalar(&fm, "description");
        if d.trim().is_empty() {
            type_name.clone()
        } else {
            d
        }
    };
    Some(ParsedAgent {
        type_name,
        display_name: fm_scalar(&fm, "display_name"),
        description,
        tools: fm
            .get("tools")
            .map(|s| split_csv(&clean_yaml_scalar(s)))
            .unwrap_or_default(),
        model: fm_scalar(&fm, "model"),
        thinking: fm_scalar(&fm, "thinking"),
        prompt_mode,
        system_prompt: body.join("\n").trim().to_string(),
        disabled: fm.get("enabled").map(|v| v.trim()) == Some("false"),
    })
}

/// Scan one of the extension's agent dirs. A file that fails to parse is
/// skipped — the loader skips it too (warnSkippedOverride path).
fn scan_agent_dir(dir: &Path, source: &str) -> Vec<SubagentPreset> {
    let mut out: Vec<SubagentPreset> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Some(a) = parse_agent_md(&content, &stem) else {
            continue;
        };
        let name = if a.display_name.trim().is_empty() {
            a.type_name.clone()
        } else {
            a.display_name
        };
        out.push(SubagentPreset {
            id: a.type_name,
            name,
            description: a.description,
            tools: a.tools,
            model: a.model,
            thinking: a.thinking,
            system_prompt_mode: a.prompt_mode,
            system_prompt: a.system_prompt,
            path: p.to_string_lossy().into_owned(),
            disabled: a.disabled,
            source: source.to_string(),
        });
    }
    out
}

/// The extension's compiled DEFAULT_AGENTS (src/default-agents.ts). A user
/// .md declaring the same type overrides these (same-name overlay).
fn default_agent_presets() -> Vec<SubagentPreset> {
    let mk = |id: &str,
              display: &str,
              description: &str,
              tools: Vec<&str>,
              model: &str,
              prompt_mode: &str,
              system_prompt: &str| SubagentPreset {
        id: id.to_string(),
        name: display.to_string(),
        description: description.to_string(),
        tools: tools.into_iter().map(str::to_string).collect(),
        model: model.to_string(),
        thinking: String::new(),
        system_prompt_mode: prompt_mode.to_string(),
        system_prompt: system_prompt.to_string(),
        path: String::new(),
        disabled: false,
        source: "default".to_string(),
    };
    vec![
        mk(
            "Explore",
            "Explore",
            "Fast read-only agent for targeted code and file searches.",
            vec!["read", "bash", "grep", "find", "ls"],
            "",
            "replace",
            "READ-ONLY: never create, modify, move, copy, or delete files, and never run commands that change system state.\nSearch code with grep, find files with find, and read files with read; use bash only for read-only commands.\nUse absolute paths, make independent searches in parallel, and report precise findings.",
        ),
    ]
}

/// List every subagent type the pi-subagents extension would resolve for the
/// current work dir: compiled defaults + project/workspace/global .md files.
///
/// Mirrors the loader's merge (src/agent-types.ts `registerAgents`): defaults
/// first (skipped entirely when `disableDefaultAgents` is set), then user
/// files overlaid in precedence order, so a same-type project file replaces
/// the global one. Case-insensitive on the type id, matching `resolveKeyIn`
/// — first-loaded wins among case variants, as in the loader's map overlay.
#[tauri::command]
pub fn helix_list_subagents() -> Vec<SubagentPreset> {
    if !subagents_extension_installed() {
        return vec![];
    }
    let cwd = subagents_work_dir();
    let settings = merged_subagents_settings(&cwd);
    let defaults_off = settings
        .get("disableDefaultAgents")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut out: Vec<SubagentPreset> = Vec::new();
    let push =
        |p: SubagentPreset, out: &mut Vec<SubagentPreset>, seen: &mut HashMap<String, ()>| {
            let key = p.id.to_lowercase();
            if seen.insert(key, ()).is_none() {
                out.push(p);
            }
        };

    if !defaults_off {
        for p in default_agent_presets() {
            push(p, &mut out, &mut seen);
        }
    }
    // Highest-precedence dir first; later entries are dropped on id clash.
    let ext_dir = plugins_dir()
        .join("pi-subagents-master")
        .join("agents");
    let dirs: Vec<(std::path::PathBuf, &str)> = vec![
        (cwd.join(".pi").join("agents"), "project"),
        (cwd.join(".agents").join("agents"), "workspace"),
        (global_agents_dir(), "global"),
    ]
    .into_iter()
    .filter(|(dir, _)| dir.is_dir())
    .collect();
    for (dir, source) in &dirs {
        for p in scan_agent_dir(dir, source) {
            push(p, &mut out, &mut seen);
        }
    }
    // The extension's bundled agents (claude.md, codex.md, …) act as
    // built-in defaults: source "default" so the UI treats them the same as
    // the compiled presets, but their definitions live in the .md files so
    // they can be updated without recompiling.
    if ext_dir.is_dir() {
        for mut p in scan_agent_dir(&ext_dir, "extension") {
            p.source = "default".to_string();
            push(p, &mut out, &mut seen);
        }
    }
    out
}

/// Locate the .md that defines an agent type, in the loader's precedence
/// order (project → workspace → global). Built-in defaults have no file.
fn find_agent_file(type_name: &str) -> Option<PathBuf> {
    for dir in subagent_agent_roots() {
        let p = dir.join(format!("{type_name}.md"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Set `enabled: false` / remove it — the same frontmatter edit the
/// extension's own `/agents` command performs (src/agent-file-toggle.ts):
///
/// - Has a .md → insert `enabled: false` right after the opening `---`
///   (disable) or strip the line (enable), preserving the file's line
///   endings and formatting. A file that was only a disable-stub is deleted
///   on enable, restoring the compiled default.
/// - No .md (compiled default) → disable writes a stub
///   `---\nenabled: false\n---\n` to `~/.pi/agent/agents/<type>.md`;
///   enable is a no-op (nothing to re-enable).
///
/// The extension re-reads agent files on every Agent call, so changes apply
/// to the next spawn without restarting anything.
#[tauri::command]
pub fn helix_set_subagent_enabled(name: String, enabled: bool) -> Result<(), String> {
    if !subagents_extension_installed() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    if name.trim().is_empty()
        || name.trim() != name
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("非法的预设名".to_string());
    }
    let name = name.trim().to_string();

    if let Some(path) = find_agent_file(&name) {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if is_disable_stub(&content) && enabled {
            // Stub only existed to disable a compiled default — removing it
            // restores the default (mirrors enableAgent's stub branch).
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            return Ok(());
        }
        let updated = if enabled {
            strip_enabled_false(&content).ok_or_else(|| format!("{name} 未处于禁用状态"))?
        } else {
            insert_enabled_false(&content)
                .ok_or_else(|| format!("无法在 {name} 的 frontmatter 中写入禁用标记"))?
        };
        std::fs::write(&path, updated).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if !enabled && is_default_agent(&name) {
        // Compiled default: write the disable-stub into the personal dir,
        // exactly what `/agents → Disable` does for a default with no file.
        let dir = global_agents_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{name}.md"));
        if path.exists() {
            return Err(format!("{name} 的覆盖文件已存在"));
        }
        std::fs::write(&path, "---\nenabled: false\n---\n").map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err(format!("预设 {name} 不存在"))
}

/// Set the `model:` field in an agent's `.md` frontmatter.
/// Pass an empty string to clear the model (inherit parent).
#[tauri::command]
pub fn helix_set_subagent_model(name: String, model: String) -> Result<(), String> {
    if !subagents_extension_installed() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    let name = name.trim().to_string();
    if name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("非法的预设名".to_string());
    }
    let path = find_agent_file(&name).ok_or_else(|| format!("预设 {name} 不存在"))?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let updated = if model.trim().is_empty() {
        upsert_model_line(&content, None)
    } else {
        upsert_model_line(&content, Some(model.trim()))
    }
    .ok_or_else(|| format!("无法修改 {name} 的 frontmatter"))?;

    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    Ok(())
}

/// Replace or insert a `model:` line in the frontmatter of a `.md` agent file.
/// Returns the new file content, or None if the file has no parseable frontmatter block.
fn upsert_model_line(content: &str, model: Option<&str>) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    // Find frontmatter end (the closing ---)
    let mut fm_end: Option<usize> = None;
    let mut in_fm = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t == "---" {
            if i == 0 || in_fm {
                in_fm = !in_fm;
                if !in_fm {
                    fm_end = Some(i);
                    break;
                }
            }
        }
    }
    let fm_end = fm_end?;

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut model_replaced = false;

    for (i, line) in lines.iter().enumerate() {
        if i <= fm_end {
            let t = line.trim_start();
            if t.starts_with("model:") {
                if let Some(m) = model {
                    out.push(format!("model: \"{m}\""));
                } else {
                    continue; // drop the line
                }
                model_replaced = true;
            }
        }
        out.push(line.to_string());
    }

    if !model_replaced && model.is_some() {
        // Insert `model: "..."` right after the opening `---`
        let mut out2: Vec<String> = Vec::with_capacity(out.len() + 1);
        for (i, line) in out.iter().enumerate() {
            out2.push(line.clone());
            if i == 0 {
                out2.push(format!("model: \"{}\"", model.unwrap()));
            }
        }
        out = out2;
    }

    Some(out.join("\n"))
}

/// Permanently remove a custom agent's .md file (the extension's Delete does
/// `unlink`). Compiled defaults have no file to delete — refuse rather than
/// suggest deleting something the extension would resurrect.
#[tauri::command]
pub fn helix_delete_subagent(name: String) -> Result<(), String> {
    if !subagents_extension_installed() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    if name.trim().is_empty() || name.trim() != name {
        return Err("非法的预设名".to_string());
    }
    let name = name.trim().to_string();
    let path = find_agent_file(&name).ok_or_else(|| format!("预设 {name} 不存在"))?;
    if is_disable_stub(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?) {
        // A stub is a default's off-switch, not a definition — delete reads
        // as "remove the agent" but the file carries nothing to remove.
        return Err("内置默认的禁用存根只能启用，不能删除".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Is this type one of the extension's compiled defaults?
fn is_default_agent(name: &str) -> bool {
    ["general-purpose", "Explore", "Plan"]
        .iter()
        .any(|d| d.eq_ignore_ascii_case(name))
}

/// A file the extension writes to disable a compiled default: exactly
/// `---\nenabled: false\n---` (src/agent-file-toggle.ts isEmptyStub).
fn is_disable_stub(content: &str) -> bool {
    let normalized = content.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    trimmed == "---\nenabled: false\n---" || trimmed == "---\n---"
}

/// Split keeping each line's terminator, matching splitFrontmatter in
/// agent-file-toggle.ts: lines keep their terminators, so an edit preserves
/// the file's line endings (and a missing final newline stays missing).
fn split_lines_keep_ends(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, b) in content.bytes().enumerate() {
        if b == b'\n' {
            lines.push(content[start..=i].to_string());
            start = i + 1;
        }
    }
    if start < content.len() {
        lines.push(content[start..].to_string());
    }
    lines
}

/// Index of the frontmatter's closing `---` (a `---`-trimmed line after the
/// opening one), or None when the file has no frontmatter block.
fn frontmatter_close(lines: &[String]) -> Option<usize> {
    if lines.first()?.trim() != "---" {
        return None;
    }
    lines
        .iter()
        .skip(1)
        .position(|l| l.trim() == "---")
        .map(|i| i + 1)
}

/// Insert `enabled: false` immediately after the opening `---`, preserving
/// everything else (disableInContent). None when there is no frontmatter
/// block or the file is already disabled.
fn insert_enabled_false(content: &str) -> Option<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = split_lines_keep_ends(content);
    let close = frontmatter_close(&lines)?;
    if lines
        .iter()
        .take(close)
        .any(|l| l.trim() == "enabled: false")
    {
        return None;
    }
    let eol = if lines[0].ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    lines.insert(1, format!("enabled: false{eol}"));
    Some(lines.join(""))
}

/// Remove the `enabled: false` line from the frontmatter wherever it appears
/// (enableInContent removes it at any position). None when the file has no
/// frontmatter block; Some(content) unchanged when there was nothing to
/// strip — the caller then reports the no-op.
fn strip_enabled_false(content: &str) -> Option<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines = split_lines_keep_ends(content);
    let close = frontmatter_close(&lines)?;
    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, l)| !(*i > 0 && *i < close && l.trim() == "enabled: false"))
        .map(|(_, l)| l.clone())
        .collect();
    Some(kept.join(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_skills_matches_pi_load_roots() {
        let skills = helix_list_skills();
        for s in &skills {
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
