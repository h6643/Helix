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

/// 判断 `url` 是否允许被 iframe / webview 嵌入。
///
/// github.com 这类站点返回 `X-Frame-Options: deny` 或
/// `Content-Security-Policy: frame-ancestors 'none'`，嵌进应用内会被浏览器直接
/// 拒绝（"Framing ... violates frame-ancestors"），跟代理、网络都无关。预览面板
/// 用这个先决定走"真加载"还是 `page_fetch` + `<iframe srcdoc>` 快照。
///
/// 只发 HEAD（部分服务器不支持 HEAD 时退回 GET），不取 body，成本远低于抓取。
#[tauri::command]
pub async fn page_frame_policy(url: String) -> Result<Value, String> {
    if !is_http_url(&url) {
        return Err("仅支持 http/https 地址".into());
    }
    let target = url.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(u16, bool), String> {
        let client = crate::proxy::proxy_aware_blocking_client_builder()
            .redirect(reqwest::redirect::Policy::limited(8))
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            )
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        // 先 HEAD（便宜）；不支持 HEAD 的服务器才退回 GET。
        for attempt in 0..2usize {
            let resp = if attempt == 0 {
                client.head(&target).send()
            } else {
                client.get(&target).send()
            };
            if let Ok(resp) = resp {
                return Ok((
                    resp.status().as_u16(),
                    frameable_from_headers(resp.headers()),
                ));
            }
        }
        Err("请求失败".into())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "status": result.0, "frameable": result.1 }))
}

/// 响应头是否允许被嵌入 iframe / webview。
///
/// CSP 可能多次出现（或拆成多条 header），任一条收紧即算收紧，所以逐条检查。
fn frameable_from_headers(headers: &reqwest::header::HeaderMap) -> bool {
    // X-Frame-Options：旧策略，但 GitHub 这类站点至今仍在发。
    // （ALLOW-FROM 已被所有浏览器废弃，等同没有这个 header。）
    if let Some(xfo) = headers
        .get(reqwest::header::X_FRAME_OPTIONS)
        .and_then(|v| v.to_str().ok())
    {
        match xfo.trim().to_ascii_lowercase().as_str() {
            "deny" | "sameorigin" => return false,
            _ => {}
        }
    }
    for csp in headers.get_all(reqwest::header::CONTENT_SECURITY_POLICY).iter() {
        let Ok(s) = csp.to_str() else { continue };
        // 按 ';' 切指令。frame-ancestors 的值里几乎不会有引号包裹的 ';'，
        // 这里不做完整 CSP 解析器。
        for part in s.split(';') {
            let directive = part.trim();
            if let Some(sources) = directive.strip_prefix("frame-ancestors ").or_else(|| {
                (directive == "frame-ancestors").then_some("")
            }) {
                if !frame_ancestors_allows_app(sources.trim()) {
                    return false;
                }
            }
        }
    }
    true
}

/// `frame-ancestors` 的源列表里是否允许**我们**（应用 origin）嵌入。
///
/// 我们不可能是目标站点同源，也不是它列出的具体 host，所以只有 `*`（或空列表）
/// 算允许；`none` / `'none'` / `'self'` / 具体源一律拒绝。
fn frame_ancestors_allows_app(sources: &str) -> bool {
    if sources.is_empty() {
        // 空的 source list 按 CSP3 属无效指令，浏览器忽略 → 视为不限制。
        return true;
    }
    // 我们既不可能和目标站点同源（'self' 不适用），也不可能是它列出的具体 host，
    // 所以唯一能放行我们的是 `*`。
    // 必须先扫 `*` 再判 'none'：CSP3 规定 'none' 只有在它是**唯一**源时才生效，
    // `frame-ancestors 'self' *` / `frame-ancestors 'none' *` 都算放行一切。
    sources.split_whitespace().any(|t| t == "*" || t == "'*'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    fn hdrs(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    #[test]
    fn no_frame_directives_are_frameable() {
        assert!(frameable_from_headers(&hdrs(&[])));
        assert!(frameable_from_headers(&hdrs(&[(
            "content-security-policy",
            "default-src 'self'; script-src 'self'",
        )])));
        // frame-src 管"页面里嵌谁"，不是"谁嵌我"，不能用来判嵌入
        assert!(frameable_from_headers(&hdrs(&[(
            "content-security-policy",
            "frame-src viewscreen.githubusercontent.com",
        )])));
    }

    #[test]
    fn x_frame_options_blocks() {
        assert!(!frameable_from_headers(&hdrs(&[("x-frame-options", "DENY")])));
        assert!(!frameable_from_headers(&hdrs(&[("x-frame-options", "SAMEORIGIN")])));
        // ALLOW-FROM 已被所有浏览器废弃，等同没有这个 header
        assert!(frameable_from_headers(&hdrs(&[(
            "x-frame-options",
            "ALLOW-FROM https://app.example",
        )])));
    }

    #[test]
    fn frame_ancestors_variants() {
        for policy in [
            "frame-ancestors 'none'",
            "frame-ancestors none",
            "frame-ancestors 'self'",
            "frame-ancestors 'self'; nonce-abc",
            "frame-ancestors https://foo.example",
        ] {
            assert!(
                !frameable_from_headers(&hdrs(&[("content-security-policy", policy)])),
                "应拒绝: {policy}",
            );
        }
        for policy in [
            "frame-ancestors *",
            "frame-ancestors 'self' *",
            // CSP3：'none' 是唯一源时才生效，和 `*` 同现时失效
            "frame-ancestors 'none' *",
            "default-src 'self'; frame-ancestors *; connect-src 'self'",
        ] {
            assert!(
                frameable_from_headers(&hdrs(&[("content-security-policy", policy)])),
                "应放行: {policy}",
            );
        }
    }

    #[test]
    fn github_like_response_is_blocked() {
        // github.com 实际返回的两条
        let h = hdrs(&[
            ("x-frame-options", "deny"),
            (
                "content-security-policy",
                "default-src 'none'; frame-ancestors 'none'; frame-src viewscreen.githubusercontent.com",
            ),
        ]);
        assert!(!frameable_from_headers(&h));
    }

    #[test]
    fn later_csp_header_tightens() {
        let mut m = HeaderMap::new();
        m.append(
            reqwest::header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors *"),
        );
        m.append(
            reqwest::header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
        assert!(!frameable_from_headers(&m));
    }
}

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024; // 5MB shell cap

fn is_http_url(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[tauri::command]
pub async fn page_fetch(url: String) -> Result<Value, String> {
    if !is_http_url(&url) {
        return Err("仅支持 http/https 地址".into());
    }
    // Blocking reqwest on a worker thread so the async runtime isn't stalled.
    let fetch_url = url.clone();
    let html = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = crate::proxy::proxy_aware_blocking_client_builder()
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
            // String::truncate panics when the byte index lands inside a
            // multi-byte char ("not a char boundary"). 5MB+ pages are almost
            // always UTF-8 with non-ASCII text, so walk back to the previous
            // boundary — same crash class as the helix.rs extension scanner.
            let mut end = MAX_BODY_BYTES;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())??;

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
