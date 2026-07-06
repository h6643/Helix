import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get('path')
  if (!filePath) {
    return NextResponse.json({ error: 'path parameter required' }, { status: 400 })
  }

  const resolved = path.resolve(filePath)
  try {
    await fs.access(resolved)
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 })
    }
    if (stat.size > 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (>1MB)' }, { status: 400 })
    }
    const content = await fs.readFile(resolved, 'utf-8')
    return NextResponse.json({ content, path: filePath })
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}
