//! 把本机的 provider 配置镜像到远程机器的 pi `~/.pi/agent/models.json`。
//!
//! # 为什么需要
//!
//! 远程会话的 agent 跑在**另一台机器**的 pi 上（`remote-bridge.js` →
//! `pi --mode rpc`），模型请求从远端的网络出口发出，模型清单读的也是远端的
//! `~/.pi/agent/models.json`。本机那几十个供应商配置对远端进程完全不可见：下拉里
//! 选一个本机供应商的模型，`set_model` 打到远端只会得到 `Model not found`。
//!
//! 镜像就是把这个缺口显式补上：连上服务器时把本机（有 baseUrl 的）provider 写进
//! 远端 models.json —— baseUrl 在那边指向同一个互联网端点，models / api / apiKey
//! 照搬。
//!
//! # 边界（写之前想清楚的三件事）
//!
//! 1. **只合并、不覆盖。** 远端可能有自己的 provider（甚至同一名字的本地网关）。
//!    与远端同名时**跳过并报告**，绝不静默改写远端本来能用的配置。
//! 2. **apiKey 会离开本机。** 这是镜像的唯一理由（没有 key 远端调不通），但也是
//!    真实的凭据外泄面：只写进远端 models.json，不回读、不落日志、不进错误信息。
//! 3. **远端 pi 在启动时快照 models.json。** 写完那一刻已在跑的远端实例仍是旧
//!    清单，要等它重建实例才看得到新 provider。

use serde_json::{json, Value};

use crate::ssh::{apply_auth_env, detach_window, SshAuth};

/// 一条要镜像的 provider（`models` 已经是 pi 的模型条目数组）。
pub struct MirrorProvider {
    pub name: String,
    pub base_url: String,
    pub api: String,
    pub api_key: String,
    pub models: Value,
}

/// 一次镜像的结果，回给前端展示（哪些写了、哪些因为远端已有而跳过）。
#[derive(Default)]
pub struct MirrorReport {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    /// 远端 models.json 的真实路径（`~` 展开后），用于告诉用户「写到哪了」。
    pub remote_path: String,
}

/// 在远端 shell 里执行一段命令，返回 stdout（成功）或 Err(stderr)。
///
/// `stdin` 有内容时用管道喂进去：models.json 可能几十 KB，塞进命令行会撞 argv
/// 上限，而且 JSON 里的引号/换行经 shell 转义后极易变形。
fn ssh_run(
    host: &str,
    port: u32,
    username: &str,
    auth: &SshAuth,
    command: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    use std::io::Write;
    let mut c = std::process::Command::new("ssh");
    c.args(&crate::ssh::ssh_opts_for(auth))
        .arg("-p")
        .arg(port.to_string())
        .arg(format!("{username}@{host}"))
        .arg(command);
    apply_auth_env(&mut c, auth);
    detach_window(&mut c);
    match stdin {
        None => {
            let out = c.output().map_err(|e| format!("执行 ssh 失败: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
        Some(bytes) => {
            c.stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = c.spawn().map_err(|e| format!("执行 ssh 失败: {e}"))?;
            if let Some(mut si) = child.stdin.take() {
                si.write_all(bytes)
                    .map_err(|e| format!("写入远端 stdin 失败: {e}"))?;
            }
            let out = child
                .wait_with_output()
                .map_err(|e| format!("等待远端命令失败: {e}"))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
    }
}

/// 读远端 `~/.pi/agent/models.json`，返回 (文档, 真实绝对路径)。
/// 文件不存在返回空文档（首次镜像的常态）。
fn read_remote_models(
    host: &str,
    port: u32,
    username: &str,
    auth: &SshAuth,
) -> Result<(Value, String), String> {
    let body = ssh_run(
        host,
        port,
        username,
        auth,
        "cat ~/.pi/agent/models.json 2>/dev/null || echo __HELIX_MISSING__",
        None,
    )?;
    // `cd ~ && pwd -P` 展开 `~`：前端要显示的就是这个真实路径。
    let home = ssh_run(host, port, username, auth, "cd ~ && pwd -P", None)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let remote_path = if home.is_empty() {
        "~/.pi/agent/models.json".to_string()
    } else {
        format!("{home}/.pi/agent/models.json")
    };
    if body.trim() == "__HELIX_MISSING__" || body.trim().is_empty() {
        return Ok((json!({ "providers": {} }), remote_path));
    }
    // 远端文件损坏时**不能**当成空文档继续写：那会把用户原有配置整体覆盖掉。
    // 明确的错误让人去修，比默默清空好得多。
    let doc: Value = serde_json::from_str(&body)
        .map_err(|e| format!("远端 {remote_path} 不是合法 JSON（{e}），未做任何改动"))?;
    Ok((doc, remote_path))
}

/// 把远端 models.json 与要镜像的 provider 合并，返回**新文档**。
///
/// 纯函数（可单独测）：远端同名 provider 一律跳过——用户的远端配置可能指向只有
/// 那台机器才连得到的地址（本地网关 / 内网端点），拿本机的覆盖它等于把一台
/// 服务器上本来能用的东西弄坏。
pub fn merge_mirrored_providers(
    mut remote_doc: Value,
    providers: &[MirrorProvider],
) -> (Value, Vec<String>, Vec<String>) {
    if remote_doc
        .get("providers")
        .and_then(Value::as_object)
        .is_none()
    {
        remote_doc["providers"] = json!({});
    }
    let mut written = Vec::new();
    let mut skipped = Vec::new();
    for p in providers {
        let name = p.name.trim();
        let base = p.base_url.trim().trim_end_matches('/');
        if name.is_empty() || base.is_empty() {
            continue;
        }
        if remote_doc.pointer(&format!("/providers/{name}")).is_some() {
            skipped.push(name.to_string());
            continue;
        }
        let api = p.api.trim();
        let mut entry = json!({
            "baseUrl": base,
            "api": if api.is_empty() { "openai-completions" } else { api },
            "models": p.models.clone(),
        });
        // 空 key 不写：写成空串等于「配了一个空凭据」，pi 会 401 而不是回落到
        // 它自己的环境变量。
        if !p.api_key.trim().is_empty() {
            entry["apiKey"] = Value::String(p.api_key.trim().to_string());
        }
        remote_doc["providers"][name] = entry;
        written.push(name.to_string());
    }
    (remote_doc, written, skipped)
}

/// 镜像入口：读远端 → 合并 → 原子写回（先写临时文件再 mv，避免半截 JSON 让
/// 远端 pi 起不来）。
///
/// 失败绝不影响连接流程本身：远程连接已经把隧道和 bridge 起好了，镜像挂了只是
/// 「远端还没有本机的供应商」，调用方降级成警告即可。
pub fn mirror_providers_to_remote(
    host: &str,
    port: u32,
    username: &str,
    auth: &SshAuth,
    providers: &[MirrorProvider],
) -> Result<MirrorReport, String> {
    if providers.is_empty() {
        return Ok(MirrorReport::default());
    }
    let (remote_doc, remote_path) = read_remote_models(host, port, username, auth)?;
    let (merged, written, skipped) = merge_mirrored_providers(remote_doc, providers);
    let mut report = MirrorReport {
        written,
        skipped,
        remote_path,
    };
    if report.written.is_empty() {
        return Ok(report);
    }
    let body = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("序列化 models.json 失败: {e}"))?;
    ssh_run(
        host,
        port,
        username,
        auth,
        "mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json.helix-tmp && mv ~/.pi/agent/models.json.helix-tmp ~/.pi/agent/models.json",
        Some(body.as_bytes()),
    )?;
    report.written.sort();
    report.skipped.sort();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(name: &str, base: &str, key: &str) -> MirrorProvider {
        MirrorProvider {
            name: name.into(),
            base_url: base.into(),
            api: "openai-completions".into(),
            api_key: key.into(),
            models: json!([{ "id": "m1", "name": "m1" }]),
        }
    }

    #[test]
    fn merges_into_empty_remote_doc() {
        let (doc, written, skipped) =
            merge_mirrored_providers(json!({}), &[provider("acme", "https://a/v1/", "k")]);
        assert_eq!(written, vec!["acme"]);
        assert!(skipped.is_empty());
        let e = doc.pointer("/providers/acme").unwrap();
        // 结尾斜杠被抹掉：pi 拼 `/chat/completions` 时不出现双斜杠。
        assert_eq!(e.get("baseUrl").unwrap(), "https://a/v1");
        assert_eq!(e.get("apiKey").unwrap(), "k");
        assert_eq!(e.pointer("/models/0/id").unwrap(), "m1");
    }

    #[test]
    fn never_overwrites_a_remote_provider_of_the_same_name() {
        let remote = json!({ "providers": { "acme": { "baseUrl": "http://localhost:8080" } } });
        let (doc, written, skipped) =
            merge_mirrored_providers(remote, &[provider("acme", "https://a", "k")]);
        assert!(written.is_empty());
        assert_eq!(skipped, vec!["acme"]);
        assert_eq!(
            doc.pointer("/providers/acme/baseUrl").unwrap(),
            "http://localhost:8080"
        );
    }

    #[test]
    fn keeps_unrelated_remote_providers_and_unknown_keys() {
        let remote = json!({
            "providers": { "other": { "baseUrl": "http://h" } },
            "someFutureKey": { "x": 1 },
        });
        let (doc, _, _) = merge_mirrored_providers(remote, &[provider("acme", "https://a", "k")]);
        assert!(doc.pointer("/providers/other").is_some());
        assert!(doc.pointer("/someFutureKey/x").is_some());
        assert!(doc.pointer("/providers/acme").is_some());
    }

    #[test]
    fn skips_entries_without_a_base_url() {
        let p = provider("nobase", "   ", "k");
        let (doc, written, _) = merge_mirrored_providers(json!({}), &[p]);
        assert!(written.is_empty());
        assert!(doc.pointer("/providers/nobase").is_none());
    }

    #[test]
    fn empty_key_is_omitted_not_written_as_empty_string() {
        let (doc, _, _) = merge_mirrored_providers(json!({}), &[provider("a", "https://a", "")]);
        assert!(doc.pointer("/providers/a/apiKey").is_none());
    }
}
