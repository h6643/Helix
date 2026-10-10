//! Shared no-shell subprocess helper for external CLIs (`gh`, `cargo`, `node`,
//! `tsc`, `go`, …). `git.rs` keeps its own `git_exec` — it has a 30 s budget and
//! treats a non-zero exit as an error. Callers here need those two decisions
//! separated: `tsc` exits 1 *because* it found problems, so the exit code is
//! data, and a real check needs minutes rather than seconds.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub struct ExecOutcome {
    /// `None` when the child was killed after `timeout`.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub enum ExecError {
    /// The program could not be started (not on PATH, or not launchable on
    /// this platform). Carries the OS message so the UI can name *which*
    /// program failed instead of a generic "运行失败".
    Unavailable(String),
}

/// Run `program args…` in `cwd` with piped output, killing it at `timeout`.
///
/// Both pipes are drained on their own threads *while* waiting. A parent that
/// only polls `try_wait()` deadlocks once the child fills the OS pipe buffer
/// (`cargo check --message-format=json` and `tsc` produce megabytes), and that
/// deadlock would be reported to the user as a timeout.
pub fn run(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<ExecOutcome, ExecError> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| ExecError::Unavailable(format!("{program} 无法启动: {e}")))?;
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();

    let mut stdout_bytes: Vec<u8> = Vec::new();
    let mut stderr_bytes: Vec<u8> = Vec::new();
    let mut code: Option<i32> = None;
    let deadline = Instant::now() + timeout;

    std::thread::scope(|scope| {
        let (out_buf, err_buf) = (&mut stdout_bytes, &mut stderr_bytes);
        scope.spawn(move || {
            if let Some(mut pipe) = out_pipe {
                let _ = pipe.read_to_end(out_buf);
            }
        });
        scope.spawn(move || {
            if let Some(mut pipe) = err_pipe {
                let _ = pipe.read_to_end(err_buf);
            }
        });
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    code = status.code();
                    break;
                }
                Ok(None) => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        // code stays None — callers read that as "超时".
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = child.kill();
                    break;
                }
            }
        }
    });

    Ok(ExecOutcome {
        code,
        stdout: String::from_utf8_lossy(&stdout_bytes).to_string(),
        stderr: String::from_utf8_lossy(&stderr_bytes).to_string(),
    })
}

/// Absolute path to `program` if it is on PATH (PATHEXT-aware on Windows).
/// Tells "not installed" apart from "installed but failed", so the UI can offer
/// to install rather than report an opaque error.
pub fn locate(program: &str) -> Option<PathBuf> {
    which::which(program).ok()
}

/// A runnable `node`. Mirrors how `pi_gateway::resolve_pi_cli` avoids launching
/// npm's `.cmd` shims on Windows: running the tool's own `.js` entry under node
/// works on every platform, whereas launching `<tool>.cmd` leans on
/// CreateProcess batch-file handling that has bitten this project before.
pub fn node_binary() -> String {
    if let Some(p) = locate("node") {
        return p.to_string_lossy().into_owned();
    }
    "node".to_string()
}
