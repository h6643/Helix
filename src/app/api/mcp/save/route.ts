import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import type { McpServerConfig } from '@/lib/helix/mcp'

const CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc', 'helix.json', '.helixrc.json']

/**
 * Save MCP server config to helix.json
 */
export async function POST(request: NextRequest) {
  try {
    const { mcpServers } = await request.json() as { mcpServers: Record<string, McpServerConfig> }

    // Find the helix config file to write
    let configPath = ''
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.resolve(process.cwd(), name)
      try {
        await fs.access(candidate)
        configPath = candidate
        break
      } catch {
        // File doesn't exist, try next
      }
    }

    // If no existing config file, use helix.json in cwd
    if (!configPath) {
      configPath = path.resolve(process.cwd(), 'helix.json')
    }

    // Read existing config or start fresh
    let config: Record<string, unknown> = {}
    try {
      const content = await fs.readFile(configPath, 'utf-8')
      config = JSON.parse(content)
    } catch {
      // File doesn't exist or invalid JSON, start fresh
    }

    // Update the mcp section
    config.mcp = { ...((config.mcp as Record<string, unknown>) || {}), ...mcpServers }

    // Write back
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')

    // Invalidate config cache
    const { invalidateCache } = await import('@/lib/helix/helix-config')
    invalidateCache()

    return NextResponse.json({ success: true, path: configPath })
  } catch (error) {
    console.error('[MCP Save] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '保存失败' },
      { status: 500 },
    )
  }
}
