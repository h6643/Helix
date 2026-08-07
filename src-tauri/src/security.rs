//! `secure:*`, `shell:*` and `dialog:*` commands.
//! Port of `electron/ipc/security.js` + the shell/dialog handlers in main.js.
//!
//! safeStorage is replaced by a machine-bound AES-GCM key (Linux libsecret is
//! unavailable in many desktop environments; a key file under userData with
//! 0600 perms gives equivalent single-user protection). The ciphertext format
//! is `b64(nonce) + ":" + b64(ciphertext)`.

use crate::state::{user_data_dir, AppState};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::{AppHandle, State};

const KEY_FILE: &str = "helix-secure.key";

fn machine_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| {
        let dir = user_data_dir().unwrap_or_else(std::env::temp_dir);
        let path = dir.join(KEY_FILE);
        let key: [u8; 32] = match std::fs::read(&path) {
            Ok(raw) if raw.len() == 32 => raw.try_into().unwrap_or_else(|_| new_key(&dir, &path)),
            _ => new_key(&dir, &path),
        };
        key
    })
}

fn new_key(dir: &std::path::Path, path: &std::path::Path) -> [u8; 32] {
    let mut key = [0u8; 32];
    let mut rng = rand::thread_rng();
    rng.fill_bytes(&mut key);
    let _ = std::fs::create_dir_all(dir);
    // Persist with 0600 so only the owner can read it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::write(path, &key);
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, &key);
    }
    key
}

fn derive_cipher() -> Aes256Gcm {
    let key = machine_key();
    Aes256Gcm::new_from_slice(key).expect("32-byte key")
}

#[tauri::command]
pub fn secure_available() -> bool {
    true
}

#[tauri::command]
pub fn secure_encrypt(plaintext: String) -> Option<String> {
    if plaintext.is_empty() {
        return Some(String::new());
    }
    if !secure_available() {
        return None;
    }
    let cipher = derive_cipher();
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    match cipher.encrypt(nonce, plaintext.as_bytes()) {
        Ok(ct) => Some(format!(
            "{}:{}",
            hex::encode(nonce_bytes),
            hex::encode(&ct)
        )),
        Err(_) => None,
    }
}

#[tauri::command]
pub fn secure_decrypt(blob: String) -> Option<String> {
    if blob.is_empty() {
        return Some(String::new());
    }
    if !secure_available() {
        return None;
    }
    let (b64n, b64c) = blob.split_once(':')?;
    let nonce_bytes = hex::decode(b64n).ok()?;
    if nonce_bytes.len() != 12 {
        return None;
    }
    let ct = hex::decode(b64c).ok()?;
    let cipher = derive_cipher();
    match cipher.decrypt(Nonce::from_slice(&nonce_bytes), ct.as_slice()) {
        Ok(plain) => String::from_utf8(plain).ok(),
        Err(_) => None,
    }
}

// ── shell ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn open(target: String) {
    // shell.openExternal — browser/anonymous target.
    let _ = tauri_plugin_opener::open_url(target, None::<String>);
}

#[tauri::command]
pub fn show_item_in_folder(state: State<'_, Arc<AppState>>, relative_path: String) -> Value {
    let resolved = crate::fs::resolve_safe(state.inner(), &relative_path);
    let resolved = match resolved {
        Some(p) => p,
        None => {
            // Also allow the Hermes memory directory (learning view "reveal in folder").
            let mem_dir = crate::paths::hermes_data_dir().join("memories");
            let candidate = std::path::Path::new(&relative_path).to_path_buf();
            if candidate.starts_with(&mem_dir) {
                candidate
            } else {
                return json!({ "ok": false, "error": "路径不安全或超出工作目录范围" });
            }
        }
    };
    let _ = tauri_plugin_opener::reveal_item_in_dir(resolved);
    json!({ "ok": true })
}

#[tauri::command]
pub fn open_path(dir: String) {
    let _ = tauri_plugin_opener::open_path(dir, None::<String>);
}

#[tauri::command]
pub fn exec() -> Result<(), String> {
    // shell:exec is disabled for security (mirror electron).
    Err("shell:exec is disabled for security".into())
}

// ── dialogs ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn open_directory(app: AppHandle, default_path: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let mut builder = app.dialog().file();
    if let Some(dp) = default_path {
        if !dp.trim().is_empty() {
            builder = builder.set_directory(&dp);
        }
    }
    match builder.blocking_pick_folder() {
        Some(FilePath::Path(p)) => p.into_os_string().into_string().ok(),
        _ => None,
    }
}

#[tauri::command]
pub fn open_file(app: AppHandle, options: Option<Value>) -> Option<String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let mut builder = app.dialog().file();
    if let Some(opts) = options {
        if let Some(filters) = opts.get("filters").and_then(|v| v.as_array()) {
            for f in filters {
                if let (Some(name), Some(exts)) = (
                    f.get("name").and_then(|v| v.as_str()),
                    f.get("extensions").and_then(|v| v.as_array()),
                ) {
                    let ext_str: Vec<&str> = exts.iter().filter_map(|e| e.as_str()).collect();
                    builder = builder.add_filter(name, &ext_str);
                }
            }
        }
    }
    match builder.blocking_pick_file() {
        Some(FilePath::Path(p)) => p.into_os_string().into_string().ok(),
        _ => None,
    }
}

#[tauri::command]
pub fn save_file(app: AppHandle, options: Option<Value>) -> Option<String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let mut builder = app.dialog().file();
    if let Some(opts) = options {
        if let Some(filters) = opts.get("filters").and_then(|v| v.as_array()) {
            for f in filters {
                if let (Some(name), Some(exts)) = (
                    f.get("name").and_then(|v| v.as_str()),
                    f.get("extensions").and_then(|v| v.as_array()),
                ) {
                    let ext_str: Vec<&str> = exts.iter().filter_map(|e| e.as_str()).collect();
                    builder = builder.add_filter(name, &ext_str);
                }
            }
        }
    }
    match builder.blocking_save_file() {
        Some(FilePath::Path(p)) => p.into_os_string().into_string().ok(),
        _ => None,
    }
}

// ── diagnostics helper ─────────────────────────────────────────────────────

#[allow(dead_code)]
pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}
