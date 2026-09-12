//! Integration tests for the oversized-session local trim (pi_gateway).
//!
//! These exercise the trim/estimate logic against the REAL production session
//! files under ~/.pi/agent/sessions when they exist, plus synthetic sessions.

use helix_lib::pi_gateway_test_hooks as hooks;

fn session_dir() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let d = home.join(".pi").join("agent").join("sessions");
    d.is_dir().then_some(d)
}

fn rec(id: &str, parent: Option<&str>, role: &str, text_len: usize) -> String {
    let parent_val = match parent {
        Some(p) => format!("\"{p}\""),
        None => "null".to_string(),
    };
    let body = "x".repeat(text_len);
    format!(
        r#"{{"type":"message","id":"{id}","parentId":{parent},"timestamp":"t","message":{{"role":"{role}","content":[{{"type":"text","text":"{body}"}}]}}}}"#,
        parent = parent_val,
        body = body
    )
    .replace("{id}", id)
    .replace("{role}", role)
}

fn compaction(id: &str, first_kept: &str, summary_len: usize) -> String {
    format!(
        r#"{{"type":"compaction","id":"{id}","parentId":null,"summary":"{}","firstKeptEntryId":"{first_kept}"}}"#,
        "s".repeat(summary_len)
    )
    .replace("{id}", id)
    .replace("{first_kept}", first_kept)
}

#[test]
fn synthetic_estimate_whole_file_without_compaction() {
    let lines = vec![
        rec("a", None, "user", 4000),
        rec("b", Some("a"), "assistant", 4000),
        rec("c", Some("b"), "user", 4000),
        rec("d", Some("c"), "assistant", 4000),
    ];
    let (tokens, start, compaction) = hooks::estimate_active_branch(&lines);
    assert_eq!(start, Some(0));
    assert!(compaction.is_none());
    assert_eq!(tokens, 4 * (4000 / 4));
}

#[test]
fn trim_margin_constant_is_sane() {
    assert_eq!(hooks::TRIM_MARGIN_TOKENS, 16 * 1024);
}

#[test]
fn synthetic_estimate_branch_after_latest_compaction() {
    let lines = vec![
        rec("a", None, "user", 4000),
        rec("b", Some("a"), "assistant", 4000),
        compaction("k1", "c", 4000),
        rec("c", Some("k1"), "user", 2000),
        rec("d", Some("c"), "assistant", 2000),
    ];
    let (tokens, start, compaction_idx) = hooks::estimate_active_branch(&lines);
    assert_eq!(start, Some(3));
    assert_eq!(compaction_idx, Some(2));
    assert_eq!(tokens, 1000 + 500 + 500);
}

#[test]
fn synthetic_trim_produces_fitting_slice_with_null_root() {
    let window = 40000i64;
    let mut lines = Vec::new();
    for turn in 0..6 {
        let parent = if turn == 0 { None } else { Some("prev") };
        lines.push(rec(&format!("u{turn}"), parent, "user", 16000));
        lines.push(rec(
            &format!("a{turn}"),
            Some(&format!("u{turn}")),
            "assistant",
            16000,
        ));
    }
    let tmp = std::env::temp_dir().join("helix_trim_test.jsonl");
    std::fs::write(&tmp, lines.join("\n") + "\n").unwrap();
    let trimmed = hooks::trim_session_if_oversized(tmp.to_str().unwrap(), window).unwrap();
    assert!(
        trimmed.is_some(),
        "expected a trim for an oversized session"
    );
    let out = std::fs::read_to_string(trimmed.unwrap()).unwrap();
    let out_lines: Vec<&str> = out.trim().split('\n').collect();
    assert!(out_lines.len() >= 3, "trimmed file too small");
    let first: serde_json::Value = serde_json::from_str(out_lines[1]).unwrap();
    assert!(first.get("parentId").unwrap().is_null());
    let owned: Vec<String> = out_lines.iter().map(|s| s.to_string()).collect();
    let (tokens, _, _) = hooks::estimate_active_branch(&owned);
    assert!(
        tokens <= window - hooks::TRIM_MARGIN_TOKENS,
        "trimmed tokens {tokens} exceed budget"
    );
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn synthetic_trim_returns_none_when_fitting() {
    let lines = vec![
        rec("a", None, "user", 100),
        rec("b", Some("a"), "assistant", 100),
    ];
    let tmp = std::env::temp_dir().join("helix_trim_fit_test.jsonl");
    std::fs::write(&tmp, lines.join("\n") + "\n").unwrap();
    let trimmed = hooks::trim_session_if_oversized(tmp.to_str().unwrap(), 128 * 1024).unwrap();
    assert!(trimmed.is_none());
    let _ = std::fs::remove_file(&tmp);
}

/// Cross-check the estimator against the REAL oversized session that hung the
/// free upstream (2.7MB file, ~276k tokens by manual simulation). Skips
/// silently when that file is absent.
#[test]
fn real_session_estimate_matches_manual_simulation() {
    let Some(dir) = session_dir() else { return };
    let target = dir
        .join("--D--Project-Helix--")
        .join("2026-09-08T14-46-52-053Z_01a0817c-7394-7209-bff5-30205d77da60.jsonl");
    if !target.exists() {
        return;
    }
    let raw = std::fs::read_to_string(&target).unwrap();
    let lines: Vec<String> = raw
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    let (tokens, start, compaction) = hooks::estimate_active_branch(&lines);
    assert_eq!(compaction, Some(379), "latest compaction line moved");
    assert_eq!(
        start,
        Some(327),
        "active-branch start (firstKeptEntryId) moved"
    );
    // Manual simulation said ~275846; allow ±15% for block-level detail.
    assert!(
        tokens > 200_000 && tokens < 350_000,
        "estimate {tokens} far from the manual ~276k"
    );
}
