//! Scheduled tasks (cron jobs.json) IPC.
//! Port of `electron/ipc/scheduled-tasks.js`.
//!
//! Paths mirror the pi-scheduled-tasks extension (pi-scheduled-tasks.ts):
//!   jobs:  ~/.pi/agent/pi-cron/cron/jobs.json
//!   events: ~/.pi/agent/pi-cron/events/<jobId>.json
//! so the Helix「计划」panel and the pi `schedule_*` tools read/write the
//! same files.
//!
//! ── 两种定时任务（对齐 Codex 的 Scheduled Task / Scheduled Message）────
//! 每个 job 有 `helix_session_mode` 字段：
//!
//!   "fresh"（默认）= Codex Scheduled Task —— 每次运行 `session/new` 开一条
//!                     新对话。明天的汇总不需要记得今天的汇总，跑完即焚
//!                     （drop_session_instance），历史只留在 session 文件里。
//!   "reuse"        = Codex Scheduled Message —— 每次运行回到**同一条**对话。
//!                     适合轮询/盯状态类任务（「每 30 分钟检查这个 PR，处理
//!                     新评论」）：这次检查依赖上次检查的结论。
//!
//! 判据就一句：如果明天跑这次任务，它需要之前的对话吗？需要 → reuse。
//! `session_id` 持久化在 job 上，reuse 模式靠它走 `session/resume`；会话
//! 实例被 reaper 回收（IDLE_REAP_MS）也没关系，resume 会从 session 文件
//! 透明重spawn（见 pi_gateway.rs 顶部的 idle reaping 注释）。

use chrono::{Datelike, Local, SecondsFormat, TimeZone, Timelike, Utc};
use rand::Rng;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;

// ── Minimal cron engine ──────────────────────────────────────────────────────
// Supports the 5-field syntax the extension / frontend generate:
// minute hour dom month dow with `*`, `n`, `a-b`, lists, and `*/step`.

fn parse_cron_field(field: &str, min: u32, max: u32) -> Option<BTreeSet<u32>> {
    let mut out = BTreeSet::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (r, s.trim().parse::<u32>().ok().filter(|n| *n >= 1)?),
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (
                a.trim().parse::<u32>().ok()?,
                b.trim().parse::<u32>().ok()?,
            )
        } else {
            let v = range.trim().parse::<u32>().ok()?;
            if step > 1 { (v, max) } else { (v, v) }
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            out.insert(v);
            v += step;
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// First local-time occurrence strictly after `after_ms` for a 5-field cron
/// expression, scanning minute by minute (≤ 366 days). Returns None for
/// unparsable expressions so callers can disable the job instead of refiring
/// it every tick.
fn next_cron_occurrence(expr: &str, after_ms: i64) -> Option<i64> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return None;
    }
    let minutes = parse_cron_field(fields[0], 0, 59)?;
    let hours = parse_cron_field(fields[1], 0, 23)?;
    let doms = parse_cron_field(fields[2], 1, 31)?;
    let months = parse_cron_field(fields[3], 1, 12)?;
    let dows = parse_cron_field(fields[4], 0, 7)?;

    let start = Local.timestamp_millis_opt(after_ms).single()?;
    let mut cur = start.with_second(0)?;
    cur = cur.with_nanosecond(0)?;
    for _ in 0..(366 * 24 * 60) {
        cur += chrono::Duration::minutes(1);
        // cron dow: 0/7=Sun, 1=Mon … 6=Sat; chrono: Mon=0 … Sun=6
        let dow_cron = (cur.weekday().num_days_from_monday() + 1) % 7;
        if minutes.contains(&cur.minute())
            && hours.contains(&cur.hour())
            && months.contains(&cur.month())
            && doms.contains(&cur.day())
            && dows.contains(&dow_cron)
        {
            return Some(cur.timestamp_millis());
        }
    }
    None
}

fn pi_agent_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".pi").join("agent"))
        .unwrap_or_default()
}

/// Root dir of the pi-scheduled-tasks extension's event files.
/// Mirrors pi-scheduled-tasks.ts EVENTS_DIR (`~/.pi/agent/pi-cron/events`).
fn events_dir() -> std::path::PathBuf {
    pi_agent_dir().join("pi-cron").join("events")
}

/// Shared jobs registry written by the pi-scheduled-tasks extension
/// (`~/.pi/agent/pi-cron/cron/jobs.json`).
fn cron_jobs_path() -> std::path::PathBuf {
    pi_agent_dir().join("pi-cron").join("cron").join("jobs.json")
}

fn atomic_write_jobs(data: &Value) -> Result<(), String> {
    let p = cron_jobs_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn gen_job_id() -> String {
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand: u64 = rand::thread_rng().gen_range(0..0xffffff);
    format!("{time:x}{rand:06x}")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// jobs.json 的全局写锁。
///
/// 本文件里多个路径都会 read-modify-write 同一份 jobs.json：poller 线程的
/// poll_due_jobs（认领时前移 next_run_at）、mark_job_fired_in_jobs、
/// record_job_session，以及派发到独立线程的渠道签到桥。它们各自
/// load_jobs() → 改一个字段 → atomic_write_jobs()，没有锁时后写的快照会
/// 整份覆盖先写的修改 —— 最容易被静默吃掉的是 session_id（reuse 模式丢了
/// 它就退化成每次新建对话，而且没有任何报错）。写路径全部包进这个锁。
static JOBS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn load_jobs() -> Value {
    let p = cron_jobs_path();
    match std::fs::read_to_string(&p) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "jobs": [] })),
        Err(_) => json!({ "jobs": [] }),
    }
}

fn parse_ts(v: Option<&Value>) -> Option<i64> {
    let s = v?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn task_from_job(job: &Value, updated_at: Option<&Value>) -> Value {
    let empty = json!({});
    let schedule = job.get("schedule").unwrap_or(&empty);
    let kind = schedule.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let mut schedule_text = schedule
        .get("display")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if schedule_text.is_empty() {
        schedule_text = match kind {
            "once" => {
                let run_at = schedule
                    .get("run_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if run_at.is_empty() {
                    "unknown".to_string()
                } else {
                    format!("once at {run_at}")
                }
            }
            "cron" => {
                let expr = schedule.get("expr").and_then(|v| v.as_str()).unwrap_or("");
                if expr.is_empty() {
                    "unknown".to_string()
                } else {
                    format!("cron: {expr}")
                }
            }
            _ => "unknown".to_string(),
        };
    }
    let cron_expr = if kind == "cron" {
        schedule
            .get("expr")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    } else {
        None
    };
    let created_at = parse_ts(job.get("created_at")).unwrap_or_else(now_ms);
    let updated_at = parse_ts(updated_at).unwrap_or_else(now_ms);
    json!({
        "id": job.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "label": job.get("name").and_then(|v| v.as_str()).unwrap_or("未命名任务"),
        "prompt": job.get("prompt").and_then(|v| v.as_str()).unwrap_or(""),
        "scheduleText": schedule_text,
        "cronExpression": cron_expr,
        "action": job.get("helix_action").and_then(Value::as_str),
        "sessionMode": job
            .get(SESSION_MODE_KEY)
            .and_then(Value::as_str)
            .unwrap_or(SESSION_MODE_FRESH),
        "sessionId": job.get("last_session_id").and_then(Value::as_str),
        "runCount": job.get("run_count").and_then(Value::as_u64).unwrap_or(0),
        "enabled": job.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
        "lastRunAt": parse_ts(job.get("last_run_at")),
        "nextRunAt": parse_ts(job.get("next_run_at")),
        "createdAt": created_at,
        "updatedAt": updated_at,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn scheduled_tasks_list() -> Value {
    let data = load_jobs();
    let jobs = data
        .get("jobs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let updated_at = data.get("updated_at");
    let tasks: Vec<Value> = jobs.iter().map(|j| task_from_job(j, updated_at)).collect();
    json!({ "ok": true, "tasks": tasks })
}

#[tauri::command]
pub fn create(params: Option<Value>) -> Value {
    let p = params.unwrap_or(json!({}));
    let name = p
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prompt = p
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cron_expression = p
        .get("cronExpression")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let next_run_at = p.get("nextRunAt").and_then(|v| v.as_i64());
    // 会话模式：缺省 fresh（Codex Scheduled Task 语义）。认不出的值也当
    // fresh —— 未知配置不该让对话无限累积。
    let session_mode = match p.get("sessionMode").and_then(Value::as_str) {
        Some(SESSION_MODE_REUSE) => SESSION_MODE_REUSE,
        _ => SESSION_MODE_FRESH,
    };

    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load_jobs();
    let jobs = data.get_mut("jobs");
    let jobs = match jobs {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return json!({ "ok": false, "error": "jobs.json corrupted" }),
    };

    let id = gen_job_id();
    let (schedule, schedule_display, next_run_at_str): (Value, String, Option<String>) =
        if let Some(expr) = cron_expression {
            (
                json!({ "kind": "cron", "expr": expr, "display": expr }),
                expr.clone(),
                None,
            )
        } else if let Some(ts) = next_run_at {
            let iso = format_iso(ts);
            let disp = format!(
                "once at {}",
                iso.replace('T', " ").chars().take(16).collect::<String>()
            );
            (
                json!({ "kind": "once", "run_at": iso, "display": disp }),
                disp,
                Some(iso),
            )
        } else {
            let fallback = format_iso(now_ms() + 86_400_000);
            (
                json!({ "kind": "once", "run_at": fallback, "display": "once (fallback)" }),
                "unknown".to_string(),
                Some(fallback),
            )
        };
    let next_run_at_str_clone = next_run_at_str.clone();

    let job = json!({
        "id": id,
        "name": if name.is_empty() { "未命名任务" } else { &name },
        "prompt": prompt,
        "skills": [],
        "skill": null,
        "model": null,
        "provider": null,
        "provider_snapshot": "",
        "model_snapshot": "",
        "base_url": null,
        "script": null,
        "no_agent": false,
        "context_from": null,
        "schedule": schedule,
        "schedule_display": schedule_display,
        "repeat": json!({
            "times": if next_run_at_str.is_some() { json!(1) } else { Value::Null },
            "completed": 0,
        }),
        "enabled": true,
        "state": "scheduled",
        "paused_at": null,
        "paused_reason": null,
        SESSION_MODE_KEY: session_mode,
        "session_id": null,
        "last_session_id": null,
        "run_count": 0,
        "created_at": now_iso(),
        "next_run_at": next_run_at_str,
        "last_run_at": null,
        "last_status": null,
        "last_error": null,
        "last_delivery_error": null,
        "deliver": "local",
        "origin": null,
        "enabled_toolsets": null,
        "workdir": null,
    });
    jobs.push(job);
    data["updated_at"] = json!(now_iso());
    match atomic_write_jobs(&data) {
        Ok(_) => {
            let next = next_run_at_str_clone
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis());
            json!({ "ok": true, "id": id, "nextRunAt": next })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn update(params: Option<Value>) -> Value {
    let p = params.unwrap_or(json!({}));
    let id = p
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // enabled 三态：只有显式传了才写。旧实现缺省 false，任何不传 enabled 的
    // partial update 都会把任务意外暂停 —— 面板只传 enabled 时无差别，但
    // 一旦有人开始传别的字段就会踩坑。
    let enabled = p.get("enabled").and_then(|v| v.as_bool());
    // sessionMode 同理：只有显式传了才改，认不出的值当 fresh。
    let session_mode = match p.get("sessionMode").and_then(Value::as_str) {
        Some(SESSION_MODE_REUSE) => Some(SESSION_MODE_REUSE),
        Some(SESSION_MODE_FRESH) => Some(SESSION_MODE_FRESH),
        Some(_) => Some(SESSION_MODE_FRESH),
        None => None,
    };
    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load_jobs();
    let jobs = data.get_mut("jobs");
    let jobs = match jobs {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return json!({ "ok": false, "error": "jobs.json corrupted" }),
    };
    let mut found = false;
    for job in jobs.iter_mut() {
        if job.get("id").and_then(|v| v.as_str()) == Some(id.as_str()) {
            if let Some(mode) = session_mode {
                job[SESSION_MODE_KEY] = json!(mode);
                // 模式变了就解绑旧会话：reuse→fresh 后 resume 出来的 sid
                // 不再被使用，留着只会让 last_session_id 误导。
                if mode == SESSION_MODE_FRESH {
                    job["session_id"] = Value::Null;
                }
            }
            let Some(enabled) = enabled else {
                found = true;
                break;
            };
            job["enabled"] = json!(enabled);
            if enabled {
                job["paused_at"] = Value::Null;
                job["paused_reason"] = Value::Null;
                if job.get("state").and_then(|v| v.as_str()) == Some("paused") {
                    job["state"] = json!("scheduled");
                }
            } else {
                job["paused_at"] = json!(now_iso());
                job["paused_reason"] = json!("paused from Helix UI");
                job["state"] = json!("paused");
            }
            found = true;
            break;
        }
    }
    if !found {
        return json!({ "ok": false, "error": "job not found" });
    }
    data["updated_at"] = json!(now_iso());
    match atomic_write_jobs(&data) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn remove(params: Option<Value>) -> Value {
    let p = params.unwrap_or(json!({}));
    let id = p
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load_jobs();
    let jobs = data.get_mut("jobs");
    let jobs = match jobs {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return json!({ "ok": false, "error": "jobs.json corrupted" }),
    };
    let before = jobs.len();
    jobs.retain(|j| j.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    if jobs.len() == before {
        return json!({ "ok": false, "error": "job not found" });
    }
    data["updated_at"] = json!(now_iso());
    match atomic_write_jobs(&data) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

fn format_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap())
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

// (helix_cron_list/create/delete/run removed — they were thin aliases of
// scheduled_tasks_list/create/remove; the renderer talks to the
// `scheduledTasks` bridge surface only. helix_cron_run's manual one-shot
// dispatch has no UI either — the poller below is the single dispatcher.)

/// Helix 内置任务的动作标记（jobs.json 的 `helix_action` 字段）：带标记的
/// 任务分发时不发 agent prompt，由 dispatch_scheduled_task 按动作路由到
/// 专用通道（渠道签到 = pi_connect 一次性桥）。
const CHANNEL_CHECKIN_ACTION: &str = "channel_checkin";

/// 会话模式字段名（jobs.json）："fresh" | "reuse"，缺省 = "fresh"。
/// 与 Codex 的 Scheduled Task / Scheduled Message 一一对应。
const SESSION_MODE_KEY: &str = "helix_session_mode";
const SESSION_MODE_REUSE: &str = "reuse";
const SESSION_MODE_FRESH: &str = "fresh";

/// 从 jobs.json 快照里取某个 job 的会话模式 + 已绑定的 session_id（纯函数，
/// 便于单测；job_session_binding 是它的 IO 包装）。
fn session_binding_from(data: &Value, job_id: &str) -> (&'static str, Option<String>) {
    if job_id.is_empty() {
        return (SESSION_MODE_FRESH, None);
    }
    let Some(jobs) = data.get("jobs").and_then(Value::as_array) else {
        return (SESSION_MODE_FRESH, None);
    };
    let Some(job) = jobs
        .iter()
        .find(|j| j.get("id").and_then(Value::as_str) == Some(job_id))
    else {
        return (SESSION_MODE_FRESH, None);
    };
    let mode = match job.get(SESSION_MODE_KEY).and_then(Value::as_str) {
        Some(SESSION_MODE_REUSE) => SESSION_MODE_REUSE,
        _ => SESSION_MODE_FRESH,
    };
    let sid = job
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (mode, sid)
}

/// 读 job 的会话模式 + 已绑定的 session_id。
///
/// 返回 `(mode, session_id)`；`mode` 认不出的值一律回落 `fresh`（跑完即焚
/// 是安全的一侧 —— 未知配置不该让会话无限累积）。`session_id` 为 None 表示
/// 从没成功跑过（首次触发，或上次建会话失败）。
fn job_session_binding(job_id: &str) -> (&'static str, Option<String>) {
    if job_id.is_empty() {
        return (SESSION_MODE_FRESH, None);
    }
    session_binding_from(&load_jobs(), job_id)
}

/// 把本次运行的 session_id 与模式写回 job，让下一轮 reuse 能 resume。
///
/// 只更新这两个字段 + run_count，不碰 next_run_at —— 调度时钟由
/// `mark_job_fired_in_jobs` 单独负责（它同时会把 once 任务置为 disabled）。
fn record_job_session(job_id: &str, session_id: &str, mode: &str) {
    if job_id.is_empty() || session_id.is_empty() {
        return;
    }
    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load_jobs();
    let jobs = match data.get_mut("jobs") {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return,
    };
    let Some(job) = jobs
        .iter_mut()
        .find(|j| j.get("id").and_then(Value::as_str) == Some(job_id))
    else {
        return;
    };
    job[SESSION_MODE_KEY] = json!(mode);
    job["session_id"] = json!(session_id);
    job["last_session_id"] = json!(session_id);
    let runs = job.get("run_count").and_then(Value::as_u64).unwrap_or(0);
    job["run_count"] = json!(runs + 1);
    job["last_session_at"] = json!(now_iso());
    job["updated_at"] = json!(now_iso());
    data["updated_at"] = json!(now_iso());
    if let Err(e) = atomic_write_jobs(&data) {
        eprintln!("[scheduled-events] failed to record session for {job_id}: {e}");
    }
}

/// 迟到判定宽限：poller 是 5s tick，正常抖动不该被标成「补跑」。
const LATE_GRACE_MS: i64 = 15 * 60 * 1000;

/// 轮询间隔。
const POLL_TICK: Duration = Duration::from_secs(5);

/// 首轮扫描前的启动宽限。setup 之后 5s 就开扫会同时撞两件还没就绪的事
/// （2026-10-08 21:59 实测）：常驻网关仍在冷启动 → 普通任务的 `session/new`
/// 必失败；helix-layout 的 5s 渠道预热正占着 pi_connect 的串行锁 → 补跑签到
/// 被 try_lock 直接拒掉。两种都已经在认领时把 next_run_at 前移，于是当天彻底
/// 丢失。过期任务会一直是 due，晚 60s 认领不丢任何东西。
const STARTUP_GRACE: Duration = Duration::from_secs(60);

/// 「原定 11:00，实际 19:32 补跑」——只在真的错过窗口时产出。
///
/// `due_ms` 是认领前 jobs.json 里的 `next_run_at`；由扩展事件
/// （`task_fired`）进来的任务拿不到名义时间，传 None 就不标注。
fn late_note(due_ms: Option<i64>) -> Option<String> {
    let due = due_ms?;
    let now = now_ms();
    if now - due <= LATE_GRACE_MS {
        return None;
    }
    let hhmm = |ms: i64| {
        Local
            .timestamp_millis_opt(ms)
            .single()
            .map(|d| d.format("%H:%M").to_string())
            .unwrap_or_else(|| "?".to_string())
    };
    Some(format!("原定 {}，实际 {} 补跑", hhmm(due), hhmm(now)))
}

/// 一次性播种「每日 11:00 自动领取渠道签到」任务（2026-10-08 用户要求）。
///
/// 幂等 + 防复活：helix_data_dir() 下的标记文件一旦落盘就永不再播种 —— 用户
/// 手动删除该任务后，下次启动不能原地复活它。jobs.json 里已存在同动作的
/// 任务（如换机同步）时只补标记，不重复创建；jobs.json 存在但解析失败时
/// 跳过（绝不在损坏文件上覆写）。
pub fn seed_channel_checkin_job() {
    let marker = crate::paths::helix_data_dir().join("channel-checkin-seeded");
    if marker.exists() {
        return;
    }
    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = cron_jobs_path();
    let mut data = match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(v) => v,
            Err(_) => {
                eprintln!("[scheduled-events] seed skipped: jobs.json unparsable");
                return;
            }
        },
        Err(_) => json!({ "jobs": [] }),
    };
    let jobs = match data.get_mut("jobs") {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => {
            eprintln!("[scheduled-events] seed skipped: jobs.json has no jobs array");
            return;
        }
    };
    let existing = jobs.iter().any(|j| {
        j.get("helix_action").and_then(Value::as_str) == Some(CHANNEL_CHECKIN_ACTION)
    });
    if !existing {
        let expr = "0 11 * * *";
        let next = next_cron_occurrence(expr, now_ms());
        let id = gen_job_id();
        jobs.push(json!({
            "id": id,
            "name": "渠道中心签到",
            "prompt": "/connect checkin",
            "schedule": { "kind": "cron", "expr": expr, "display": "every day at 11:00" },
            "schedule_display": "every day at 11:00",
            "enabled": true,
            "state": "scheduled",
            "created_at": now_iso(),
            "next_run_at": next.map(format_iso),
            "last_run_at": null,
            "helix_action": CHANNEL_CHECKIN_ACTION,
        }));
        data["updated_at"] = json!(now_iso());
        if let Err(e) = atomic_write_jobs(&data) {
            eprintln!("[scheduled-events] failed to seed channel checkin job: {e}");
            return; // 不落标记 → 下次启动重试
        }
        eprintln!("[scheduled-events] seeded 渠道中心签到 job {id} (daily 11:00)");
    }
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&marker, now_iso()) {
        eprintln!("[scheduled-events] failed to write seed marker: {e}");
    }
}

/// Start a background thread that polls for due jobs in jobs.json and consumes
/// the extension's event files every 5 s. This thread is the SINGLE dispatcher
/// for scheduled tasks — the frontend runner only refreshes UI state and the
/// extension's old auto-fire tick was removed — so nothing double-fires.
/// The first scan waits out `STARTUP_GRACE`. Call once at setup.
pub fn start_scheduled_events_poller() {
    std::thread::Builder::new()
        .name("scheduled-events-poller".into())
        .spawn(move || {
            std::thread::sleep(STARTUP_GRACE);
            loop {
                poll_due_jobs();
                poll_scheduled_events();
                std::thread::sleep(POLL_TICK);
            }
        })
        .ok();
}

/// Scan jobs.json for enabled jobs whose next_run_at has passed, claim them by
/// advancing next_run_at BEFORE dispatching (so a concurrent tick can never
/// refire), then dispatch to a dedicated pi session. Cron jobs advance to the
/// real next occurrence of their expression; once-jobs are disabled. Cron jobs
/// with a missing next_run_at are seeded with their next occurrence instead of
/// being skipped forever.
fn poll_due_jobs() {
    let now = now_ms();
    // 认领 + 写盘全程持锁，写完立刻释放 —— 下面的 dispatch 会自己再拿一次锁
    // （record_job_session / mark_job_fired_in_jobs），不能在同一次持锁下调
    // 度，否则 std::sync::Mutex 非重入会自锁死。
    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load_jobs();
    let jobs = match data.get_mut("jobs") {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return,
    };
    let mut due: Vec<(String, String, String, Option<i64>)> = Vec::new();
    let mut changed = false;
    for job in jobs.iter_mut() {
        if !job.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let schedule = job.get("schedule").cloned().unwrap_or_else(|| json!({}));
        let kind = schedule
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let expr = schedule
            .get("expr")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let id = job
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match parse_ts(job.get("next_run_at")) {
            Some(t) if t <= now => {
                let next = if kind == "cron" {
                    expr.as_deref().and_then(|e| next_cron_occurrence(e, now))
                } else {
                    None
                };
                match next {
                    Some(ms) => job["next_run_at"] = json!(format_iso(ms)),
                    None => {
                        // once-task, or unparsable cron expr — disable so it
                        // can't refire every tick.
                        job["enabled"] = json!(false);
                        job["next_run_at"] = Value::Null;
                    }
                }
                job["last_run_at"] = json!(now_iso());
                job["updated_at"] = json!(now_iso());
                changed = true;
                let label = job
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unnamed")
                    .to_string();
                let prompt = job
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !id.is_empty() && !prompt.is_empty() {
                    due.push((id, label, prompt, Some(t)));
                }
            }
            None if kind == "cron" => {
                // next_run_at absent (e.g. UI-created cron job) — seed it.
                if let Some(ms) = expr.as_deref().and_then(|e| next_cron_occurrence(e, now)) {
                    job["next_run_at"] = json!(format_iso(ms));
                    job["updated_at"] = json!(now_iso());
                    changed = true;
                }
            }
            _ => {}
        }
    }
    if changed {
        data["updated_at"] = json!(now_iso());
        if let Err(e) = atomic_write_jobs(&data) {
            eprintln!("[scheduled-events] failed to advance due jobs: {e}");
        }
    }
    drop(_guard);
    for (id, label, prompt, due_ms) in due {
        dispatch_scheduled_task(&id, &label, &prompt, "auto", due_ms);
    }
}
///
/// Reads every unconsumed `.json` file, dispatches `task_fired` events to a
/// dedicated pi session, and renames consumed files to `.done` so they are
/// never processed twice.
pub fn poll_scheduled_events() {
    let dir = events_dir();
    if !dir.exists() {
        return;
    }
    let files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();

    for file in files {
        let raw = match std::fs::read_to_string(&file) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let event: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                let _ = std::fs::remove_file(&file);
                continue;
            }
        };
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        let job_id = event.get("jobId").and_then(Value::as_str).unwrap_or("").to_string();
        let label = event.get("label").and_then(Value::as_str).unwrap_or("");

        match event_type {
            "task_fired" => {
                let prompt = event.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
                let trigger = event.get("trigger").and_then(Value::as_str).unwrap_or("auto");
                // 扩展事件里没有名义时间，迟到标注只能留给 poller 认领的那批。
                dispatch_scheduled_task(&job_id, label, &prompt, trigger, None);
            }
            "task_created" | "task_deleted" | "task_toggled" => {
                // Informational only — the frontend picks up the change on its
                // next 30 s refreshFromBackend() call.
                eprintln!("[scheduled-events] {} job={job_id} label={label}", event_type);
            }
            _ => {}
        }
        // Mark consumed before the next file so a crash doesn't re-dispatch.
        let done = file.with_extension("json.done");
        let _ = std::fs::rename(&file, &done);
    }
}

/// 派发一次定时任务。会话策略分两种（对齐 Codex）：
///
///   fresh（默认）—— 每次 `session/new` 开新对话，跑完 drop_session_instance
///                     立即回收。明天的汇总不需要记得今天的汇总。
///   reuse        —— resume job 上绑定的 session_id（没有就新建并记下），
///                     跑完**不**回收，等下一次 resume 接着聊。适合轮询类
///                     任务：这次检查依赖上次检查的结论。
///
/// 两种模式都 fire-and-forget：turn 结束后 mark_job_fired（调度时钟），
/// reuse 模式额外 record_job_session（把 sid 落盘）。
fn dispatch_scheduled_task(
    job_id: &str,
    label: &str,
    prompt: &str,
    trigger: &str,
    due_ms: Option<i64>,
) {
    eprintln!(
        "[scheduled-events] dispatching task_fired job={job_id} label={label} trigger={trigger}"
    );
    // 渠道签到类任务走一次性 pi_connect 桥：`/connect checkin` 的扩展 confirm
    // 会被网关转成审批弹窗，无人值守下永远等不到回应（见 pi_gateway 的
    // extension_ui_request 分支）；桥自动放行 confirm 且进程用完即杀。
    if job_helix_action(job_id).as_deref() == Some(CHANNEL_CHECKIN_ACTION) {
        dispatch_channel_checkin(job_id, label, due_ms);
        return;
    }
    let prompt = prompt.to_string();
    let label = label.to_string();
    let job_id = job_id.to_string();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
    let rt = match rt {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[scheduled-events] failed to build runtime: {e}");
            return;
        }
    };
    rt.block_on(async {
        // 会话策略：reuse 优先 resume 绑定的 sid（实例被 reaper 回收了也没
        // 关系，resume 会从 session 文件透明重 spawn）；fresh 永远新建。
        let (mode, bound_sid) = job_session_binding(&job_id);
        let reuse = mode == SESSION_MODE_REUSE;
        let mut session_id = String::new();
        if reuse {
            if let Some(sid) = bound_sid.as_deref() {
                let resumed = crate::pi_gateway::send(
                    "session/resume",
                    json!({ "session_id": sid }),
                )
                .await;
                match resumed {
                    Ok(v) if v.get("error").is_none() => {
                        if let Some(s) = v
                            .get("session_id")
                            .or_else(|| v.get("sessionID"))
                            .and_then(Value::as_str)
                        {
                            session_id = s.to_string();
                        }
                        eprintln!(
                            "[scheduled-events] task {job_id} ({label}) resumed session {session_id}"
                        );
                    }
                    Ok(v) => {
                        let kind = v
                            .get("error_kind")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        eprintln!(
                            "[scheduled-events] resume failed for {job_id} sid={sid} kind={kind}; falling back to session/new"
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "[scheduled-events] resume errored for {job_id} sid={sid}: {e}; falling back to session/new"
                        );
                    }
                }
            }
        }
        if session_id.is_empty() {
            // session/new without cwd → falls back to home dir (neutral default).
            let new_res = crate::pi_gateway::send(
                "session/new",
                json!({ "cwd": "" }),
            )
            .await;
            session_id = match new_res {
                Ok(v) => {
                    let sid = v
                        .get("session_id")
                        .or_else(|| v.get("sessionID"))
                        .or_else(|| v.get("_meta").and_then(|m| m.get("helix")).and_then(|h| h.get("sessionProvenance")).and_then(|s| s.get("acpSessionId")))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_default();
                    if sid.is_empty() {
                        eprintln!("[scheduled-events] session/new returned no session_id: {v}");
                        return;
                    }
                    sid
                }
                Err(e) => {
                    eprintln!("[scheduled-events] session/new failed: {e}");
                    return;
                }
            };
        }
        // 任务已开始跑 —— 用户切走时这是唯一信号（跑完不另行通知；
        // 卡在审批上时网关的审批 toast 会接力）。
        let toast_body: &str = if label.is_empty() { "未命名任务" } else { &label };
        crate::desktop_notify::notify(
            crate::desktop_notify::Scene::TurnEnd,
            "定时任务已触发",
            toast_body,
        );
        let prompt_res = crate::pi_gateway::send(
            "session/prompt",
            json!({
                "session_id": session_id,
                "prompt": [{ "type": "text", "text": prompt }],
            }),
        )
        .await;
        match prompt_res {
            Ok(_) => {
                mark_job_fired_in_jobs(&job_id);
                // reuse 模式把 sid 落盘，下一轮 resume 同一条对话；fresh
                // 模式也记一笔（last_session_id 供 UI 展示 + run_count 统计），
                // 但不会因为有 sid 就改成复用 —— 模式只看 helix_session_mode。
                record_job_session(&job_id, &session_id, mode);
                eprintln!("[scheduled-events] task {job_id} ({label}) dispatched to session {session_id} mode={mode}");
            }
            Err(e) => {
                eprintln!("[scheduled-events] session/prompt failed for job {job_id}: {e}");
            }
        }
        // fresh 模式跑完即焚：定时任务是一次性的，对话不该在内存里挂到
        // IDLE_REAP_MS 才回收。reuse 模式**必须留着** —— 下一轮要 resume
        // 这条对话；即使实例被 reaper 回收，session/resume 也会从 session
        // 文件透明重 spawn（见 pi_gateway.rs 顶部注释），所以不持有实例也安全。
        if !reuse {
            // The pi `send` surface has no `session/close` method (that path
            // used to error on every dispatch), so we drop the in-memory
            // instance directly instead.
            crate::pi_gateway::drop_session_instance(&session_id);
        }
    });
}

/// 读 jobs.json 里该 job 的 `helix_action`（事件文件路径也经此取动作）。
fn job_helix_action(job_id: &str) -> Option<String> {
    if job_id.is_empty() {
        return None;
    }
    let data = load_jobs();
    data.get("jobs")?
        .as_array()?
        .iter()
        .find(|j| j.get("id").and_then(Value::as_str) == Some(job_id))
        .and_then(|j| j.get("helix_action").and_then(Value::as_str))
        .map(str::to_string)
}

/// 渠道签到任务的分发：在独立线程里跑 pi_connect 桥（阻塞 ~15-150s），不占
/// poller 的 5s tick；桥自带全局串行锁（与面板手动签到互斥）。结算走系统
/// 通知（聚焦时静默），成功才 mark_job_fired —— next_run_at 在认领时已前移，
/// 失败不会重试风暴，次日 11:00 再试。
///
/// 错过窗口的补跑（应用没开 → poller 首轮扫描即认领）会在通知正文首行标注
/// 「原定 HH:MM，实际 HH:MM 补跑」，免得迟到的一次看起来像空转。
fn dispatch_channel_checkin(job_id: &str, label: &str, due_ms: Option<i64>) {
    let job_id = job_id.to_string();
    let label = if label.is_empty() {
        "渠道中心签到".to_string()
    } else {
        label.to_string()
    };
    let note = late_note(due_ms);
    let prefix = note
        .as_deref()
        .map(|n| format!("{n}\n"))
        .unwrap_or_default();
    let log_note = note
        .as_deref()
        .map(|n| format!(" — {n}"))
        .unwrap_or_default();
    std::thread::Builder::new()
        .name("channel-checkin-dispatch".into())
        .spawn(move || {
            eprintln!(
                "[scheduled-events] channel checkin job {job_id} ({label}) started{log_note}"
            );
            match crate::pi_connect::run_checkin_blocking() {
                Ok(v) => {
                    let body = format!("{prefix}{}", checkin_summary(&v));
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::TurnEnd,
                        "渠道中心签到",
                        &body,
                    );
                    mark_job_fired_in_jobs(&job_id);
                    eprintln!("[scheduled-events] channel checkin job {job_id} done: {body}");
                }
                Err(e) => {
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::TurnEnd,
                        "渠道签到失败",
                        &format!("{prefix}{e}"),
                    );
                    eprintln!("[scheduled-events] channel checkin job {job_id} failed: {e}");
                }
            }
        })
        .ok();
}

/// 从桥返回的 results 取第一段（checkin）的 notify 文案，拼成通知正文。
fn checkin_summary(v: &Value) -> String {
    let msgs: Vec<String> = v
        .get("results")
        .and_then(Value::as_array)
        .and_then(|r| r.first())
        .and_then(|r| r.get("messages"))
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter_map(|m| m.get("message").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if msgs.is_empty() {
        "签到完成".to_string()
    } else {
        msgs.join("\n")
    }
}

/// Update jobs.json for the fired job: set last_run_at=now, disable once-tasks,
/// advance cron-tasks next_run_at to the real next occurrence of their
/// expression (previously this was a flat now+60 s, which made hourly jobs
/// fire every minute).
fn mark_job_fired_in_jobs(job_id: &str) {
    if job_id.is_empty() {
        return;
    }
    let _guard = JOBS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load_jobs();
    let jobs = match data.get_mut("jobs") {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return,
    };
    for job in jobs.iter_mut() {
        if job.get("id").and_then(Value::as_str) != Some(job_id) {
            continue;
        }
        job["last_run_at"] = json!(now_iso());
        let schedule = job.get("schedule").cloned().unwrap_or_else(|| json!({}));
        let kind = schedule.get("kind").and_then(Value::as_str).unwrap_or("");
        let expr = schedule.get("expr").and_then(Value::as_str);
        if kind == "cron" {
            match expr.and_then(|e| next_cron_occurrence(e, now_ms())) {
                Some(ms) => job["next_run_at"] = json!(format_iso(ms)),
                None => {
                    job["enabled"] = json!(false);
                    job["next_run_at"] = Value::Null;
                }
            }
        } else {
            job["enabled"] = json!(false);
            job["next_run_at"] = Value::Null;
        }
        job["updated_at"] = json!(now_iso());
        break;
    }
    data["updated_at"] = json!(now_iso());
    if let Err(e) = atomic_write_jobs(&data) {
        eprintln!("[scheduled-events] failed to update jobs.json: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_note_marks_only_missed_windows() {
        // 名义时间两小时前 = 错过窗口，必须标注；时间戳走本机时区，只断言形态。
        let note = late_note(Some(now_ms() - 2 * 3_600_000)).expect("two hours late");
        assert!(note.starts_with("原定 "));
        assert!(note.ends_with(" 补跑"));
        // poller 的 5s tick 抖动与「没有名义时间」（扩展事件进来的任务）都不标注。
        assert!(late_note(Some(now_ms() - 60_000)).is_none());
        assert!(late_note(None).is_none());
    }

    #[test]
    fn session_binding_defaults_to_fresh() {
        // 无 mode 字段的老 job（以及不存在的 id）必须落到 fresh：复用是对话
        // 累积的未知风险，跑完即焚才是安全的一侧。
        let data = json!({ "jobs": [{ "id": "a", "name": "老任务" }] });
        assert_eq!(session_binding_from(&data, "a"), (SESSION_MODE_FRESH, None));
        assert_eq!(session_binding_from(&data, "nope"), (SESSION_MODE_FRESH, None));
        assert_eq!(session_binding_from(&data, ""), (SESSION_MODE_FRESH, None));
        // jobs 数组缺失/类型错也不能 panic。
        assert_eq!(
            session_binding_from(&json!({}), "a"),
            (SESSION_MODE_FRESH, None)
        );
        assert_eq!(
            session_binding_from(&json!({ "jobs": {} }), "a"),
            (SESSION_MODE_FRESH, None)
        );
    }

    #[test]
    fn session_binding_honors_reuse_mode() {
        let data = json!({ "jobs": [{
            "id": "a",
            SESSION_MODE_KEY: "reuse",
            "session_id": "sid-1",
        }] });
        assert_eq!(
            session_binding_from(&data, "a"),
            (SESSION_MODE_REUSE, Some("sid-1".to_string()))
        );
        // 认不出的 mode 值回落 fresh，但已绑定的 sid 照样返回（调用方按
        // fresh 用，不会去 resume 它）。
        let weird = json!({ "jobs": [{
            "id": "a",
            SESSION_MODE_KEY: "bogus",
            "session_id": "sid-1",
        }] });
        assert_eq!(
            session_binding_from(&weird, "a"),
            (SESSION_MODE_FRESH, Some("sid-1".to_string()))
        );
        // 空串 sid 等同没有。
        let empty = json!({ "jobs": [{
            "id": "a",
            SESSION_MODE_KEY: "reuse",
            "session_id": "",
        }] });
        assert_eq!(
            session_binding_from(&empty, "a"),
            (SESSION_MODE_REUSE, None)
        );
    }
}
