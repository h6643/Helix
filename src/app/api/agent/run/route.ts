/**
 * SSE streaming API route for Agent execution.
 * Receives user instruction, starts Agent Loop, pushes events in real-time.
 */

import { NextRequest } from 'next/server'
import { runAgentLoop, type AgentMessage } from '@/lib/agent/loop'
import { createRequestContext, runWithContext } from '@/lib/agent/sandbox'
import { createApprovalRequest, waitForApproval } from '@/lib/agent/approval'
import { validateApiToken } from '@/lib/agent/auth'
import { checkRateLimit } from '@/lib/agent/rate-limit'
import { acquire, release } from '@/lib/agent/limits'
import { AgentRunRequestSchema } from '@/lib/validations'
import type { ApiConfig } from '@/stores/helix-store'

export async function POST(req: NextRequest) {
  try {
    // Authentication check
    if (!validateApiToken(req)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Rate limiting
    const ip = req.headers.get('x-forwarded-for') || 'unknown'
    const rateLimit = checkRateLimit(ip)
    
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimit.retryAfter),
        },
      })
    }

    // Acquire resource slot
    await acquire()

    try {
      const body = await req.json()
      const parsed = AgentRunRequestSchema.safeParse(body)
      
      if (!parsed.success) {
        return new Response(JSON.stringify({ error: parsed.error.issues }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const { messages, apiConfig, workDir } = parsed.data

      // Create request context for isolation
      const requestId = createRequestContext(workDir || process.cwd())
      const finalWorkDir = workDir || process.cwd()

      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          const sendEvent = (event: { type: string; content: string; toolName?: string; toolParams?: Record<string, unknown>; approvalId?: string }) => {
            const data = JSON.stringify(event)
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }

          try {
            // Run agent loop within request context
            await runWithContext(requestId, finalWorkDir, async () => {
              // Convert messages to AgentMessage format
              const agentMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content?: string }> = messages
                .filter((m: { role: string }) => m.role !== 'system')
                .map((m: { role: string; content: string }) => ({
                  role: m.role as 'user' | 'assistant',
                  content: m.content,
                }))

              const systemPrompt = messages.find((m: { role: string }) => m.role === 'system')?.content || '你是 Helix，一个专业的 AI 编程助手。'

              await runAgentLoop({
                apiConfig: apiConfig as ApiConfig,
                messages: agentMessages,
                systemPrompt,
                requestId,
                onEvent: (event) => {
                  sendEvent({
                    type: event.type,
                    content: event.content,
                    toolName: event.toolName,
                    toolParams: event.toolParams,
                    approvalId: event.approvalId,
                  })
                },
                onApprovalRequest: async (approvalId, toolName, params) => {
                  createApprovalRequest(approvalId, toolName, params)
                  sendEvent({ 
                    type: 'approval_request', 
                    content: `${toolName} needs approval`,
                    toolName, 
                    toolParams: params, 
                    approvalId 
                  })
                  return waitForApproval(approvalId)
                },
              })
            })
          } catch (err) {
            sendEvent({
              type: 'error',
              content: err instanceof Error ? err.message : String(err),
            })
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    } finally {
      // Release resource slot
      release()
    }
  } catch (error) {
    console.error('Agent API error:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
