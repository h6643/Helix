/**
 * Agent Loop Engine
 * Core loop: call LLM → parse tool_call → execute tool → inject result → call LLM again
 * Stops when LLM returns plain text (no tool calls).
 */

import { tools, getToolByName, toolsToOpenAIFunctions, getApprovalRequiredTools } from './tools'
import { safePath } from './sandbox'
import { logToolExecution } from './audit'
import type { ApiConfig } from '@/stores/helix-store'

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'approval_request' | 'text' | 'error' | 'done'
  content: string
  toolName?: string
  toolParams?: Record<string, unknown>
  approvalId?: string
  timestamp: number
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

export interface AgentLoopOptions {
  apiConfig: ApiConfig
  messages: AgentMessage[]
  systemPrompt: string
  maxIterations?: number
  requestId?: string
  onEvent?: (event: AgentEvent) => void
  onApprovalRequest?: (approvalId: string, toolName: string, params: Record<string, unknown>) => Promise<boolean>
}

const MAX_ITERATIONS = 20

/**
 * Call LLM API (OpenAI-compatible format)
 */
async function callLLM(
  apiConfig: ApiConfig,
  messages: AgentMessage[],
  tools?: ReturnType<typeof toolsToOpenAIFunctions>
): Promise<{
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}> {
  const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const body: Record<string, unknown> = {
    model: apiConfig.model,
    messages,
    tools,
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`LLM API error (${response.status}): ${errorBody.slice(0, 500)}`)
  }

  const result = await response.json()
  const choice = result.choices?.[0]
  if (!choice) {
    throw new Error('No response from LLM')
  }

  return {
    content: choice.message?.content || null,
    tool_calls: choice.message?.tool_calls,
  }
}

/**
 * Execute a tool call
 */
async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  onApprovalRequest?: (approvalId: string, toolName: string, params: Record<string, unknown>) => Promise<boolean>
): Promise<string> {
  const tool = getToolByName(toolName)
  if (!tool) {
    return `Error: Unknown tool "${toolName}"`
  }

  // Check if approval is required
  const approvalRequired = getApprovalRequiredTools()
  if (approvalRequired.includes(toolName) && onApprovalRequest) {
    const approvalId = `approval-${Date.now()}`
    const approved = await onApprovalRequest(approvalId, toolName, params)
    if (!approved) {
      return `Tool "${toolName}" was rejected by user`
    }
  }

  return tool.execute(params)
}

/**
 * Main Agent Loop
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  const {
    apiConfig,
    messages: initialMessages,
    systemPrompt,
    maxIterations = MAX_ITERATIONS,
    requestId,
    onEvent,
    onApprovalRequest,
  } = options

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    ...initialMessages,
  ]

  const openaiTools = toolsToOpenAIFunctions()

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Emit thinking event
    onEvent?.({
      type: 'thinking',
      content: `Iteration ${iteration + 1}`,
      timestamp: Date.now(),
    })

    // Call LLM
    let result: { content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
    try {
      result = await callLLM(apiConfig, messages, openaiTools)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      onEvent?.({
        type: 'error',
        content: errorMsg,
        timestamp: Date.now(),
      })
      return errorMsg
    }

    // If no tool calls, return the text response
    if (!result.tool_calls || result.tool_calls.length === 0) {
      const finalText = result.content || '(no response)'
      onEvent?.({
        type: 'text',
        content: finalText,
        timestamp: Date.now(),
      })
      onEvent?.({
        type: 'done',
        content: 'Agent loop completed',
        timestamp: Date.now(),
      })
      return finalText
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: result.content || undefined,
      tool_calls: result.tool_calls,
    })

    // Execute each tool call
    for (const toolCall of result.tool_calls) {
      const toolName = toolCall.function.name
      let params: Record<string, unknown> = {}
      try {
        params = JSON.parse(toolCall.function.arguments)
      } catch {
        params = {}
      }

      // Validate paths for file operations
      if (['read_file', 'write_file', 'edit_file'].includes(toolName) && params.path) {
        const resolved = safePath(params.path as string)
        if (!resolved) {
          const errorMsg = `Error: Path "${params.path}" is outside the working directory`
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: errorMsg,
          })
          onEvent?.({
            type: 'tool_result',
            content: errorMsg,
            toolName,
            timestamp: Date.now(),
          })
          continue
        }
      }

      // Emit tool call event
      onEvent?.({
        type: 'tool_call',
        content: `Calling ${toolName}`,
        toolName,
        toolParams: params,
        timestamp: Date.now(),
      })

      // Execute tool with timing
      const startTime = Date.now()
      const result = await executeTool(toolName, params, onApprovalRequest)
      const duration = Date.now() - startTime

      // Log tool execution for audit
      logToolExecution({
        requestId,
        toolName,
        params,
        result: result.slice(0, 500),
        duration,
      })

      // Emit tool result event
      onEvent?.({
        type: 'tool_result',
        content: result.slice(0, 2000), // Truncate long results
        toolName,
        timestamp: Date.now(),
      })

      // Add tool result to messages
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      })
    }
  }

  // Max iterations reached
  const warning = `Agent loop stopped after ${maxIterations} iterations`
  onEvent?.({
    type: 'error',
    content: warning,
    timestamp: Date.now(),
  })
  return warning
}
