import type { ToolDefinition } from '@/lib/agent/tools'

const JINA_READER_URL = 'https://r.jina.ai'

const WEB_EXTRACTOR_TOOL_DEFINITION: ToolDefinition = {
  name: 'web_extractor',
  description: 'Extract structured content from a URL using Jina Reader API. Returns clean markdown with title, content, and metadata. Supports any public URL.',
  parameters: {
    url: { type: 'string', description: 'URL to extract content from', required: true },
    maxLength: { type: 'number', description: 'Max characters to return (default 10000, max 50000)' },
  },
  execute: async (params) => {
    const url = (params.url as string) || ''
    const maxLength = Math.min(Number(params.maxLength) || 10000, 50000)

    if (!url.trim()) return 'Error: URL is required'
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'Error: URL must start with http:// or https://'
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)

      const response = await fetch(`${JINA_READER_URL}/${encodeURI(url)}`, {
        headers: {
          'Accept': 'text/plain',
          'User-Agent': 'Helix/1.0',
        },
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return `Jina Reader error (${response.status}): ${text.slice(0, 200)}`
      }

      const text = await response.text()
      if (!text.trim()) return '(no content extracted)'

      const truncated = text.length > maxLength
        ? text.slice(0, maxLength) + '\n\n... (content truncated)'
        : text

      return truncated
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return 'Error: Request timed out after 30s'
      }
      return `Error extracting content: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

export { WEB_EXTRACTOR_TOOL_DEFINITION }
