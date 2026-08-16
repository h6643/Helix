//! `page_fetch:*` commands — fetch a web page's HTML for the sidebar "pick
//! element" feature.
//!
//! The sidebar browser runs a cross-origin `<iframe>` in Tauri, so the parent
//! page cannot reach into the frame's DOM to attach a picker. Instead we fetch
//! the HTML server-side (no CORS / X-Frame-Options restrictions), hand it back
//! to the frontend, and the frontend renders it via `<iframe srcdoc>` — which
//! inherits the parent origin, so the picker script can be injected and the
//! selected element can be posted back with `parent.postMessage`.
//!
//! Limitations (by design): JS-rendered SPAs yield an empty shell; sites that
//! require login/cookies won't carry session state.

use serde_json::Value;

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024; // 5MB shell cap

fn is_http_url(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[tauri::command]
pub async fn page_fetch(url: String) -> Result<Value, String> {
    eprintln!("[page_fetch] called url={url}");
    if !is_http_url(&url) {
        return Err("仅支持 http/https 地址".into());
    }
    // Blocking reqwest on a worker thread so the async runtime isn't stalled.
    let fetch_url = url.clone();
    let html = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(8))
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            )
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&fetch_url)
            .send()
            .map_err(|e| format!("请求失败: {e}"))?;
        let status = resp.status();
        if !status.is_success() && status.as_u16() != 304 {
            return Err(format!("页面返回 {status}"));
        }
        let body = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
        let mut text = body;
        if text.len() > MAX_BODY_BYTES {
            text.truncate(MAX_BODY_BYTES);
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!("[page_fetch] got html len={}", html.len());

    // Inject a <base href> so relative resources in the fetched HTML resolve
    // against the original site (images / css / links just work).
    let base = format!("<base href=\"{}\">", html_escape(&url));
    let head_tag = "<head";
    let full = if html.find(head_tag).is_some() {
        // Insert right after <head ...> — find the closing '>' of the tag.
        if let Some(idx) = html.find(head_tag) {
            if let Some(gt) = html[idx..].find('>') {
                let insert_at = idx + gt + 1;
                let mut out = String::with_capacity(html.len() + base.len());
                out.push_str(&html[..insert_at]);
                out.push_str(&base);
                out.push_str(&html[insert_at..]);
                out
            } else {
                format!("{base}{html}")
            }
        } else {
            format!("{base}{html}")
        }
    } else {
        format!("<html><head>{base}</head><body>{html}</body></html>")
    };

    Ok(serde_json::json!({
        "html": full,
        "final_url": url,
    }))
}

/// Minimal HTML attribute escaping for the base href injection.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
