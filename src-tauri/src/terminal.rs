//! Interactive terminal for the Tauri build (Windows plain-pipe backend).
//!
//! The renderer uses xterm.js and talks to these commands through the Tauri
//! bridge. Output is pushed back as `terminal:data` string events.

use serde_json::{json, Value};

// ===========================================================================
// Plain-pipe process backend (no ConPTY).
//
// ConPTY (CreatePseudoConsole + PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE) is broken
// on this machine: any console app attached to a pseudo console exits with
// 0xC0000142 (STATUS_DLL_INIT_FAILED). Verified in isolation for both cmd.exe
// and powershell.exe with a canonical ConPTY setup (MTA COM, inheritable pipes,
// correct attribute list, valid HPCON), while plain pipe redirection works. The
// cause is a system-level ConPTY host failure, not a code bug.
//
// Fallback: spawn Windows PowerShell (powershell.exe 5.1 — always present at a
// stable system path) with STARTF_USESTDHANDLES piping stdin/stdout/stderr
// through anonymous pipes. Not a real TTY (no line editing / console echo), but
// it reliably runs commands and streams output. The shell is bootstrapped with
// UTF-8 console encodings so CJK output survives the pipe. If the machine's
// ConPTY is repaired, switch this backend back to the pseudo-console flow.
//
// Written against `windows` 0.61 (the same major version Tauri 2 pulls in).
// `HANDLE` is pointer-backed (not `Send`/`Sync` in 0.51+), so
// `WindowsTerminalSession` is explicitly marked `Send`/`Sync` — the values are
// plain OS handles safe to move between threads and all access is serialized
// by the Mutex.
// ===========================================================================

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::Emitter;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, TerminateProcess, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};

fn emit_terminal_data(id: u32, data: &[u8]) {
    let text = String::from_utf8_lossy(data).into_owned();
    let _ = crate::state::app_handle().emit("terminal:data", json!({ "id": id, "data": text }));
}

struct WindowsTerminalSession {
    h_in_write: HANDLE,
    h_out_read: HANDLE,
    process: PROCESS_INFORMATION,
    stop: Arc<AtomicBool>,
}

// `HANDLE` is pointer-backed and not `Send`/`Sync` in windows 0.51+, but the
// values are just OS handles that are safe to move between threads; all access
// is serialized by the `Mutex` below.
unsafe impl Send for WindowsTerminalSession {}
unsafe impl Sync for WindowsTerminalSession {}

static WINDOWS_TERMINAL: OnceLock<Mutex<HashMap<u32, WindowsTerminalSession>>> = OnceLock::new();

fn windows_terminal_state() -> &'static Mutex<HashMap<u32, WindowsTerminalSession>> {
    WINDOWS_TERMINAL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn kill_session(id: u32) {
    let mut guard = windows_terminal_state().lock().unwrap();
    if let Some(session) = guard.remove(&id) {
        session.stop.store(true, Ordering::Relaxed);
        unsafe {
            let _ = TerminateProcess(session.process.hProcess, 0);
            let _ = CloseHandle(session.process.hThread);
            let _ = CloseHandle(session.process.hProcess);
            let _ = CloseHandle(session.h_in_write);
            let _ = CloseHandle(session.h_out_read);
        }
    }
}

fn read_loop(id: u32, h_out_read: usize, stop: Arc<AtomicBool>) {
    // windows 0.61 的 `HANDLE` 是 `*mut c_void`（非 Send），不能直接 move 进
    // `thread::spawn` 的闭包；这里以 `usize` 传句柄，进函数再还原。
    let h_out_read = HANDLE(h_out_read as *mut std::ffi::c_void);
    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let mut bytes_read: u32 = 0;
        let ok = unsafe { ReadFile(h_out_read, Some(&mut buf), Some(&mut bytes_read), None) };
        // 0 字节 = 子进程已退出（管道写端全部关闭）→ EOF
        if ok.is_err() || bytes_read == 0 {
            break;
        }
        emit_terminal_data(id, &buf[..bytes_read as usize]);
    }
}

#[tauri::command]
pub fn terminal_start(
    id: u32,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
) -> Result<Value, String> {
    // 普通管道无窗口尺寸语义；保留参数仅为前端接口兼容。
    let _ = (cols, rows);

    unsafe {
        let mut h_in_read: HANDLE = HANDLE::default();
        let mut h_in_write: HANDLE = HANDLE::default();
        let mut h_out_read: HANDLE = HANDLE::default();
        let mut h_out_write: HANDLE = HANDLE::default();
        let inheritable = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };

        if CreatePipe(
            &mut h_in_read,
            &mut h_in_write,
            Some(&inheritable as *const SECURITY_ATTRIBUTES),
            0,
        )
        .is_err()
        {
            return Err("failed to create input pipe".to_string());
        }
        if CreatePipe(
            &mut h_out_read,
            &mut h_out_write,
            Some(&inheritable as *const SECURITY_ATTRIBUTES),
            0,
        )
        .is_err()
        {
            let _ = CloseHandle(h_in_read);
            let _ = CloseHandle(h_in_write);
            return Err("failed to create output pipe".to_string());
        }
        // 保留的端（写输入/读输出）设为不可继承
        // 子进程退出后管道读端仍开着，收不到 EOF
        // 收不到 EOF。
        let _ = SetHandleInformation(h_in_write, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
        let _ = SetHandleInformation(h_out_read, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));

        let mut si = STARTUPINFOW::default();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = h_in_read;
        si.hStdOutput = h_out_write;
        si.hStdError = h_out_write;

        // 管道模式下 PowerShell 默认按 OEM 代码页输出，中文会乱码；启动时把
        // 输入/输出编码强制为 UTF-8。`-NoLogo -NoExit` 去掉横幅并保持交互。
        let mut cmd_line: Vec<u16> = "powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -Command \"[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8\"\0"
            .encode_utf16()
            .collect();
        // `std::fs::canonicalize` yields verbatim `\\?\` paths; if one leaks in
        // here the shell starts in a verbatim cwd and the prompt renders as
        // `Microsoft.PowerShell.Core\FileSystem::\\?\D:\...`. Strip the prefix.
        let cwd_wide: Option<Vec<u16>> = cwd.filter(|c| !c.trim().is_empty()).map(|c| {
            let c = match c.strip_prefix("\\\\?\\") {
                Some(rest) => rest.to_string(),
                None => c,
            };
            c.encode_utf16().chain(std::iter::once(0u16)).collect()
        });
        let cwd_pcwstr: Option<PCWSTR> = cwd_wide.as_ref().map(|v| PCWSTR(v.as_ptr()));

        let mut pi = PROCESS_INFORMATION::default();
        let ok = CreateProcessW(
            None,
            Some(PWSTR(cmd_line.as_mut_ptr())),
            None,
            None,
            true,
            PROCESS_CREATION_FLAGS(0),
            None,
            // windows-core 0.61 的 `Param<PCWSTR>` 只实现于 `Option<&T>`
            //（值类型 `Option<PCWSTR>` 没有 Param 实现），传引用。
            cwd_pcwstr.as_ref(),
            &si as *const STARTUPINFOW,
            &mut pi,
        );
        // 子进程通过 STARTF_USESTDHANDLES 拿到了 h_in_read / h_out_write；
        // 关闭父进程的副本，子进程退出时输出管道写端全关 → EOF。
        let _ = CloseHandle(h_in_read);
        let _ = CloseHandle(h_out_write);
        if ok.is_err() {
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            return Err("CreateProcessW(powershell.exe) failed".to_string());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        // HANDLE 非 Send，先取出底层指针值（usize）再进闭包——否则 move 闭包
        // 会捕获整个 HANDLE（`*mut c_void`）导致 thread::spawn 报 Send 错误。
        let out_read_raw = h_out_read.0 as usize;
        thread::spawn(move || read_loop(id, out_read_raw, reader_stop));

        windows_terminal_state().lock().unwrap().insert(
            id,
            WindowsTerminalSession {
                h_in_write,
                h_out_read,
                process: pi,
                stop,
            },
        );

        Ok(json!({ "ok": true }))
    }
}

#[tauri::command]
pub fn terminal_write(id: u32, data: String) -> Result<(), String> {
    let guard = windows_terminal_state().lock().unwrap();
    match guard.get(&id) {
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

#[tauri::command]
pub fn terminal_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    // 普通管道无窗口尺寸语义——接受但忽略。
    let _ = (id, cols, rows);
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(id: u32) -> Result<Value, String> {
    kill_session(id);
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    // PeekNamedPipe 仅测试轮询用；生产 read_loop 用阻塞 ReadFile。
    use windows::Win32::System::Pipes::PeekNamedPipe;

    /// 普通管道回退后端的机制验证：CreatePipe + STARTF_USESTDHANDLES +
    /// CreateProcessW 跑 `cmd.exe /c echo`，应能在输出管道收到数据。
    #[test]
    fn plain_pipe_cmd_echo() {
        unsafe {
            let mut h_in_read: HANDLE = HANDLE::default();
            let mut h_in_write: HANDLE = HANDLE::default();
            let mut h_out_read: HANDLE = HANDLE::default();
            let mut h_out_write: HANDLE = HANDLE::default();
            let inheritable = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: true.into(),
            };
            assert!(
                CreatePipe(
                    &mut h_in_read,
                    &mut h_in_write,
                    Some(&inheritable as *const SECURITY_ATTRIBUTES),
                    0,
                )
                .is_ok(),
                "create input pipe"
            );
            assert!(
                CreatePipe(
                    &mut h_out_read,
                    &mut h_out_write,
                    Some(&inheritable as *const SECURITY_ATTRIBUTES),
                    0,
                )
                .is_ok(),
                "create output pipe"
            );

            let mut si = STARTUPINFOW::default();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.dwFlags = windows::Win32::System::Threading::STARTF_USESTDHANDLES;
            si.hStdInput = h_in_read;
            si.hStdOutput = h_out_write;
            si.hStdError = h_out_write;

            let mut cmd_line: Vec<u16> = "cmd.exe /c echo HELLO_PLAIN\0".encode_utf16().collect();
            let mut pi = PROCESS_INFORMATION::default();
            let ok = CreateProcessW(
                None,
                Some(PWSTR(cmd_line.as_mut_ptr())),
                None,
                None,
                true,
                windows::Win32::System::Threading::PROCESS_CREATION_FLAGS(0),
                None,
                None::<&PCWSTR>,
                &si as *const STARTUPINFOW,
                &mut pi,
            );
            assert!(ok.is_ok(), "CreateProcessW(plain) failed: {ok:?}");
            eprintln!("[test] PLAIN cmd spawned, pid={}", pi.dwProcessId);

            let mut output: Vec<u8> = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut buf = [0u8; 8192];
            while std::time::Instant::now() < deadline && output.len() < 65536 {
                let mut avail: u32 = 0;
                if PeekNamedPipe(h_out_read, None, 0, None, Some(&mut avail), None).is_err() {
                    break;
                }
                if avail > 0 {
                    let mut bytes_read: u32 = 0;
                    if ReadFile(h_out_read, Some(&mut buf), Some(&mut bytes_read), None).is_err() {
                        break;
                    }
                    output.extend_from_slice(&buf[..bytes_read as usize]);
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }

            let text = String::from_utf8_lossy(&output).into_owned();
            eprintln!(
                "[test] PLAIN pipe output ({} bytes): {:?}",
                output.len(),
                &text.chars().take(120).collect::<String>()
            );
            assert!(
                text.contains("HELLO_PLAIN"),
                "pipe redirection failed — CreatePipe/CreateProcessW broken, got: {text:?}"
            );

            let _ = TerminateProcess(pi.hProcess, 0);
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
            let _ = CloseHandle(h_in_read);
            let _ = CloseHandle(h_in_write);
            let _ = CloseHandle(h_out_read);
            let _ = CloseHandle(h_out_write);
        }
    }
}
