//! Cross-platform path resolution for Helix backend data / runtime locations.
//!
//! Uses `~/.pi/agent/helix/` on all platforms as the Helix data directory
//! (config, auth, sessions, skills, memories, logs…) — colocated with the
//! Pi agent's own config root so everything Helix-related lives under one
//! `~/.pi` tree. Legacy `~/.codex` / `~/.helix` directories (retired
//! backends) are migrated automatically on first launch.

use std::path::{Path, PathBuf};

/// The Helix data directory (config.yaml, state.db, skills, memories, logs…).
/// Uses `~/.pi/agent/helix/` on all platforms so everything Helix-related
/// (its own data + the Pi agent's config) lives under one `~/.pi` tree.
///
/// The location can be overridden (Settings → 数据存储路径) via either an
/// explicit `HELIX_DATA_DIR` env var or a pointer file at
/// `<config_dir>/helix/data_root`. The pointer file intentionally lives
/// OUTSIDE the data dir so it does not move when the data dir is relocated.
pub fn helix_data_dir() -> PathBuf {
    // 1) Explicit env override (dev / test / CI).
    if let Ok(env) = std::env::var("HELIX_DATA_DIR") {
        let p = env.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    // 2) Persisted override pointer (set via Settings → 数据存储路径).
    // Strip a verbatim `\\?\` prefix if present: older builds canonicalized
    // the path before writing the pointer, leaking `\\?\C:\...` into the UI
    // and breaking `current != default` / `target == current` comparisons.
    if let Some(ptr) = data_root_pointer_path() {
        if let Ok(raw) = std::fs::read_to_string(&ptr) {
            let p = raw.trim();
            if !p.is_empty() {
                return strip_verbatim_prefix(Path::new(p));
            }
        }
    }
    // 3) Default.
    default_helix_data_dir()
}

/// The default Helix data directory (no override applied):
/// `~/.pi/agent/helix/`.
pub fn default_helix_data_dir() -> PathBuf {
    pi_agent_dir().join("helix")
}

/// One-time migration from legacy data directories (`~/.codex` from the
/// retired codex era, `~/.helix` from the interim layout). Runs at startup:
/// when a legacy dir exists but the new default does not, move it (rename
/// when possible — cheap on the same volume; fall back to copy on
/// cross-volume / locked-file cases) so the user keeps all data. When the
/// pointer/env override is already set the migration is a no-op.
pub fn migrate_legacy_data_dir() {
    // Only consider the default (no env / pointer override).
    if std::env::var("HELIX_DATA_DIR").is_ok() {
        return;
    }
    if let Some(ptr) = data_root_pointer_path() {
        if std::fs::read_to_string(&ptr)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            return;
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let target = default_helix_data_dir();
    let legacies = [home.join(".codex"), home.join(".helix")];
    migrate_data_dir_at(&target, &legacies);
}

/// Core migration: move the first existing legacy dir to `target` (which must
/// not exist yet). Rename first; fall back to a best-effort recursive copy
/// when the rename fails (cross-volume / locked files). Leaves a
/// `<legacy>.migrated` breadcrumb pointing at the new location.
fn migrate_data_dir_at(target: &std::path::Path, legacies: &[PathBuf]) {
    if target.exists() {
        return;
    }
    for legacy in legacies {
        if !legacy.is_dir() {
            continue;
        }
        // Ensure the target's parent exists (rename fails otherwise).
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Move the tree; on failure (cross-volume / locked files) fall back
        // to a best-effort recursive copy, then remove the source.
        let moved = if std::fs::rename(legacy, target).is_ok() {
            true
        } else if copy_dir_recursive(legacy, target) {
            let _ = std::fs::remove_dir_all(legacy);
            true
        } else {
            false
        };
        if moved {
            // Breadcrumb file where the old dir was, pointing at the new one.
            let _ = std::fs::write(
                legacy.with_file_name(format!(
                    "{}.migrated",
                    legacy
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("helix-data")
                )),
                target.display().to_string() + "\n",
            );
            return;
        }
    }
}

/// Recursively copy a directory tree. Returns success (best effort for
/// logs/WAL files that may be locked — they are skipped, not fatal).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(src) else {
        return false;
    };
    let _ = std::fs::create_dir_all(dst);
    let mut ok = true;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            ok &= copy_dir_recursive(&from, &to);
        } else if std::fs::copy(&from, &to).is_err() {
            // Locked files (sqlite WAL/shm in use) don't block the migration.
            ok = false;
        }
    }
    ok
}

/// Pointer file (outside the data dir) that overrides `helix_data_dir()`.
/// Lives in the platform config dir (e.g. `~/.config/helix/data_root` on Unix)
/// so it survives relocation of the data dir itself.
pub fn data_root_pointer_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join("helix").join("data_root"))
}

/// Strip the verbatim `\\?\` prefix `std::fs::canonicalize` produces for
/// Windows paths. Internal storage (state.work_dir / allowed_roots) keeps the
/// canonical form so path checks stay consistent, but child processes (the pi
/// agent) must receive the plain form: pi's session-dir slugger replaces one
/// leading backslash and the leftover `?` is an INVALID character in Windows
/// dir names — `mkdir` fails with ENOENT and the pi agent crashes at spawn.
/// UNC paths (`\\?\UNC\server\share`) are left untouched.
pub fn strip_verbatim_prefix(p: &std::path::Path) -> PathBuf {
    let Some(s) = p.to_str() else {
        return p.to_path_buf();
    };
    let Some(rest) = s.strip_prefix("\\\\?\\") else {
        return p.to_path_buf();
    };
    // `rest` starts with `UNC\` for the verbatim UNC namespace — stripping
    // the prefix would drop a required path segment, so keep it verbatim.
    if rest.get(..4) == Some("UNC\\") || rest.get(..4) == Some("unc\\") {
        return p.to_path_buf();
    }
    PathBuf::from(rest)
}

/// The Pi agent config directory (`~/.pi/agent` on all platforms). Pi reads its
/// `settings.json` (defaultProvider / defaultModel) and `custom-providers.json`
/// from here at startup — NOT from Helix's `~/.pi/agent/helix/config.yaml`. Model/provider
/// changes written through the Helix UI must be mirrored into these files so the
/// Pi backend actually picks them up.
pub fn pi_agent_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
}

/// Portable standalone Python interpreter bundled with the data dir.
/// `python/python.exe` on Windows, `python/bin/python3` on Unix.
pub fn standalone_python() -> PathBuf {
    let base = helix_data_dir().join("python");
    if cfg!(windows) {
        base.join("python.exe")
    } else {
        base.join("bin").join("python3")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "helix-paths-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// ~/.codex exists → moved to target, breadcrumb left behind.
    #[test]
    fn migrates_codex_dir() {
        let root = temp_root("codex");
        let legacy = root.join(".codex");
        std::fs::create_dir_all(legacy.join("skills")).unwrap();
        std::fs::write(legacy.join("config.yaml"), "model: x").unwrap();

        let target = root.join(".pi").join("agent").join("helix");
        migrate_data_dir_at(&target, &[legacy.clone()]);

        assert!(target.is_dir(), "target created");
        assert!(!legacy.exists(), "legacy dir gone");
        assert!(target.join("config.yaml").is_file(), "data moved");
        assert!(root.join(".codex.migrated").is_file(), "breadcrumb");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Both legacy dirs exist → the first one in the list wins.
    #[test]
    fn prefers_first_legacy() {
        let root = temp_root("both");
        for name in [".codex", ".helix"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("marker.txt"), name).unwrap();
        }
        let target = root.join(".pi").join("agent").join("helix");
        let legacies = [root.join(".codex"), root.join(".helix")];
        migrate_data_dir_at(&target, &legacies);

        assert!(target.join("marker.txt").is_file());
        assert_eq!(
            std::fs::read_to_string(target.join("marker.txt")).unwrap(),
            ".codex"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// Target already exists → legacy dirs must NOT be touched.
    #[test]
    fn skips_when_target_exists() {
        let root = temp_root("exists");
        let legacy = root.join(".codex");
        std::fs::create_dir_all(&legacy).unwrap();
        let target = root.join(".pi").join("agent").join("helix");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("existing.txt"), "keep").unwrap();

        migrate_data_dir_at(&target, &[legacy.clone()]);

        assert!(legacy.is_dir(), "legacy untouched");
        assert!(target.join("existing.txt").is_file(), "target intact");
        std::fs::remove_dir_all(&root).ok();
    }
}
