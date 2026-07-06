import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/helix/helix-config'

export async function GET() {
  try {
    const config = await loadConfig()
    const mcpConfig = config.mcp || {}
    return NextResponse.json({ mcpServers: mcpConfig })
  } catch (error) {
    return NextResponse.json({ mcpServers: {} })
  }
}