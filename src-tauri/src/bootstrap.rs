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

use crate::paths::standalone_python;
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

/// Returns true if the standalone Python runtime at `python_dir` actually has
/// the `hermes_cli` package installed in its site-packages.
///
/// We can't just check that `python.exe` exists: an older runtime copied from
/// a pre-standalone build (venv era) leaves a base interpreter without
/// `hermes_cli`, and the naive `py.exists()` guard would then skip re-extraction
/// forever — silently breaking every future launch (ModuleNotFoundError).
fn hermes_cli_present(python_dir: &Path) -> bool {
    let candidates = [
        python_dir.join("Lib").join("site-packages").join("hermes_cli"),
        python_dir
            .join("lib")
            .join("python3.12")
            .join("site-packages")
            .join("hermes_cli"),
    ];
    candidates.iter().any(|p| p.exists())
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
    let py = standalone_python();
    let python_dir = py.parent().unwrap_or(&py).to_path_buf();

    // Resolve the data dir up-front so we can also gate on agent-extra
    // (the wake-word/TTS tools package + scripts) being present, not just the
    // python runtime itself.
    let data_dir = crate::paths::hermes_data_dir();
    let agent_extra = data_dir.join("agent-extra");

    // Already bootstrapped with a usable runtime — quick return.
    // `hermes_cli` must be importable; otherwise this is a stale base
    // interpreter (venv-era copy) that would crash on launch, so we fall
    // through and re-extract below. We also require agent-extra/tools to exist
    // (wake-word + TTS live there) — if missing, fall through and copy it.
    if py.exists() && hermes_cli_present(&python_dir) && agent_extra.join("tools").is_dir() {
        return Ok(());
    }

    // ── Lock ──────────────────────────────────────────────────────────
    let _lock = bootstrap_lock();

    // Double-check after acquiring lock.
    if py.exists() && hermes_cli_present(&python_dir) && agent_extra.join("tools").is_dir() {
        return Ok(());
    }

    // Stale/missing runtime — wipe the old dir so the copy below is clean.
    if py.exists() {
        eprintln!(
            "[bootstrap] python runtime present but hermes_cli missing — re-extracting"
        );
        let _ = fs::remove_dir_all(&python_dir);
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

    // ── Copy standalone Python runtime (portable, no venv) ────────────
    emit_progress(app_handle, "preparing", "正在准备 Hermes 运行环境...");

    // Copy standalone Python runtime. Hermes + all deps are pre-installed
    // into this interpreter's site-packages at build time
    // (scripts/prepare-runtime.sh), so no venv / shebang fix is needed.
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

    // ── Copy agent-extra (wake-word listener + TTS scripts / tools pkg) ──
    let src_extra = runtime_dir.join("agent-extra");
    let dst_extra = data_dir.join("agent-extra");
    if src_extra.exists() {
        eprintln!(
            "[bootstrap] extracting agent-extra {} → {}",
            src_extra.display(),
            dst_extra.display()
        );
        copy_dir_recursive(&src_extra, &dst_extra)
            .map_err(|e| format!("复制 agent-extra 失败: {e}"))?;
    } else {
        eprintln!(
            "[bootstrap] bundled agent-extra not found at {} — wake-word/TTS may be unavailable",
            src_extra.display()
        );
    }

    eprintln!("[bootstrap] hermes runtime ready");
    emit_progress(app_handle, "done", "");

    drop(_lock);
    Ok(())
}
