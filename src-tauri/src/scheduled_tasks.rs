//! Scheduled tasks (cron jobs.json) IPC.
//! Port of `electron/ipc/scheduled-tasks.js`.
//!
//! Paths mirror the pi-scheduled-tasks extension (pi-scheduled-tasks.ts):
//!   jobs:  ~/.pi/agent/pi-cron/cron/jobs.json
//!   events: ~/.pi/agent/pi-cron/events/<jobId>.json
//! so the Helix「计划」panel and the pi `schedule_*` tools read/write the
//! same files.

use chrono::{SecondsFormat, Utc};
use rand::Rng;
use serde_json::{json, Value};

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
    let enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut data = load_jobs();
    let jobs = data.get_mut("jobs");
    let jobs = match jobs {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return json!({ "ok": false, "error": "jobs.json corrupted" }),
    };
    let mut found = false;
    for job in jobs.iter_mut() {
        if job.get("id").and_then(|v| v.as_str()) == Some(id.as_str()) {
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

// ── Cron Commands (alias for scheduled_tasks) ────────────────

/// Alias for scheduled_tasks_list
#[tauri::command]
pub fn helix_cron_list() -> Value {
    scheduled_tasks_list()
}

/// Alias for scheduled_tasks create
#[tauri::command]
pub fn helix_cron_create(params: Option<Value>) -> Value {
    create(params)
}

/// Alias for scheduled_tasks remove
#[tauri::command]
pub fn helix_cron_delete(params: Option<Value>) -> Value {
    remove(params)
}

/// Execute a cron job by ID — triggers a one-shot dispatch of the stored prompt.
#[tauri::command]
pub fn helix_cron_run(params: Option<Value>) -> Value {
    let p = params.unwrap_or(json!({}));
    let id = p
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return json!({ "ok": false, "error": "missing id" });
    }
    // Look up the job's prompt and label, then dispatch via the same path the
    // event poller uses.
    let data = load_jobs();
    let empty: Vec<Value> = vec![];
    let jobs = data.get("jobs").and_then(|v| v.as_array()).unwrap_or(&empty);
    let found = jobs.iter().find(|j| j.get("id").and_then(Value::as_str) == Some(id.as_str()));
    match found {
        Some(job) => {
            let prompt = job.get("prompt").and_then(Value::as_str).unwrap_or("");
            let label = job.get("name").and_then(Value::as_str).unwrap_or("unnamed");
            dispatch_scheduled_task(&id, label, prompt, "manual");
            json!({ "ok": true, "message": format!("Job {id} triggered") })
        }
        None => json!({ "ok": false, "error": format!("job {id} not found") }),
    }
}

/// Start a background thread that polls the extension event dir every 5 s.
/// Call once at setup, after `pi_gateway::spawn` has finished.
pub fn start_scheduled_events_poller() {
    std::thread::Builder::new()
        .name("scheduled-events-poller".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            poll_scheduled_events();
        })
        .ok();
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
                dispatch_scheduled_task(&job_id, label, &prompt, trigger);
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

/// Fire-and-forget: spawn a dedicated pi session, send the task prompt, then
/// close the session so the process doesn't linger.
fn dispatch_scheduled_task(job_id: &str, label: &str, prompt: &str, trigger: &str) {
    eprintln!(
        "[scheduled-events] dispatching task_fired job={job_id} label={label} trigger={trigger}"
    );
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
        // session/new without cwd → falls back to home dir (neutral default).
        let new_res = crate::pi_gateway::send(
            "session/new",
            json!({ "cwd": "" }),
        )
        .await;
        let session_id = match new_res {
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
                eprintln!("[scheduled-events] task {job_id} ({label}) dispatched to session {session_id}");
            }
            Err(e) => {
                eprintln!("[scheduled-events] session/prompt failed for job {job_id}: {e}");
            }
        }
        // Best-effort cleanup: don't block the poller on this.
        let _ = crate::pi_gateway::send(
            "session/close",
            json!({ "session_id": session_id }),
        )
        .await;
    });
}

/// Update jobs.json for the fired job: set last_run_at=now, disable once-tasks,
/// advance cron-tasks next_run_at to now+60 s.
fn mark_job_fired_in_jobs(job_id: &str) {
    if job_id.is_empty() {
        return;
    }
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
        let kind = job
            .get("schedule")
            .and_then(|s| s.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind == "once" {
            job["enabled"] = json!(false);
            job["next_run_at"] = Value::Null;
        } else {
            let advanced = (Utc::now() + chrono::Duration::seconds(60))
                .to_rfc3339_opts(SecondsFormat::Millis, false);
            job["next_run_at"] = json!(advanced);
        }
        job["updated_at"] = json!(now_iso());
        break;
    }
    data["updated_at"] = json!(now_iso());
    if let Err(e) = atomic_write_jobs(&data) {
        eprintln!("[scheduled-events] failed to update jobs.json: {e}");
    }
}
