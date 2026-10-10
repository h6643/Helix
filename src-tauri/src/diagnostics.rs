//! `diagnostics:*` — run the project's own type-check/lint and turn its output
//! into structured problems, so "改完了" can be judged by a real compiler
//! instead of the model's opinion of it.
//!
//! Deliberately not an LSP client: no long-lived language servers, no editor
//! squiggles. Each check is the same command a developer would run in a
//! terminal, launched with an argument array (no shell) under a bounded
//! timeout, then parsed. JS tools resolve the way `pi_gateway` resolves `pi` —
//! the project's own `node_modules` entry point run under `node` — so nothing
//! depends on npm's `.cmd` shims.

use crate::exec;
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

const MAX_PROBLEMS: usize = 200;
/// 工具原始输出的尾巴长度：解析失败时前端要靠它自救，但不能整段塞进对话。
const RAW_TAIL_CHARS: usize = 3000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    id: String,
    label: String,
    program: String,
    args: Vec<String>,
    timeout_secs: u64,
    /// 怎么被识别出来的，供面板解释「为什么是这个命令」。
    source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Problem {
    /// 相对项目根的路径，用 '/' 分隔（fs 桥与编辑器 tab 都用这个形状）。
    file: String,
    abs_path: String,
    line: u32,
    column: u32,
    severity: String,
    message: String,
    code: Option<String>,
}

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

fn exists(cwd: &Path, name: &str) -> bool {
    cwd.join(name).is_file()
}

/// The checks this project can actually run. Nothing is invented: a check
/// appears only when both the project marker and the tool itself are present.
pub(crate) fn detect_checks(cwd: &Path) -> Vec<Check> {
    let mut out: Vec<Check> = Vec::new();

    if exists(cwd, "tsconfig.json") {
        let tsc_js = cwd
            .join("node_modules")
            .join("typescript")
            .join("bin")
            .join("tsc");
        if tsc_js.is_file() {
            out.push(Check {
                id: "tsc".into(),
                label: "tsc --noEmit".into(),
                program: exec::node_binary(),
                args: vec![
                    tsc_js.to_string_lossy().into_owned(),
                    "--noEmit".into(),
                    "--pretty".into(),
                    "false".into(),
                ],
                timeout_secs: 180,
                source: "tsconfig.json + node_modules/typescript".into(),
            });
        }
    }

    let eslint_config = [
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.ts",
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintrc.json",
        ".eslintrc.yaml",
        ".eslintrc.yml",
    ]
    .iter()
    .any(|f| exists(cwd, f));
    let eslint_js = cwd
        .join("node_modules")
        .join("eslint")
        .join("bin")
        .join("eslint.js");
    if eslint_config && eslint_js.is_file() {
        out.push(Check {
            id: "eslint".into(),
            label: "eslint . --format json".into(),
            program: exec::node_binary(),
            args: vec![
                eslint_js.to_string_lossy().into_owned(),
                "--format".into(),
                "json".into(),
                ".".into(),
            ],
            timeout_secs: 180,
            source: "eslint 配置 + node_modules/eslint".into(),
        });
    }

    if exists(cwd, "Cargo.toml") && exec::locate("cargo").is_some() {
        out.push(Check {
            id: "cargo-check".into(),
            label: "cargo check".into(),
            program: "cargo".into(),
            args: vec!["check".into(), "--message-format=json".into()],
            timeout_secs: 300,
            source: "Cargo.toml + PATH 上的 cargo".into(),
        });
    }

    if exists(cwd, "go.mod") && exec::locate("go").is_some() {
        out.push(Check {
            id: "go-vet".into(),
            label: "go vet ./...".into(),
            program: "go".into(),
            args: vec!["vet".into(), "./...".into()],
            timeout_secs: 180,
            source: "go.mod + PATH 上的 go".into(),
        });
    }

    let python_marker = exists(cwd, "mypy.ini")
        || exists(cwd, ".mypy.ini")
        || exists(cwd, "pyproject.toml")
        || exists(cwd, "setup.cfg");
    if python_marker && exec::locate("mypy").is_some() {
        out.push(Check {
            id: "mypy".into(),
            label: "mypy .".into(),
            program: "mypy".into(),
            args: vec![
                ".".into(),
                "--no-error-summary".into(),
                "--show-error-codes".into(),
            ],
            timeout_secs: 180,
            source: "Python 工程标记 + PATH 上的 mypy".into(),
        });
    }

    out
}

/// (相对路径, 绝对路径)，两者都用 '/' 分隔。
fn split_path(cwd: &Path, raw: &str) -> (String, String) {
    let trimmed = raw.trim().trim_matches('"');
    let candidate = Path::new(trimmed);
    let abs = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        cwd.join(trimmed)
    };
    let rel = abs
        .strip_prefix(cwd)
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace('\\', "/");
    (rel, abs.to_string_lossy().replace('\\', "/"))
}

fn take_digits(s: &str) -> Option<(String, &str)> {
    // 数字都是单字节，按字节切安全。
    let n = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if n == 0 {
        return None;
    }
    Some((s[..n].to_string(), &s[n..]))
}

/// `src/a.ts(12,5): error TS2345: message` — tsc 的非 pretty 形状。
fn parse_paren_line(line: &str) -> Option<(&str, u32, u32, &str)> {
    let open = line.rfind('(')?;
    let close = open + line[open..].find(')')?;
    let mut parts = line[open + 1..close].split(',');
    let line_no = parts.next()?.trim().parse::<u32>().ok()?;
    let col = parts.next()?.trim().parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None; // tsc 只写 (line,col)，三段以上不是这个形状
    }
    let rest = line.get(close + 1..)?;
    let rest = rest.strip_prefix(": ").or_else(|| rest.strip_prefix(':'))?;
    let file = line.get(..open)?;
    if file.trim().is_empty() {
        return None;
    }
    Some((file, line_no, col, rest.trim()))
}

/// `path:line:col: msg`（go vet、eslint-compact）与 `path:line: msg`（mypy）。
/// 路径结尾认「第一个后面紧跟数字的冒号」，因此 Windows 盘符 `C:\` 不会被误切。
fn parse_colon_line(line: &str) -> Option<(String, u32, u32, String)> {
    // 路径结尾 = 第一个「后面紧跟数字」的冒号。Windows 盘符 `C:\` 后面不是数字，
    // 消息里的 `12:30` 之类前面已经有真路径冒号被先撞上，不会错位。
    let mut at: Option<usize> = None;
    for (idx, c) in line.char_indices() {
        if c == ':' && line[idx + 1..].starts_with(|ch: char| ch.is_ascii_digit()) {
            at = Some(idx);
            break;
        }
    }
    let at = at?;
    let file = &line[..at];
    let mut rest = &line[at + 1..];
    let (digits, tail) = take_digits(rest)?;
    let line_no = digits.parse::<u32>().ok()?;
    rest = tail;
    let mut column = 0u32;
    if let Some(tail_after_colon) = rest.strip_prefix(':') {
        if let Some((cd, t2)) = take_digits(tail_after_colon) {
            if let Some(stripped) = t2.strip_prefix(':') {
                column = cd.parse().ok()?;
                rest = stripped;
            }
        }
    }
    let message = rest.trim_start_matches([' ', ':']).to_string();
    if file.trim().is_empty() || message.is_empty() {
        return None;
    }
    Some((file.to_string(), line_no, column, message))
}

/// 从 `TS2345: msg` 或 `msg [arg-type]` 里剥出规则码。
fn extract_code(body: &str) -> (Option<String>, String) {
    if let Some((maybe, tail)) = body.split_once(": ") {
        let short = maybe.len() <= 14
            && maybe
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            && maybe.chars().any(|c| c.is_ascii_digit());
        if short {
            return (Some(maybe.to_string()), tail.to_string());
        }
    }
    if body.ends_with(']') {
        if let Some(open) = body.rfind(" [") {
            let candidate = &body[open + 2..body.len() - 1];
            if !candidate.is_empty()
                && candidate
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
            {
                return (Some(candidate.to_string()), body[..open].to_string());
            }
        }
    }
    (None, body.to_string())
}

fn split_severity(rest: &str) -> (String, Option<String>, String) {
    let rest = rest.trim();
    let lower = rest.to_lowercase();
    let mut severity = "error".to_string();
    let mut body = rest.to_string();
    for (kw, sev) in [
        ("error", "error"),
        ("warning", "warning"),
        ("warn", "warning"),
        ("info", "info"),
        ("note", "info"),
        ("help", "info"),
    ] {
        if lower.starts_with(kw) {
            let after = &rest[kw.len()..];
            if after.starts_with(':') || after.starts_with(' ') || after.is_empty() {
                severity = sev.to_string();
                body = after.trim_start_matches([':', ' ']).to_string();
                break;
            }
        }
    }
    let (code, message) = extract_code(&body);
    (severity, code, message.trim().to_string())
}

fn parse_text_output(cwd: &Path, text: &str) -> Vec<Problem> {
    let mut problems: Vec<Problem> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let candidate = if let Some((file, ln, col, rest)) = parse_paren_line(line) {
            let (rel, abs) = split_path(cwd, file);
            let (severity, code, message) = split_severity(rest);
            Some((rel, abs, ln, col, severity, code, message))
        } else if let Some((file, ln, col, rest)) = parse_colon_line(line) {
            let (rel, abs) = split_path(cwd, &file);
            let (severity, code, message) = split_severity(&rest);
            Some((rel, abs, ln, col, severity, code, message))
        } else {
            None
        };
        let Some((file, abs_path, line_no, column, severity, code, message)) = candidate else {
            continue;
        };
        // 没有路径感的行（"Found 3 errors in 2 files."）不是定位得到的诊断。
        if message.is_empty() || !(file.contains('/') || file.contains('.')) {
            continue;
        }
        problems.push(Problem {
            file,
            abs_path,
            line: line_no,
            column,
            severity,
            message,
            code,
        });
        if problems.len() >= MAX_PROBLEMS {
            break;
        }
    }
    problems
}

/// `eslint --format json` → `[{filePath, messages:[{ruleId,severity,line,column,message}]}]`
fn parse_eslint_json(cwd: &Path, text: &str) -> Option<Vec<Problem>> {
    let start = text.find("[{")?;
    let value: Value = serde_json::from_str(text[start..].trim()).ok()?;
    let mut problems = Vec::new();
    for file_entry in value.as_array()? {
        let (file, abs) = split_path(cwd, file_entry["filePath"].as_str().unwrap_or_default());
        for m in file_entry["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .take(MAX_PROBLEMS)
        {
            problems.push(Problem {
                file: file.clone(),
                abs_path: abs.clone(),
                line: m["line"].as_u64().unwrap_or(0) as u32,
                column: m["column"].as_u64().unwrap_or(0) as u32,
                severity: if m["severity"].as_i64().unwrap_or(2) == 1 {
                    "warning".into()
                } else {
                    "error".into()
                },
                message: m["message"].as_str().unwrap_or_default().to_string(),
                code: m["ruleId"].as_str().map(|s| s.to_string()),
            });
        }
        if problems.len() >= MAX_PROBLEMS {
            break;
        }
    }
    Some(problems)
}

/// `cargo check --message-format=json` → NDJSON，只取 `reason == "compiler-message"`。
fn parse_cargo_json(cwd: &Path, text: &str) -> Option<Vec<Problem>> {
    let mut problems = Vec::new();
    let mut saw_one = false;
    for raw in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(raw.trim()) else {
            continue;
        };
        if value["reason"].as_str() != Some("compiler-message") {
            continue;
        }
        saw_one = true;
        let msg = &value["message"];
        let span = msg["spans"]
            .as_array()
            .and_then(|v| {
                v.iter()
                    .find(|s| s["is_primary"].as_bool().unwrap_or(false))
                    .or_else(|| v.first())
                    .cloned()
            })
            .unwrap_or(Value::Null);
        let raw_file = span["file_name"].as_str().unwrap_or_default();
        if raw_file.is_empty() {
            continue;
        }
        let (file, abs) = split_path(cwd, raw_file);
        problems.push(Problem {
            file,
            abs_path: abs,
            line: span["line_start"]["line_number"]
                .as_u64()
                .unwrap_or(0) as u32,
            column: span["column_start"]["column_number"]
                .as_u64()
                .unwrap_or(0) as u32,
            severity: match msg["level"].as_str().unwrap_or("error") {
                "warning" => "warning",
                "note" | "help" => "info",
                _ => "error",
            }
            .to_string(),
            message: msg["message"].as_str().unwrap_or_default().trim().to_string(),
            code: msg["code"]["code"].as_str().map(|s| s.to_string()),
        });
        if problems.len() >= MAX_PROBLEMS {
            break;
        }
    }
    if saw_one {
        Some(problems)
    } else {
        None
    }
}

fn tail(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= RAW_TAIL_CHARS {
        return text.to_string();
    }
    let n = chars.len() - RAW_TAIL_CHARS;
    format!(
        "…(截断前 {} 字符)…{}",
        n,
        chars[n..].iter().collect::<String>()
    )
}

#[tauri::command]
pub fn diagnostics_detect(
    state: State<'_, Arc<AppState>>,
    target_cwd: Option<String>,
) -> Value {
    let cwd = work_cwd(&state, target_cwd.as_deref());
    let checks = detect_checks(&cwd);
    json!({
        "ok": true,
        "cwd": cwd.to_string_lossy(),
        "checks": checks,
        "note": if checks.is_empty() {
            "没找到可运行的类型检查/lint 工具（支持 TypeScript、ESLint、cargo、go vet、mypy）"
        } else { "" }
    })
}

/// 跑一项检查并返回结构化问题。`opts.checkId` 缺省时取 detect 的第一项。
#[tauri::command]
pub fn diagnostics_run(state: State<'_, Arc<AppState>>, opts: Option<Value>) -> Value {
    let opts = opts.unwrap_or_default();
    let cwd = work_cwd(&state, opts.get("cwd").and_then(Value::as_str));
    let checks = detect_checks(&cwd);
    if checks.is_empty() {
        return json!({
            "ok": false,
            "code": "no_check_available",
            "error": "当前项目没有可用的类型检查/lint 工具",
        });
    }
    let wanted = opts.get("checkId").and_then(Value::as_str);
    let check = wanted
        .and_then(|id| checks.iter().find(|c| c.id == id))
        .unwrap_or(&checks[0]);

    let arg_refs: Vec<&str> = check.args.iter().map(|a| a.as_str()).collect();
    let started = Instant::now();
    let outcome = match exec::run(
        &check.program,
        &arg_refs,
        &cwd,
        Duration::from_secs(check.timeout_secs),
    ) {
        Ok(o) => o,
        Err(exec::ExecError::Unavailable(e)) => {
            return json!({
                "ok": false,
                "code": "tool_unavailable",
                "error": e,
                "checkId": check.id,
            })
        }
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    let timed_out = outcome.code.is_none();
    // eslint 的报告在 stdout，其它工具的报错常在 stderr。
    let combined = if check.id == "eslint" {
        outcome.stdout.clone()
    } else {
        format!("{}{}", outcome.stdout, outcome.stderr)
    };

    let problems: Vec<Problem> = match check.id.as_str() {
        "eslint" => parse_eslint_json(&cwd, &combined).unwrap_or_default(),
        "cargo-check" => parse_cargo_json(&cwd, &combined).unwrap_or_default(),
        _ => parse_text_output(&cwd, &combined),
    };
    let errors = problems.iter().filter(|p| p.severity == "error").count();
    let warnings = problems.iter().filter(|p| p.severity == "warning").count();

    json!({
        "ok": !timed_out,
        "checkId": check.id,
        "label": check.label,
        "exitCode": outcome.code,
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "cwd": cwd.to_string_lossy(),
        "problems": problems,
        "counts": { "errors": errors, "warnings": warnings, "total": problems.len() },
        "truncated": problems.len() >= MAX_PROBLEMS,
        "rawTail": if problems.is_empty() { tail(&combined) } else { String::new() },
        "error": if timed_out {
            format!("{} 超过 {}s 未完成，已终止", check.label, check.timeout_secs)
        } else { String::new() },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        detect_checks, parse_cargo_json, parse_colon_line, parse_eslint_json, parse_paren_line,
        split_severity,
    };
    use std::path::Path;

    #[test]
    fn parses_tsc_shape_line() {
        let line = "src/App.tsx(12,5): error TS2345: Argument of type 'x' is not assignable.";
        let (file, ln, col, rest) = parse_paren_line(line).expect("tsc line");
        assert_eq!(file, "src/App.tsx");
        assert_eq!((ln, col), (12, 5));
        let (severity, code, message) = split_severity(rest);
        assert_eq!(severity, "error");
        assert_eq!(code.as_deref(), Some("TS2345"));
        assert!(message.starts_with("Argument of type"));
    }

    #[test]
    fn parses_mypy_two_part_line() {
        let (f, l, c, msg) =
            parse_colon_line("app/main.py:31: error: Incompatible return value [arg-type]")
                .expect("mypy line");
        assert_eq!((f.as_str(), l, c), ("app/main.py", 31, 0));
        let (severity, code, message) = split_severity(&msg);
        assert_eq!(severity, "error");
        assert_eq!(code.as_deref(), Some("arg-type"));
        assert_eq!(message, "Incompatible return value");
    }

    #[test]
    fn parses_go_three_part_line() {
        let (f, l, c, msg) = parse_colon_line("internal/x/y.go:12:5: undefined: zzz").unwrap();
        assert_eq!((f.as_str(), l, c), ("internal/x/y.go", 12, 5));
        assert_eq!(msg, "undefined: zzz");
    }

    #[test]
    fn windows_drive_letter_is_not_a_line_number() {
        // 盘符后的 ':' 紧跟 '\'，所以路径结尾应落到 :12
        let (f, l, c, _) =
            parse_colon_line("C:\\proj\\src\\main.py:12:3: error: bad thing").unwrap();
        assert_eq!((f.as_str(), l, c), ("C:\\proj\\src\\main.py", 12, 3));
    }

    #[test]
    fn ignores_summary_lines() {
        assert!(parse_paren_line("Found 3 errors in 2 files.").is_none());
        assert!(parse_paren_line("note (see docs): something").is_none());
        assert!(parse_colon_line("Found 3 errors in 2 files.").is_none());
    }

    #[test]
    fn severity_of_plain_message_defaults_to_error() {
        let (severity, code, message) = split_severity("undefined: zzz");
        assert_eq!(severity, "error");
        assert_eq!(code, None);
        assert_eq!(message, "undefined: zzz");
    }

    #[test]
    fn parses_eslint_json_format() {
        let text = r#"[{"filePath":"C:\\proj\\src\\a.ts","messages":[{"ruleId":"no-unused-vars","severity":1,"line":4,"column":7,"message":"'x' is defined but never used."}]}]"#;
        let problems = parse_eslint_json(Path::new("C:\\proj"), text)
            .expect("eslint json");
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].file, "src/a.ts");
        assert_eq!(problems[0].severity, "warning");
        assert_eq!(problems[0].code.as_deref(), Some("no-unused-vars"));
    }

    #[test]
    fn parses_cargo_message_json() {
        let line = r#"{"reason":"compiler-message","message":{"level":"error","message":"expected `;`, found alias","code":{"code":"E0079"},"spans":[{"file_name":"src\\main.rs","is_primary":true,"line_start":{"line_number":9},"column_start":{"column_number":12}}]}}"#;
        let problems = parse_cargo_json(Path::new("C:\\crate"), line).expect("cargo json");
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].file, "src/main.rs");
        assert_eq!(problems[0].line, 9);
        assert_eq!(problems[0].column, 12);
        assert_eq!(problems[0].severity, "error");
        assert!(problems[0].message.starts_with("expected"));
    }

    #[test]
    fn cargo_json_absent_for_plain_text() {
        assert!(parse_cargo_json(Path::new("."), "Compiling foo\n").is_none());
    }

    #[test]
    fn detects_nothing_in_empty_dir() {
        let dir = std::env::temp_dir().join("helix-detect-empty-case");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(detect_checks(&dir).is_empty());
    }
}
