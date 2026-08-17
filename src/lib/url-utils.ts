// Strip Markdown emphasis markers and trailing CJK/western punctuation that
// models often glue around a URL (e.g. `**https://www.baidu.com**。`).
// Without this, clicking the link opens `https://www.baidu.com%E3%80%82`
// (the `。` gets percent-encoded to `%E3%80%82` by the webview).
export function cleanUrl(raw: string): string {
  let url = raw.trim()
  // `<url>` autolink or `[text](url)` markdown link
  url = url.replace(/^<([^>]+)>$/, '$1')
  const linkMatch = url.match(
    /^\[[^\]]*\]\(\s*([^)\s]+)\s*\)[\u3002\uFF0C\u3001\uFF1B\uFF1A\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011\u300A\u300B\u3008\u3009\uFF01\uFF1F\u2026.,;:!?'"`)\]\}\-]*$/
  )
  if (linkMatch) url = linkMatch[1]
  // markdown emphasis / code markers glued to either side
  url = url.replace(/^[*_`]+/, '')
  // trailing CJK / western punctuation, raw or percent-encoded
  const trailingRaw =
    /[\u3002\uFF0C\u3001\uFF1B\uFF1A\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011\u300A\u300B\u3008\u3009\uFF01\uFF1F\u2026.,;:!?'"`)\]\}\-]+$/
  const trailingEncoded =
    /(?:%E3%80%82|%E3%80%81|%EF%BC%8C|%EF%BC%9B|%EF%BC%9A|%EF%BC%88|%EF%BC%89|%E2%80%9C|%E2%80%9D|%E2%80%98|%E2%80%99|%EF%BC%81|%EF%BC%9F|%E3%80%8A|%E3%80%8B|%E2%80%A6)+$/i
  let prev: string
  do {
    prev = url
    url = url.replace(/[*_`]+$/, '').replace(trailingRaw, '').replace(trailingEncoded, '')
  } while (url !== prev && url)
  return url
}

/** 网页标题/标签页展示用摘要：file 协议取文件名，其余取 hostname。 */
export function summarizeUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') {
      const name = decodeURIComponent(u.pathname).split('/').pop()
      return name || url
    }
    return u.hostname || url
  } catch { return url }
}
