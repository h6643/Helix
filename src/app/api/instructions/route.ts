import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

const PROJECT_CANDIDATES = [
  'Helix.md',
  'CONTEXT.md',
  '.opencode/Helix.md',
]

const GLOBAL_CANDIDATES = [
  '.config/helix/Helix.md',
  '.config/opencode/Helix.md',
]

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath)
    const content = await fs.readFile(filePath, 'utf-8')
    const trimmed = content.trim()
    return trimmed || null
  } catch {
    return null
  }
}

async function readConfigInstructions(workDir: string): Promise<string[]> {
  const configFiles = ['opencode.json', 'opencode.jsonc', 'helix.json', '.helixrc.json']
  const results: string[] = []

  for (const cfg of configFiles) {
    const cfgPath = path.join(workDir, cfg)
    try {
      const content = await fs.readFile(cfgPath, 'utf-8')
      const parsed = JSON.parse(content)
      const instructions = parsed.instructions
      if (!Array.isArray(instructions)) continue

      for (const entry of instructions) {
        if (typeof entry !== 'string') continue

        // Remote URL
        if (entry.startsWith('http://') || entry.startsWith('https://')) {
          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const res = await fetch(entry, { signal: controller.signal })
            clearTimeout(timeout)
            if (res.ok) {
              const text = await res.text()
              results.push(text)
            }
          } catch { /* skip */ }
          continue
        }

        // Glob pattern (basic support)
        if (entry.includes('*') || entry.includes('?')) {
          try {
            const dir = path.dirname(path.resolve(workDir, entry))
            const pattern = path.basename(entry)
            const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
            const files = await fs.readdir(dir)
            const matched = files.filter(f => regex.test(f)).slice(0, 20)
            for (const file of matched) {
              const p = path.join(dir, file)
              const text = await fs.readFile(p, 'utf-8')
              results.push(text)
            }
          } catch { /* skip */ }
          continue
        }

        // Local file
        const p = path.resolve(workDir, entry)
        const text = await readFileIfExists(p)
        if (text) results.push(text)
      }
    } catch { /* skip */ }
  }

  return results
}

export async function GET() {
  const workDir = process.cwd()

  // 1. Project-level files
  for (const file of PROJECT_CANDIDATES) {
    const fullPath = path.join(workDir, file)
    const content = await readFileIfExists(fullPath)
    if (content) {
      return NextResponse.json({ content, source: file })
    }
  }

  // 2. Config file instructions array
  const configInstructions = await readConfigInstructions(workDir)
  if (configInstructions.length > 0) {
    const combined = configInstructions.join('\n\n')
    return NextResponse.json({ content: combined, source: 'config.instructions' })
  }

  // 3. Global config files (~/.config/helix/Helix.md, etc.)
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  if (homeDir) {
    for (const file of GLOBAL_CANDIDATES) {
      const fullPath = path.join(homeDir, file)
      const content = await readFileIfExists(fullPath)
      if (content) {
        return NextResponse.json({ content, source: `~/${file}` })
      }
    }
  }

  return NextResponse.json({ content: null })
}
