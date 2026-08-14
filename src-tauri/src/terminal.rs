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
    if unsafe { libc::tcsetattr(slave, libc::TCSANOW, &mut termios) } != 0 {
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
//   2. CreatePseudoConsole(COORD, inRead, outWrite, 0) -> HPCON,
//   3. attach the HPCON to a proc-thread attribute list and spawn cmd.exe,
//   4. read the out-pipe in a thread and push bytes as `terminal:data`.
// Handles are stored directly; the session struct is Send+Sync so it can live
// in a global Mutex.
//
// Written against `windows` 0.61 (the same major version Tauri 2 pulls in),
// so there is exactly one `windows_core` in the graph and no `PCWSTR` version
// clash. `HANDLE`/`HPCON` are pointer-backed (not `Send`/`Sync` in 0.51+), so
// `WindowsTerminalSession` is explicitly marked `Send`/`Sync` — the values are
// plain OS handles safe to move between threads and all access is serialized
// by the Mutex.
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
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
#[cfg(windows)]
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole, COORD,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
#[cfg(windows)]
use windows::Win32::System::Pipes::CreatePipe;
#[cfg(windows)]
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
    STARTUPINFOEXW, STARTUPINFOW, TerminateProcess, CREATE_NO_WINDOW,
    EXTENDED_STARTUPINFO_PRESENT, UpdateProcThreadAttribute,
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
}

// `HANDLE`/`HPCON` are pointer-backed and not `Send`/`Sync` in windows 0.51+,
// but the values are just OS handles that are safe to move between threads;
// all access is serialized by the `Mutex` below.
#[cfg(windows)]
unsafe impl Send for WindowsTerminalSession {}
#[cfg(windows)]
unsafe impl Sync for WindowsTerminalSession {}

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
fn read_loop(h_out_read: usize, stop: Arc<AtomicBool>) {
    // windows 0.61 的 `HANDLE` 是 `*mut c_void`（非 Send），不能直接 move 进
    // `thread::spawn` 的闭包；这里以 `usize` 传句柄，进函数再还原。
    let h_out_read = HANDLE(h_out_read as *mut std::ffi::c_void);
    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            ReadFile(
                h_out_read,
                Some(&mut buf),
                Some(&mut bytes_read),
                None,
            )
        };
        if ok.is_err() || bytes_read == 0 {
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

        let mut h_in_read: HANDLE = HANDLE::default();
        let mut h_in_write: HANDLE = HANDLE::default();
        let mut h_out_read: HANDLE = HANDLE::default();
        let mut h_out_write: HANDLE = HANDLE::default();

        if CreatePipe(&mut h_in_read, &mut h_in_write, None, 0).is_err() {
            return Err("failed to create conpty input pipe".to_string());
        }
        if CreatePipe(&mut h_out_read, &mut h_out_write, None, 0).is_err() {
            let _ = CloseHandle(h_in_read);
            let _ = CloseHandle(h_in_write);
            return Err("failed to create conpty output pipe".to_string());
        }

        let size = COORD { X: cols, Y: rows };
        let hpc = match CreatePseudoConsole(size, h_in_read, h_out_write, 0) {
            Ok(h) => h,
            Err(e) => {
                let _ = CloseHandle(h_in_read);
                let _ = CloseHandle(h_in_write);
                let _ = CloseHandle(h_out_read);
                let _ = CloseHandle(h_out_write);
                return Err(format!("CreatePseudoConsole failed: {e}"));
            }
        };

        // ConPTY duplicates the endpoints it needs; close our local copies so
        // EOF is delivered when the shell exits.
        let _ = CloseHandle(h_in_read);
        let _ = CloseHandle(h_out_write);

        // Attach the pseudo console to the new process via a proc-thread
        // attribute list (InitializeStartupInfoAttachedToPseudoConsole was
        // removed in windows 0.58+).
        let mut si_ex = STARTUPINFOEXW::default();
        si_ex.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;

        let mut attr_size: usize = 0;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attr_size);
        let mut attr_buf: Vec<usize> = vec![0usize; (attr_size + 7) / 8];
        let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut std::ffi::c_void);
        if InitializeProcThreadAttributeList(Some(attr_list), 1, None, &mut attr_size).is_err() {
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            ClosePseudoConsole(hpc);
            return Err("InitializeProcThreadAttributeList failed".to_string());
        }
        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(&hpc as *const HPCON as *const std::ffi::c_void),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )
        .is_err()
        {
            DeleteProcThreadAttributeList(attr_list);
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            ClosePseudoConsole(hpc);
            return Err("UpdateProcThreadAttribute failed".to_string());
        }
        si_ex.lpAttributeList = attr_list;

        let mut cmd_line: Vec<u16> = "cmd.exe\0".encode_utf16().collect();
        let cwd_wide: Option<Vec<u16>> = cwd
            .filter(|c| !c.trim().is_empty())
            .map(|c| c.encode_utf16().chain(std::iter::once(0u16)).collect());
        let cwd_pcwstr: Option<PCWSTR> = cwd_wide.as_ref().map(|v| PCWSTR(v.as_ptr()));

        let mut pi = PROCESS_INFORMATION::default();
        let creation_flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
        // bInheritHandles 必须为 TRUE：Microsoft 的 ConPTY 文档要求附加了
        // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 的进程以 TRUE 创建，否则子进程
        // （cmd.exe）无法访问伪控制台句柄，输出永远到不了管道读端 —— 终端
        // 会一片空白（Windows 下「终端无法正常显示」的根因）。
        let ok = CreateProcessW(
            None,
            Some(PWSTR(cmd_line.as_mut_ptr())),
            None,
            None,
            true,
            creation_flags,
            None,
            // windows-core 0.61 的 `Param<PCWSTR>` 只实现于 `Option<&T>`
            //（值类型 `Option<PCWSTR>` 没有 Param 实现），传引用。
            cwd_pcwstr.as_ref(),
            &si_ex as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut pi,
        );
        // The attribute list is only needed to spawn the process.
        DeleteProcThreadAttributeList(attr_list);
        if ok.is_err() {
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            ClosePseudoConsole(hpc);
            return Err("CreateProcessW(cmd.exe) failed".to_string());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        // HANDLE 非 Send，先取出底层指针值（usize）再进闭包——否则 move 闭包
        // 会捕获整个 HANDLE（`*mut c_void`）导致 thread::spawn 报 Send 错误。
        let out_read_raw = h_out_read.0 as usize;
        thread::spawn(move || read_loop(out_read_raw, reader_stop));

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
                        Some(&bytes[offset..]),
                        Some(&mut written),
                        None,
                    )
                };
                if ok.is_err() {
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
