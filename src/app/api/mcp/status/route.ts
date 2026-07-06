import { NextResponse } from 'next/server'
import { getMcpStatus, initializeMcpServers } from '@/lib/helix/mcp'
import { loadConfig } from '@/lib/helix/helix-config'

export async function GET() {
  // Try to initialize MCP servers if not already connected
  try {
    const config = await loadConfig()
    const mcpConfig = config.mcp || {}
    // Only initialize if there are servers configured but none connected
    const currentStatus = getMcpStatus()
    if (currentStatus.length === 0 && Object.keys(mcpConfig).length > 0) {
      await initializeMcpServers(mcpConfig).catch(() => {})
    }
  } catch {}

  const status = getMcpStatus()
  return NextResponse.json({ servers: status })
}
