//! First-run bootstrap: extract hermes-agent from Tauri resources into
//! `~/.hermes/hermes-agent/`, create a venv, and pip-install the agent so
//! the gateway can launch hermes out-of-the-box without a separate install.
//!
//! Idempotent — if the venv already exists, this is a near-instant no-op.

use crate::paths::{hermes_agent_dir, venv_hermes_bin};
use serde_json::json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
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
        // Skip Python bytecode and cache junk.
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

/// Find a working Python interpreter. Prefers 3.12+, then falls back to any python3.
#[cfg(not(target_os = "windows"))]
fn find_python() -> Option<PathBuf> {
    // Prefer versioned Python 3.12+ first (avoids system python3.10 on Ubuntu 22.04).
    for name in &["python3.12", "python3.13", "python3.14", "python3", "python"] {
        if let Ok(out) = Command::new(name).arg("--version").output() {
            if out.status.success() {
                let ver = String::from_utf8_lossy(&out.stdout);
                // Extract version number from "Python 3.x.y"
                if let Some(v) = ver.strip_prefix("Python ") {
                    let major_minor: Vec<&str> = v.split('.').take(2).collect();
                    if major_minor.len() == 2 {
                        if let (Ok(maj), Ok(min)) = (major_minor[0].parse::<u32>(), major_minor[1].parse::<u32>()) {
                            if maj >= 3 && min >= 11 {
                                return Some(PathBuf::from(name));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn find_python() -> Option<PathBuf> {
    for name in &["python3.12", "python3.13", "python3.14", "python3", "python", "python.exe"] {
        if let Ok(out) = Command::new(name).arg("--version").output() {
            if out.status.success() {
                let ver = String::from_utf8_lossy(&out.stdout);
                if let Some(v) = ver.strip_prefix("Python ") {
                    let major_minor: Vec<&str> = v.split('.').take(2).collect();
                    if major_minor.len() == 2 {
                        if let (Ok(maj), Ok(min)) = (major_minor[0].parse::<u32>(), major_minor[1].parse::<u32>()) {
                            if maj >= 3 && min >= 11 {
                                return Some(PathBuf::from(name));
                            }
                        }
                    }
                }
            }
        }
    }
    None
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
            // Non-blocking exclusive lock — bail if another instance holds it.
            if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                eprintln!("[bootstrap] another process is bootstrapping; waiting...");
                // Fall through to blocking wait.
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
    // Simple lock file for non-Linux platforms — not fully atomic but
    // better than nothing for the rare concurrent-start case.
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

/// Ensure hermes-agent is bootstrapped and ready to launch.
///
/// Returns `Ok(())` whether we bootstrapped or skipped. Errors are surfaced
/// as emitted events but never propagated — we always fall through to the
/// normal gateway spawn attempt so the existing error paths handle it.
pub fn ensure_hermes_agent(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let venv_bin = venv_hermes_bin(Some(&hermes_agent_dir()), "venv");

    // Already bootstrapped — quick return.
    if venv_bin.exists() {
        return Ok(());
    }

    // ── Lock ──────────────────────────────────────────────────────────
    let _lock = bootstrap_lock();

    // Double-check after acquiring lock (another instance may have finished).
    if venv_bin.exists() {
        return Ok(());
    }

    // ── Locate resource directory ─────────────────────────────────────
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("无法获取资源目录: {e}"))?;
    let bundled_agent = resource_dir.join("hermes-agent");

    if !bundled_agent.exists() || !bundled_agent.join("pyproject.toml").exists() {
        // Running in dev mode where resources aren't bundled — the agent
        // should already be at ~/.hermes/hermes-agent/ from manual install.
        // Don't block on this; let spawn_gateway try its candidates.
        eprintln!(
            "[bootstrap] bundled hermes-agent not found at {} — skipping (dev mode?)",
            bundled_agent.display()
        );
        return Ok(());
    }

    // ── Copy source ───────────────────────────────────────────────────
    emit_progress(app_handle, "copy", "正在准备 Hermes 运行环境...");
    let target_dir = hermes_agent_dir();
    eprintln!(
        "[bootstrap] copying hermes-agent from {} → {}",
        bundled_agent.display(),
        target_dir.display()
    );
    copy_dir_recursive(&bundled_agent, &target_dir)
        .map_err(|e| format!("复制 hermes-agent 源码失败: {e}"))?;

    // ── Find Python ───────────────────────────────────────────────────
    emit_progress(app_handle, "venv", "正在创建 Python 虚拟环境...");
    let python = find_python()
        .ok_or_else(|| "未找到 Python 3 解释器。请安装 Python 3.11+。".to_string())?;
    eprintln!("[bootstrap] using python: {}", python.display());

    // ── Create venv ───────────────────────────────────────────────────
    let venv_path = target_dir.join("venv");
    let mut venv_cmd = Command::new(&python)
        .args(["-m", "venv", &venv_path.display().to_string()]);
    #[cfg(windows)]
    venv_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = venv_cmd
        .output()
        .map_err(|e| format!("创建 venv 失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("创建 venv 失败: {stderr}"));
    }

    // ── Pip install ───────────────────────────────────────────────────
    emit_progress(
        app_handle,
        "pip",
        "正在安装 Python 依赖（首次启动约需 1-2 分钟）...",
    );
    let pip = if cfg!(windows) {
        venv_path.join("Scripts").join("pip")
    } else {
        venv_path.join("bin").join("pip")
    };
    // Use a timeout to prevent pip from hanging indefinitely (e.g. network issues).
    // 5 minutes should be enough for a首次 install; subsequent runs skip pip entirely.
    let mut pip_cmd = Command::new(&pip)
        .args(["install", "-e", "."])
        .current_dir(&target_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    pip_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut pip_child = pip_cmd
        .spawn()
        .map_err(|e| format!("pip install 启动失败: {e}"))?;

    let pip_timeout = std::time::Duration::from_secs(300); // 5 minutes
    let (tx, rx) = std::sync::mpsc::channel();
    // Wait for the process in a background thread so we can enforce a timeout.
    std::thread::spawn(move || {
        let status = pip_child.wait();
        let _ = tx.send(status);
    });
    match rx.recv_timeout(pip_timeout) {
        Ok(Ok(status)) if status.success() => {
            eprintln!("[bootstrap] pip install complete");
        }
        Ok(Ok(status)) => {
            eprintln!("[bootstrap] pip install failed (exit {})", status);
            return Err(format!("pip install 失败 (exit code: {})", status));
        }
        Ok(Err(e)) => {
            return Err(format!("pip install 等待失败: {e}"));
        }
        Err(_) => {
            // Timeout — the child process is owned by the spawned thread and
            // will be cleaned up when the thread exits. For now, report the
            // error and let the app continue (gateway will fail to start but
            // the user can retry).
            eprintln!("[bootstrap] pip install timed out after 300s");
            return Err("pip install 超时（5分钟），可能是网络问题。请检查网络后重试。".to_string());
        }
    }

    eprintln!("[bootstrap] hermes-agent install complete");
    build_fts5_cjk(app_handle);
    emit_progress(app_handle, "done", "");

    // Drop the lock file handle (it stays on disk but is unlocked).
    drop(_lock);

    Ok(())
}

/// Build the optional CJK FTS5 tokenizer extension (native/fts5_cjk) so
/// Chinese/Korean substring search runs at index speed instead of a LIKE
/// full-table scan. Best-effort: if there is no C compiler or the compile
/// fails, we skip it — `hermes_state.load_fts5_cjk_extension` already
/// degrades to trigram/LIKE when the .so is absent.
fn build_fts5_cjk(app_handle: &tauri::AppHandle) {
    let so_dir = crate::paths::hermes_data_dir().join("lib");
    let so_path = so_dir.join("libfts5_cjk.so");
    if so_path.exists() {
        return; // already built
    }
    let src_dir = hermes_agent_dir().join("native").join("fts5_cjk");
    let c_file = src_dir.join("fts5_cjk.c");
    if !c_file.exists() {
        eprintln!(
            "[bootstrap] fts5_cjk source missing at {} — skipping CJK tokenizer",
            src_dir.display()
        );
        return;
    }
    let compiler = if Command::new("gcc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        "gcc"
    } else if Command::new("cc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        "cc"
    } else {
        eprintln!(
            "[bootstrap] no C compiler found — skipping fts5_cjk build (CJK search falls back to LIKE)"
        );
        return;
    };
    if let Err(e) = std::fs::create_dir_all(&so_dir) {
        eprintln!("[bootstrap] cannot create lib dir {}: {e}", so_dir.display());
        return;
    }
    emit_progress(app_handle, "cjk", "正在编译中文分词扩展（可选）...");
    let vendor_inc = src_dir.join("vendor");
    let output = Command::new(compiler)
        .args([
            "-shared",
            "-fPIC",
            "-O2",
            "-Wall",
            "-Wextra",
            "-I",
            vendor_inc.to_str().unwrap_or("."),
            c_file.to_str().unwrap_or("fts5_cjk.c"),
            "-o",
            so_path.to_str().unwrap_or("/tmp/libfts5_cjk.so"),
        ])
        .current_dir(&src_dir)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            eprintln!("[bootstrap] fts5_cjk built at {}", so_path.display());
        }
        Ok(o) => {
            eprintln!(
                "[bootstrap] fts5_cjk build failed (CJK search falls back to LIKE): {}",
                String::from_utf8_lossy(&o.stderr)
            );
        }
        Err(e) => {
            eprintln!("[bootstrap] fts5_cjk build error (ignored): {e}");
        }
    }
}
