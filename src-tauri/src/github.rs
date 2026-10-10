//! `github:*` commands — the PR leg of the git workflow (`git.rs` stops at
//! push). Prefers the `gh` CLI; when `gh` is missing or unauthenticated it
//! still pushes the branch and returns GitHub's compare URL with the title and
//! body pre-filled, so the last step is a click in the browser instead of a
//! dead end. Neither path stores a token in Helix.

use crate::exec;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const GH_TIMEOUT: Duration = Duration::from_secs(45);

fn work_cwd(state: &AppState, target_cwd: Option<&str>) -> PathBuf {
    if let Some(t) = target_cwd {
        if !t.trim().is_empty() {
            return PathBuf::from(t.trim());
        }
    }
    let wd = state.work_dir.read().unwrap().clone();
    if wd.exists() {
        wd
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
}

fn git(cwd: &PathBuf, args: &[&str]) -> Result<(Option<i32>, String, String), String> {
    match exec::run("git", args, cwd, GIT_TIMEOUT) {
        Ok(out) => Ok((out.code, out.stdout, out.stderr)),
        Err(e) => Err(match e {
            exec::ExecError::Unavailable(m) => m,
        }),
    }
}

fn gh(args: &[&str], cwd: &PathBuf) -> Result<(Option<i32>, String, String), String> {
    let bin = exec::locate("gh")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "gh".to_string());
    match exec::run(&bin, args, cwd, GH_TIMEOUT) {
        Ok(out) => Ok((out.code, out.stdout, out.stderr)),
        Err(exec::ExecError::Unavailable(m)) => Err(m),
    }
}

/// 只认「像主机名」的段：必须有一个点，且最后一段是字母/数字（TLD），且不含
/// 路径分隔符。这一条同时挡住了 `D:\repos\Helix`（host="D"）和 `../vendor/pi`
/// （host="."）这类相对/本地路径被误当成 remote。
fn looks_like_host(h: &str) -> bool {
    let Some((_, tld)) = h.rsplit_once('.') else {
        return false;
    };
    !tld.is_empty()
        && tld.chars().all(|c| c.is_ascii_alphanumeric())
        && h.chars().all(|c| c != '/' && c != '\\' && c != ' ')
}

/// `owner/repo` + host from a remote URL. Accepts the three forms people
/// actually paste (`git@host:o/r.git`, `ssh://git@host/o/r.git`,
/// `https://host/o/r[.git]`) and non-GitHub hosts, so GHES/Gitee users get a
/// working compare link too. Returns `None` for local/path remotes.
pub fn parse_remote_url(raw: &str) -> Option<(String, String, String)> {
    let s = raw.trim().trim_end_matches('/');
    if s.is_empty() {
        return None;
    }
    let s = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => s,
    };
    // scp-style (`host:path`) separates on ':' *before* any '/'; URL-style
    // separates on the first '/'. A Windows path like `D:\repos\x` has a colon
    // first and therefore parses to host="D:", which the '.'/'/' checks reject.
    let (host_part, path_part) = match (s.find(':'), s.find('/')) {
        (Some(c), Some(sl)) if sl < c => (&s[..sl], &s[sl + 1..]),
        (Some(c), _) => (&s[..c], &s[c + 1..]),
        (None, Some(sl)) => (&s[..sl], &s[sl + 1..]),
        (None, None) => return None,
    };
    let host = host_part
        .rsplit('@')
        .next()
        .unwrap_or(host_part)
        .split(':')
        .next()
        .unwrap_or(host_part);
    if !looks_like_host(host) {
        return None;
    }
    let mut segs: Vec<&str> = path_part.split('/').filter(|x| !x.is_empty()).collect();
    // scp 语法可以带端口：`host:2222/team/tool`，第一次按 ':' 切时端口会掉进
    // 路径头一段。只有形如 `数字/…/…`（三段起）才当端口丢，避免误删数字开头的
    // owner 段。
    if segs.len() >= 3 && segs[0].chars().all(|c| c.is_ascii_digit()) {
        segs.remove(0);
    }
    if segs.len() < 2 {
        return None;
    }
    let last = segs.len() - 1;
    segs[last] = segs[last].strip_suffix(".git").unwrap_or(segs[last]);
    let owner = segs.first().copied()?.to_string();
    let repo = segs.last().copied()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((host.to_string(), owner, repo))
}

/// GitHub/Gitee "create pull request" page, pre-filled. `base...head` is the
/// three-dot (merge-base) form GitHub's own UI uses.
pub fn compare_url(
    host: &str,
    owner: &str,
    repo: &str,
    base: &str,
    head: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> String {
    let mut url = format!(
        "https://{host}/{owner}/{repo}/compare/{base}...{head}?expand=1"
    );
    if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
        url.push_str(&format!("&title={}", urlencoding::encode(t.trim())));
    }
    if let Some(b) = body.filter(|b| !b.trim().is_empty()) {
        url.push_str(&format!("&body={}", urlencoding::encode(b.trim())));
    }
    url
}

/// The remote's own default branch, the way `gh` decides it: `origin/HEAD`
/// symbolic ref first, then whichever of main/master exists on the remote.
fn default_base(cwd: &PathBuf) -> String {
    if let Ok((Some(0), stdout, _)) = git(
        cwd,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        let name = stdout.trim();
        if let Some(stripped) = name.strip_prefix("origin/") {
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }
    }
    for candidate in ["main", "master"] {
        if let Ok((Some(0), _, _)) =
            git(cwd, &["rev-parse", "--verify", "--quiet", &format!("origin/{candidate}")])
        {
            return candidate.to_string();
        }
    }
    "main".to_string()
}

/// The branch HEAD is on. `None` when detached — you cannot open a PR from a
/// detached commit, and saying so beats pushing a branch named `HEAD`.
fn current_branch(cwd: &PathBuf) -> Option<String> {
    let (Some(0), stdout, _) = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()? else {
        return None;
    };
    let name = stdout.trim().to_string();
    if name.is_empty() || name == "HEAD" {
        return None;
    }
    Some(name)
}

fn origin_url(cwd: &PathBuf) -> Option<String> {
    let (Some(0), stdout, _) = git(cwd, &["remote", "get-url", "origin"]).ok()? else {
        return None;
    };
    let url = stdout.trim().to_string();
    if url.is_empty() {
        return None;
    }
    Some(url)
}

/// `{host, owner, repo}` shared by every command here, or a `{ok:false, code}`
/// response the frontend can turn into a specific sentence.
fn repo_slug(cwd: &PathBuf) -> Result<Value, Value> {
    let Some(url) = origin_url(cwd) else {
        return Err(json!({
            "ok": false,
            "code": "no_remote",
            "error": "当前项目没有 origin 远端，无法创建 PR",
        }));
    };
    let Some((host, owner, repo)) = parse_remote_url(&url) else {
        return Err(json!({
            "ok": false,
            "code": "bad_remote",
            "error": format!("无法从远端地址解析仓库：{url}"),
        }));
    };
    Ok(json!({
        "host": host,
        "owner": owner,
        "repo": repo,
        "remoteUrl": url,
    }))
}

#[tauri::command]
pub fn gh_status(state: State<'_, Arc<AppState>>, target_cwd: Option<String>) -> Value {
    let cwd = work_cwd(&state, target_cwd.as_deref());
    let Some(path) = exec::locate("gh") else {
        return json!({
            "ok": true,
            "available": false,
            "authenticated": false,
            "hint": "未找到 gh CLI。装好后登录：winget install GitHub.cli && gh auth login",
        });
    };
    let version = gh(&["--version"], &cwd)
        .ok()
        .and_then(|(_, stdout, _)| {
            stdout
                .lines()
                .next()
                .map(|l| l.trim().strip_prefix("gh version ").unwrap_or(l.trim()).to_string())
        });
    let authed = match gh(&["auth", "status"], &cwd) {
        Ok((Some(0), _, _)) => true,
        Ok((_, _, stderr)) => {
            return json!({
                "ok": true,
                "available": true,
                "authenticated": false,
                "path": path.to_string_lossy(),
                "version": version,
                "hint": "gh 已安装但未登录，运行 gh auth login 后可直接用命令行建 PR",
                "authError": stderr.trim(),
            })
        }
        Err(e) => {
            return json!({
                "ok": true,
                "available": false,
                "authenticated": false,
                "path": path.to_string_lossy(),
                "hint": e,
            })
        }
    };
    json!({
        "ok": true,
        "available": true,
        "authenticated": authed,
        "path": path.to_string_lossy(),
        "version": version,
    })
}

#[tauri::command]
pub fn gh_repo(
    state: State<'_, Arc<AppState>>,
    target_cwd: Option<String>,
) -> Value {
    let cwd = work_cwd(&state, target_cwd.as_deref());
    let slug = match repo_slug(&cwd) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let mut out = slug;
    out["base"] = json!(default_base(&cwd));
    match current_branch(&cwd) {
        Some(b) => out["head"] = json!(b),
        None => out["head"] = Value::Null,
    }
    let dirty = git(&cwd, &["status", "--porcelain"])
        .map(|(_, stdout, _)| {
            stdout.lines().filter(|l| !l.trim().is_empty()).count()
        })
        .unwrap_or(0);
    out["uncommitted"] = json!(dirty);
    out["ok"] = json!(true);
    out
}

/// Push the current branch (setting upstream) and open a PR for it.
///
/// `opts`: `{title?, body?, base?, draft?, head?}`. Refuses to run on a dirty
/// tree or on the base branch itself: both produce a PR that silently omits
/// the work the user thinks they just submitted.
#[tauri::command]
pub fn pr_create(state: State<'_, Arc<AppState>>, opts: Option<Value>) -> Value {
    let opts = opts.unwrap_or_default();
    let cwd = work_cwd(&state, opts.get("cwd").and_then(Value::as_str));

    let slug = match repo_slug(&cwd) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let (host, owner, repo) = (
        slug["host"].as_str().unwrap_or("github.com").to_string(),
        slug["owner"].as_str().unwrap_or_default().to_string(),
        slug["repo"].as_str().unwrap_or_default().to_string(),
    );

    let head = opts
        .get("head")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| current_branch(&cwd));
    let Some(head) = head else {
        return json!({ "ok": false, "code": "detached_head", "error": "当前处于游离 HEAD，先切到一个功能分支再创建 PR" });
    };
    let base = opts
        .get("base")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_base(&cwd));
    if head == base {
        return json!({
            "ok": false,
            "code": "on_base_branch",
            "error": format!("当前就在 {base} 分支上，PR 需要「功能分支 → {base}」；先切分支"),
            "head": head,
            "base": base,
        });
    }

    // 未提交改动直接拦下：这里如果顺手 commit，用户会看到 PR 里出现自己没打算
    // 提交的临时改动（本仓库常年 WIP，这条尤其重要）。
    if let Ok((_, stdout, _)) = git(&cwd, &["status", "--porcelain"]) {
        let files: Vec<&str> = stdout
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if !files.is_empty() {
            return json!({
                "ok": false,
                "code": "uncommitted_changes",
                "error": format!("有 {} 个未提交改动，先提交（或用「已修改」卡片提交）再创建 PR", files.len()),
                "files": files.iter().take(8).map(|f| f.to_string()).collect::<Vec<_>>(),
            });
        }
    }

    // 先推分支：gh 与 compare 链接两条路都需要远端有这个 head。
    let (code, _, stderr) = match git(&cwd, &["push", "-u", "origin", head.as_str()]) {
        Ok(v) => v,
        Err(e) => return json!({ "ok": false, "code": "push_failed", "error": e, "head": head }),
    };
    if code != Some(0) {
        return json!({
            "ok": false,
            "code": "push_failed",
            "error": stderr.trim(),
            "head": head,
        });
    }

    let title = opts.get("title").and_then(Value::as_str).unwrap_or("").trim();
    let body = opts.get("body").and_then(Value::as_str).unwrap_or("").trim();
    let draft = opts.get("draft").and_then(Value::as_bool).unwrap_or(false);

    if exec::locate("gh").is_some() {
        let mut args: Vec<String> = vec!["pr".into(), "create".into()];
        if title.is_empty() {
            // gh 自己从提交信息推断标题/正文
            args.push("--fill".into());
        } else {
            args.push("--title".into());
            args.push(title.into());
            if !body.is_empty() {
                args.push("--body".into());
                args.push(body.into());
            }
        }
        args.push("--base".into());
        args.push(base.clone());
        args.push("--head".into());
        args.push(head.clone());
        if draft {
            args.push("--draft".into());
        }
        let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        match gh(&borrowed, &cwd) {
            Ok((Some(0), stdout, _)) => {
                let url = stdout.trim().lines().last().unwrap_or("").to_string();
                return json!({
                    "ok": true,
                    "method": "gh",
                    "url": url,
                    "head": head,
                    "base": base,
                    "pushed": true,
                });
            }
            Ok((_, _, stderr)) => {
                // 推都推上去了，gh 失败（多为未登录/权限）不该让整件事报废：
                // 继续回 compare 链接，并把 gh 的报错原样带出去。
                let url = compare_url(
                    &host,
                    &owner,
                    &repo,
                    &base,
                    &head,
                    Some(title),
                    Some(body),
                );
                return json!({
                    "ok": true,
                    "method": "compare",
                    "url": url,
                    "head": head,
                    "base": base,
                    "pushed": true,
                    "ghError": stderr.trim(),
                });
            }
            Err(e) => {
                return json!({ "ok": false, "code": "gh_unavailable", "error": e, "head": head });
            }
        }
    }

    let url = compare_url(&host, &owner, &repo, &base, &head, Some(title), Some(body));
    json!({
        "ok": true,
        "method": "compare",
        "url": url,
        "head": head,
        "base": base,
        "pushed": true,
        "note": "未安装 gh CLI：分支已推送，在浏览器里确认这一步即可",
    })
}

#[tauri::command]
pub fn pr_list(state: State<'_, Arc<AppState>>, opts: Option<Value>) -> Value {
    let opts = opts.unwrap_or_default();
    let cwd = work_cwd(&state, opts.get("cwd").and_then(Value::as_str));
    if exec::locate("gh").is_none() {
        return json!({ "ok": false, "code": "gh_unavailable", "error": "未找到 gh CLI" });
    }
    let state_arg = opts.get("state").and_then(Value::as_str).unwrap_or("open");
    let limit = opts
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 100)
        .to_string();
    let args = [
        "pr",
        "list",
        "--state",
        state_arg,
        "--limit",
        &limit,
        "--json",
        "number,title,url,headRefName,baseRefName,isDraft",
    ];
    match gh(&args, &cwd) {
        Ok((Some(0), stdout, _)) => {
            let prs: Vec<Value> = serde_json::from_str(stdout.trim()).unwrap_or_default();
            json!({ "ok": true, "prs": prs })
        }
        Ok((_, _, stderr)) => json!({ "ok": false, "code": "gh_failed", "error": stderr.trim() }),
        Err(e) => json!({ "ok": false, "code": "gh_unavailable", "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::{compare_url, parse_remote_url};

    fn slug(raw: &str) -> Option<(String, String, String)> {
        parse_remote_url(raw)
    }

    #[test]
    fn parses_ssh_scp_style() {
        assert_eq!(
            slug("git@github.com:h6643/Helix.git"),
            Some(("github.com".into(), "h6643".into(), "Helix".into()))
        );
    }

    #[test]
    fn parses_https_and_ssh_url_forms() {
        assert_eq!(
            slug("https://github.com/openai/codex.git"),
            Some(("github.com".into(), "openai".into(), "codex".into()))
        );
        assert_eq!(
            slug("ssh://git@git.example.com:2222/team/tool"),
            Some(("git.example.com".into(), "team".into(), "tool".into()))
        );
        assert_eq!(
            slug("https://gitee.com/foo/bar/"),
            Some(("gitee.com".into(), "foo".into(), "bar".into()))
        );
    }

    #[test]
    fn rejects_local_or_truncated_remotes() {
        assert!(slug(r"D:\repos\Helix").is_none());
        assert!(slug("../vendor/pi").is_none());
        assert!(slug("git@github.com:onlyrepo.git").is_none());
        assert!(slug("").is_none());
    }

    #[test]
    fn compare_url_prefills_and_encodes() {
        let url = compare_url(
            "github.com",
            "o",
            "r",
            "main",
            "feature/x",
            Some("fix: 标题 & 符号"),
            None,
        );
        assert!(url.starts_with("https://github.com/o/r/compare/main...feature/x?expand=1&title="));
        assert!(url.contains("%26")); // '&' 必须编码，否则会把正文截断
        assert!(!url.contains("&body="));
    }
}
