/**
 * LLM request formatter supporting multiple provider formats
 * Ported from Helix's AISDK integration
 * Handles: openai, anthropic, google, ollama
 */

import { getRequestFormat, getProvider } from './providers'

export interface ImageContentPart {
  type: 'image_url'
  image_url: { url: string }
}

export interface TextContentPart {
  type: 'text'
  text: string
}

export type MultimodalContent = string | Array<TextContentPart | ImageContentPart>

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: MultimodalContent
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface LLMFunctionDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMRequestPayload {
  model: string
  messages: LLMChatMessage[]
  tools?: LLMFunctionDefinition[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
}

export interface LLMResponse {
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  finish_reason?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function formatOpenAIMessages(messages: LLMChatMessage[]): Record<string, unknown>[] {
  return messages.map(m => {
    const msg: Record<string, unknown> = { role: m.role }
    if (m.content !== undefined) msg.content = m.content
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    return msg
  })
}

function formatAnthropicMessages(messages: LLMChatMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  let systemContent = ''

  for (const m of messages) {
    if (m.role === 'system') {
      systemContent += (typeof m.content === 'string' ? m.content : '') + '\n'
      continue
    }
    if (m.role === 'tool') {
      result.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }],
      })
      continue
    }
    if (m.role === 'assistant' && m.tool_calls) {
      result.push({
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        tool_calls: m.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })),
      })
      continue
    }

    // Handle multimodal content for user messages
    if (m.role === 'user' && Array.isArray(m.content)) {
      const contentParts = m.content.map(p => {
        if (p.type === 'image_url' && 'image_url' in p) {
          const url = (p as { image_url: { url: string } }).image_url.url
          // Parse data URL to extract media type and base64 data
          const match = url.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1],
                data: match[2],
              }
            }
          }
        }
        if (p.type === 'text' && 'text' in p) {
          return { type: 'text', text: (p as { text: string }).text }
        }
        return p
      })
      result.push({ role: 'user', content: contentParts })
    } else {
      result.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })
    }
  }

  if (systemContent) result.unshift({ role: 'system', content: systemContent })
  return result
}

function formatGoogleMessages(messages: LLMChatMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant' && m.tool_calls) {
      const parts: Record<string, unknown>[] = []
      if (typeof m.content === 'string' && m.content) parts.push({ text: m.content })
      for (const tc of m.tool_calls) {
        parts.push({
          functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) },
        })
      }
      result.push({ role: 'model', parts })
      continue
    }
    if (m.role === 'tool') {
      result.push({
        role: 'function',
        parts: [{ functionResponse: { name: 'tool', response: { response: typeof m.content === 'string' ? m.content : '' } } }],
      })
      continue
    }

    // Handle multimodal content for user messages
    if (m.role === 'user' && Array.isArray(m.content)) {
      const parts = m.content.map(p => {
        if (p.type === 'image_url' && 'image_url' in p) {
          const url = (p as { image_url: { url: string } }).image_url.url
          const match = url.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            return {
              inlineData: {
                mimeType: match[1],
                data: match[2],
              }
            }
          }
        }
        if (p.type === 'text' && 'text' in p) {
          return { text: (p as { text: string }).text }
        }
        return p
      })
      result.push({ role: 'user', parts })
    } else {
      result.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }] })
    }
  }
  return result
}

function formatOllamaMessages(messages: LLMChatMessage[]): Record<string, unknown>[] {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const msg: Record<string, unknown> = { role: m.role }
      if (m.content !== undefined) msg.content = m.content
      if (m.tool_calls) msg.tool_calls = m.tool_calls.map(tc => ({
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }))
      return msg
    })
}

function formatOllamaTools(tools?: LLMFunctionDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }))
}

function formatGoogleTools(tools?: LLMFunctionDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return
  return tools.map(t => ({
    functionDeclarations: [{
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }],
  }))
}

function formatAnthropicTools(tools?: LLMFunctionDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

function normalizeUrl(base: string): string {
  let url = base.trim()
  // Strip trailing slash
  if (url.endsWith('/')) url = url.slice(0, -1)
  return url
}

export function buildRequestBody(
  providerID: string,
  payload: LLMRequestPayload,
  baseUrlOverride?: string,
): { url: string; headers: Record<string, string>; body: string } {
  const provider = getProvider(providerID)
  const baseUrl = normalizeUrl(baseUrlOverride || provider?.baseUrl || 'https://api.openai.com/v1')
  const format = getRequestFormat(providerID)

  switch (format) {
    case 'anthropic': {
      const messages = formatAnthropicMessages(payload.messages)
      let system = ''
      const nonSystemMessages = messages.filter(m => {
        if (m.role === 'system') { system += (m.content as string || '') + '\n'; return false }
        return true
      })
      const body: Record<string, unknown> = {
        model: payload.model,
        max_tokens: payload.max_tokens ?? 8192,
        messages: nonSystemMessages,
      }
      if (system.trim()) body.system = system.trim()
      if (payload.tools) body.tools = formatAnthropicTools(payload.tools)
      if (payload.stream) body.stream = true
      return {
        url: `${baseUrl}/messages`,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      }
    }

    case 'google': {
      const contents = formatGoogleMessages(payload.messages)
      const systemParts = payload.messages.filter(m => m.role === 'system').map(m => ({ text: m.content }))
      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: payload.temperature ?? 0,
          maxOutputTokens: payload.max_tokens ?? 8192,
        },
      }
      if (systemParts.length > 0) body.systemInstruction = { parts: systemParts }
      if (payload.tools) body.tools = formatGoogleTools(payload.tools)
      const streamSuffix = payload.stream ? '?alt=sse' : ''
      return {
        url: `${baseUrl}/models/${payload.model}:generateContent${streamSuffix}`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    }

    case 'ollama': {
      const messages = formatOllamaMessages(payload.messages)
      const systemMsg = payload.messages.find(m => m.role === 'system')
      const body: Record<string, unknown> = {
        model: payload.model,
        messages,
        stream: payload.stream ?? false,
      }
      if (systemMsg?.content) body.system = systemMsg.content
      if (payload.tools) body.tools = formatOllamaTools(payload.tools)
      return {
        url: `${baseUrl}/chat/completions`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    }

    default: {
      const messages = formatOpenAIMessages(payload.messages)
      const body: Record<string, unknown> = {
        model: payload.model,
        messages,
        temperature: payload.temperature ?? 0,
        max_tokens: payload.max_tokens ?? 8192,
      }
      // Only include tools if they exist and the API supports them
      if (payload.tools && payload.tools.length > 0) {
        // Filter out tools with empty parameters
        const validTools = payload.tools.filter(t =>
          t.function?.name && t.function?.parameters?.properties
        )
        if (validTools.length > 0) {
          body.tools = validTools
        }
      }
      if (payload.stream) body.stream = true

      // Validate JSON before sending
      let bodyStr: string
      try {
        bodyStr = JSON.stringify(body)
      } catch (err) {
        console.error('[LLM] JSON stringify failed:', err)
        // Remove tools and try again
        delete body.tools
        bodyStr = JSON.stringify(body)
      }

      return {
        url: `${baseUrl}/chat/completions`,
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
      }
    }
  }
}

function parseOpenAIResponse(data: any): LLMResponse {
  const choice = data.choices?.[0]
  if (!choice) return { content: null }
  return {
    content: choice.message?.content || null,
    tool_calls: choice.message?.tool_calls,
    finish_reason: choice.finish_reason,
    usage: data.usage ? {
      prompt_tokens: data.usage.prompt_tokens,
      completion_tokens: data.usage.completion_tokens,
      total_tokens: data.usage.total_tokens,
    } : undefined,
  }
}

function parseAnthropicResponse(data: any): LLMResponse {
  if (data.type === 'error') throw new Error(`Anthropic API error: ${data.error?.message || JSON.stringify(data)}`)
  const content: string[] = []
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  for (const block of data.content || []) {
    if (block.type === 'text') content.push(block.text)
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })
    }
  }
  return {
    content: content.join('') || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason,
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    } : undefined,
  }
}

function parseGoogleResponse(data: any): LLMResponse {
  const candidate = data.candidates?.[0]
  if (!candidate) return { content: null }
  const content: string[] = []
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  for (const part of candidate.content?.parts || []) {
    if (part.text) content.push(part.text)
    if (part.functionCall) {
      toolCalls.push({
        id: `fc-${Date.now()}`,
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) },
      })
    }
  }
  return {
    content: content.join('') || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    finish_reason: candidate.finishReason === 'STOP' ? 'stop' : candidate.finishReason === 'TOOL_CALL' ? 'tool_calls' : candidate.finishReason,
    usage: data.usageMetadata ? {
      prompt_tokens: data.usageMetadata.promptTokenCount,
      completion_tokens: data.usageMetadata.candidatesTokenCount,
      total_tokens: data.usageMetadata.totalTokenCount,
    } : undefined,
  }
}

export function parseResponse(providerID: string, data: any): LLMResponse {
  const format = getRequestFormat(providerID)
  switch (format) {
    case 'anthropic': return parseAnthropicResponse(data)
    case 'google': return parseGoogleResponse(data)
    default: return parseOpenAIResponse(data)
  }
}
