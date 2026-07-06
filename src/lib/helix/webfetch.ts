import type { ToolDefinition } from '@/lib/agent/tools'

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT = 30000

function stripHTML(html: string): string {
  let text = html
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&nbsp;/g, ' ')
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#(\d+);/g, (_: string, code: string) => String.fromCharCode(Number(code)))
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()
  return text
}

function htmlToMarkdown(html: string): string {
  let md = html
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')
  md = md.replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
  md = md.replace(/<b>(.*?)<\/b>/gi, '**$1**')
  md = md.replace(/<em>(.*?)<\/em>/gi, '*$1*')
  md = md.replace(/<i>(.*?)<\/i>/gi, '*$1*')
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
  md = md.replace(/<a[^>]*href='([^']*)'[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
  md = md.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```')
  md = md.replace(/<code>(.*?)<\/code>/gi, '`$1`')
  md = md.replace(/<li>(.*?)<\/li>/gi, '- $1\n')
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
  md = md.replace(/<blockquote>(.*?)<\/blockquote>/gi, '> $1\n\n')
  md = md.replace(/<hr\s*\/?>/gi, '---\n\n')
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
  md = stripHTML(md)
  return md
}

export const WEBFETCH_TOOL_DEFINITION: ToolDefinition = {
  name: 'webfetch',
  description: 'Fetches content from a specified URL. Returns content in the specified format (markdown, text, or html).',
  parameters: {
    url: { type: 'string', description: 'The URL to fetch content from', required: true },
    format: { type: 'string', description: 'Output format: "markdown" (default), "text", or "html"' },
    timeout: { type: 'number', description: 'Timeout in seconds (max 120, default 30)' },
  },
  execute: async (params) => {
    const url = params.url as string
    const format = (params.format as string) || 'markdown'
    const timeout = Math.min((params.timeout ? Number(params.timeout) * 1000 : DEFAULT_TIMEOUT), 120000)

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'Error: URL must start with http:// or https://'
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        return 'Error: Response too large (exceeds 5MB limit)'
      }

      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        return 'Error: Response too large (exceeds 5MB limit)'
      }

      const contentType = response.headers.get('content-type') || ''
      const content = new TextDecoder().decode(arrayBuffer)

      if (format === 'html') {
        return content.length > 50000 ? content.slice(0, 50000) + '\n\n... (truncated at 50K chars)' : content
      }

      const isHTML = contentType.includes('text/html') || /^\s*</.test(content.trim())
      if (isHTML) {
        if (format === 'markdown') {
          const md = htmlToMarkdown(content)
          return md.length > 50000 ? md.slice(0, 50000) + '\n\n... (truncated at 50K chars)' : md
        }
        const text = stripHTML(content)
        return text.length > 50000 ? text.slice(0, 50000) + '\n\n... (truncated at 50K chars)' : text
      }

      return content.length > 50000 ? content.slice(0, 50000) + '\n\n... (truncated at 50K chars)' : content
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return `Error: Request timed out after ${timeout / 1000}s`
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
