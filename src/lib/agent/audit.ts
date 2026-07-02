/**
 * Audit logging for Agent tool executions.
 * In-memory ring buffer with configurable max entries.
 */

export interface AuditEntry {
  timestamp: number
  requestId?: string
  toolName: string
  params: Record<string, unknown>
  result: string
  duration: number
}

const auditLog: AuditEntry[] = []
const MAX_ENTRIES = 10000

export function logToolExecution(entry: Omit<AuditEntry, 'timestamp'>): void {
  auditLog.push({
    ...entry,
    timestamp: Date.now(),
  })
  
  if (auditLog.length > MAX_ENTRIES) {
    auditLog.shift()
  }
}

export function getAuditLog(limit?: number): AuditEntry[] {
  return limit ? auditLog.slice(-limit) : [...auditLog]
}