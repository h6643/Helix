//! Helix memory sync (MEMORY.md / USER.md).
//! The renderer's memory panel calls these via the `helix_*` commands.

use crate::paths::helix_data_dir;
use std::path::{Path, PathBuf};

const MEM_DELIM: &str = "\n◊\n";
const MANUAL_MARKERS_FILE: &str = ".helix_manual.json";

pub fn helix_memories_dir() -> PathBuf {
    let home = std::env::var("HELIX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| helix_data_dir());
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
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Array(arr)) => arr
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
