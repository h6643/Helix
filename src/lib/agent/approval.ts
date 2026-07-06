/**
 * Approval mechanism for Agent write operations.
 * Stores pending approvals and handles approve/reject.
 */

export interface PendingApproval {
  id: string
  toolName: string
  params: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
  resolvedAt?: number
}

// In-memory store for pending approvals
const pendingApprovals = new Map<string, PendingApproval>()

// Callbacks waiting for approval resolution
const waitingCallbacks = new Map<string, {
  resolve: (approved: boolean) => void
  reject: (error: Error) => void
}>()

let autoApproveAll = false

const approvalCache = new Map<string, boolean>()

export function setAutoApproveAll(): void {
  autoApproveAll = true
}

export function getCachedApproval(key: string): boolean | undefined {
  return approvalCache.get(key)
}

export function setCachedApproval(key: string, approved: boolean): void {
  approvalCache.set(key, approved)
}

const PER_ACTION_TIMEOUTS: Record<string, number> = {
  write_file: 2 * 60 * 1000,
  edit_file: 2 * 60 * 1000,
  run_bash: 3 * 60 * 1000,
}

/**
 * Create a new approval request
 */
export function createApprovalRequest(
  approvalId: string,
  toolName: string,
  params: Record<string, unknown>
): PendingApproval {
  const request: PendingApproval = {
    id: approvalId,
    toolName,
    params,
    status: 'pending',
    createdAt: Date.now(),
  }
  pendingApprovals.set(approvalId, request)
  return request
}

/**
 * Wait for approval (returns a promise that resolves when approved/rejected)
 */
export function waitForApproval(approvalId: string, toolName?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (autoApproveAll) {
      const request = pendingApprovals.get(approvalId)
      if (request) {
        request.status = 'approved'
        request.resolvedAt = Date.now()
      }
      resolve(true)
      return
    }

    waitingCallbacks.set(approvalId, { resolve, reject: (e) => resolve(false) })

    const timeout = (toolName && PER_ACTION_TIMEOUTS[toolName]) || 5 * 60 * 1000
    setTimeout(() => {
      if (waitingCallbacks.has(approvalId)) {
        waitingCallbacks.delete(approvalId)
        const request = pendingApprovals.get(approvalId)
        if (request) {
          request.status = 'rejected'
          request.resolvedAt = Date.now()
        }
        resolve(false)
      }
    }, timeout)
  })
}

/**
 * Approve a pending request
 */
export function approveRequest(approvalId: string): boolean {
  const request = pendingApprovals.get(approvalId)
  if (!request || request.status !== 'pending') {
    return false
  }

  request.status = 'approved'
  request.resolvedAt = Date.now()

  const callback = waitingCallbacks.get(approvalId)
  if (callback) {
    waitingCallbacks.delete(approvalId)
    callback.resolve(true)
  }

  return true
}

/**
 * Reject a pending request
 */
export function rejectRequest(approvalId: string): boolean {
  const request = pendingApprovals.get(approvalId)
  if (!request || request.status !== 'pending') {
    return false
  }

  request.status = 'rejected'
  request.resolvedAt = Date.now()

  const callback = waitingCallbacks.get(approvalId)
  if (callback) {
    waitingCallbacks.delete(approvalId)
    callback.resolve(false)
  }

  return true
}

/**
 * Get a pending approval request
 */
export function getApprovalRequest(approvalId: string): PendingApproval | undefined {
  return pendingApprovals.get(approvalId)
}

/**
 * Get all pending approval requests
 */
export function getPendingApprovals(): PendingApproval[] {
  return Array.from(pendingApprovals.values()).filter(r => r.status === 'pending')
}

/**
 * Cleanup old approvals (older than 1 hour)
 */
export function cleanupApprovals(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  for (const [id, request] of pendingApprovals.entries()) {
    if (request.createdAt < oneHourAgo) {
      pendingApprovals.delete(id)
      waitingCallbacks.delete(id)
    }
  }
}
