//! 从本机 Chrome / Edge 导入密码到内置浏览器（设置页「浏览器」）。
//!
//! 三条边界：
//! 1. **只读**系统浏览器的 profile（`Login Data`），
//!    数据库被占用时先整库拷到临时目录再读（Chrome 运行中也安全）。
//! 2. **只写**内置浏览器自己的 WebView2 profile（`<UDF>/EBWebView/Default`），
//!    写之前必须 `close_all_browser_windows`（WebView2 持有文件句柄）。
//! 3. Helix 自身**不留任何副本**：密码解密后直接写进浏览器的 Login Data，
//!    进程内不缓存、不落盘到 Helix 的数据目录。
//!
//! Chrome v10/v11 密码 = `"v10" + IV(12) + AES-128-CBC(PKCS7) + HMAC-SHA256 截断(16)`，
//! 密钥来自 `Local State` 的 `os_crypt.encrypted_key`（DPAPI 包了一层）。
//! Chrome 127+ 的应用绑定加密（v20）**无法**被第三方进程解密，只能跳过并在
//! 结果里报告条数。
//!
//! 写入端把密码用**内置浏览器自己** Local State 里的密钥重新加密成 v10，
//! Chromium 读自己的 Login Data 时即可解出并在登录页自动填充（读取不依赖
//! 密码自动保存开关，那是写入路径的开关）。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// ── 系统浏览器探测 ──────────────────────────────────────────────────────

/// 本机已安装的浏览器（目前支持 Chrome / Edge 两个 Chromium 系）。
fn system_browser_root(id: &str) -> Option<PathBuf> {
    let local = dirs::data_local_dir()?;
    match id {
        "chrome" => Some(local.join("Google").join("Chrome").join("User Data")),
        "edge" => Some(local.join("Microsoft").join("Edge").join("User Data")),
        _ => None,
    }
}

/// 浏览器可用的 profile 列表：User Data 下含 History / Login Data 的子目录
/// （`Default`、`Profile 1`…）。排除 System Profile 之类的基础设施目录。
fn list_profiles(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "System Profile" || name.starts_with('.') {
            continue;
        }
        if p.join("History").is_file()
            || p.join("Login Data").is_file()
            || p.join("Bookmarks").is_file()
        {
            out.push(name);
        }
    }
    out.sort();
    // Default 永远排第一（多数用户只有它）。
    out.sort_by(|a, b| match (a.as_str(), b.as_str()) {
        ("Default", _) => std::cmp::Ordering::Less,
        (_, "Default") => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
    out
}

fn profile_dir(root: &Path, profile: &str) -> PathBuf {
    // profile 名只来自 list_profiles 或用户显式传入；防路径穿越。
    let safe: String = profile
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '_' || *c == '-')
        .collect();
    root.join(if safe.is_empty() { "Default".to_string() } else { safe })
}

// ── Chrome 时间戳（1601-01-01 起的微秒）↔ unix ─────────────────────────

const CHROME_EPOCH_OFFSET_US: i64 = 11_644_473_600_000_000;

fn unix_us_to_chrome(unix_us: i64) -> i64 {
    unix_us + CHROME_EPOCH_OFFSET_US
}

fn now_unix_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

// ── 被占用 SQLite 的快照读取 ───────────────────────────────────────────

/// 把 SQLite 库连同 -wal / -shm 拷进临时目录（Chrome 运行中主文件被独占锁，
/// 直接打开会失败；拷贝读取是各密码导出工具的通用做法）。返回 (临时目录, 快照路径)。
fn snapshot_db(src: &Path) -> Option<(PathBuf, PathBuf)> {
    if !src.is_file() {
        return None;
    }
    let tag = format!(
        "helix-bimport-{}-{}",
        std::process::id(),
        rand::random::<u32>()
    );
    let tmp_dir = std::env::temp_dir().join(tag);
    std::fs::create_dir_all(&tmp_dir).ok()?;
    let dst = tmp_dir.join(src.file_name()?);
    if std::fs::copy(src, &dst).is_err() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return None;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", src.display(), suffix));
        if sidecar.is_file() {
            let _ = std::fs::copy(&sidecar, PathBuf::from(format!("{}{}", dst.display(), suffix)));
        }
    }
    Some((tmp_dir, dst))
}

fn cleanup_tmp(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn open_readonly(db: &Path) -> Result<rusqlite::Connection, String> {
    rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("打开 {} 失败: {e}", db.display()))
}

// ── DPAPI（手写 FFI，不绑 windows crate 的版本线） ─────────────────────

#[cfg(target_os = "windows")]
mod dpapi {
    use std::os::raw::c_void;

    #[repr(C)]
    pub struct Blob {
        pub cb_data: u32,
        pub pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_NONE: u32 = 0x1;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const Blob,
            desc: *const u16,
            entropy: *const Blob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const Blob,
            desc: *mut *mut u16,
            entropy: *const Blob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut Blob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut c_void) -> *mut c_void;
    }

    /// LocalFree 的 RAII：Crypt*Data 输出缓冲区必须 LocalFree，漏了就是常驻泄漏。
    struct LocalFreeGuard(*mut u8);
    impl Drop for LocalFreeGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0 as *mut c_void);
                }
            }
        }
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        if data.is_empty() {
            return None;
        }
        unsafe {
            let input = Blob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut output = Blob {
                cb_data: 0,
                pb_data: std::ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_NONE,
                &mut output,
            );
            let _guard = LocalFreeGuard(output.pb_data);
            if ok == 0 || output.pb_data.is_null() || output.cb_data == 0 {
                return None;
            }
            Some(std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec())
        }
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        if data.is_empty() {
            return None;
        }
        unsafe {
            let input = Blob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut output = Blob {
                cb_data: 0,
                pb_data: std::ptr::null_mut(),
            };
            let ok = CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_NONE,
                &mut output,
            );
            let _guard = LocalFreeGuard(output.pb_data);
            if ok == 0 || output.pb_data.is_null() || output.cb_data == 0 {
                return None;
            }
            Some(std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod dpapi {
    pub fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
    pub fn protect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

// ── Chrome os_crypt 密钥 + v10 密码加解密 ───────────────────────────────

use aes::cipher::{generic_array::GenericArray, BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use aes_gcm::aead::{Aead, KeyInit as AeadKeyInit};
use aes_gcm::Aes256Gcm;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// AES-128-CBC 解密（手写链式：cbc crate 已迁 cipher 0.5，与 aes 0.8 不兼容）。
/// `iv12` 是 Chrome v10 的 12 字节 nonce，右侧补 4 个 0 凑满一个 AES 块。
/// 末尾按 PKCS7 去填充；填充非法 → None。
fn aes128_cbc_decrypt(key16: &[u8], iv12: &[u8], ct: &[u8]) -> Option<Vec<u8>> {
    if key16.len() != 16 || iv12.len() != 12 || ct.is_empty() || ct.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new(GenericArray::from_slice(key16));
    let mut iv = [0u8; 16];
    iv[..12].copy_from_slice(iv12);
    let mut out = Vec::with_capacity(ct.len());
    let mut prev = iv;
    for chunk in ct.chunks_exact(16) {
        let mut enc_block = [0u8; 16];
        enc_block.copy_from_slice(chunk);
        let mut dec = enc_block;
        cipher.decrypt_block(GenericArray::from_mut_slice(&mut dec));
        let mut plain = [0u8; 16];
        for j in 0..16 {
            plain[j] = dec[j] ^ prev[j];
        }
        out.extend_from_slice(&plain);
        prev = enc_block;
    }
    let pad = *out.last()? as usize;
    if pad == 0 || pad > 16 || pad > out.len() {
        return None;
    }
    if !out[out.len() - pad..].iter().all(|&b| b as usize == pad) {
        return None;
    }
    out.truncate(out.len() - pad);
    Some(out)
}

/// AES-128-CBC 加密（PKCS7 填充）——仅测试里用来构造老格式 v10 样本，
/// 生产写入端走 GCM（见 encrypt_v10）。
#[cfg_attr(not(test), allow(dead_code))]
fn aes128_cbc_encrypt(key16: &[u8], iv12: &[u8], pt: &[u8]) -> Option<Vec<u8>> {
    if key16.len() != 16 || iv12.len() != 12 {
        return None;
    }
    let cipher = Aes128::new(GenericArray::from_slice(key16));
    let pad = 16 - (pt.len() % 16);
    let mut buf = Vec::with_capacity(pt.len() + pad);
    buf.extend_from_slice(pt);
    buf.extend(std::iter::repeat(pad as u8).take(pad));
    let mut iv = [0u8; 16];
    iv[..12].copy_from_slice(iv12);
    let mut out = Vec::with_capacity(buf.len());
    let mut prev = iv;
    for chunk in buf.chunks_exact(16) {
        let mut block = [0u8; 16];
        for j in 0..16 {
            block[j] = chunk[j] ^ prev[j];
        }
        cipher.encrypt_block(GenericArray::from_mut_slice(&mut block));
        out.extend_from_slice(&block);
        prev = block;
    }
    Some(out)
}
/// Local State 在 **user data 根**（profile 的上一级），不在 profile 目录里：
/// Chrome 是 `User Data/Local State`，内置浏览器是 `<UDF>/EBWebView/Local State`。
fn local_state_of(profile_dir: &Path) -> PathBuf {
    profile_dir
        .parent()
        .unwrap_or(profile_dir)
        .join("Local State")
}

/// 从浏览器（或内置浏览器自己）的 Local State 取 os_crypt 密钥（32 字节）。
fn read_os_crypt_key(local_state: &Path) -> Option<Vec<u8>> {
    let raw = std::fs::read(local_state).ok()?;
    let doc: Value = serde_json::from_slice(&raw).ok()?;
    let enc = doc.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let blob = BASE64.decode(enc).ok()?;
    // 前缀 "DPAPI" 之后才是真正的 DPAPI 密文。
    let rest: &[u8] = match blob.strip_prefix(b"DPAPI") {
        Some(r) => r,
        None => &blob,
    };
    dpapi::unprotect(rest)
}

/// 内置浏览器的 Local State 密钥；profile 从没被 WebView2 初始化过时现造一把
/// （随机 32B → DPAPI 包一层写回 Local State，和 Chromium 自己的格式一致）。
fn ensure_webview_key(profile_dir: &Path) -> Result<Vec<u8>, String> {
    let ls = local_state_of(profile_dir);
    if let Some(key) = read_os_crypt_key(&ls) {
        if key.len() >= 32 {
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut key);
    let wrapped = dpapi::protect(&key).ok_or("DPAPI 加密失败（无法生成浏览器密钥）")?;
    let mut payload = b"DPAPI".to_vec();
    payload.extend_from_slice(&wrapped);
    let b64 = BASE64.encode(payload);
    // 合并进已有 Local State（可能有其它键），没有/坏 JSON 就重建。
    let mut doc: Value = std::fs::read_to_string(&ls)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !doc.is_object() {
        doc = json!({});
    }
    doc["os_crypt"]["encrypted_key"] = json!(b64);
    let ls_dir = ls.parent().unwrap_or(profile_dir);
    std::fs::create_dir_all(ls_dir).map_err(|e| format!("建 Local State 目录失败: {e}"))?;
    std::fs::create_dir_all(profile_dir).map_err(|e| format!("建 profile 目录失败: {e}"))?;
    let tmp = ls_dir.join("Local State.helix-tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&doc).unwrap_or_default())
        .map_err(|e| format!("写 Local State 失败: {e}"))?;
    std::fs::rename(&tmp, &ls).map_err(|e| format!("替换 Local State 失败: {e}"))?;
    Ok(key.to_vec())
}

/// 解一段 v10/v11 密码 blob。key32 = Local State 里的 32B 密钥。
///
/// 先试**当前 Chrome 的 AES-256-GCM** 布局（`v10 + 12B nonce + 密文+tag`，
/// 真机 Chrome 138 实测，见 smoke_read_real_passwords）；失败再回退老版
/// Windows 的 **AES-128-CBC + HMAC-SHA256**。都不认 → None。
fn decrypt_v10(key32: &[u8], blob: &[u8]) -> Option<String> {
    if key32.len() < 32 || blob.len() < 3 + 12 + 1 + 16 {
        return None;
    }
    if &blob[..3] != b"v10" && &blob[..3] != b"v11" {
        return None;
    }

    // 1) AES-256-GCM：nonce = blob[3..15]，密文+tag = blob[15..]。
    if let Ok(c) = <Aes256Gcm as AeadKeyInit>::new_from_slice(&key32[..32]) {
        let nonce = aes_gcm::Nonce::from_slice(&blob[3..15]);
        if let Ok(pt) = c.decrypt(nonce, &blob[15..]) {
            return String::from_utf8(pt).ok();
        }
    }

    // 2) 老格式：iv12 + body(CBC) + HMAC-SHA256 截断 16B。
    if blob.len() < 3 + 12 + 16 + 16 {
        return None;
    }
    let iv = &blob[3..15];
    let body = &blob[15..blob.len() - 16];
    let tag = &blob[blob.len() - 16..];
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key32[16..32]).ok()?;
    mac.update(iv);
    mac.update(body);
    if mac.finalize().into_bytes()[..16] != *tag {
        return None;
    }
    let plain = aes128_cbc_decrypt(&key32[..16], iv, body)?;
    String::from_utf8(plain).ok()
}

/// 用内置浏览器的密钥把密码加密成 v10 blob（写入它的 Login Data）。
/// 产出与当前 Chrome 一致的 **AES-256-GCM** 格式。
fn encrypt_v10(key32: &[u8], password: &str) -> Option<Vec<u8>> {
    if key32.len() < 32 {
        return None;
    }
    let c = <Aes256Gcm as AeadKeyInit>::new_from_slice(&key32[..32]).ok()?;
    let mut nonce = [0u8; 12];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = c.encrypt(aes_gcm::Nonce::from_slice(&nonce), password.as_bytes()).ok()?;
    let mut out = Vec::with_capacity(3 + 12 + ct.len());
    out.extend_from_slice(b"v10");
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Some(out)
}

/// signon_realm = scheme://host[:port]（去掉路径），HTML 表单登录的惯例值。
fn signon_realm(origin_url: &str) -> String {
    if let Some(idx) = origin_url.find("://") {
        let scheme = &origin_url[..idx];
        let rest = &origin_url[idx + 3..];
        let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        if !host.is_empty() {
            return format!("{scheme}://{host}");
        }
    }
    origin_url.to_string()
}

// ── Login Data：读系统浏览器 / 写内置浏览器 ─────────────────────────────

/// Chromium 的 logins 表（对齐 login_database.cc 的现行 schema；缺列由
/// Chromium 下次启动的 ensureDatatypesPresent 迁移补齐）。
const LOGINS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS logins (
  origin_url VARCHAR NOT NULL,
  action_url VARCHAR,
  username_element VARCHAR,
  username_value VARCHAR,
  password_element VARCHAR,
  password_value BLOB,
  signon_realm VARCHAR NOT NULL,
  date_created INTEGER NOT NULL,
  blacklisted_by_user INTEGER NOT NULL,
  scheme INTEGER NOT NULL,
  password_type INTEGER NOT NULL,
  times_used INTEGER NOT NULL DEFAULT 0,
  form_data BLOB,
  date_last_used INTEGER NOT NULL DEFAULT 0,
  date_password_changed INTEGER NOT NULL DEFAULT 0,
  blocked_by_user INTEGER NOT NULL DEFAULT 0,
  date_last_verified INTEGER NOT NULL DEFAULT 0,
  moving_blocked_for BLOB,
  sender_email VARCHAR NOT NULL DEFAULT '',
  sending_frame_host VARCHAR NOT NULL DEFAULT '',
  receiving_frame_host VARCHAR NOT NULL DEFAULT '',
  date_received VARCHAR NOT NULL DEFAULT '',
  sender_name VARCHAR NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS logins_unique_key_index
  ON logins (origin_url, username_value, signon_realm);
CREATE INDEX IF NOT EXISTS logins_signon_realm_index ON logins (signon_realm);
CREATE TABLE IF NOT EXISTS black_box (name TEXT PRIMARY KEY, value BLOB);
";

struct SourceLogin {
    origin: String,
    username: String,
    password: String,
}

/// 读系统浏览器的 Login Data（快照后只读打开），v10/v11 解密；v20 计入 unsupported。
fn read_system_logins(
    profile_dir: &Path,
) -> Result<(Vec<SourceLogin>, usize, usize), String> {
    let db = profile_dir.join("Login Data");
    let Some((tmp, snap)) = snapshot_db(&db) else {
        return Err("找不到 Login Data（该 profile 可能没有保存过密码）".into());
    };
    let result = (|| {
        let conn = open_readonly(&snap)?;
        let key = read_os_crypt_key(&local_state_of(profile_dir))
            .ok_or("读不到 Local State 里的解密密钥（可能全部为应用绑定加密）")?;
        let mut stmt = conn
            .prepare(
                "SELECT origin_url, username_value, password_value FROM logins \
                 WHERE blacklisted_by_user = 0",
            )
            .map_err(|e| format!("查询 logins 失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0).unwrap_or_default(),
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, Vec<u8>>(2).unwrap_or_default(),
                ))
            })
            .map_err(|e| format!("读 logins 失败: {e}"))?;
        let mut logins = Vec::new();
        let mut unsupported = 0usize;
        let mut failed = 0usize;
        for row in rows.flatten() {
            let (origin, username, blob) = row;
            if origin.is_empty() || blob.is_empty() {
                continue;
            }
            let plain = if blob.starts_with(b"v20") {
                unsupported += 1;
                continue;
            } else if blob.starts_with(b"v10") || blob.starts_with(b"v11") {
                decrypt_v10(&key, &blob)
            } else {
                // Chrome 80 之前的旧格式：整个 blob 就是 DPAPI 密文。
                dpapi::unprotect(&blob)
                    .and_then(|p| String::from_utf8(p).ok())
            };
            match plain {
                Some(p) if !p.is_empty() => logins.push(SourceLogin {
                    origin,
                    username,
                    password: p,
                }),
                _ => failed += 1,
            }
        }
        Ok((logins, unsupported, failed))
    })();
    cleanup_tmp(&tmp);
    result
}

/// 把解密后的密码写进内置浏览器的 Login Data（同 origin+user 先删后插，重复导入不堆重）。
fn write_webview_logins(
    profile_dir: &Path,
    key32: &[u8],
    logins: &[SourceLogin],
) -> Result<usize, String> {
    let db = profile_dir.join("Login Data");
    let mut conn = rusqlite::Connection::open(&db)
        .map_err(|e| format!("打开内置浏览器 Login Data 失败: {e}"))?;
    conn.execute_batch(LOGINS_SCHEMA)
        .map_err(|e| format!("初始化 logins 表失败: {e}"))?;
    let now_chrome = unix_us_to_chrome(now_unix_us());
    let mut imported = 0usize;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {e}"))?;
    {
        let mut del = tx
            .prepare("DELETE FROM logins WHERE origin_url = ?1 AND username_value = ?2")
            .map_err(|e| format!("准备删除语句失败: {e}"))?;
        let mut ins = tx
            .prepare(
                "INSERT INTO logins (origin_url, action_url, username_element, \
                 username_value, password_element, password_value, signon_realm, \
                 date_created, blacklisted_by_user, scheme, password_type, \
                 times_used, date_last_used, date_password_changed, blocked_by_user, \
                 date_last_verified, sender_email, sending_frame_host, \
                 receiving_frame_host, date_received, sender_name) \
                 VALUES (?1, ?1, '', ?2, 'password', ?3, ?4, ?5, 0, 1, 1, 0, \
                 ?5, ?5, 0, ?5, '', '', '', '', '')",
            )
            .map_err(|e| format!("准备插入语句失败: {e}"))?;
        for login in logins {
            let Some(blob) = encrypt_v10(key32, &login.password) else {
                continue;
            };
            del.execute(rusqlite::params![login.origin, login.username])
                .map_err(|e| format!("去重删除失败: {e}"))?;
            ins.execute(rusqlite::params![
                login.origin,
                login.username,
                blob,
                signon_realm(&login.origin),
                now_chrome
            ])
            .map_err(|e| format!("写入密码失败: {e}"))?;
            imported += 1;
        }
    }
    tx.commit().map_err(|e| format!("提交失败: {e}"))?;
    Ok(imported)
}

// ── Tauri 命令 ──────────────────────────────────────────────────────────

fn require_windows() -> Result<(), String> {
    if cfg!(target_os = "windows") {
        Ok(())
    } else {
        Err("浏览器数据导入目前只在 Windows 上实现".into())
    }
}

/// 探测本机 Chrome / Edge：返回可用浏览器与各自的 profile 列表。
#[tauri::command]
pub fn browser_import_detect() -> Value {
    if require_windows().is_err() {
        return json!({ "ok": false, "browsers": [], "error": "目前只支持 Windows" });
    }
    let mut browsers = Vec::new();
    for (id, name) in [("chrome", "Google Chrome"), ("edge", "Microsoft Edge")] {
        let Some(root) = system_browser_root(id) else {
            continue;
        };
        if !root.is_dir() {
            continue;
        }
        let profiles = list_profiles(&root);
        if profiles.is_empty() {
            continue;
        }
        browsers.push(json!({
            "id": id,
            "name": name,
            "dir": root.to_string_lossy(),
            "profiles": profiles,
        }));
    }
    json!({ "ok": true, "browsers": browsers })
}

/// 读系统浏览器的密码并直接写进内置浏览器（Helix 不留副本）。
#[tauri::command]
pub async fn browser_import_passwords(
    app: tauri::AppHandle,
    browser: String,
    profile: Option<String>,
) -> Result<Value, String> {
    require_windows()?;
    let root = system_browser_root(&browser).ok_or("未知浏览器（仅支持 chrome / edge）")?;
    let src = profile_dir(&root, profile.as_deref().unwrap_or("Default"));
    if !src.is_dir() {
        return Err(format!("找不到 profile 目录: {}", src.display()));
    }

    // 1) 关浏览器窗口并等句柄释放：后面要写它的 Login Data。
    let closed = crate::browser_webview::close_all_browser_windows(&app).await;

    // 2) 快照读系统库 + 解密（不落 Helix 目录）。
    let (logins, unsupported, failed) = read_system_logins(&src)?;
    if logins.is_empty() && unsupported == 0 {
        return Err("没有可导入的密码（全部为空或解密失败）".into());
    }

    // 3) 写进内置浏览器（用它自己的密钥重新加密成 v10）。
    let profile = crate::browser_webview::browser_default_profile_dir(&app)?;
    std::fs::create_dir_all(&profile).map_err(|e| format!("建 profile 目录失败: {e}"))?;
    let key = ensure_webview_key(&profile)?;
    let imported = write_webview_logins(&profile, &key, &logins)?;

    Ok(json!({
        "ok": true,
        "imported": imported,
        "unsupported": unsupported,
        "failed": failed,
        "total": logins.len() + unsupported + failed,
        "closed_windows": closed.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x00, 0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7,
        0xe8, 0xf9,
    ];
    const IV: [u8; 12] = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 10, 11];

    #[test]
    fn cbc_roundtrip_all_block_edges() {
        for len in [0usize, 1, 15, 16, 17, 64, 255] {
            let pt: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
            let ct = aes128_cbc_encrypt(&KEY[..16], &IV, &pt).expect("encrypt");
            // CBC 密文长度必为 16 的整数倍（PKCS7 至少补 1 块）。
            assert_eq!(ct.len() % 16, 0);
            assert!(ct.len() >= 16);
            let back = aes128_cbc_decrypt(&KEY[..16], &IV, &ct).expect("decrypt");
            assert_eq!(back, pt, "roundtrip failed at len={len}");
        }
    }

    #[test]
    fn cbc_decrypt_rejects_truncated_ciphertext() {
        let ct = aes128_cbc_encrypt(&KEY[..16], &IV, b"hello world").unwrap();
        // 截掉最后一块 → 不再对齐，直接 None。
        assert!(aes128_cbc_decrypt(&KEY[..16], &IV, &ct[..ct.len() - 8]).is_none());
        // 空密文。
        assert!(aes128_cbc_decrypt(&KEY[..16], &IV, b"").is_none());
        // 错误的 nonce 长度。
        assert!(aes128_cbc_decrypt(&KEY[..16], &IV[..8], &ct).is_none());
    }

    #[test]
    fn v10_roundtrip() {
        let blob = encrypt_v10(&KEY, "s3cret!中文").expect("encrypt");
        assert_eq!(&blob[..3], b"v10");
        // GCM 布局：前缀3 + nonce12 + 密文(≥1) + tag16
        assert!(blob.len() >= 3 + 12 + 1 + 16);
        let back = decrypt_v10(&KEY, &blob).expect("decrypt");
        assert_eq!(back, "s3cret!中文");
    }

    #[test]
    fn v10_rejects_wrong_key_and_tamper() {
        let blob = encrypt_v10(&KEY, "password").unwrap();

        // 换一把密钥：HMAC 校验失败。
        let mut wrong = KEY;
        wrong[0] ^= 0xff;
        assert!(decrypt_v10(&wrong, &blob).is_none());

        // 改密文中间一个字节：HMAC 必须失败（防篡改）。
        let mut tampered = blob.clone();
        let mid = 3 + 12 + 4;
        tampered[mid] ^= 0x01;
        assert!(decrypt_v10(&KEY, &tampered).is_none());

        // 砍掉 MAC：长度不足。
        assert!(decrypt_v10(&KEY, &blob[..blob.len() - 16]).is_none());

        // 非 v10/v11 前缀（如 v20 应用绑定加密）：直接不认。
        let mut v20 = blob.clone();
        v20[..3].copy_from_slice(b"v20");
        assert!(decrypt_v10(&KEY, &v20).is_none());
    }

    #[test]
    fn v10_legacy_cbc_fallback() {
        // 老版 Windows 格式：v10 + iv12 + AES-128-CBC(PKCS7) + HMAC 截断 16B。
        let iv: [u8; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let ct = aes128_cbc_encrypt(&KEY[..16], &iv, b"legacy-pass").unwrap();
        let mut mac = <HmacSha256 as Mac>::new_from_slice(&KEY[16..32]).unwrap();
        mac.update(&iv);
        mac.update(&ct);
        let mut blob = b"v10".to_vec();
        blob.extend_from_slice(&iv);
        blob.extend_from_slice(&ct);
        blob.extend_from_slice(&mac.finalize().into_bytes()[..16]);

        assert_eq!(decrypt_v10(&KEY, &blob).as_deref(), Some("legacy-pass"));
        // 换密钥：GCM 与 CBC 两条路都必须拒绝。
        let mut wrong = KEY;
        wrong[31] ^= 0xff;
        assert!(decrypt_v10(&wrong, &blob).is_none());
    }

    #[test]
    fn signon_realm_extraction() {
        assert_eq!(signon_realm("https://example.com/a/b?x=1"), "https://example.com");
        assert_eq!(signon_realm("http://localhost:8080/x"), "http://localhost:8080");
        assert_eq!(signon_realm("file:///x"), "file:///x");
        assert_eq!(signon_realm("no-scheme"), "no-scheme");
    }

    // ── 真机冒烟：探测 + 与命令同路径的全链路读写 ──────────────────────

    /// 探测本机 Chrome/Edge（不依赖 Tauri AppHandle 的那部分）。
    #[test]
    fn smoke_detect_real_browsers() {
        let v = browser_import_detect();
        println!("[smoke] detect => {v}");
        assert_eq!(v.get("ok"), Some(&json!(true)));
        if let Some(list) = v.get("browsers").and_then(Value::as_array) {
            for b in list {
                assert!(b.get("id").and_then(Value::as_str).is_some());
                assert!(b.get("name").and_then(Value::as_str).is_some());
                assert!(b.get("dir").and_then(Value::as_str).is_some());
                assert!(b.get("profiles").and_then(Value::as_array).is_some());
            }
        }
    }

    /// 读真实 Chrome/Edge 密码库（只统计，绝不打印密码内容）。
    #[test]
    fn smoke_read_real_passwords() {        let v = browser_import_detect();
        let Some(list) = v.get("browsers").and_then(Value::as_array).cloned() else {
            println!("[smoke] 本机没有 Chrome/Edge，跳过密码读取");
            return;
        };
        for b in list {
            let id = b.get("id").and_then(Value::as_str).unwrap_or_default();
            let dir = b.get("dir").and_then(Value::as_str).unwrap_or_default();
            let profiles = b
                .get("profiles")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let profile = profiles
                .first()
                .and_then(Value::as_str)
                .unwrap_or("Default")
                .to_string();
            let root = std::path::PathBuf::from(dir);
            match read_system_logins(&profile_dir(&root, &profile)) {
                Ok((logins, unsupported, failed)) => {
                    println!(
                        "[smoke] {id}/{profile}: 可导入 {} 条，v20 不支持 {unsupported} 条，解密失败 {failed} 条",
                        logins.len()
                    );
                    // 明文只在内存里，不落盘、不打印。
                    assert!(logins.iter().all(|l| !l.password.is_empty()));
                }
                Err(e) => println!("[smoke] {id}/{profile} 跳过: {e}"),
            }
        }
    }

    /// 写入端 → 读取端全链路：临时 user data 根下建 profile、生成密钥、写入、
    /// 按系统读取路径读回并解密，顺带验证密钥幂等与重复导入不堆重。
    #[test]
    fn smoke_login_roundtrip_in_temp_profile() {
        let root = std::env::temp_dir().join(format!("helix-browser-smoke-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // Local State 在 user data 根，profile 在它下面一层 —— 布局对齐真机。
        let dir = root.join("Default");

        // 密钥：首次生成，再次必须是同一把（不得覆盖已有密钥）。
        let key = ensure_webview_key(&dir).expect("生成浏览器密钥");
        assert_eq!(key.len(), 32);
        assert!(root.join("Local State").is_file(), "Local State 必须在 user data 根");
        let key2 = ensure_webview_key(&dir).expect("重取浏览器密钥");
        assert_eq!(key, key2, "密钥必须幂等，不能每次导入都换");

        let logins = vec![
            SourceLogin {
                origin: "https://smoke.test".into(),
                username: "用户a".into(),
                password: "p@ss中文🔐".into(),
            },
            SourceLogin {
                origin: "http://example.com".into(),
                username: "bob".into(),
                password: "x".repeat(64),
            },
        ];
        let n = write_webview_logins(&dir, &key, &logins).expect("首次写入");
        assert_eq!(n, 2);
        // 重复导入（同 origin+user 先删后插）不能堆重。
        let n2 = write_webview_logins(&dir, &key, &logins).expect("重复写入");
        assert_eq!(n2, 2);

        // 用与导入端完全相同的读取函数读回。
        let (back, unsupported, failed) = read_system_logins(&dir).expect("读回");
        assert_eq!((unsupported, failed), (0, 0), "自写数据必须全部可解");
        assert_eq!(back.len(), 2, "重复导入后仍应只有 2 条");
        let mut back: Vec<(String, String, String)> = back
            .into_iter()
            .map(|l| (l.origin, l.username, l.password))
            .collect();
        back.sort();
        let mut want: Vec<(String, String, String)> = logins
            .into_iter()
            .map(|l| (l.origin, l.username, l.password))
            .collect();
        want.sort();
        assert_eq!(back, want, "读回的明文必须与写入完全一致");

        let _ = std::fs::remove_dir_all(&root);
    }
}
