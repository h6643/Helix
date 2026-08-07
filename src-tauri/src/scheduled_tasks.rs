//! Scheduled tasks (cron jobs.json) IPC.
//! Port of `electron/ipc/scheduled-tasks.js`.

use crate::paths::hermes_data_dir;
use chrono::{SecondsFormat, Utc};
use rand::Rng;
use serde_json::{json, Value};

fn cron_jobs_path() -> std::path::PathBuf {
    hermes_data_dir().join("cron").join("jobs.json")
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
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
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
                let run_at = schedule.get("run_at").and_then(|v| v.as_str()).unwrap_or("");
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
        schedule.get("expr").and_then(|v| v.as_str()).map(|s| s.to_string())
    } else {
        None
    };
    let created_at = parse_ts(job.get("created_at")).unwrap_or_else(|| now_ms());
    let updated_at = parse_ts(updated_at).unwrap_or_else(|| now_ms());
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
    let jobs = data.get("jobs").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let updated_at = data.get("updated_at");
    let tasks: Vec<Value> = jobs.iter().map(|j| task_from_job(j, updated_at)).collect();
    json!({ "ok": true, "tasks": tasks })
}

#[tauri::command]
pub fn create(params: Option<Value>) -> Value {
    let p = params.unwrap_or(json!({}));
    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let prompt = p.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cron_expression = p.get("cronExpression").and_then(|v| v.as_str()).map(|s| s.to_string());
    let next_run_at = p.get("nextRunAt").and_then(|v| v.as_i64());

    let mut data = load_jobs();
    let jobs = data.get_mut("jobs");
    let jobs = match jobs {
        Some(j) if j.is_array() => j.as_array_mut().unwrap(),
        _ => return json!({ "ok": false, "error": "jobs.json corrupted" }),
    };

    let id = gen_job_id();
    let (schedule, schedule_display, next_run_at_str): (Value, String, Option<String>) = if let Some(expr) = cron_expression {
        (json!({ "kind": "cron", "expr": expr, "display": expr }), expr.clone(), None)
    } else if let Some(ts) = next_run_at {
        let iso = format_iso(ts);
        let disp = format!("once at {}", iso.replace('T', " ").chars().take(16).collect::<String>());
        (json!({ "kind": "once", "run_at": iso, "display": disp }), disp, Some(iso))
    } else {
        let fallback = format_iso(now_ms() + 86_400_000);
        (json!({ "kind": "once", "run_at": fallback, "display": "once (fallback)" }), "unknown".to_string(), Some(fallback))
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
        "provider_snapshot": "ant-ling",
        "model_snapshot": "Ling-2.6-1T",
        "base_url": null,
        "script": null,
        "no_agent": false,
        "context_from": null,
        "schedule": schedule,
        "schedule_display": schedule_display,
        "repeat": json!({ "times": if next_run_at_str.is_some() { json!(1) } else { Value::Null }, "completed": 0 }),
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
    let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
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
    let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
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
