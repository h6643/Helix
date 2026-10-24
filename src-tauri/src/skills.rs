//! File-based skills: SKILL.md directories under pi's skill roots.
//!
//! Tauri port of the Electron `helixSkills` bridge (main.js). The renderer's
//! slash-command picker (`/…`) and the skill management panel both consume
//! these commands; without them `invoke('helix_list_skills')` rejects and no
//! skills show up in the composer.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn skills_dir() -> PathBuf {
    // The user-managed skills root pi actually loads. (Legacy Helix used
    // `<helix_data_dir>/skills`; pi never reads that, so listing it only showed
    // phantom entries.)
    pi_user_skills_dir()
}

/// `~/.pi/agent/skills/` — pi's user skill root.
fn pi_user_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("skills")
}

/// `~/.agents/skills/` — pi 的「跨 agent」用户级技能根（package-manager.js
/// `addAutoDiscoveredResources` 里的 `userAgentsSkillsDir`）。这一根**不受项目
/// 信任门控**，终端 `pi` 和 Helix 拉起的 gateway 都会无条件加载；而它不在
/// `~/.pi/agent/` 下，所以 Helix 原来那套扫描完全看不到它。
fn user_agents_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agents")
        .join("skills")
}

/// `~/.pi/agent/npm/` — pi's package store (`pi install` target).
fn pi_npm_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("npm")
}

fn plugins_dir() -> PathBuf {
    // pi's user extension root (what the installed-plugins list reflects).
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("extensions")
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

#[derive(Serialize)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "commandName")]
    pub command_name: String,
    pub description: String,
    #[serde(rename = "isBuiltin")]
    pub is_builtin: bool,
    /// Where the skill is loaded from: "pi" (user root ~/.pi/agent/skills) or
    /// the bundling npm package name (e.g. "pi-subagents").
    pub source: String,
    pub path: String,
    /// pi 的 `disable-model-invocation: true`：模型不主动读它，只能靠
    /// 显式 `/skill:<name>` 触发。
    #[serde(rename = "modelInvocationDisabled", default)]
    pub model_invocation_disabled: bool,
    /// 技能是否启用。false = SKILL.md 已改名为 `SKILL.md.disabled`，pi 根本
    /// 不会加载它（连显式 `/skill:name` 也不触发）。禁用态仍然列出来，
    /// 才能让用户重新开启。
    #[serde(rename = "isActive")]
    pub is_active: bool,
    /// 面板上能否给这个技能开关「启用/禁用」（正文文件在本地可改名）。
    /// 点目录开头的内置技能（如 `.system`）为 false。
    #[serde(rename = "disableable")]
    pub disableable: bool,
}

#[tauri::command]
pub fn helix_get_skills_dir() -> Option<String> {
    skills_dir().to_str().map(str::to_string)
}

#[tauri::command]
pub fn helix_read_dir(dir_path: String) -> Vec<DirEntryInfo> {
    let Ok(entries) = std::fs::read_dir(&dir_path) else {
        return vec![];
    };
    let mut out: Vec<DirEntryInfo> = entries
        .filter_map(|e| e.ok())
        .map(|e| DirEntryInfo {
            is_directory: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            name: e.file_name().to_string_lossy().into_owned(),
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// Read a text file. Unrestricted (mirrors the Electron bridge): the renderer
/// also uses it to import Chrome bookmarks from outside the skills dir.
#[tauri::command]
pub fn helix_read_file(file_path: String) -> Option<String> {
    std::fs::read_to_string(&file_path).ok()
}

/// Delete a skill directory. Guarded: only paths inside the skills dir may be
/// removed (its sole renderer use is deleting a listed skill folder), and
/// dot-directories (builtin skills like `.system`) are protected.
#[tauri::command]
pub fn helix_delete_dir(dir_path: String) -> bool {
    let target = Path::new(&dir_path);
    let root = skills_dir();
    match (target.canonicalize(), root.canonicalize()) {
        (Ok(t), Ok(r)) if t.starts_with(&r) && t != r => {
            let is_builtin = t
                .strip_prefix(&r)
                .ok()
                .and_then(|rel| rel.components().next())
                .map(|c| c.as_os_str().to_string_lossy().starts_with('.'))
                .unwrap_or(true);
            !is_builtin && std::fs::remove_dir_all(t).is_ok()
        }
        _ => false,
    }
}

/// List every SKILL.md directory pi actually loads:
///   ~/.pi/agent/skills/<skill>/ (and <category>/<skill>/) — user root
///   ~/.agents/skills/<skill>/ — pi 的跨 agent 用户根（无条件加载）
///   <work_dir>(及向上到 git 根的各层)/.agents/skills + <work_dir>/.pi/skills
///     — 项目根，只在信任档位为 always 时才加载（与 gateway 的 `--approve` 一致）
///   ~/.pi/agent/npm/node_modules/<pkg>/<pi.skills paths>/… — package-bundled
/// Directories starting with `.` are listed with `isBuiltin: true`.
#[tauri::command]
pub fn helix_list_skills() -> Vec<SkillEntry> {
    let mut out: Vec<SkillEntry> = Vec::new();

    // ── Pi user skills (~/.pi/agent/skills/) ──
    if let Ok(top) = std::fs::read_dir(skills_dir()) {
        collect_skills_from_dir(top, &mut out, "pi", false);
    }

    // ── Skills from pi's settings.json `skills` roots ──
    // pi 自己会读 ~/.pi/agent/settings.json 的 `skills` 数组作为额外加载根。
    // Helix 列表必须跟上同一套根，
    // 否则技能面板 / 输入框 "/" 菜单看不到这些已安装技能。
    collect_settings_skills(&mut out);

    // ── .agents/skills（用户根 + 受信任门控的项目根）──
    collect_agents_skills(&mut out);

    // ── Skills bundled with pi npm packages ──
    collect_package_skills(&mut out);

    // 同一个技能目录可能被多个根重复命中（例如 settings.json 把根指回 .agents）。
    // pi 自己按 canonicalize 后的正文路径去重，这里跟上，避免面板出现两行。
    let mut seen: Vec<PathBuf> = Vec::with_capacity(out.len());
    out.retain(|s| {
        let real = Path::new(&s.path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(s.path.replace('\\', "/")));
        if seen.iter().any(|p| *p == real) {
            false
        } else {
            seen.push(real);
            true
        }
    });

    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// 技能「模型自动调用」开关的返回体。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInvocationResult {
    /// 真的改写了文件（否则已经是目标状态）。
    pub changed: bool,
    /// 修改后「模型自动调用」是否被禁用。
    pub disabled: bool,
}

/// 技能正文文件名与其禁用态对应文件名。
const SKILL_FILENAMES: &[&str] = &["SKILL.md", "README.md"];
const DISABLED_SUFFIX: &str = ".disabled";

/// 一个技能目录里找到的正文文件。
struct SkillFile {
    path: PathBuf,
    /// true = `SKILL.md`（启用态）；false = `SKILL.md.disabled`（禁用态）。
    active: bool,
}

/// `SKILL.md`（或 pi 同样接受的 `README.md`）的完整路径；目录里只有禁用态
/// 文件（`SKILL.md.disabled`）时也算找到，`active` 为 false —— pi 的加载器只认
/// 那两个精确文件名，改名后必然加载不到，这就是「真正关掉一个技能」的机制。
fn skill_markdown_path(skill_dir: &str) -> Option<SkillFile> {
    let dir = Path::new(skill_dir);
    for cand in SKILL_FILENAMES {
        let p = dir.join(cand);
        if p.is_file() {
            return Some(SkillFile { path: p, active: true });
        }
    }
    for cand in SKILL_FILENAMES {
        let p = dir.join(format!("{cand}{DISABLED_SUFFIX}"));
        if p.is_file() {
            return Some(SkillFile { path: p, active: false });
        }
    }
    None
}

/// 只取启用态正文文件路径（写 frontmatter 用：禁用态的文件改它没意义）。
fn skill_active_md(skill_dir: &str) -> Option<PathBuf> {
    skill_markdown_path(skill_dir).filter(|f| f.active).map(|f| f.path)
}

/// Helix 自己维护的禁用清单（落在用户技能根下，内容是被禁用技能的目录路径，
/// 每行一个）。只用来让 npm 包内置技能的禁用态在包被重装/升级覆盖后能重新
/// 生效（`helix_reapply_disabled_skills`）。pi 的扫描会跳过 `.` 开头的目录，
/// 也不读根下的普通文件，所以这个清单对 pi 完全不可见。
fn disabled_manifest_path() -> PathBuf {
    pi_user_skills_dir().join(".helix-disabled-skills")
}

fn read_disabled_manifest() -> Vec<String> {
    std::fs::read_to_string(disabled_manifest_path())
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

fn write_disabled_manifest(list: &[String]) {
    let root = pi_user_skills_dir();
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    let mut body: Vec<String> = list.to_vec();
    body.sort();
    body.dedup();
    let _ = std::fs::write(
        disabled_manifest_path(),
        format!("{}\n", body.join("\n")),
    );
}

/// 校验目录路径落在某个技能根内（用户根 / settings 根 / npm 包目录），
/// 拒绝越界写入。
fn ensure_skill_dir_allowed(skill_dir: &Path) -> Result<(), String> {
    let real = skill_dir
        .canonicalize()
        .map_err(|e| format!("技能目录不可访问: {e}"))?;
    let npm = pi_npm_dir().join("node_modules");
    let mut roots: Vec<PathBuf> = vec![pi_user_skills_dir(), npm, user_agents_skills_dir()];
    // 项目侧根（.agents/skills 与 .pi/skills）也允许启停，与列表面向同一套根。
    if let Some(cwd) = crate::state::app_state()
        .map(|s| s.work_dir.read().unwrap().clone())
        .or_else(|| dirs::home_dir())
    {
        roots.push(cwd.join(".pi").join("skills"));
        let git_root = find_git_repo_root(&cwd);
        let mut dir = cwd.as_path();
        loop {
            roots.push(dir.join(".agents").join("skills"));
            if git_root.as_deref() == Some(dir) {
                break;
            }
            match dir.parent() {
                Some(p) if p != dir => dir = p,
                _ => break,
            }
        }
    }
    if let Some(settings_path) = pi_settings_path() {
        if let Ok(raw) = std::fs::read_to_string(settings_path) {
            if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(arr) = settings.get("skills").and_then(serde_json::Value::as_array) {
                    for root in arr.iter().filter_map(serde_json::Value::as_str) {
                        if let Ok(p) = Path::new(root).canonicalize() {
                            roots.push(p);
                        }
                    }
                }
            }
        }
    }
    if roots
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|r| real.starts_with(&r))
    {
        Ok(())
    } else {
        Err("只能修改 pi 技能目录下的文件".to_string())
    }
}

/// 开关技能的「启用 / 禁用」：把正文文件在 `SKILL.md` 与 `SKILL.md.disabled`
/// 之间改名。禁用后 pi 的发现器（只认 `SKILL.md` / `README.md`）根本看不到
/// 这个技能，因此不会进 prompt、也不能被 `/skill:name` 显式触发 —— 比「仅手
/// 动」更彻底，也比删目录温和（随时可开回来，正文一字未动）。
///
/// 禁用 npm 包内置技能时，额外在技能根下记一条 `.helix-disabled-skills`，让
/// 禁用态能在包被重装/升级覆盖后重新生效（见 `helix_reapply_disabled_skills`）。
///
/// 真的改了名后会 `restart_gateway_soon`，让当前会话重新加载技能（pi 只在
/// 进程启动时快照技能列表）。
#[tauri::command]
pub fn helix_set_skill_enabled(
    skill_dir: String,
    enabled: bool,
) -> Result<SkillEnabledResult, String> {
    let dir = Path::new(&skill_dir);
    ensure_skill_dir_allowed(dir)?;
    let found = skill_markdown_path(&skill_dir)
        .ok_or_else(|| "目录下找不到 SKILL.md / README.md".to_string())?;
    if found.active == enabled {
        return Ok(SkillEnabledResult {
            changed: false,
            enabled,
            deferred: false,
        });
    }
    let (from, to) = if enabled {
        let stem = found
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(DISABLED_SUFFIX))
            .ok_or_else(|| "禁用文件名异常".to_string())?;
        (found.path.clone(), found.path.with_file_name(stem))
    } else {
        (
            found.path.clone(),
            found.path.with_file_name(format!(
                "{}{DISABLED_SUFFIX}",
                found
                    .path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| "技能文件名异常".to_string())?
            )),
        )
    };
    std::fs::rename(&from, &to).map_err(|e| format!("改名失败: {e}"))?;

    // pi 在进程启动时快照技能列表，改了磁盘不 respawn 就还得等下个会话。
    // 但重启会打断正在跑的对话，所以走 idle-aware：没对话在跑就立即重启（当前
    // 会话马上生效），有对话在跑则等它结算完再重启。deferred 告诉前端是不是
    // 需要等。
    let deferred = crate::pi_gateway::any_turn_running();
    if let Some(state) = crate::state::app_state() {
        crate::gateway::restart_gateway_when_idle(
            &state,
            &format!("技能启用状态变更 → {enabled}"),
        );
    }

    // 包内置技能（node_modules 里的）重装会被覆盖 → 记进禁用清单。
    let in_packages = dir.canonicalize().ok().map(|r| {
        pi_npm_dir()
            .join("node_modules")
            .canonicalize()
            .map(|npm| r.starts_with(npm))
            .unwrap_or(false)
    });
    if in_packages == Some(true) {
        let mut list = read_disabled_manifest();
        let key = to
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| skill_dir.clone());
        if enabled {
            list.retain(|p| p != &key);
        } else {
            if !list.iter().any(|p| p == &key) {
                list.push(key);
            }
        }
        write_disabled_manifest(&list);
    }

    Ok(SkillEnabledResult {
        changed: true,
        enabled,
        deferred,
    })
}

/// 把禁用清单里记着的技能重新改名回禁用态（`SKILL.md` → `SKILL.md.disabled`）。
///
/// npm 重装 / 包升级会重写 node_modules，把 `SKILL.md.disabled` 变回
/// `SKILL.md`，等于用户的禁用默默失效。Helix 启动时在拉起 gateway 之前调一次，
/// 把禁用重新贴回去。返回重新禁用的技能数。
#[tauri::command]
pub fn helix_reapply_disabled_skills() -> usize {
    let list = read_disabled_manifest();
    let mut reapplied = 0;
    let mut kept: Vec<String> = Vec::new();
    for entry in list {
        let dir = Path::new(&entry);
        // 目录已不存在（技能被卸载）→ 丢弃条目，不再纠缠。
        if !dir.is_dir() {
            continue;
        }
        match skill_markdown_path(&entry) {
            // 正文文件都没了（包拆了一半）→ 保留条目等下次。
            None => kept.push(entry),
            // 已是禁用态：正常情况，继续记账。
            Some(f) if !f.active => kept.push(entry),
            // 启用态 = 重装把文件覆盖回来了 → 重新改名成禁用态。
            Some(f) => {
                if let Some(name) = f.path.file_name().and_then(|n| n.to_str()) {
                    let to = f.path.with_file_name(format!("{name}{DISABLED_SUFFIX}"));
                    if std::fs::rename(&f.path, &to).is_ok() {
                        reapplied += 1;
                    }
                }
                kept.push(entry);
            }
        }
    }
    write_disabled_manifest(&kept);
    reapplied
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnabledResult {
    /// 真的改了名（否则已是目标状态）。
    pub changed: bool,
    /// 修改后技能是否处于启用态。
    pub enabled: bool,
    /// 重启是否被延后（当前有对话在跑，等它结算完才重启生效）。
    pub deferred: bool,
}

#[tauri::command]
/// 开关「模型自动调用」：翻转 SKILL.md frontmatter 里的
/// `disable-model-invocation`（pi 唯一认的标记）。开启 = 把标记删掉；
/// 关闭 = 写上 `disable-model-invocation: true`，此后只能靠显式
/// `/skill:name` 触发。返回 (改写了, 修改后是否禁用)。
pub fn helix_set_skill_model_invocation(
    skill_dir: String,
    enabled: bool,
) -> Result<SkillInvocationResult, String> {
    let path = skill_active_md(&skill_dir)
        .ok_or_else(|| "目录下找不到启用的 SKILL.md / README.md".to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let disable_key = "disable-model-invocation";
    let new_content = if enabled {
        strip_frontmatter_true(&content, disable_key)
    } else {
        insert_frontmatter_true(&content, disable_key)
    }
    .ok_or_else(|| "无法修改 frontmatter".to_string())?;
    if new_content != content {
        std::fs::write(&path, new_content).map_err(|e| e.to_string())?;
        Ok(SkillInvocationResult { changed: true, disabled: !enabled })
    } else {
        Ok(SkillInvocationResult {
            changed: false,
            disabled: frontmatter_has_true(&content, disable_key)
                .unwrap_or(!enabled),
        })
    }
}

/// `~/.pi/agent/settings.json` — pi's user settings (its `skills` array lists
/// additional skill roots pi loads).
fn pi_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("settings.json"))
}

/// 扫描 pi 的 `.agents/skills` 体系，与 package-manager.js
/// `addAutoDiscoveredResources` 对齐：
/// - 用户根 `~/.agents/skills/`：无条件加载（不受信任门控）。
/// - 项目根：从 work_dir 向上每层的 `.agents/skills/`，碰到 git 根就停；
///   另外 `work_dir/.pi/skills/` 也是项目技能根。这些都只在项目被信任时
///   才加载 —— Helix 的 gateway 靠 `--approve` / `--no-approve` 决定，跟
///   `configured_project_trust()` 一致。不跟上就会出现「终端 pi 看得到、
///   Helix 面板看不到」（或反过来）的不一致。
fn collect_agents_skills(out: &mut Vec<SkillEntry>) {
    // 用户根（agents）
    if let Ok(top) = std::fs::read_dir(user_agents_skills_dir()) {
        collect_skills_from_dir(top, out, "agents", false);
    }

    let cwd = crate::state::app_state()
        .map(|s| s.work_dir.read().unwrap().clone())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));

    // 项目根只在信任档位为 always 时生效（跟 gateway 的 `--approve` 同步）。
    if crate::pi_advanced::configured_project_trust() != "always" {
        return;
    }

    // work_dir/.pi/skills
    let pi_project_skills = cwd.join(".pi").join("skills");
    if let Ok(top) = std::fs::read_dir(&pi_project_skills) {
        collect_skills_from_dir(top, out, "agents", false);
    }

    // 向上各层的 .agents/skills，到 git 根为止（collectAncestorAgentsSkillDirs）。
    let git_root = find_git_repo_root(&cwd);
    let user_agents = user_agents_skills_dir();
    let mut dir = cwd.as_path();
    loop {
        let cand = dir.join(".agents").join("skills");
        if cand != user_agents {
            if let Ok(top) = std::fs::read_dir(&cand) {
                collect_skills_from_dir(top, out, "agents", false);
            }
        }
        if git_root.as_deref() == Some(dir) {
            break;
        }
        match dir.parent() {
            Some(p) if p != dir => dir = p,
            _ => break,
        }
    }
}

/// 从 `start` 向上找第一个含 `.git` 的目录（package-manager.js 的 findGitRepoRoot）。
fn find_git_repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start;
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        match dir.parent() {
            Some(p) if p != dir => dir = p,
            _ => return None,
        }
    }
}

/// Scan each directory listed in settings.json's `skills` array, mirroring
/// pi's own loading rule. Missing/unreadable roots are skipped silently.
/// 这些技能同样允许禁用（改名 + 不记清单：重装不涉及），故 builtin=false。
fn collect_settings_skills(out: &mut Vec<SkillEntry>) {
    let Some(settings_path) = pi_settings_path() else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(settings_path) else {
        return;
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(roots) = settings
        .get("skills")
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };
    for root in roots {
        let Some(dir) = root.as_str() else {
            continue;
        };
        let Ok(top) = std::fs::read_dir(dir) else {
            continue;
        };
        collect_skills_from_dir(top, out, "pi", false);
    }
}

/// Scan `~/.pi/agent/npm/node_modules/<dep>/` for skills declared via the
/// `pi.skills` manifest field (same rule pi itself uses — undeclared `skills/`
/// directories are NOT loaded, so they are not listed either).
fn collect_package_skills(out: &mut Vec<SkillEntry>) {
    let npm = pi_npm_dir();
    let Ok(content) = std::fs::read_to_string(npm.join("package.json")) else {
        return;
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    let Some(deps) = pkg
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let node_modules = npm.join("node_modules");
    for dep_name in deps.keys() {
        let pkg_dir = node_modules.join(dep_name);
        let Ok(meta_raw) = std::fs::read_to_string(pkg_dir.join("package.json")) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_raw) else {
            continue;
        };
        // Only declared paths (glob/exclusion entries are skipped — the
        // directory scan below covers what a plain dir glob would match).
        let Some(roots) = meta
            .pointer("/pi/skills")
            .and_then(serde_json::Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| !s.contains('*') && !s.starts_with('!'))
                    .map(|s| pkg_dir.join(s.trim_start_matches("./")))
                    .collect::<Vec<_>>()
            })
        else {
            continue;
        };
        for root in roots {
            if let Ok(top) = std::fs::read_dir(&root) {
                collect_skills_from_dir(top, out, dep_name, true);
            }
        }
    }
}

fn collect_skills_from_dir(
    top: std::fs::ReadDir,
    out: &mut Vec<SkillEntry>,
    source: &str,
    builtin: bool,
) {
    for entry in top.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        // 点目录 = pi/Helix 自己的内置技能，面板不删也不关。
        let dot = dir_name.starts_with('.');
        let builtin = builtin || dot;
        // Depth 1: <skills>/<skill>/SKILL.md
        if let Some(skill) =
            read_skill_dir(&entry.path(), &dir_name, &dir_name, builtin, source, !dot)
        {
            out.push(skill);
            continue;
        }
        // Depth 2: <skills>/<category>/<skill>/SKILL.md
        let Ok(children) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        for child in children.filter_map(|e| e.ok()) {
            if !child.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let child_name = child.file_name().to_string_lossy().into_owned();
            let id = format!("{dir_name}/{child_name}");
            let child_dot = child_name.starts_with('.');
            if let Some(skill) = read_skill_dir(
                &child.path(),
                &id,
                &child_name,
                builtin || child_dot,
                source,
                !(dot || child_dot),
            ) {
                out.push(skill);
            }
        }
    }
}

/// Build a SkillEntry if `dir` contains a SKILL.md (or README.md — pi 接受两个，
/// 或其禁用态 `*.disabled`)。
/// `id` — stable identifier (relative path); `fallback_name` — dir name used
/// when frontmatter has no `name:`; `builtin` — non-user-managed flag (dot
/// directory, or package-bundled); `disableable` — 面板可给此技能开关启用/禁用。
fn read_skill_dir(
    dir: &Path,
    id: &str,
    fallback_name: &str,
    builtin: bool,
    source: &str,
    disableable: bool,
) -> Option<SkillEntry> {
    let Some(found) = skill_markdown_path(dir.to_str().unwrap_or("")) else {
        return None;
    };
    let content = std::fs::read_to_string(&found.path).ok()?;
    let (name, description) = parse_skill_frontmatter(&content);
    let name = name.unwrap_or_else(|| fallback_name.to_string());
    Some(SkillEntry {
        id: id.to_string(),
        name: name.clone(),
        // Slash-command invocation name for the pi skill engine
        // (`/skill:<name>`), serialized to the frontend as commandName.
        command_name: name,
        description: description.unwrap_or_default(),
        is_builtin: builtin,
        source: source.to_string(),
        path: dir.to_string_lossy().into_owned(),
        model_invocation_disabled:
            frontmatter_has_true(&content, "disable-model-invocation")
                .unwrap_or(false),
        is_active: found.active,
        disableable,
    })
}

/// Extract `name` / `description` from a SKILL.md YAML frontmatter block.
fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if in_frontmatter {
                break; // closing delimiter
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(v) = trimmed.strip_prefix("name:") {
            name = Some(clean_yaml_scalar(v));
        } else if let Some(v) = trimmed.strip_prefix("description:") {
            description = Some(clean_yaml_scalar(v));
        }
    }
    (name, description)
}

fn clean_yaml_scalar(v: &str) -> String {
    let v = v.trim();
    let v = v.trim_matches(|c| c == '"' || c == '\'');
    v.trim().to_string()
}

/// A subagent type as the `pi-subagents` extension actually resolves it.
///
/// The extension merges three compiled defaults (general-purpose / Explore /
/// Plan, src/default-agents.ts) with `<work_dir>/.pi/agents/*.md`,
/// `<work_dir>/.agents/agents/*.md` and `~/.pi/agent/agents/*.md`
/// (src/custom-agents.ts — project overrides global). Disabling an agent is
/// an `enabled: false` line in its frontmatter; the extension never moves
/// files, so this bridge edits frontmatter the same way its `/agents`
/// command does (src/agent-file-toggle.ts).
#[derive(Serialize)]
pub struct SubagentPreset {
    /// Registry key: the `subagent_type` the model passes to the Agent tool.
    pub id: String,
    /// Display label (`display_name:`), falling back to the type.
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub model: String,
    pub thinking: String,
    /// `prompt_mode:` ("replace" | "append"); absent means "replace".
    #[serde(rename = "systemPromptMode")]
    pub system_prompt_mode: String,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    /// Absolute path of the defining .md (empty for compiled defaults).
    pub path: String,
    #[serde(rename = "disabled")]
    pub disabled: bool,
    /// "default" | "project" | "workspace" | "global".
    pub source: String,
}

/// Split a YAML scalar that is a comma-separated list into trimmed items.
fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn fm_scalar(fm: &HashMap<String, String>, key: &str) -> String {
    fm.get(key)
        .map(|v| clean_yaml_scalar(v))
        .unwrap_or_default()
}

/// `~/.pi/agent/agents/` — the extension's personal agent dir
/// (`getAgentDir()/agents`).
fn global_agents_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pi")
        .join("agent")
        .join("agents")
}

/// The extension is installed under one of these roots (this machine uses
/// Candidate directory names the pi-subagents extension is known to install
/// under `~/.pi/agent/extensions/` (and npm-global). Different install paths
/// (git clone vs `pi install npm:pi-subagents` vs local dev checkout) land under
/// different folder names, so probe all of them instead of a single hard-coded
/// one — otherwise the extension's own bundled agents (claude.md / codex.md)
/// stay invisible to `helix_list_subagents`.
const SUBAGENTS_EXT_DIR_NAMES: &[&str] = &[
    "pi-subagents",
    "pi-subagents-master",
    "subagents",
];

/// `extensions/pi-subagents-master` (or any known variant). Without it the Agent
/// tool doesn't exist, so the settings section stays hidden.
fn subagents_extension_installed() -> bool {
    let ext = plugins_dir();
    if SUBAGENTS_EXT_DIR_NAMES
        .iter()
        .any(|name| ext.join(name).is_dir())
    {
        return true;
    }
    pi_npm_dir()
        .join("node_modules")
        .join("pi-subagents")
        .is_dir()
}

/// Resolve which of the candidate extension dir names actually exists on disk,
/// so the bundled `agents/` folder can be located regardless of how the
/// extension was installed. Returns `None` when none of them exist.
fn find_subagents_ext_dir() -> Option<std::path::PathBuf> {
    let ext = plugins_dir();
    for name in SUBAGENTS_EXT_DIR_NAMES {
        let dir = ext.join(name);
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

/// Helix's current work dir — the cwd pi instances run with, and therefore
/// the root the extension resolves project agents from.
fn subagents_work_dir() -> PathBuf {
    crate::state::app_state()
        .map(|s| s.work_dir.read().unwrap().clone())
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

/// Merged pi-subagents settings from `<work_dir>/.pi/subagents.json`
/// (the extension's own project-level file).
fn merged_subagents_settings(cwd: &Path) -> HashMap<String, serde_json::Value> {
    let project = cwd.join(".pi").join("subagents.json");
    let mut out: HashMap<String, serde_json::Value> = HashMap::new();
    if let Ok(raw) = std::fs::read_to_string(&project) {
        if let Ok(serde_json::Value::Object(o)) = serde_json::from_str(&raw) {
            for (k, v) in o {
                out.insert(k, v);
            }
        }
    }
    out
}

/// The three agent dirs in load precedence order (project highest), plus the
/// extension's own bundled agents dir (lowest precedence — these are fallback
/// agent types shipped with pi-subagents, e.g. claude.md / codex.md under
/// `~/.pi/agent/extensions/<variant>/agents/`).
fn subagent_agent_roots() -> Vec<PathBuf> {
    let cwd = subagents_work_dir();
    let mut roots = vec![
        cwd.join(".pi").join("agents"),
        cwd.join(".agents").join("agents"),
        global_agents_dir(),
    ];
    if let Some(ext_dir) = find_subagents_ext_dir() {
        let bundled = ext_dir.join("agents");
        if bundled.is_dir() {
            roots.push(bundled);
        }
    }
    roots
}

struct ParsedAgent {
    type_name: String,
    display_name: String,
    description: String,
    tools: Vec<String>,
    model: String,
    thinking: String,
    prompt_mode: String,
    system_prompt: String,
    disabled: bool,
}

/// Parse an `agents/<name>.md` file the way src/custom-agents.ts does:
/// frontmatter map (tolerating a leading UTF-8 BOM) + body as the system
/// prompt. The type is the declared `name:`, falling back to the filename;
/// a name containing `:` is skipped (reserved for plugin-scoped ids).
/// Disabling is `enabled: false` — only the literal spelling, matching what
/// the extension writes and what pi's frontmatter parser keeps as boolean.
fn parse_agent_md(content: &str, filename_stem: &str) -> Option<ParsedAgent> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut fm: HashMap<String, String> = HashMap::new();
    let mut body: Vec<&str> = Vec::new();
    let mut in_frontmatter = false;
    let mut closed = false;
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed == "---" && !closed {
            if i == 0 {
                in_frontmatter = true;
                continue;
            }
            if in_frontmatter {
                closed = true;
                continue;
            }
        }
        if in_frontmatter && !closed {
            if let Some((k, v)) = trimmed.split_once(':') {
                fm.insert(k.trim().to_string(), v.trim().to_string());
            }
        } else {
            body.push(line);
        }
    }
    let declared = fm.get("name").map(|v| clean_yaml_scalar(v));
    if declared.as_deref().is_some_and(|d| d.contains(':')) {
        return None;
    }
    let type_name = declared
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| filename_stem.to_string());
    let prompt_mode = match fm_scalar(&fm, "prompt_mode").to_lowercase().as_str() {
        "append" => "append".to_string(),
        _ => "replace".to_string(),
    };
    let description = {
        let d = fm_scalar(&fm, "description");
        if d.trim().is_empty() {
            type_name.clone()
        } else {
            d
        }
    };
    Some(ParsedAgent {
        type_name,
        display_name: fm_scalar(&fm, "display_name"),
        description,
        tools: fm
            .get("tools")
            .map(|s| split_csv(&clean_yaml_scalar(s)))
            .unwrap_or_default(),
        model: fm_scalar(&fm, "model"),
        thinking: fm_scalar(&fm, "thinking"),
        prompt_mode,
        system_prompt: body.join("\n").trim().to_string(),
        disabled: fm.get("enabled").map(|v| v.trim()) == Some("false"),
    })
}

/// Scan one of the extension's agent dirs. A file that fails to parse is
/// skipped — the loader skips it too (warnSkippedOverride path).
fn scan_agent_dir(dir: &Path, source: &str) -> Vec<SubagentPreset> {
    let mut out: Vec<SubagentPreset> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Some(a) = parse_agent_md(&content, &stem) else {
            continue;
        };
        let name = if a.display_name.trim().is_empty() {
            a.type_name.clone()
        } else {
            a.display_name
        };
        out.push(SubagentPreset {
            id: a.type_name,
            name,
            description: a.description,
            tools: a.tools,
            model: a.model,
            thinking: a.thinking,
            system_prompt_mode: a.prompt_mode,
            system_prompt: a.system_prompt,
            path: p.to_string_lossy().into_owned(),
            disabled: a.disabled,
            source: source.to_string(),
        });
    }
    out
}

/// 内置子代理预设已全部改为 .md 文件（用户全局/项目目录），不再有编译进二进制的
/// 硬编码默认。保留此函数返回空列表以维持加载顺序占位；未来如需新增内置
/// 子代理，直接在这里 add 即可，无需改动调用方。
fn default_agent_presets() -> Vec<SubagentPreset> {
    vec![]
}

/// List every subagent type the pi-subagents extension would resolve for the
/// current work dir: compiled defaults + project/workspace/global .md files.
///
/// Mirrors the loader's merge (src/agent-types.ts `registerAgents`): defaults
/// first (skipped entirely when `disableDefaultAgents` is set), then user
/// files overlaid in precedence order, so a same-type project file replaces
/// the global one. Case-insensitive on the type id, matching `resolveKeyIn`
/// — first-loaded wins among case variants, as in the loader's map overlay.
#[tauri::command]
pub fn helix_list_subagents() -> Vec<SubagentPreset> {
    if !subagents_extension_installed() {
        return vec![];
    }
    let cwd = subagents_work_dir();
    let settings = merged_subagents_settings(&cwd);
    let defaults_off = settings
        .get("disableDefaultAgents")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut out: Vec<SubagentPreset> = Vec::new();
    let push =
        |p: SubagentPreset, out: &mut Vec<SubagentPreset>, seen: &mut HashMap<String, ()>| {
            let key = p.id.to_lowercase();
            if seen.insert(key, ()).is_none() {
                out.push(p);
            }
        };

    if !defaults_off {
        for p in default_agent_presets() {
            push(p, &mut out, &mut seen);
        }
    }
    // Highest-precedence dir first; later entries are dropped on id clash.
    let dirs: Vec<(std::path::PathBuf, &str)> = vec![
        (cwd.join(".pi").join("agents"), "project"),
        (cwd.join(".agents").join("agents"), "workspace"),
        (global_agents_dir(), "global"),
    ]
    .into_iter()
    .filter(|(dir, _)| dir.is_dir())
    .collect();
    for (dir, source) in &dirs {
        for p in scan_agent_dir(dir, source) {
            push(p, &mut out, &mut seen);
        }
    }
    // The extension's bundled agents (claude.md, codex.md, …) act as
    // built-in defaults: source "default" so the UI treats them the same as
    // the compiled presets, but their definitions live in the .md files so
    // they can be updated without recompiling.
    if let Some(ext_dir) = find_subagents_ext_dir() {
        let bundled = ext_dir.join("agents");
        if bundled.is_dir() {
            for mut p in scan_agent_dir(&bundled, "extension") {
                p.source = "default".to_string();
                push(p, &mut out, &mut seen);
            }
        }
    }
    out
}

/// Locate the .md that defines an agent type, in the loader's precedence
/// order (project → workspace → global). Built-in defaults have no file.
fn find_agent_file(type_name: &str) -> Option<PathBuf> {
    for dir in subagent_agent_roots() {
        let p = dir.join(format!("{type_name}.md"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Set `enabled: false` / remove it — the same frontmatter edit the
/// extension's own `/agents` command performs (src/agent-file-toggle.ts):
///
/// - Has a .md → insert `enabled: false` right after the opening `---`
///   (disable) or strip the line (enable), preserving the file's line
///   endings and formatting. A file that was only a disable-stub is deleted
///   on enable, restoring the compiled default.
/// - No .md (compiled default) → disable writes a stub
///   `---\nenabled: false\n---\n` to `~/.pi/agent/agents/<type>.md`;
///   enable is a no-op (nothing to re-enable).
///
/// The extension re-reads agent files on every Agent call, so changes apply
/// to the next spawn without restarting anything.
#[tauri::command]
pub fn helix_set_subagent_enabled(name: String, enabled: bool) -> Result<(), String> {
    if !subagents_extension_installed() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    if name.trim().is_empty()
        || name.trim() != name
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("非法的预设名".to_string());
    }
    let name = name.trim().to_string();

    if let Some(path) = find_agent_file(&name) {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if is_disable_stub(&content) && enabled {
            // Stub only existed to disable a compiled default — removing it
            // restores the default (mirrors enableAgent's stub branch).
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            return Ok(());
        }
        let updated = if enabled {
            strip_enabled_false(&content).ok_or_else(|| format!("{name} 未处于禁用状态"))?
        } else {
            insert_enabled_false(&content)
                .ok_or_else(|| format!("无法在 {name} 的 frontmatter 中写入禁用标记"))?
        };
        std::fs::write(&path, updated).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if !enabled && is_default_agent(&name) {
        // Compiled default: write the disable-stub into the personal dir,
        // exactly what `/agents → Disable` does for a default with no file.
        let dir = global_agents_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{name}.md"));
        if path.exists() {
            return Err(format!("{name} 的覆盖文件已存在"));
        }
        std::fs::write(&path, "---\nenabled: false\n---\n").map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err(format!("预设 {name} 不存在"))
}

/// Set the `model:` field in an agent's `.md` frontmatter.
/// Pass an empty string to clear the model (inherit parent).
#[tauri::command]
pub fn helix_set_subagent_model(name: String, model: String) -> Result<(), String> {
    if !subagents_extension_installed() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    let name = name.trim().to_string();
    if name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("非法的预设名".to_string());
    }
    let path = find_agent_file(&name).ok_or_else(|| format!("预设 {name} 不存在"))?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let updated = if model.trim().is_empty() {
        upsert_model_line(&content, None)
    } else {
        upsert_model_line(&content, Some(model.trim()))
    }
    .ok_or_else(|| format!("无法修改 {name} 的 frontmatter"))?;

    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    Ok(())
}

/// Replace or insert a `model:` line in the frontmatter of a `.md` agent file.
/// Returns the new file content, or None if the file has no parseable frontmatter block.
fn upsert_model_line(content: &str, model: Option<&str>) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    // Find frontmatter end (the closing ---)
    let mut fm_end: Option<usize> = None;
    let mut in_fm = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t == "---" {
            if i == 0 || in_fm {
                in_fm = !in_fm;
                if !in_fm {
                    fm_end = Some(i);
                    break;
                }
            }
        }
    }
    let fm_end = fm_end?;

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut model_replaced = false;

    for (i, line) in lines.iter().enumerate() {
        if i <= fm_end {
            let t = line.trim_start();
            if t.starts_with("model:") {
                // Keep at most one model line: the first occurrence gets
                // replaced, any later duplicates are dropped.
                if !model_replaced {
                    if let Some(m) = model {
                        out.push(format!("model: \"{m}\""));
                    }
                    model_replaced = true;
                }
                continue;
            }
        }
        out.push(line.to_string());
    }

    if !model_replaced && model.is_some() {
        // Insert `model: "..."` right after the opening `---`
        let mut out2: Vec<String> = Vec::with_capacity(out.len() + 1);
        for (i, line) in out.iter().enumerate() {
            out2.push(line.clone());
            if i == 0 {
                out2.push(format!("model: \"{}\"", model.unwrap()));
            }
        }
        out = out2;
    }

    Some(out.join("\n") + if content.ends_with('\n') { "\n" } else { "" })
}

/// Permanently remove a custom agent's .md file (the extension's Delete does
/// `unlink`). Compiled defaults have no file to delete — refuse rather than
/// suggest deleting something the extension would resurrect.
#[tauri::command]
pub fn helix_delete_subagent(name: String) -> Result<(), String> {
    if !subagents_extension_installed() {
        return Err("pi-subagents 扩展未安装".to_string());
    }
    if name.trim().is_empty() || name.trim() != name {
        return Err("非法的预设名".to_string());
    }
    let name = name.trim().to_string();
    let path = find_agent_file(&name).ok_or_else(|| format!("预设 {name} 不存在"))?;
    if is_disable_stub(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?) {
        // A stub is a default's off-switch, not a definition — delete reads
        // as "remove the agent" but the file carries nothing to remove.
        return Err("内置默认的禁用存根只能启用，不能删除".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Is this type one of the extension's compiled defaults?
fn is_default_agent(name: &str) -> bool {
    ["general-purpose", "Explore", "Plan"]
        .iter()
        .any(|d| d.eq_ignore_ascii_case(name))
}

/// A file the extension writes to disable a compiled default: exactly
/// `---\nenabled: false\n---` (src/agent-file-toggle.ts isEmptyStub).
fn is_disable_stub(content: &str) -> bool {
    let normalized = content.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    trimmed == "---\nenabled: false\n---" || trimmed == "---\n---"
}

/// Split keeping each line's terminator, matching splitFrontmatter in
/// agent-file-toggle.ts: lines keep their terminators, so an edit preserves
/// the file's line endings (and a missing final newline stays missing).
fn split_lines_keep_ends(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, b) in content.bytes().enumerate() {
        if b == b'\n' {
            lines.push(content[start..=i].to_string());
            start = i + 1;
        }
    }
    if start < content.len() {
        lines.push(content[start..].to_string());
    }
    lines
}

/// Index of the frontmatter's closing `---` (a `---`-trimmed line after the
/// opening one), or None when the file has no frontmatter block.
fn frontmatter_close(lines: &[String]) -> Option<usize> {
    if lines.first()?.trim() != "---" {
        return None;
    }
    lines
        .iter()
        .skip(1)
        .position(|l| l.trim() == "---")
        .map(|i| i + 1)
}

/// Insert `enabled: false` immediately after the opening `---`, preserving
/// everything else (disableInContent). None when there is no frontmatter
/// block or the file is already disabled.
fn insert_enabled_false(content: &str) -> Option<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = split_lines_keep_ends(content);
    let close = frontmatter_close(&lines)?;
    if lines
        .iter()
        .take(close)
        .any(|l| l.trim() == "enabled: false")
    {
        return None;
    }
    let eol = if lines[0].ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    lines.insert(1, format!("enabled: false{eol}"));
    Some(lines.join(""))
}

/// Remove the `enabled: false` line from the frontmatter wherever it appears
/// (enableInContent removes it at any position). None when the file has no
/// frontmatter block; Some(content) unchanged when there was nothing to
/// strip — the caller then reports the no-op.
fn strip_enabled_false(content: &str) -> Option<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines = split_lines_keep_ends(content);
    let close = frontmatter_close(&lines)?;
    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, l)| !(*i > 0 && *i < close && l.trim() == "enabled: false"))
        .map(|(_, l)| l.clone())
        .collect();
    Some(kept.join(""))
}

/// 判断 frontmatter 里 `key` 是否被显式设成真值（`true` / 裸写）。
/// 只在前 200 行里搜：frontmatter 永远在文件头，避免撞到正文里偶然
/// 同名的词。没有 frontmatter 块返回 None。
fn frontmatter_has_true(content: &str, key: &str) -> Option<bool> {
    let lines = split_lines_keep_ends(content.strip_prefix('\u{feff}').unwrap_or(content));
    let close = frontmatter_close(&lines)?;
    let hit = lines
        .iter()
        .take(close)
        .find(|l| l.trim_start().split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
            .next()
            .map(str::trim)
            .map(|s| s.eq_ignore_ascii_case(key))
            .unwrap_or(false));
    Some(match hit {
        Some(l) => {
            let v = l.splitn(2, ':').nth(1).map(str::trim).unwrap_or("");
            v.is_empty() || v.eq_ignore_ascii_case("true")
        }
        None => false,
    })
}

/// 在 frontmatter 开头插入 `key: true`。None = 没有 frontmatter 块。
fn insert_frontmatter_true(content: &str, key: &str) -> Option<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    if frontmatter_has_true(content, key).unwrap_or(false) {
        return Some(content.to_string());
    }
    let mut lines = split_lines_keep_ends(content);
    frontmatter_close(&lines)?;
    let eol = if lines[0].ends_with("\r\n") { "\r\n" } else { "\n" };
    lines.insert(1, format!("{key}: true{eol}"));
    Some(lines.join(""))
}

/// 删掉 frontmatter 里 `key` 的所有行（无论值是真还是假）。None = 没有
/// frontmatter 块；Some(原文) = 本来就没有这一行（调用方报 no-op）。
fn strip_frontmatter_true(content: &str, key: &str) -> Option<String> {
    let lines = split_lines_keep_ends(content.strip_prefix('\u{feff}').unwrap_or(content));
    let close = frontmatter_close(&lines)?;
    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, l)| {
            !(*i > 0 && *i < close && {
                l.trim_start()
                    .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                    .next()
                    .map(str::trim)
                    .map(|s| s.eq_ignore_ascii_case(key))
                    .unwrap_or(false)
            })
        })
        .map(|(_, l)| l.clone())
        .collect();
    Some(kept.join(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The extension can live under several folder names depending on how it
    /// was installed (git-clone checkout, `pi install npm:…`, …). This test
    /// runs against the real on-disk layout and skips cleanly on machines that
    /// don't have pi-subagents at all, so it doesn't break CI — but on a
    /// machine that *does* have it (any variant dir name), the resolver must
    /// actually find it.
    #[test]
    fn subagents_ext_dir_resolves_any_known_variant() {
        let found = find_subagents_ext_dir().map(|p| p.clone());
        let installed = subagents_extension_installed();
        // If none of the known dir variants nor the npm-global copy exists on
        // this machine, there is nothing to resolve — a no-op, not a failure.
        if !installed {
            return;
        }
        // The resolver must agree with the "installed" check: if we say the
        // extension is present, we must be able to point at its directory.
        assert!(
            found.is_some(),
            "extension reported installed but find_subagents_ext_dir() returned None"
        );
    }

    #[test]
    fn list_subagents_includes_bundled_claude_codex_when_present() {
        // Skip on machines without the extension — the bundled agents can only
        // be listed when the extension's dir is resolvable.
        if !subagents_extension_installed() {
            return;
        }
        let presets = helix_list_subagents();
        let ids: Vec<&str> = presets
            .iter()
            .map(|p| p.id.as_str())
            .collect();
        // claude / codex ship with the extension as bundled .md agents; on a
        // machine that has them they must show up (source coerced to "default").
        println!("list_subagents ids: {ids:?}");
    }

    #[test]
    fn list_skills_matches_pi_load_roots() {
        let skills = helix_list_skills();
        for s in &skills {
            // 启用态：目录里有 SKILL.md；禁用态：只有 SKILL.md.disabled。
            let dir = std::path::Path::new(&s.path);
            let active_md = dir.join("SKILL.md").is_file()
                || dir.join("README.md").is_file();
            let disabled_md = dir.join("SKILL.md.disabled").is_file()
                || dir.join("README.md.disabled").is_file();
            if s.is_active {
                assert!(
                    active_md,
                    "启用的技能 {} 目录里找不到 SKILL.md",
                    s.name
                );
            } else {
                assert!(
                    disabled_md,
                    "禁用的技能 {} 目录里找不到 SKILL.md.disabled",
                    s.name
                );
            }
        }
        // The pi user root (~/.pi/agent/skills) is machine-specific — only
        // assert on it when the reference skill actually exists on disk,
        // otherwise the test breaks on any machine without that skill.
        let coding_standards_dir = pi_user_skills_dir()
            .join("coding-standards")
            .join("SKILL.md");
        if coding_standards_dir.is_file() {
            assert!(skills
                .iter()
                .any(|s| s.name == "coding-standards" && s.source == "pi"));
        }
        // pi-subagents bundles council-mode + pi-subagents skills. The bundle
        // scan only runs when the package is installed on this machine.
        let subagents_pkg = pi_npm_dir()
            .join("node_modules")
            .join("pi-subagents")
            .join("package.json");
        if subagents_pkg.is_file() {
            let bundled: Vec<_> = skills
                .iter()
                .filter(|s| s.source == "pi-subagents")
                .map(|s| s.name.clone())
                .collect();
            assert!(
                bundled.contains(&"council-mode".to_string()),
                "bundled: {bundled:?}"
            );
            assert!(
                bundled.contains(&"pi-subagents".to_string()),
                "bundled: {bundled:?}"
            );
        }
        println!(
            "ALL SKILLS: {:#?}",
            skills
                .iter()
                .map(|s| (s.name.as_str(), s.source.as_str()))
                .collect::<Vec<_>>()
        );
    }

    /// 禁用态发现：只有 `SKILL.md` 算启用，改名成 `SKILL.md.disabled` 后
    /// 仍能被找到但 `active=false`（pi 的加载器只认前者，等于真关掉）。
    #[test]
    fn skill_markdown_path_detects_disabled_rename() {
        let dir = std::env::temp_dir().join(format!(
            "helix-skill-disable-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sp = dir.join("SKILL.md");
        std::fs::write(&sp, "---\nname: x\ndescription: y\n---\n").unwrap();
        let s = dir.to_str().unwrap();

        // 启用态
        let f = skill_markdown_path(s).unwrap();
        assert!(f.active);
        assert!(skill_active_md(s).is_some());

        // 改名为禁用态
        std::fs::rename(&sp, dir.join("SKILL.md.disabled")).unwrap();
        let f = skill_markdown_path(s).unwrap();
        assert!(!f.active);
        // 禁用态下 `skill_active_md`（写 frontmatter 用）拿不到路径。
        assert!(skill_active_md(s).is_none());

        // 改名回启用态
        std::fs::rename(dir.join("SKILL.md.disabled"), &sp).unwrap();
        assert!(skill_markdown_path(s).unwrap().active);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 开关前/后 frontmatter 标记的正确性：插入、删除、幂等。
    #[test]
    fn skill_frontmatter_disable_flag_roundtrips() {
        let content = "---\nname: my-skill\ndescription: does stuff\n---\n\n# Body\n";
        let key = "disable-model-invocation";

        assert_eq!(frontmatter_has_true(content, key), Some(false));

        // 插入：标记出现在第二个位置，其余行不动。
        let inserted = insert_frontmatter_true(content, key).unwrap();
        assert!(inserted.starts_with("---\ndisable-model-invocation: true\n"));
        assert!(inserted.contains("name: my-skill"));
        assert_eq!(frontmatter_has_true(&inserted, key), Some(true));

        // 幂等：已经禁用了再插一次不会重复写。
        assert_eq!(insert_frontmatter_true(&inserted, key).unwrap(), inserted);

        // 删除：标记没了，其他行保持原样。
        let stripped = strip_frontmatter_true(&inserted, key).unwrap();
        assert_eq!(stripped, content);

        // 没有 frontmatter 块的文件一律返回 None（不动）。
        assert_eq!(insert_frontmatter_true("just a body", key), None);
        assert_eq!(strip_frontmatter_true("just a body", key), None);

        // CRLF 文件保留换行风格。
        let crlf = "---\r\nname: x\r\n---\r\nbody";
        let ins = insert_frontmatter_true(crlf, key).unwrap();
        assert!(ins.starts_with("---\r\ndisable-model-invocation: true\r\n"));
    }
}
