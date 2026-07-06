import fs from 'fs/promises'
import { safePath, getWorkDir } from '@/lib/agent/sandbox'
import { addFile } from './context'

interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  const lines = patch.split('\n')
  let currentHunk: Hunk | null = null

  for (const line of lines) {
    const hunkHeader = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/.exec(line)
    if (hunkHeader) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = {
        oldStart: parseInt(hunkHeader[1], 10),
        oldLines: hunkHeader[2] ? parseInt(hunkHeader[2], 10) : 1,
        newStart: parseInt(hunkHeader[3], 10),
        newLines: hunkHeader[4] ? parseInt(hunkHeader[4], 10) : 1,
        lines: [],
      }
    } else if (currentHunk) {
      currentHunk.lines.push(line)
    }
  }
  if (currentHunk) hunks.push(currentHunk)
  return hunks
}

function applyHunks(content: string, hunks: Hunk[]): { result: string; applied: number; errors: string[] } {
  const lines = content.split('\n')
  const errors: string[] = []
  let applied = 0
  let offset = 0

  for (const hunk of hunks) {
    const startLine = hunk.oldStart - 1 + offset
    const contextLines = hunk.lines.filter(l => l.startsWith(' '))
    const removeLines = hunk.lines.filter(l => l.startsWith('-'))
    const addLines = hunk.lines.filter(l => l.startsWith('+'))

    const oldLines = hunk.lines.filter(l => l.startsWith(' ') || l.startsWith('-'))
      .map(l => l.slice(1))

    const fileSlice = lines.slice(startLine, startLine + oldLines.length)

    if (fileSlice.length !== oldLines.length) {
      errors.push(`Hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@: expected ${oldLines.length} lines, got ${fileSlice.length}`)
      continue
    }

    let match = true
    for (let i = 0; i < oldLines.length; i++) {
      if (fileSlice[i] !== oldLines[i]) {
        match = false
        errors.push(`Hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@: mismatch at line ${startLine + i + 1}: expected "${oldLines[i]}", got "${fileSlice[i]}"`)
        break
      }
    }

    if (!match) continue

    const insertLines = hunk.lines.filter(l => l.startsWith(' ') || l.startsWith('+'))
      .map(l => l.slice(1))

    lines.splice(startLine, oldLines.length, ...insertLines)
    offset += insertLines.length - oldLines.length
    applied++
  }

  return { result: lines.join('\n'), applied, errors }
}

export const APPLY_PATCH_TOOL_DEFINITION = {
  name: 'apply_patch',
  description: 'Apply a unified diff (patch) to a file. Uses standard unified diff format with @@ -old,count +new,count @@ hunks. Lines starting with " " are context, "-" are removed, "+" are added. More reliable than edit for complex multi-block edits.',
  parameters: {
    path: { type: 'string' as const, description: 'File path to patch', required: true },
    patch: { type: 'string' as const, description: 'Unified diff content to apply', required: true },
  },
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const filePath = params.path as string
    const patch = params.patch as string

    if (!filePath) return 'Error: path is required'
    if (!patch) return 'Error: patch is required'

    const resolved = safePath(filePath)
    if (!resolved) return `Error: Path "${filePath}" is outside the working directory`

    try {
      let content: string
      try {
        content = await fs.readFile(resolved, 'utf-8')
      } catch {
        content = ''
      }

      const hunks = parsePatch(patch)
      if (hunks.length === 0) return 'Error: No valid hunks found in patch'

      const { result, applied, errors } = applyHunks(content, hunks)

      let output = `Applied ${applied} of ${hunks.length} hunks`
      if (errors.length > 0) {
        output += `\nErrors (${errors.length}):\n${errors.join('\n')}`
      }
      if (applied > 0) {
        await fs.writeFile(resolved, result, 'utf-8')
        addFile(filePath)
        output += `\nFile updated: ${filePath}`
      }
      return output
    } catch (err) {
      return `Error applying patch: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
