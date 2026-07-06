import type { ToolDefinition } from '@/lib/agent/tools'

let browserInstance: any = null
let pageInstance: any = null

async function getPage() {
  if (pageInstance) return pageInstance
  try {
    // playwright is optional — webpackIgnore prevents build-time resolution
    const { chromium } = await import(/* webpackIgnore: true */ 'playwright')
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    const context = await browserInstance.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
    pageInstance = await context.newPage()
    return pageInstance
  } catch (err) {
    throw new Error(`Playwright not available: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function closeBrowser(): Promise<void> {
  try {
    if (pageInstance) { await pageInstance.close().catch(() => {}); pageInstance = null }
    if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null }
  } catch {}
}

const BROWSER_NAVIGATE_TOOL: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Navigate to a URL and get the page title and text content. Use this to browse web pages, read documentation, or inspect websites.',
  parameters: {
    url: { type: 'string', description: 'URL to navigate to', required: true },
    maxLength: { type: 'number', description: 'Max characters of text content to return (default 8000)' },
  },
  execute: async (params) => {
    const url = (params.url as string) || ''
    const maxLength = Number(params.maxLength) || 8000
    if (!url.trim()) return 'Error: URL is required'

    try {
      const page = await getPage()
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      const title = await page.title()
      const text = await page.evaluate(() => document.body?.innerText || '')
      const truncated = text.length > maxLength
        ? text.slice(0, maxLength) + '\n... (truncated)'
        : text
      return `# ${title}\n\n${truncated}`
    } catch (err) {
      return `Error navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

const BROWSER_CLICK_TOOL: ToolDefinition = {
  name: 'browser_click',
  description: 'Click an element on the current page by CSS selector.',
  parameters: {
    selector: { type: 'string', description: 'CSS selector of element to click', required: true },
  },
  execute: async (params) => {
    const selector = (params.selector as string) || ''
    if (!selector.trim()) return 'Error: selector is required'

    try {
      const page = await getPage()
      await page.click(selector, { timeout: 10000 })
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      const title = await page.title()
      return `Clicked "${selector}" on "${title}"`
    } catch (err) {
      return `Error clicking "${selector}": ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

const BROWSER_TYPE_TOOL: ToolDefinition = {
  name: 'browser_type',
  description: 'Type text into an input field on the current page.',
  parameters: {
    selector: { type: 'string', description: 'CSS selector of the input element', required: true },
    text: { type: 'string', description: 'Text to type', required: true },
  },
  execute: async (params) => {
    const selector = (params.selector as string) || ''
    const text = (params.text as string) || ''
    if (!selector.trim()) return 'Error: selector is required'

    try {
      const page = await getPage()
      await page.fill(selector, text, { timeout: 10000 })
      return `Typed into "${selector}"`
    } catch (err) {
      return `Error typing into "${selector}": ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

const BROWSER_SCREENSHOT_TOOL: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current page. Returns a base64-encoded PNG image.',
  parameters: {
    fullPage: { type: 'boolean', description: 'Capture full page (default: false)' },
  },
  execute: async (params) => {
    const fullPage = params.fullPage === true

    try {
      const page = await getPage()
      const screenshot = await page.screenshot({ fullPage, type: 'png' })
      const base64 = screenshot.toString('base64')
      return `![Page screenshot](data:image/png;base64,${base64})`
    } catch (err) {
      return `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

const BROWSER_GET_HTML_TOOL: ToolDefinition = {
  name: 'browser_get_html',
  description: 'Get the full HTML of the current page.',
  parameters: {
    selector: { type: 'string', description: 'Optional CSS selector to get HTML of a specific element' },
  },
  execute: async (params) => {
    const selector = (params.selector as string) || ''

    try {
      const page = await getPage()
      let html: string
      if (selector) {
        html = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel)
          return el?.outerHTML || '(element not found)'
        }, selector)
      } else {
        html = await page.content()
      }
      return html.length > 10000
        ? html.slice(0, 10000) + '\n... (truncated)'
        : html
    } catch (err) {
      return `Error getting HTML: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

export const BROWSER_TOOLS: ToolDefinition[] = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_GET_HTML_TOOL,
]
