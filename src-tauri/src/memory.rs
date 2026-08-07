//! Hermes memory sync (MEMORY.md / USER.md) + skill scanning helpers.
//! Port of `electron/lib/memory.js`.

use crate::paths::hermes_data_dir;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MEM_DELIM: &str = "\n◊\n";
const MANUAL_MARKERS_FILE: &str = ".helix_manual.json";
const SKILL_CALL_COUNTS_FILE: &str = "skill-call-counts.json";

pub fn hermes_memories_dir() -> PathBuf {
    let home = std::env::var("HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| hermes_data_dir());
    home.join("memories")
}

pub fn read_mem_file(file: &Path) -> Vec<String> {
    let raw = match std::fs::read_to_string(file) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    if raw.trim().is_empty() {
        return Vec::new();
    }
    raw.split(MEM_DELIM)
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect()
}

pub fn write_mem_file(file: &Path, entries: &[String]) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let content = entries.join(MEM_DELIM);
    // Atomic write (temp + rename).
    let tmp = file.with_file_name(format!(
        ".mem_{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    if std::fs::write(&tmp, content).is_ok() {
        let _ = std::fs::remove_file(file);
        let _ = std::fs::rename(&tmp, file);
    }
}

pub fn read_manual_markers(dir: &Path) -> Vec<String> {
    let path = dir.join(MANUAL_MARKERS_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

pub fn add_manual_marker(dir: &Path, text: &str) {
    let mut cur = read_manual_markers(dir);
    if cur.iter().any(|c| c == text) {
        return;
    }
    cur.push(text.to_string());
    let _ = std::fs::create_dir_all(dir);
    if let Ok(s) = serde_json::to_string_pretty(&cur) {
        let _ = std::fs::write(dir.join(MANUAL_MARKERS_FILE), s);
    }
}

pub fn remove_manual_marker(dir: &Path, text: &str) {
    let cur = read_manual_markers(dir);
    let cur_len = cur.len();
    let next: Vec<String> = cur.into_iter().filter(|c| c != text).collect();
    if next.len() == cur_len {
        return;
    }
    let file = dir.join(MANUAL_MARKERS_FILE);
    if next.is_empty() {
        let _ = std::fs::remove_file(file);
        return;
    }
    if let Ok(s) = serde_json::to_string_pretty(&next) {
        let _ = std::fs::write(file, s);
    }
}

// ── skill call counts ──────────────────────────────────────────────────────

static CALL_COUNTS: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(load_call_counts()));

fn load_call_counts() -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    let usage_file = hermes_data_dir().join("skills").join(".usage.json");
    if let Ok(raw) = std::fs::read_to_string(&usage_file) {
        if let Ok(Value::Object(usage)) = serde_json::from_str::<Value>(&raw) {
            for (name, info) in usage {
                if let Some(cnt) = info.get("use_count").and_then(|v| v.as_u64()) {
                    map.insert(name, cnt);
                }
            }
        }
    } else if let Ok(raw) = std::fs::read_to_string(hermes_data_dir().join(SKILL_CALL_COUNTS_FILE)) {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&raw) {
            for (k, v) in obj {
                if let Some(n) = v.as_u64() {
                    map.insert(k, n);
                }
            }
        }
    }
    map
}

fn save_call_counts(map: &std::collections::HashMap<String, u64>) {
    let dir = hermes_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(dir.join(SKILL_CALL_COUNTS_FILE), s);
    }
}

pub fn increment_skill_call_count(skill_name: &str) -> u64 {
    let mut map = CALL_COUNTS.lock().unwrap();
    let next = map.entry(skill_name.to_string()).or_insert(0);
    *next += 1;
    let val = *next;
    save_call_counts(&map);
    val
}

pub fn call_count(name: &str) -> u64 {
    CALL_COUNTS.lock().unwrap().get(name).copied().unwrap_or(0)
}

// ── skill scanning ─────────────────────────────────────────────────────────

fn parse_skill_frontmatter(content: &str, fallback: &str) -> (String, String) {
    let mut name = fallback.to_string();
    let mut description = String::new();
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let block = &rest[..end];
            for line in block.lines() {
                if let Some(n) = line.strip_prefix("name:") {
                    name = n.trim().to_string();
                } else if let Some(d) = line.strip_prefix("description:") {
                    description = d.trim().to_string();
                }
            }
        }
    }
    (name, description)
}

pub fn collect_skills_from_dir(root_dir: &Path, is_builtin: bool, out: &mut Vec<Value>) {
    // If rootDir itself is a skill (has SKILL.md), add it directly.
    let self_md = root_dir.join("SKILL.md");
    if let Ok(content) = std::fs::read_to_string(&self_md) {
        let fallback = root_dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (name, description) = parse_skill_frontmatter(&content, &fallback);
        out.push(json!({
            "id": self_md.display().to_string(),
            "name": name,
            "description": description,
            "isBuiltin": is_builtin,
            "path": self_md.display().to_string(),
            "callCount": call_count(&name),
        }));
        return;
    }

    let entries = match std::fs::read_dir(root_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name == "tests" || name.starts_with('.') {
            continue;
        }
        let full = e.path();
        let skill_md = full.join("SKILL.md");
        if std::fs::read_to_string(&skill_md).is_err() {
            collect_skills_from_dir(&full, is_builtin, out);
            continue;
        }
        let content = match std::fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (sk_name, description) = parse_skill_frontmatter(&content, &name);
        out.push(json!({
            "id": skill_md.display().to_string(),
            "name": sk_name,
            "description": description,
            "isBuiltin": is_builtin,
            "path": skill_md.display().to_string(),
            "callCount": call_count(&sk_name),
        }));
    }
}
