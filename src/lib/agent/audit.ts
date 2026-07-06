import fs from 'fs'
import path from 'path'

interface ToolExecutionLog {
  requestId?: string
  toolName: string
  params: Record<string, unknown>
  result: string | undefined
  duration: number
}

export interface FileChangeRecord {
  timestamp: number
  requestId?: string
  filePath: string
  changeType: 'add' | 'modify' | 'delete'
  toolName: string
  contentBefore?: string
  contentAfter?: string
  diff?: string
  rollbackAvailable: boolean
}

const changeLog: FileChangeRecord[] = []
const AUDIT_LOG_MAX = 500

const SNAPSHOT_DIR = process.env.AUDIT_SNAPSHOT_DIR || '.helix-snapshots'

export function logToolExecution(entry: ToolExecutionLog): void {
  if (entry.duration > 1000) {
    console.log(`[Audit] ${entry.toolName} (${entry.duration}ms)`)
  }
}

function ensureSnapshotDir(): void {
  const dir = path.resolve(SNAPSHOT_DIR)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function captureSnapshot(requestId: string | undefined, filePath: string): string | null {
  try {
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved)) return null
    ensureSnapshotDir()
    const ts = Date.now()
    const snapshotFile = path.join(SNAPSHOT_DIR, `${ts}-${path.basename(filePath)}.snap`)
    fs.copyFileSync(resolved, snapshotFile)
    return snapshotFile
  } catch {
    return null
  }
}

export function recordFileChange(record: FileChangeRecord): void {
  changeLog.push(record)
  if (changeLog.length > AUDIT_LOG_MAX) {
    changeLog.splice(0, changeLog.length - AUDIT_LOG_MAX)
  }
  console.log(`[Audit] ${record.changeType} ${record.filePath} (via ${record.toolName})`)
  writeAuditEntry(record)
}

export function getChangeLog(): FileChangeRecord[] {
  return [...changeLog]
}

export function getRecentChanges(limit: number = 20): FileChangeRecord[] {
  return changeLog.slice(-limit).reverse()
}

function writeAuditEntry(record: FileChangeRecord): void {
  try {
    ensureSnapshotDir()
    const logFile = path.join(SNAPSHOT_DIR, 'audit.jsonl')
    const line = JSON.stringify(record) + '\n'
    fs.appendFileSync(logFile, line, 'utf-8')
  } catch {
    // Non-critical
  }
}
