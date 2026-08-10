//! First-run bootstrap: extract a pre-built hermes runtime (standalone Python
//! + venv with hermes-agent and all dependencies) from Tauri resources into
//! `~/.hermes/`. The runtime is built in CI by `scripts/prepare-runtime.sh`
//! using python-build-standalone and `pip install`.
//!
//! This replaces the old approach of bundling raw hermes-agent source and
//! running `pip install -e .` at runtime — now the venv is pre-built, so
//! bootstrap only copies files and fixes shebangs. No Python, no network, no
//! pip needed on the user's machine.
//!
//! Idempotent — if the venv hermes binary already exists, this is a near-instant
//! no-op.

use crate::paths::{hermes_agent_dir, venv_hermes_bin};
use serde_json::json;
use std::fs;
use std::io;
use std::path::Path;
use tauri::Emitter;
use tauri::Manager;

/// Emit a bootstrap progress event to the renderer — same envelope as
/// `hermes:event` so the frontend's existing listener picks it up.
fn emit_progress(app_handle: &tauri::AppHandle, stage: &str, message: &str) {
    let _ = app_handle.emit(
        "hermes:event",
        json!({
            "method": "bootstrap:progress",
            "params": { "stage": stage, "message": message }
        }),
    );
}

/// Recursively copy `src` directory contents into `dst`, creating `dst` if
/// needed. Skips `__pycache__` directories and `.pyc` files.
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let fname = entry.file_name();
        let fname_str = fname.to_string_lossy();
        if fname_str == "__pycache__"
            || fname_str.ends_with(".pyc")
            || fname_str.ends_with(".pyo")
            || fname_str == ".git"
            || fname_str == "tests"
            || fname_str == "node_modules"
            || fname_str.starts_with(".venv")
        {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&fname);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Fix shebangs in `venv/bin/` (or `venv/Scripts/` on Windows) so they
/// reference the runtime Python path instead of the CI build path.
///
/// Only rewrites shebang lines that contain the word "python" — pip entry
/// points always have `#!/path/to/python3`. Shell wrappers (`#!/bin/sh`)
/// and native binaries are left untouched.
fn fix_venv_shebangs(venv_dir: &Path, python_bin: &Path) -> io::Result<()> {
    let bin_dir = if cfg!(windows) {
        venv_dir.join("Scripts")
    } else {
        venv_dir.join("bin")
    };
    if !bin_dir.exists() {
        return Ok(());
    }
    let new_shebang = format!("#!{}", python_bin.display());
    for entry in fs::read_dir(&bin_dir)? {
        let path = entry?.path();
        if !path.is_file() {
            continue;
        }
        let Ok(content) = fs::read(&path) else { continue };
        if !content.starts_with(b"#!") {
            continue;
        }
        let first_line_end = content
            .iter()
            .position(|&b| b == b'\n')
            .unwrap_or(content.len());
        let first_line = &content[..first_line_end];
        // Only fix Python entry points — not shell wrappers.
        if !first_line
            .windows(b"python".len())
            .any(|w| w == b"python")
        {
            continue;
        }
        let mut fixed = new_shebang.as_bytes().to_vec();
        fixed.extend_from_slice(&content[first_line_end..]);
        fs::write(&path, fixed)?;
        eprintln!(
            "[bootstrap] fixed shebang in {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
    }
    Ok(())
}

/// Acquire a cross-process advisory lock so only one Helix instance runs
/// the bootstrap at a time.
#[cfg(target_os = "linux")]
fn bootstrap_lock() -> Option<fs::File> {
    use std::os::unix::io::AsRawFd;
    let lock_dir = crate::paths::hermes_data_dir().join("runtime");
    let _ = fs::create_dir_all(&lock_dir);
    let lock_path = lock_dir.join("bootstrap.lock");
    match fs::OpenOptions::new().create(true).write(true).truncate(false).open(&lock_path) {
        Ok(f) => {
            let fd = f.as_raw_fd();
            if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                eprintln!("[bootstrap] another process is bootstrapping; waiting...");
                unsafe { libc::flock(fd, libc::LOCK_EX) };
                eprintln!("[bootstrap] lock acquired after waiting");
            }
            Some(f)
        }
        Err(e) => {
            eprintln!("[bootstrap] lock file error: {e}");
            None
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn bootstrap_lock() -> Option<fs::File> {
    let lock_dir = crate::paths::hermes_data_dir().join("runtime");
    let _ = fs::create_dir_all(&lock_dir);
    let lock_path = lock_dir.join("bootstrap.lock");
    match fs::OpenOptions::new().create_new(true).write(true).open(&lock_path) {
        Ok(f) => Some(f),
        Err(_) => {
            eprintln!("[bootstrap] lock file exists; another process may be bootstrapping");
            None
        }
    }
}

/// Ensure the pre-built hermes runtime is extracted and ready to launch.
///
/// Returns `Ok(())` whether we bootstrapped or skipped. Errors are surfaced
/// via eprintln but never propagated — we always fall through to the normal
/// gateway spawn attempt so the existing error paths handle it.
pub fn ensure_hermes_agent(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let venv_bin = venv_hermes_bin(Some(&hermes_agent_dir()), "venv");

    // Already bootstrapped — quick return.
    if venv_bin.exists() {
        return Ok(());
    }

    // ── Lock ──────────────────────────────────────────────────────────
    let _lock = bootstrap_lock();

    // Double-check after acquiring lock.
    if venv_bin.exists() {
        return Ok(());
    }

    // ── Locate resource directory ─────────────────────────────────────
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    let runtime_dir = resource_dir.join("hermes-runtime");

    if !runtime_dir.exists() {
        // Dev mode — resources aren't bundled. Let spawn_gateway fall
        // through to its other candidates.
        eprintln!(
            "[bootstrap] bundled runtime not found at {} — skipping (dev mode?)",
            runtime_dir.display()
        );
        return Ok(());
    }

    // ── Copy runtime ──────────────────────────────────────────────────
    emit_progress(app_handle, "preparing", "正在准备 Hermes 运行环境...");

    let data_dir = crate::paths::hermes_data_dir();

    // Copy standalone Python runtime.
    let src_python = runtime_dir.join("python");
    let dst_python = data_dir.join("python");
    if src_python.exists() {
        eprintln!(
            "[bootstrap] extracting python runtime {} → {}",
            src_python.display(),
            dst_python.display()
        );
        copy_dir_recursive(&src_python, &dst_python)
            .map_err(|e| format!("复制 Python 运行时失败: {e}"))?;
    }

    // Copy pre-built hermes-agent venv.
    let src_venv = runtime_dir.join("hermes-agent").join("venv");
    let dst_venv = hermes_agent_dir().join("venv");
    if src_venv.exists() {
        eprintln!(
            "[bootstrap] extracting venv {} → {}",
            src_venv.display(),
            dst_venv.display()
        );
        copy_dir_recursive(&src_venv, &dst_venv)
            .map_err(|e| format!("复制 venv 失败: {e}"))?;
    }

    // ── Fix shebangs ─────────────────────────────────────────────────
    // The venv was built at a CI path; rewrite entry-point shebangs to
    // point at the runtime Python (which was copied with --copies, so
    // it lives in both python/ and venv/bin/).
    let venv_python = if cfg!(windows) {
        dst_venv.join("Scripts").join("python.exe")
    } else {
        dst_venv.join("bin").join("python3")
    };
    if let Err(e) = fix_venv_shebangs(&dst_venv, &venv_python) {
        eprintln!("[bootstrap] shebang fix warning: {e}");
    }

    eprintln!("[bootstrap] hermes runtime ready");
    emit_progress(app_handle, "done", "");

    drop(_lock);
    Ok(())
}
