/**
 * API route for approving/rejecting Agent operations.
 */

import { NextRequest } from 'next/server'
import { approveRequest, rejectRequest, getPendingApprovals, setCachedApproval, setAutoApproveAll, getApprovalRequest } from '@/lib/agent/approval'
import { validateApiToken } from '@/lib/agent/auth'
import { ApproveRequestSchema } from '@/lib/validations'

export async function POST(req: NextRequest) {
  // Authentication check
  if (!validateApiToken(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const body = await req.json()
    const parsed = ApproveRequestSchema.safeParse(body)
    
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.issues }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { approvalId, action, cache, approveAll } = parsed.data

    if (approveAll) {
      setAutoApproveAll()
    }

    if (action === 'approve') {
      const success = approveRequest(approvalId)
      if (!success) {
        return new Response(
          JSON.stringify({ error: 'Approval request not found or already resolved' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (cache) {
        const req = getApprovalRequest(approvalId)
        if (req && req.params.path) {
          const key = `${req.toolName}:${req.params.path as string}`
          setCachedApproval(key, true)
        }
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    } else {
      const success = rejectRequest(approvalId)
      if (!success) {
        return new Response(
          JSON.stringify({ error: 'Approval request not found or already resolved' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (cache) {
        const req = getApprovalRequest(approvalId)
        if (req && req.params.path) {
          const key = `${req.toolName}:${req.params.path as string}`
          setCachedApproval(key, false)
        }
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
  } catch (error) {
    console.error('Approve API error:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

export async function GET(req: NextRequest) {
  // Authentication check
  if (!validateApiToken(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const pending = getPendingApprovals()
  return new Response(JSON.stringify({ pending }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
