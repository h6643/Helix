import fs from 'fs/promises'

interface FileChange {
  path: string
  type: 'add' | 'modify' | 'delete'
  diff: string
}

let preSnapshot: Map<string, string> | null = null

export function capturePreSnapshot(): void {
  preSnapshot = new Map()
}

function trackFile(filePath: string): void {
  if (!preSnapshot) return
  try {
    const content = require('fs').readFileSync(filePath, 'utf-8')
    preSnapshot.set(filePath, content)
  } catch {
    // File doesn't exist yet — mark as new
    preSnapshot.set(filePath, '')
  }
}

export function trackFileWrite(filePath: string): void {
  if (!preSnapshot) {
    // If no snapshot was started, start one now
    preSnapshot = new Map()
  }
  trackFile(filePath)
}

export function computeDiff(): FileChange[] {
  if (!preSnapshot) return []

  const changes: FileChange[] = []

  for (const [filePath, oldContent] of preSnapshot) {
    try {
      const newContent = require('fs').readFileSync(filePath, 'utf-8')
      if (oldContent === '') {
        // File was new (didn't exist before)
        changes.push({
          path: filePath,
          type: 'add',
          diff: generateDiff('', newContent),
        })
      } else if (oldContent !== newContent) {
        changes.push({
          path: filePath,
          type: 'modify',
          diff: generateDiff(oldContent, newContent),
        })
      }
    } catch {
      // File was deleted
      if (oldContent !== '') {
        changes.push({
          path: filePath,
          type: 'delete',
          diff: generateDiff(oldContent, ''),
        })
      }
    }
  }

  return changes
}

function generateDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const diff: string[] = []

  const maxLen = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine === undefined) {
      diff.push(`+ ${newLine}`)
    } else if (newLine === undefined) {
      diff.push(`- ${oldLine}`)
    } else if (oldLine !== newLine) {
      diff.push(`- ${oldLine}`)
      diff.push(`+ ${newLine}`)
    }
  }

  return diff.slice(0, 50).join('\n') // Limit to 50 lines
}

export function resetSnapshot(): void {
  preSnapshot = null
}
