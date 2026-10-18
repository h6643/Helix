// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // SSH_ASKPASS 子进程模式：ssh.exe 拿密码时会把本 exe 当 askpass 程序拉起
    // （见 ssh.rs::apply_auth_env）。见到标记变量就打印密码退出，绝不进 GUI。
    if let Ok(pw) = std::env::var("HELIX_SSH_ASKPASS_VALUE") {
        if !pw.is_empty() {
            print!("{pw}\n");
            std::process::exit(0);
        }
        std::process::exit(1);
    }
    helix_lib::run()
}
