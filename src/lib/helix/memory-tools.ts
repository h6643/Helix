import fs from 'fs/promises'
import path from 'path'
import type { ToolDefinition } from '@/lib/agent/tools'
import { safePath } from '@/lib/agent/sandbox'

const MEMORY_DIR = '.helix/memory'

function getMemoryPath(category: string): string {
  const safe = path.normalize(category).replace(/^(\.\.(\/|\\|$))+/, '').replace(/[\\/]/g, '/')
  return safePath(path.join(MEMORY_DIR, `${safe}.md`)) || ''
}

const MEMORY_TOOL: ToolDefinition = {
  name: 'memory_add',
  description: 'Write a persistent memory entry to .helix/memory/. Categories: user, feedback, project, reference, architecture, rule, decision, pattern, gotcha. Memories persist across sessions.',
  parameters: {
    category: { type: 'string', description: 'Memory category: user, feedback, project, reference, architecture, rule, decision, pattern, gotcha', required: true },
    content: { type: 'string', description: 'Memory content to persist', required: true },
  },
  execute: async (params) => {
    const category = (params.category as string) || 'reference'
    const content = (params.content as string) || ''
    if (!content.trim()) return 'Error: content is required'

    const filePath = getMemoryPath(category)
    if (!filePath) return 'Error: Invalid category path'

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })

      const timestamp = new Date().toISOString()
      const entry = `## ${timestamp}\n\n${content}\n\n`
      await fs.appendFile(filePath, entry, 'utf-8')
      return `Memory written to ${category}: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`
    } catch (err) {
      return `Error writing memory: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

const MEMORY_READ_TOOL: ToolDefinition = {
  name: 'memory_read',
  description: 'Read persistent memory entries from .helix/memory/. If no category specified, lists all available memory categories. Reads the latest entries across all or a specific category.',
  parameters: {
    category: { type: 'string', description: 'Optional memory category to read from. Omit to list all categories.' },
    limit: { type: 'number', description: 'Max entries to return per category (default 10)' },
  },
  execute: async (params) => {
    const category = params.category as string | undefined
    const limit = Number(params.limit) || 10

    try {
      const memoryDir = safePath(MEMORY_DIR)
      if (!memoryDir) return 'Error: Memory directory not accessible'

      try { await fs.access(memoryDir) } catch {
        return '(no memories yet)'
      }

      if (category) {
        const filePath = getMemoryPath(category)
        if (!filePath) return 'Error: Invalid category'
        try {
          const content = await fs.readFile(filePath, 'utf-8')
          const entries = content.split('## ').filter(Boolean).slice(-limit)
          return entries.map(e => `## ${e.trim()}`).join('\n\n')
        } catch {
          return `(no memories in category: ${category})`
        }
      }

      const files = await fs.readdir(memoryDir)
      const categories = files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''))
      if (categories.length === 0) return '(no memory categories)'
      return `Available memory categories:\n${categories.map(c => `  - ${c}`).join('\n')}`
    } catch (err) {
      return `Error reading memory: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}

export const MEMORY_TOOLS: ToolDefinition[] = [MEMORY_TOOL, MEMORY_READ_TOOL]
