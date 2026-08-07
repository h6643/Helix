//! Interactive PTY-backed terminal for the Tauri build.
//!
//! The renderer uses xterm.js and talks to these commands through the Tauri
//! bridge. Output is pushed back as `terminal:data` string events.

use serde_json::{json, Value};
use std::io::Error as IoError;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(unix)]
struct TerminalSession {
    master: std::os::unix::io::RawFd,
    pid: libc::pid_t,
    stop: Arc<AtomicBool>,
}

#[cfg(unix)]
static TERMINAL: OnceLock<Mutex<Option<TerminalSession>>> = OnceLock::new();

#[cfg(unix)]
fn terminal_state() -> &'static Mutex<Option<TerminalSession>> {
    TERMINAL.get_or_init(|| Mutex::new(None))
}

#[cfg(unix)]
fn last_os_error(action: &str) -> String {
    format!("{action}: {}", IoError::last_os_error())
}

#[cfg(unix)]
fn open_pty() -> Result<(std::os::unix::io::RawFd, std::os::unix::io::RawFd), String> {
    let mut master = 0;
    let mut slave = 0;
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if rc != 0 {
        return Err(last_os_error("openpty"));
    }
    Ok((master, slave))
}

#[cfg(unix)]
fn configure_slave(slave: std::os::unix::io::RawFd) -> Result<(), String> {
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(slave, &mut termios) } != 0 {
        return Err(last_os_error("tcgetattr"));
    }
    unsafe { libc::cfmakeraw(&mut termios) };
    termios.c_iflag |= libc::ICRNL | libc::IXON;
    termios.c_oflag |= libc::OPOST | libc::ONLCR;
    termios.c_lflag |= libc::ISIG;
    if unsafe { libc::tcsetattr(slave, libc::TCSANOW, &termios) } != 0 {
        return Err(last_os_error("tcsetattr"));
    }
    Ok(())
}

#[cfg(unix)]
fn set_nonblocking(fd: std::os::unix::io::RawFd) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(last_os_error("fcntl F_GETFL"));
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(last_os_error("fcntl F_SETFL"));
    }
    Ok(())
}

#[cfg(unix)]
fn set_window_size(fd: std::os::unix::io::RawFd, cols: u16, rows: u16) -> Result<(), String> {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as libc::c_ulong, &ws) } != 0 {
        return Err(last_os_error("TIOCSWINSZ"));
    }
    Ok(())
}

#[cfg(unix)]
fn spawn_shell(
    cwd: Option<String>,
    master: std::os::unix::io::RawFd,
    slave: std::os::unix::io::RawFd,
) -> Result<libc::pid_t, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut cmd = Command::new(&shell);
    cmd.arg("-i");
    if let Some(cwd) = cwd {
        if !cwd.trim().is_empty() && Path::new(&cwd).is_dir() {
            cmd.current_dir(&cwd);
        }
    }
    cmd.env("TERM", "xterm-256color");
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(IoError::last_os_error());
            }
            if libc::ioctl(slave, libc::TIOCSCTTY as libc::c_ulong, 0) < 0 {
                return Err(IoError::last_os_error());
            }
            for target in [0, 1, 2] {
                if libc::dup2(slave, target) < 0 {
                    return Err(IoError::last_os_error());
                }
            }
            if slave > 2 {
                libc::close(slave);
            }
            libc::close(master);
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {shell}: {e}"))?;
    Ok(child.id() as libc::pid_t)
}

#[cfg(unix)]
fn emit_terminal_data(data: &[u8]) {
    let text = String::from_utf8_lossy(data).into_owned();
    let _ = crate::state::app_handle().emit("terminal:data", text);
}

#[cfg(unix)]
fn reap_child(pid: libc::pid_t) {
    loop {
        let rc = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
        if rc < 0 {
            let err = IoError::last_os_error();
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
        }
        break;
    }
}

#[cfg(unix)]
fn cleanup_session(pid: libc::pid_t, master: std::os::unix::io::RawFd) {
    let mut guard = terminal_state().lock().unwrap();
    if let Some(session) = guard.as_ref() {
        if session.pid == pid {
            unsafe {
                let _ = libc::kill(-pid, libc::SIGKILL);
                libc::close(master);
            }
            *guard = None;
            reap_child(pid);
        }
    }
}

#[cfg(unix)]
fn kill_current() {
    let mut guard = terminal_state().lock().unwrap();
    if let Some(session) = guard.take() {
        session.stop.store(true, Ordering::Relaxed);
        unsafe {
            let _ = libc::kill(-session.pid, libc::SIGKILL);
            libc::close(session.master);
        }
        reap_child(session.pid);
    }
}

#[cfg(unix)]
fn write_all(fd: std::os::unix::io::RawFd, bytes: &[u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        let n = unsafe {
            libc::write(
                fd,
                bytes[offset..].as_ptr().cast(),
                bytes.len() - offset,
            )
        };
        if n < 0 {
            let err = IoError::last_os_error();
            let code = err.raw_os_error().unwrap_or(-1);
            if code == libc::EAGAIN || code == libc::EWOULDBLOCK {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            return Err(last_os_error("write"));
        }
        offset += n as usize;
    }
    Ok(())
}

#[cfg(unix)]
fn read_loop(
    master: std::os::unix::io::RawFd,
    pid: libc::pid_t,
    stop: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let mut pfd = libc::pollfd {
            fd: master,
            events: libc::POLLIN,
            revents: 0,
        };
        let rc = unsafe { libc::poll(&mut pfd, 1, 250) };
        if rc < 0 {
            let err = IoError::last_os_error();
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            break;
        }
        if rc == 0 {
            continue;
        }
        if pfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) == 0 {
            continue;
        }

        loop {
            let n = unsafe { libc::read(master, buf.as_mut_ptr().cast(), buf.len()) };
            if n > 0 {
                emit_terminal_data(&buf[..n as usize]);
                continue;
            }
            if n == 0 {
                cleanup_session(pid, master);
                return;
            }
            let err = IoError::last_os_error();
            let code = err.raw_os_error().unwrap_or(-1);
            if code == libc::EAGAIN || code == libc::EWOULDBLOCK {
                break;
            }
            if !stop.load(Ordering::Relaxed) {
                cleanup_session(pid, master);
            }
            return;
        }
    }
    if !stop.load(Ordering::Relaxed) {
        cleanup_session(pid, master);
    }
}

#[cfg(unix)]
#[tauri::command]
pub fn terminal_start(
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
) -> Result<Value, String> {
    let cols = cols.unwrap_or(80).max(2);
    let rows = rows.unwrap_or(24).max(2);
    kill_current();

    let (master, slave) = open_pty()?;
    configure_slave(slave)?;
    set_nonblocking(master)?;
    set_window_size(master, cols, rows)?;
    let pid = spawn_shell(cwd, master, slave)?;
    unsafe { libc::close(slave) };

    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    *terminal_state().lock().unwrap() = Some(TerminalSession {
        master,
        pid,
        stop,
    });
    thread::spawn(move || read_loop(master, pid, reader_stop));
    Ok(json!({ "ok": true }))
}

#[cfg(unix)]
#[tauri::command]
pub fn terminal_write(data: String) -> Result<(), String> {
    let guard = terminal_state().lock().unwrap();
    match guard.as_ref() {
        Some(session) => write_all(session.master, data.as_bytes()),
        None => Err("Terminal is not running".to_string()),
    }
}

#[cfg(unix)]
#[tauri::command]
pub fn terminal_resize(cols: u16, rows: u16) -> Result<(), String> {
    let guard = terminal_state().lock().unwrap();
    match guard.as_ref() {
        Some(session) => set_window_size(session.master, cols.max(2), rows.max(2)),
        None => Err("Terminal is not running".to_string()),
    }
}

#[cfg(unix)]
#[tauri::command]
pub fn terminal_kill() -> Result<Value, String> {
    kill_current();
    Ok(json!({ "ok": true }))
}

#[cfg(not(unix))]
#[tauri::command]
pub fn terminal_start(
    _cols: Option<u16>,
    _rows: Option<u16>,
    _cwd: Option<String>,
) -> Result<Value, String> {
    Err("Interactive terminal is not supported on this platform".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn terminal_write(_data: String) -> Result<(), String> {
    Err("Terminal is not running".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn terminal_resize(_cols: u16, _rows: u16) -> Result<(), String> {
    Err("Terminal is not running".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn terminal_kill() -> Result<Value, String> {
    Ok(json!({ "ok": true }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn pty_receives_shell_output() {
        let (master, slave) = open_pty().expect("openpty");
        configure_slave(slave).expect("configure slave");
        set_nonblocking(master).expect("nonblocking master");
        let pid = spawn_shell(None, master, slave).expect("spawn shell");
        unsafe { libc::close(slave) };

        let _ = write_all(master, b"printf terminal-ok\n");
        let mut output = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + Duration::from_secs(5);

        while std::time::Instant::now() < deadline && !output.contains("terminal-ok") {
            let mut pfd = libc::pollfd {
                fd: master,
                events: libc::POLLIN,
                revents: 0,
            };
            let rc = unsafe { libc::poll(&mut pfd, 1, 200) };
            if rc > 0 && pfd.revents & libc::POLLIN != 0 {
                loop {
                    let n = unsafe { libc::read(master, buf.as_mut_ptr().cast(), buf.len()) };
                    if n > 0 {
                        output.push_str(&String::from_utf8_lossy(&buf[..n as usize]));
                    } else {
                        let err = IoError::last_os_error();
                        let code = err.raw_os_error().unwrap_or(-1);
                        if code != libc::EAGAIN && code != libc::EWOULDBLOCK {
                            break;
                        }
                        break;
                    }
                }
            }
        }

        unsafe {
            let _ = libc::kill(-pid, libc::SIGKILL);
            libc::close(master);
        }
        reap_child(pid);
        assert!(
            output.contains("terminal-ok"),
            "expected shell output, got: {output}"
        );
    }
}
