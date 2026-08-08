//! Hermes executable resolution + kernel (runtime) verification.
//! Port of `electron/lib/kernel.js`.

use crate::paths::{hermes_agent_dir, venv_hermes_bin};
use ed25519_dalek::{Signature, SignatureError, Verifier, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Ordered list of candidate hermes executables, deduplicated, existing only.
pub fn resolve_hermes_candidates() -> Vec<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![
        venv_hermes_bin(Some(&hermes_agent_dir()), "venv"),
        venv_hermes_bin(Some(&hermes_agent_dir()), ".venv"),
    ];
    // A `hermes` / `hermes-agent` on PATH works as a last resort.
    if let Ok(out) = Command::new("sh").arg("-lc").arg("command -v hermes hermes-agent 2>/dev/null").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            for l in s.lines() {
                let l = l.trim();
                if !l.is_empty() {
                    cands.push(PathBuf::from(l));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut existing = Vec::new();
    for c in cands {
        if seen.insert(c.clone()) && c.exists() {
            existing.push(c);
        }
    }
    existing
}

/// Preferred hermes executable (first existing candidate), or None.
pub fn resolve_hermes_cmd() -> Option<PathBuf> {
    resolve_hermes_candidates().into_iter().next()
}

fn is_trusted_path(p: &Path) -> bool {
    let hermes_dir = crate::paths::hermes_data_dir();
    let trusted_roots = vec![
        hermes_dir,
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
    ];
    if let Ok(rp) = std::fs::canonicalize(p) {
        for root in trusted_roots {
            if let Ok(rr) = std::fs::canonicalize(&root) {
                if rp.starts_with(&rr) {
                    return true;
                }
            }
        }
    }
    false
}

fn sha256_file(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|d| hex::encode(Sha256::digest(&d)))
}

#[derive(Serialize, Default)]
pub struct KernelSig {
    pub ok: bool,
    pub has_key: bool,
    pub has_sig: bool,
    pub message: String,
}

#[derive(Serialize, Default)]
pub struct KernelVerify {
    pub ok: bool,
    pub status: String,
    pub message: String,
    pub combined_hash: String,
    pub sig: KernelSig,
}

fn load_kernel_public_key() -> Option<Vec<u8>> {
    for c in [
        crate::paths::hermes_data_dir().join("kernel.pub"),
        dirs::home_dir()
            .unwrap_or_default()
            .join(".local")
            .join("share")
            .join("hermes")
            .join("kernel.pub"),
    ] {
        if c.exists() {
            if let Ok(b) = std::fs::read(&c) {
                return Some(b);
            }
        }
    }
    None
}

fn verify_ed25519(data: &[u8], sig: &[u8], pubkey: &[u8]) -> Result<bool, SignatureError> {
    let key = VerifyingKey::from_bytes(pubkey.try_into().map_err(|_| SignatureError::from_source("bad key len"))?)?;
    let sig_obj = Signature::from_bytes(sig.try_into().map_err(|_| SignatureError::from_source("bad sig len"))?);
    Ok(key.verify(data, &sig_obj).is_ok())
}

pub fn verify_kernel() -> KernelVerify {
    let mut out = KernelVerify {
        ok: false,
        status: "unknown".into(),
        message: String::new(),
        sig: KernelSig::default(),
        combined_hash: String::new(),
    };
    let Some(cmd) = resolve_hermes_cmd() else {
        out.status = "unknown".into();
        out.message = "未找到 Hermes 运行时可执行文件".into();
        return out;
    };
    if !is_trusted_path(&cmd) {
        out.status = "untrusted".into();
        out.message = format!("运行时路径不在受信任安装目录中: {}", cmd.display());
        return out;
    }
    let artifacts: Vec<(&str, String)> = {
        let mut v = Vec::new();
        if let Some(h) = sha256_file(&cmd) {
            v.push(("entry", h));
        }
        let base = cmd.parent().unwrap_or(Path::new("/"));
        for (id, cand) in [
            ("hermes", base.join("hermes")),
            ("python", if cfg!(windows) { base.join("python.exe") } else { base.join("python") }),
        ] {
            if cand.is_file() {
                if let Some(h) = sha256_file(&cand) {
                    v.push((id, h));
                }
            }
        }
        v
    };
    let combined = {
        let mut h = Sha256::new();
        for (_, hash) in &artifacts {
            h.update(hash.as_bytes());
        }
        hex::encode(h.finalize())[..32].to_string()
    };
    out.combined_hash = combined.clone();

    let mut sig = KernelSig::default();
    let pubkey = load_kernel_public_key();
    match pubkey {
        None => {
            sig.ok = false;
            sig.has_key = false;
            sig.message = "未包含官方公钥（开发构建），已跳过 Ed25519 校验".into();
        }
        Some(pubkey) => {
            sig.has_key = true;
            let sig_path = PathBuf::from(format!("{}.sig", cmd.display()));
            if !sig_path.exists() {
                sig.has_sig = false;
                sig.message = format!("未找到运行时签名文件 {}", sig_path.display());
            } else {
                sig.has_sig = true;
                let data = std::fs::read(&cmd).unwrap_or_default();
                let sig_bytes = std::fs::read(&sig_path).unwrap_or_default();
                match verify_ed25519(&data, &sig_bytes, &pubkey) {
                    Ok(true) => {
                        sig.ok = true;
                        sig.message = "Ed25519 签名校验通过".into();
                    }
                    Ok(false) => {
                        sig.message = "Ed25519 签名校验失败".into();
                    }
                    Err(e) => {
                        sig.message = format!("签名校验出错: {e}");
                    }
                }
            }
        }
    }
    out.sig = sig;
    out.status = if out.sig.ok { "verified".into() } else { "unverified".into() };
    out.ok = out.sig.ok;
    out.message = if out.sig.ok {
        format!("内核来源已校验，完整性哈希 {combined}")
    } else {
        format!("{}；完整性哈希 {combined}", out.sig.message)
    };
    out
}
