/**
 * Sub-agent/task tool for Helix
 * Allows the agent to delegate complex multi-step work to a child agent
 */

import { tools as allTools, getToolByName, toolsToOpenAIFunctions } from '../agent/tools'
import type { ApiConfig } from '@/stores/helix-store'
import { buildRequestBody, parseResponse } from './llm'
import { getEnvApiKey } from './providers'
import type { PermissionRuleset } from './permission'

export interface TaskInput {
  description: string
  tools?: string[]
  limit?: number
}

const TASK_MAX_ITERATIONS = 10

async function callLLM(
  apiConfig: ApiConfig,
  messages: Array<{ role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }>,
  functions?: ReturnType<typeof toolsToOpenAIFunctions>,
): Promise<{ content: string | null; tool_calls?: any[]; finish_reason?: string }> {
  const providerKey = apiConfig.provider as string
  const providerID = providerKey === 'custom' ? 'openai' : providerKey
  const apiKey = apiConfig.apiKey || getEnvApiKey(providerID) || ''

  const { url, headers, body } = buildRequestBody(providerID, {
    model: apiConfig.model,
    messages: messages as any,
    tools: functions as any,
    stream: false,
  })

  const authHeaders: Record<string, string> = { ...headers }
  if (providerID === 'anthropic') authHeaders['x-api-key'] = apiKey
  else if (providerID === 'google') authHeaders['x-goog-api-key'] = apiKey
  else authHeaders['Authorization'] = `Bearer ${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders,
    body,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Sub-agent LLM error (${response.status}): ${errorBody.slice(0, 500)}`)
  }

  return parseResponse(providerID, await response.json())
}

export async function runTask(
  input: TaskInput,
  apiConfig: ApiConfig,
  permissions?: PermissionRuleset,
): Promise<string> {
  const toolFilter = input.tools && input.tools.length > 0
    ? allTools.filter(t => input.tools!.includes(t.name))
    : allTools.filter(t => t.name !== 'run_bash' && t.name !== 'edit_file' && t.name !== 'write_file')

  const functions = toolFilter.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([key, param]) => [
            key,
            { type: param.type, description: param.description },
          ]),
        ),
        required: Object.entries(t.parameters)
          .filter(([, param]) => param.required)
          .map(([key]) => key),
      },
    },
  }))

  const messages: Array<{ role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }> = [
    {
      role: 'system',
      content: `You are a task-focused sub-agent. Your goal:\n\n${input.description}\n\nComplete this task using the available tools. Return your final answer when done.`,
    },
  ]

  let result = ''
  for (let i = 0; i < (input.limit ?? TASK_MAX_ITERATIONS); i++) {
    const response = await callLLM(apiConfig, messages, functions)

    if (!response.tool_calls || response.tool_calls.length === 0) {
      result = response.content || '(no output)'
      break
    }

    if (response.content) {
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls })
    } else {
      messages.push({ role: 'assistant', tool_calls: response.tool_calls })
    }

    for (const tc of response.tool_calls) {
      const tool = getToolByName(tc.function.name)
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: Unknown tool "${tc.function.name}"` })
        continue
      }

      let params: Record<string, unknown> = {}
      try { params = JSON.parse(tc.function.arguments) } catch { params = {} }

      const toolResult = await tool.execute(params)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult.slice(0, 3000) })
    }
  }

  return result || `Task completed after ${input.limit ?? TASK_MAX_ITERATIONS} iterations`
}

export const TASK_TOOL_DEFINITION = {
  name: 'run_task',
  description: 'Delegate a complex multi-step task to a sub-agent. Use for research, exploration, or multi-file changes.',
  parameters: {
    description: { type: 'string' as const, description: 'Task description for the sub-agent', required: true },
    tools: { type: 'string' as const, description: 'Comma-separated tool names the sub-agent can use (default: read-only tools)' },
    limit: { type: 'number' as const, description: 'Max sub-agent iterations (default: 10)' },
  },
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const input: TaskInput = {
      description: params.description as string,
      tools: typeof params.tools === 'string' ? params.tools.split(',').map(t => t.trim()) : undefined,
      limit: params.limit ? Number(params.limit) : undefined,
    }
    const apiConfig: ApiConfig = (globalThis as any).__helixApiConfig
    if (!apiConfig) return 'Error: No API config available for sub-agent'
    return runTask(input, apiConfig)
  },
}
