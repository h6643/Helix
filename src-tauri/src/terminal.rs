//! Interactive PTY-backed terminal for the Tauri build.
//!
//! The renderer uses xterm.js and talks to these commands through the Tauri
//! bridge. Output is pushed back as `terminal:data` string events.

use serde_json::{json, Value};

#[cfg(unix)]
use std::io::Error as IoError;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tauri::Emitter;

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

// ===========================================================================
// Windows (ConPTY) backend — mirrors the Unix PTY backend above.
//
// On Windows there is no POSIX PTY, so the interactive terminal is powered by
// the Windows Pseudo Console (ConPTY) API. The flow:
//   1. create two anon pipes (in/out) shared with the pseudo console,
//   2. CreatePseudoConsole(COORD, inRead, outWrite) -> HPCON,
//   3. spawn cmd.exe attached to the pseudo console,
//   4. read the out-pipe in a thread and push bytes as `terminal:data`.
// Handles are stored directly; the session struct is Send+Sync so it can live
// in a global Mutex.
// ===========================================================================

#[cfg(windows)]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use tauri::Emitter;
#[cfg(windows)]
use windows::core::{PCWSTR, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
#[cfg(windows)]
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole, COORD,
};
#[cfg(windows)]
use windows::Win32::System::IO::{ReadFile, WriteFile};
#[cfg(windows)]
use windows::Win32::System::Pipes::CreatePipe;
#[cfg(windows)]
use windows::Win32::System::Threading::{
    CreateProcessW, InitializeStartupInfoAttachedToPseudoConsole, PROCESS_INFORMATION,
    STARTUPINFO, STARTUPINFOEXW, TerminateProcess, CREATE_NO_WINDOW,
    EXTENDED_STARTUPINFO_PRESENT,
};

#[cfg(windows)]
fn emit_terminal_data(data: &[u8]) {
    let text = String::from_utf8_lossy(data).into_owned();
    let _ = crate::state::app_handle().emit("terminal:data", text);
}

#[cfg(windows)]
struct WindowsTerminalSession {
    hpc: HPCON,
    h_in_write: HANDLE,
    h_out_read: HANDLE,
    process: PROCESS_INFORMATION,
    stop: Arc<AtomicBool>,
    // NB: the proc-thread attribute list allocated by
    // InitializeStartupInfoAttachedToPseudoConsole is intentionally leaked (not
    // freed) so this struct stays Send+Sync. It is a tiny one-time allocation
    // per terminal session.
}

#[cfg(windows)]
static WINDOWS_TERMINAL: OnceLock<Mutex<Option<WindowsTerminalSession>>> = OnceLock::new();

#[cfg(windows)]
fn windows_terminal_state() -> &'static Mutex<Option<WindowsTerminalSession>> {
    WINDOWS_TERMINAL.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
fn kill_current() {
    let mut guard = windows_terminal_state().lock().unwrap();
    if let Some(session) = guard.take() {
        session.stop.store(true, Ordering::Relaxed);
        unsafe {
            let _ = TerminateProcess(session.process.hProcess, 0);
            let _ = CloseHandle(session.process.hThread);
            let _ = CloseHandle(session.process.hProcess);
            let _ = CloseHandle(session.h_in_write);
            let _ = CloseHandle(session.h_out_read);
            ClosePseudoConsole(session.hpc);
        }
    }
}

#[cfg(windows)]
fn read_loop(h_out_read: HANDLE, stop: Arc<AtomicBool>) {
    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            ReadFile(
                h_out_read,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                buf.len() as u32,
                &mut bytes_read,
                None,
            )
        };
        if !ok.is_ok() || bytes_read == 0 {
            break;
        }
        emit_terminal_data(&buf[..bytes_read as usize]);
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn terminal_start(
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
) -> Result<Value, String> {
    let cols = cols.unwrap_or(80).max(2) as i16;
    let rows = rows.unwrap_or(24).max(2) as i16;
    kill_current();

    unsafe {
        // ConPTY requires the calling thread to be in the multithreaded COM
        // apartment. If COM is already initialised (any mode) this returns an
        // error which we safely ignore — ConPTY still functions.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let mut h_in_read: HANDLE = HANDLE::NULL;
        let mut h_in_write: HANDLE = HANDLE::NULL;
        let mut h_out_read: HANDLE = HANDLE::NULL;
        let mut h_out_write: HANDLE = HANDLE::NULL;

        if !CreatePipe(&mut h_in_read, &mut h_in_write, None, 0).is_ok() {
            return Err("failed to create conpty input pipe".to_string());
        }
        if !CreatePipe(&mut h_out_read, &mut h_out_write, None, 0).is_ok() {
            let _ = CloseHandle(h_in_read);
            let _ = CloseHandle(h_in_write);
            return Err("failed to create conpty output pipe".to_string());
        }

        let size = COORD { X: cols, Y: rows };
        let mut hpc: HPCON = std::mem::zeroed();
        if CreatePseudoConsole(size, h_in_read, h_out_write, 0, &mut hpc).is_err() {
            let _ = CloseHandle(h_in_read);
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            let _ = CloseHandle(h_out_write);
            return Err("CreatePseudoConsole failed".to_string());
        }

        // ConPTY duplicates the endpoints it needs; close our local copies so
        // EOF is delivered when the shell exits.
        let _ = CloseHandle(h_in_read);
        let _ = CloseHandle(h_out_write);

        let mut si_ex = STARTUPINFOEXW::default();
        si_ex.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        if InitializeStartupInfoAttachedToPseudoConsole(&mut si_ex, hpc).is_err() {
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            ClosePseudoConsole(hpc);
            return Err("InitializeStartupInfoAttachedToPseudoConsole failed".to_string());
        }

        let mut cmd_line: Vec<u16> = "cmd.exe\0".encode_utf16().collect();
        let cwd_wide: Option<Vec<u16>> = cwd
            .filter(|c| !c.trim().is_empty())
            .map(|c| c.encode_utf16().chain(std::iter::once(0u16)).collect());
        let cwd_pcwstr: Option<PCWSTR> = cwd_wide.as_ref().map(|v| PCWSTR(v.as_ptr()));

        let mut pi = PROCESS_INFORMATION::default();
        let creation_flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
        let ok = CreateProcessW(
            None,
            PWSTR(cmd_line.as_mut_ptr()),
            None,
            None,
            FALSE,
            creation_flags,
            None,
            cwd_pcwstr,
            &si_ex as *const STARTUPINFOEXW as *const STARTUPINFO,
            &mut pi,
        );
        if !ok.is_ok() {
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            ClosePseudoConsole(hpc);
            return Err("CreateProcessW(cmd.exe) failed".to_string());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        thread::spawn(move || read_loop(h_out_read, reader_stop));

        *windows_terminal_state().lock().unwrap() = Some(WindowsTerminalSession {
            hpc,
            h_in_write,
            h_out_read,
            process: pi,
            stop,
        });

        Ok(json!({ "ok": true }))
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn terminal_write(data: String) -> Result<(), String> {
    let guard = windows_terminal_state().lock().unwrap();
    match guard.as_ref() {
        Some(session) => {
            let bytes = data.as_bytes();
            let mut offset = 0;
            while offset < bytes.len() {
                let mut written: u32 = 0;
                let ok = unsafe {
                    WriteFile(
                        session.h_in_write,
                        bytes[offset..].as_ptr() as *const std::ffi::c_void,
                        (bytes.len() - offset) as u32,
                        &mut written,
                        None,
                    )
                };
                if !ok.is_ok() {
                    return Err("failed to write to terminal".to_string());
                }
                offset += written as usize;
            }
            Ok(())
        }
        None => Err("Terminal is not running".to_string()),
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn terminal_resize(cols: u16, rows: u16) -> Result<(), String> {
    let guard = windows_terminal_state().lock().unwrap();
    match guard.as_ref() {
        Some(session) => {
            let size = COORD {
                X: cols.max(2) as i16,
                Y: rows.max(2) as i16,
            };
            if unsafe { ResizePseudoConsole(session.hpc, size) }.is_err() {
                return Err("failed to resize terminal".to_string());
            }
            Ok(())
        }
        None => Err("Terminal is not running".to_string()),
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn terminal_kill() -> Result<Value, String> {
    kill_current();
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
