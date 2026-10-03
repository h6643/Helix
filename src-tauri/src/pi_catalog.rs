//! pi.dev 包目录抓取。
//!
//! 为什么不用 npm registry 搜索：npm 的 `/-/v1/search` 是**全量**搜索，
//! 搜 `pi` 首屏是数学库 `pi`、遥测包 `@earendil-works/pi-telemetry`，跟
//! coding agent 毫无关系；而且它只认 `keywords`，pi 生态实际用的
//! `pi-package` / `pi-extension` keyword 命中的包类型还要靠猜。
//!
//! pi.dev/packages 是 Pi 官方目录（5464+ 个包），服务端渲染，每张卡片都带
//! 结构化 data-* 属性，直接解析即可。它支持三个查询参数（实测有效）：
//!
//! | 参数 | 取值 | 说明 |
//! |---|---|---|
//! | `name` | 任意串 | 按名称/描述/作者过滤（子串匹配，不是 npm 的分词器） |
//! | `type` | extension / skill / theme / prompt | 类型过滤 |
//! | `sort` | downloads（默认）/ recent / name | 排序 |
//! | `page` | 1..=110 | 分页，每页 50 |
//!
//! 两个实测到的坑：
//! 1. **参数顺序会触发 302**（`?page=2&name=web` 就跳），但 reqwest 默认
//!    跟随重定向，所以无害；我们仍按固定顺序拼串以减少无谓跳转。
//! 2. **空 `name` + 非默认 sort 会被规范化掉**（`?name=&sort=recent` 退回
//!    默认排序）。所以查询为空时干脆不发 `name` 参数。
//!
//! 数据源：<https://pi.dev/packages>

use serde_json::{json, Value};

/// 目录页地址
const CATALOG_URL: &str = "https://pi.dev/packages";
/// 每页条数（pi.dev 固定 50）
pub const PAGE_SIZE: usize = 50;

fn client() -> reqwest::Client {
    crate::proxy::proxy_aware_client_builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

/// 抓取包目录。
///
/// - `query`：名称/描述/作者过滤，空 = 不限（返回最热门）
/// - `pkg_type`：`extension` / `skill` / `theme` / `prompt`，`None` = 全部
/// - `sort`：`downloads` / `recent` / `name`，默认 `downloads`
/// - `page`：1 起
pub async fn fetch_catalog(
    query: &str,
    pkg_type: Option<&str>,
    sort: &str,
    page: u32,
) -> Result<Value, String> {
    let mut url = String::from(CATALOG_URL);
    url.push('?');
    let mut first = true;
    let mut push = |k: &str, v: &str| {
        if !first {
            url.push('&');
        }
        first = false;
        url.push_str(k);
        url.push('=');
        url.push_str(&urlencoding::encode(v).into_owned());
    };
    // 空查询不发 name（见文件头坑 2）
    if !query.trim().is_empty() {
        push("name", query.trim());
    }
    if let Some(t) = pkg_type.filter(|t| !t.is_empty() && *t != "all") {
        push("type", t);
    }
    if !sort.is_empty() {
        push("sort", sort);
    }
    if page > 1 {
        push("page", &page.to_string());
    }

    let html = client()
        .get(&url)
        .header("accept", "text/html")
        .header("user-agent", "Helix/0.1 (+https://github.com/h6643/Helix)")
        .send()
        .await
        .map_err(|e| format!("pi.dev 请求失败: {e}"))?
        .text()
        .await
        .map_err(|e| format!("pi.dev 响应读取失败: {e}"))?;

    Ok(json!({
        "packages": parse_cards(&html),
        "total": parse_total(&html),
        "page": page,
        "pageSize": PAGE_SIZE,
        "source": "pi.dev",
    }))
}

// ── HTML 解析 ──────────────────────────────────────────────────────
// 卡片形如：
// <article class="surface-panel content-card" data-package-card="true"
//   data-package-name="pi-web-access" data-package-types="extension"
//   data-package-downloads="503819" data-package-date="1790802323733" …>
//   <p class="packages-desc">…</p>
//   <div class="packages-meta"><span>nicopreme</span>…</div>
//   <a href="https://www.npmjs.com/package/pi-web-access" …>

/// 取标签内的 `name="value"` 属性
fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')? + start;
    Some(unescape(&tag[start..end]))
}

/// 去掉标签，保留文本
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' => {
                depth = depth.saturating_sub(1);
                out.push(' ');
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    unescape(&out)
}

/// 极简 HTML 实体解码（目录页只可能出现这几种）
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// 抓所有 `data-package-card` 卡片的字段
fn parse_cards(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(pos) = rest.find("data-package-card=\"true\"") {
        // 卡片起点 = 该 article 开始标签的 `<`
        let card_start = rest[..pos].rfind('<').unwrap_or(0);
        let body_start = match rest[pos..].find('>') {
            Some(i) => pos + i + 1,
            None => break,
        };
        // 卡片终点 = 对应的 `</article>`
        let after = &rest[body_start..];
        let body_end = match after.find("</article>") {
            Some(i) => body_start + i,
            None => body_start + after.len(),
        };
        let open_tag = &rest[card_start..body_start];
        let body = &rest[body_start..body_end];

        let Some(name) = attr(open_tag, "data-package-name") else {
            rest = &rest[body_end..];
            continue;
        };
        if name.is_empty() {
            rest = &rest[body_end..];
            continue;
        }

        // 类型：空格分隔的多值（"extension skill"），取首个；空 = package
        let type_raw = attr(open_tag, "data-package-types").unwrap_or_default();
        let pkg_type = type_raw
            .split_whitespace()
            .next()
            .filter(|t| !t.is_empty())
            .unwrap_or("package")
            .to_string();

        // 描述
        let description = body
            .split("packages-desc\">")
            .nth(1)
            .and_then(|s| s.split("</p>").next())
            .map(strip_tags)
            .unwrap_or_default();

        // 作者：meta 区第一个 <span>
        let author = body
            .split("packages-meta\">")
            .nth(1)
            .and_then(|s| s.split("<span>").nth(1))
            .and_then(|s| s.split("</span>").next())
            .map(strip_tags)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                // scoped 包名退化取 scope：`@scope/name` → scope
                name.strip_prefix('@')
                    .and_then(|rest| rest.split('/').next())
                    .unwrap_or("")
                    .to_string()
            });

        // npm 下载量（周）
        let downloads = attr(open_tag, "data-package-downloads")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        // 发布时间：epoch 毫秒 → RFC3339
        let date = attr(open_tag, "data-package-date")
            .and_then(|v| v.parse::<i64>().ok())
            .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();

        // npm 链接（pi.dev 卡片固定带）
        let npm_url = body
            .split("https://www.npmjs.com/package/")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .map(|n| format!("https://www.npmjs.com/package/{n}"))
            .unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}"));

        out.push(json!({
            "name": name,
            "description": description,
            // pi.dev 卡片不带版本号；要版本得再打一次 npm registry，
            // 50 个包就是 50 个请求，不划算。前端本来就会在 version 为空时隐藏徽标。
            "version": "",
            "type": pkg_type,
            "author": author,
            "npmUrl": npm_url,
            "installCmd": format!("pi install npm:{name}"),
            "downloads": downloads,
            "date": date,
            "piUrl": format!("https://pi.dev/packages/{}", name),
        }));

        rest = &rest[body_end..];
    }
    out
}

/// 从 `packages-count">1-50 / 385 (of 5464)` 里取过滤后的总数（385）
fn parse_total(html: &str) -> Option<u64> {
    let tail = html.split("packages-count\">").nth(1)?;
    let text = strip_tags(tail.split('<').next().unwrap_or(""));
    // "1-50 / 385 (of 5464)" → 取 " / " 后的数字
    let after = text.split('/').nth(1)?;
    let digits: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || c.is_whitespace())
        .filter(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"
<span class="packages-count">1-50 / 385 (of 5464)</span>
<article class="surface-panel content-card" data-package-card="true" data-package-name="pi-web-access" data-package-search="x" data-package-types="extension" data-package-downloads="503819" data-package-date="1790802323733" data-package-sort-name="pi-web-access">
<div class="packages-card-body"><h3 class="packages-name"><a href="/packages/pi-web-access">pi-web-access</a></h3>
<p class="packages-desc">Web search, URL fetching &amp; PDF extraction for Pi</p>
<div class="packages-meta"><span>nicopreme</span><span>503.8K/mo</span><span>1d ago</span></div>
<div class="packages-badges"><span class="meta-chip" data-type="extension">extension</span></div>
<div class="packages-links"><a href="https://www.npmjs.com/package/pi-web-access">npm</a></div>
</div></article>
<article class="surface-panel content-card" data-package-card="true" data-package-name="@acme/multi" data-package-types="extension skill theme prompt" data-package-downloads="12" data-package-date="1790802323733">
<div class="packages-card-body"><p class="packages-desc">Multi type</p>
<div class="packages-meta"><span>acme</span></div></div></article>
<article class="surface-panel content-card" data-package-card="true" data-package-name="no-desc-no-type" data-package-types="" data-package-downloads="0" data-package-date="0">
<div class="packages-card-body"><div class="packages-meta"></div></div></article>
"##;

    #[test]
    fn parses_all_three_cards() {
        let cards = parse_cards(SAMPLE);
        assert_eq!(cards.len(), 3, "应解析出 3 张卡片，实际 {}", cards.len());
        assert_eq!(cards[0]["name"], "pi-web-access");
    }

    #[test]
    fn decodes_entities_in_description() {
        let cards = parse_cards(SAMPLE);
        assert_eq!(cards[0]["description"], "Web search, URL fetching & PDF extraction for Pi");
    }

    #[test]
    fn multi_type_takes_first() {
        let cards = parse_cards(SAMPLE);
        assert_eq!(cards[1]["type"], "extension");
        assert_eq!(cards[1]["author"], "acme");
    }

    #[test]
    fn empty_type_falls_back_to_package_and_author_to_scope() {
        let cards = parse_cards(SAMPLE);
        assert_eq!(cards[2]["type"], "package");
        // 作者从包名退化：no-desc-no-type 没有 @scope → 空
        assert_eq!(cards[2]["author"], "");
    }

    #[test]
    fn scoped_name_supplies_author_when_meta_missing() {
        let html = r##"<article data-package-card="true" data-package-name="@foo/bar" data-package-types="skill" data-package-downloads="1" data-package-date="0"><div class="packages-meta"></div></article>"##;
        let cards = parse_cards(html);
        assert_eq!(cards[0]["author"], "foo");
    }

    #[test]
    fn parses_downloads_and_npm_url() {
        let cards = parse_cards(SAMPLE);
        assert_eq!(cards[0]["downloads"], 503819u64);
        assert_eq!(cards[0]["npmUrl"], "https://www.npmjs.com/package/pi-web-access");
        assert_eq!(cards[0]["installCmd"], "pi install npm:pi-web-access");
    }

    #[test]
    fn epoch_millis_becomes_rfc3339() {
        let cards = parse_cards(SAMPLE);
        let d = cards[0]["date"].as_str().unwrap();
        assert!(d.starts_with("2026-"), "期望 2026 年份，实际 {d}");
    }

    #[test]
    fn total_is_filtered_count_not_catalog_size() {
        assert_eq!(parse_total(SAMPLE), Some(385));
    }

    #[test]
    fn total_absent_returns_none() {
        assert_eq!(parse_total("<html>no count here</html>"), None);
    }

    #[test]
    fn skips_cards_without_name() {
        let cards = parse_cards(r##"<article data-package-card="true" data-package-types="skill"></article>"##);
        assert!(cards.is_empty());
    }
}
