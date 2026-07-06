import { tools, getToolByName, toolsToOpenAIFunctions, type ToolDefinition } from './tools'
import { safePath } from './sandbox'
import { logToolExecution, recordFileChange, captureSnapshot } from './audit'
import { agentPermission, type PermissionRuleset } from '@/lib/helix/permission'
import { buildRequestBody, parseResponse } from '@/lib/helix/llm'
import { getEnvApiKey } from '@/lib/helix/providers'
import { runWithContext } from './sandbox'
import { getCwd } from '@/lib/helix/context'
import type { ApiConfig } from '@/stores/helix-store'
import { capturePreSnapshot, computeDiff, resetSnapshot } from './snapshot'
import { getCachedApproval, setCachedApproval } from './approval'
import { withRetry, defaultRetryPolicy, parseRetryAfter, retryWithBackoff, type RetryPolicy } from './retry'

export interface AgentEvent {
  type: 'thinking' | 'reasoning' | 'tool_call' | 'tool_result' | 'approval_request' | 'question_request' | 'text' | 'error' | 'done' | 'plan' | 'task' | 'usage' | 'compact' | 'file_change'
  content: string
  toolName?: string
  toolParams?: Record<string, unknown>
  approvalId?: string
  questionId?: string
  questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean }>
  finishReason?: string
  planText?: string
  taskLabel?: string
  taskId?: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number }
  fileChanges?: Array<{ path: string; type: 'add' | 'modify' | 'delete'; diff: string }>
  timestamp: number
}

export interface TextPart {
  type: 'text'
  text: string
}

export interface ReasoningPart {
  type: 'reasoning'
  reasoning: string
  signature?: string
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: string
  isError?: boolean
}

export interface FilePart {
  type: 'file'
  path: string
  diff?: string
}

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | FilePart

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  parts?: MessagePart[]
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
  permissions?: PermissionRuleset
  allowedTools?: string[]
  customTools?: ToolDefinition[]
  onEvent?: (event: AgentEvent) => void
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  onApprovalRequest?: (approvalId: string, toolName: string, params: Record<string, unknown>) => Promise<boolean>
}

const MAX_ITERATIONS = 50
const DOOM_LOOP_THRESHOLD = 3

function extractToolSignature(name: string, params: Record<string, unknown>): string {
  const keyFields: Record<string, string[]> = {
    grep: ['pattern', 'include'],
    glob: ['pattern'],
    read_file: ['path'],
    write_file: ['path'],
    edit_file: ['path'],
    delete_file: ['path'],
    create_file: ['path'],
    rename_file: ['path'],
    list_directory: ['path'],
    bash: ['command'],
    webfetch: ['url'],
    web_fetch: ['url'],
    websearch: ['query'],
    question: ['questions'],
    run_task: ['task'],
  }
  const fields = keyFields[name] || Object.keys(params).slice(0, 1)
  const sig: Record<string, unknown> = {}
  for (const f of fields) {
    if (f in params) sig[f] = params[f]
  }
  return `${name}:${JSON.stringify(sig)}`
}

function detectDoomLoop(toolHistory: Array<{ name: string; params: string }>): { isDoomLoop: boolean; detail: string } {
  if (toolHistory.length < DOOM_LOOP_THRESHOLD) return { isDoomLoop: false, detail: '' }

  const recent = toolHistory.slice(-10)
  const sigCount = new Map<string, number>()
  for (const h of recent) {
    const hParams = safeParseParams(h.params)
    const sig = extractToolSignature(h.name, hParams)
    sigCount.set(sig, (sigCount.get(sig) || 0) + 1)
  }

  for (const [sig, count] of sigCount) {
    if (count >= DOOM_LOOP_THRESHOLD) {
      const [toolName] = sig.split(':')
      return { isDoomLoop: true, detail: `工具 "${toolName}" 相同参数已调用 ${count} 次` }
    }
  }

  return { isDoomLoop: false, detail: '' }
}

function smartTruncate(result: string, toolName: string, maxTokens: number = 2000): string {
  const approx = (s: string) => {
    let t = 0
    for (const c of s) { t += c.charCodeAt(0) < 128 ? 0.25 : 1 }
    return Math.ceil(t)
  }

  if (approx(result) <= maxTokens) return result

  const lines = result.split('\n')

  if (toolName === 'read_file') {
    const head = lines.slice(0, 80)
    const tail = lines.slice(-20)
    const skipped = lines.length - 100
    return head.join('\n') + `\n... (skipped ${skipped} lines) ...\n` + tail.join('\n')
  }

  if (toolName === 'grep' || toolName === 'glob') {
    const truncated = lines.slice(0, 50).map(l => l.length > 200 ? l.slice(0, 200) + '...' : l)
    if (lines.length > 50) truncated.push(`... (${lines.length - 50} more lines)`)
    return truncated.join('\n')
  }

  if (toolName === 'run_bash' || toolName === 'bash') {
    const headLen = Math.floor(result.length * 0.6)
    const head = result.slice(0, headLen)
    const tail = result.slice(-Math.floor(headLen / 2))
    return head + `\n... (truncated, ${approx(result) - maxTokens}+ tokens) ...\n` + tail
  }

  let chars = 0
  let idx = 0
  while (idx < result.length && chars < maxTokens * 4) {
    chars += result.charCodeAt(idx) < 128 ? 0.25 : 1
    idx++
  }
  return result.slice(0, idx) + `\n... (truncated at ~${maxTokens} tokens)`
}

function safeParseParams(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) } catch { return {} }
}

const LOW_RISK_TOOLS = new Set(['read_file', 'list_directory', 'glob', 'grep', 'websearch', 'webfetch', 'web_fetch'])

async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  onApprovalRequest?: (approvalId: string, toolName: string, params: Record<string, unknown>) => Promise<boolean>,
  permissions?: PermissionRuleset,
  customTools?: ToolDefinition[],
): Promise<string> {
  let tool = getToolByName(toolName)
  if (!tool && customTools) {
    tool = customTools.find(t => t.name === toolName)
  }
  if (!tool) {
    return `Error: Unknown tool "${toolName}"`
  }

  // Auto-approve low-risk read-only tools
  if (LOW_RISK_TOOLS.has(toolName)) {
    return tool.execute(params)
  }

  const actionMap: Record<string, string> = {
    read_file: 'read',
    write_file: 'write',
    edit_file: 'edit',
    run_bash: 'bash',
    glob: 'glob',
    grep: 'grep',
    list_directory: 'list_directory',
    memory_add: 'write',
    memory_read: 'read',
    webfetch: 'webfetch',
    websearch: 'webfetch',
    web_extractor: 'webfetch',
    browser_navigate: 'webfetch',
    browser_click: 'webfetch',
    browser_type: 'webfetch',
    browser_screenshot: 'webfetch',
    browser_get_html: 'webfetch',
    git_status: 'read',
    git_diff: 'read',
    git_log: 'read',
    git_branch: 'read',
    git_commit: 'write',
    create_artifact: 'write',
    spawn_agent: 'read',
    get_sub_agent_result: 'read',
    run_task: 'read',
  }
  const action = actionMap[toolName] || toolName
  const resource = (params.path as string) || (params.command as string) || (params.pattern as string) || '*'
  const permission = agentPermission(action, resource, permissions)

  const WRITE_TOOLS = ['write_file', 'edit_file', 'run_bash', 'bash', 'delete_file', 'create_file', 'rename_file', 'apply_patch', 'git_commit']

  if (permission.effect === 'deny') {
    if (WRITE_TOOLS.includes(toolName)) {
      ;(globalThis as any).__helixStopRequested = true
    }
    return `Error: Tool "${toolName}" is denied by permission rules`
  }

  if (permission.effect === 'ask' && onApprovalRequest) {
    const cacheKey = `${toolName}:${resource}`
    const cached = getCachedApproval(cacheKey)
    if (cached !== undefined) {
      if (!cached && WRITE_TOOLS.includes(toolName)) {
        ;(globalThis as any).__helixStopRequested = true
      }
      return cached ? tool.execute(params) : `Tool "${toolName}" was rejected by user (cached)`
    }

    const approvalId = `approval-${Date.now()}`
    const approved = await onApprovalRequest(approvalId, toolName, params)

    setCachedApproval(cacheKey, approved)

    if (!approved) {
      if (WRITE_TOOLS.includes(toolName)) {
        ;(globalThis as any).__helixStopRequested = true
      }
      return `Tool "${toolName}" was rejected by user`
    }
  }

  return tool.execute(params)
}

const MAX_CONTEXT_TOKENS = 262144
const TRUNCATION_THRESHOLD = 200000
const PRUNE_PROTECT = 40000
const MIN_KEEP_ROUNDS = 10

function approxTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    tokens += char.charCodeAt(0) < 128 ? 0.25 : 1
  }
  return Math.ceil(tokens)
}

function extractTextContent(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === 'text')
      .map(p => ('text' in p ? p.text : '') || '')
      .join('\n')
  }
  return ''
}

function countMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    const text = extractTextContent(msg.content)
    if (text) total += approxTokens(text)
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += approxTokens(tc.function.name + tc.function.arguments)
      }
    }
  }
  return total
}

function pruneMessages(messages: AgentMessage[]): AgentMessage[] {
  const total = countMessagesTokens(messages)
  // PRUNE_PROTECT: don't prune unless we can save at least PRUNE_PROTECT tokens
  if (total < TRUNCATION_THRESHOLD + PRUNE_PROTECT) return messages

  const keep: AgentMessage[] = [messages[0]]
  let keptTokens = approxTokens(extractTextContent(messages[0].content))

  let firstUserIdx = -1
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      firstUserIdx = i
      break
    }
  }
  if (firstUserIdx > 0) {
    keep.push(messages[firstUserIdx])
    keptTokens += approxTokens(extractTextContent(messages[firstUserIdx].content))
  }

  // Collect all tool messages to check for skill tool outputs (never prune those)
  const skillMessages = new Set<number>()
  for (let i = firstUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === 'tool' && extractTextContent(messages[i].content).includes('skill')) {
      // Check if a recent assistant tool_call was 'skill'
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === 'assistant' && messages[j].tool_calls) {
          for (const tc of messages[j].tool_calls!) {
            if (tc.function.name === 'skill' || tc.function.name === 'run_task') {
              skillMessages.add(i)
            }
          }
        }
      }
    }
  }

  let endIdx = messages.length
  const recent: AgentMessage[] = []
  let roundsKept = 0

  // Walk backwards, keep recent rounds + skill tool outputs
  const alwaysKeep = new Set<number>()
  for (const idx of skillMessages) alwaysKeep.add(idx)

  for (let i = messages.length - 1; i > firstUserIdx; i--) {
    if (roundsKept >= MIN_KEEP_ROUNDS * 2 && !alwaysKeep.has(i)) break
    recent.push(messages[i])
    keptTokens += approxTokens(extractTextContent(messages[i].content))
    if (messages[i].tool_calls) {
      for (const tc of messages[i].tool_calls!) {
        keptTokens += approxTokens(tc.function.name + tc.function.arguments)
      }
    }
    endIdx = i
    roundsKept++
  }
  keep.push(...recent.reverse())

  if (keptTokens >= TRUNCATION_THRESHOLD || endIdx <= firstUserIdx + 1) {
    return keep
  }

  const truncatedCount = endIdx - firstUserIdx - 1
  if (truncatedCount > 0) {
    const truncatedMsgs = messages.slice(firstUserIdx + 1, endIdx)
    const fileOps = truncatedMsgs
      .filter(m => m.tool_calls)
      .flatMap(m => m.tool_calls!.map(tc => tc.function.name))
    const uniqueOps = [...new Set(fileOps)].join(', ')

    keep.splice(2, 0, {
      role: 'user',
      content: `[上下文已压缩：之前 ${truncatedCount} 条消息被截断。已执行的操作: ${uniqueOps || '无'}。请根据后续消息继续任务。]`,
    })
  }

  return keep
}

const DEFAULT_AGENT_GLOBAL_TIMEOUT = 300_000

export function getGlobalTimeout(maxIterations: number): number {
  const envTimeout = process.env.AGENT_GLOBAL_TIMEOUT ? parseInt(process.env.AGENT_GLOBAL_TIMEOUT, 10) : NaN
  if (!isNaN(envTimeout) && envTimeout > 0) return envTimeout * 1000
  return Math.max(maxIterations * 12000, DEFAULT_AGENT_GLOBAL_TIMEOUT)
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  const {
    apiConfig,
    messages: initialMessages,
    systemPrompt,
    maxIterations = MAX_ITERATIONS,
    requestId,
    permissions,
    allowedTools,
    customTools,
    onEvent,
    onDelta,
    onReasoning,
    onApprovalRequest,
  } = options

  ;(globalThis as any).__helixRequestId = requestId
  ;(globalThis as any).__helixCompressRequested = false
  ;(globalThis as any).__helixStopRequested = false
  // Expose todo store for todoread tool
  if (!(globalThis as any).__helixTodoStore) {
    ;(globalThis as any).__helixTodoStore = []
  }

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    ...initialMessages,
  ]

  const allCustomTools = customTools || []
  const allToolNames = [
    ...(allowedTools || tools.map(t => t.name)),
    ...allCustomTools.map(t => t.name),
  ]
  const openaiTools = toolsToOpenAIFunctions(allToolNames, allCustomTools)
  const toolHistory: Array<{ name: string; params: string }> = []
  let doomLoopTriggered = false
  let doomLoopCooldown = 0
  let shouldStop = false

  const usageAccumulator = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const COMPACT_THRESHOLD = 500000
  let compacted = false

  const startTime = Date.now()

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if ((globalThis as any).__helixStopRequested || shouldStop) {
      ;(globalThis as any).__helixStopRequested = false
      const msg = 'Agent loop stopped by stopWhen'
      onEvent?.({ type: 'done', content: msg, finishReason: 'stopped', timestamp: Date.now() })
      return msg
    }
    const globalTimeout = getGlobalTimeout(maxIterations)
    if (Date.now() - startTime > globalTimeout) {
      const warning = `Agent loop timed out after ${globalTimeout / 1000}s`
      onEvent?.({ type: 'error', content: warning, timestamp: Date.now() })
      return warning
    }

    onEvent?.({
      type: 'thinking',
      content: `[${iteration + 1}/${maxIterations}] 处理中...`,
      timestamp: Date.now(),
    })

    let result: {
      content: string | null
      reasoning?: string
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      finish_reason?: string
      usage?: LLMUsage
    }
    try {
      let truncated = pruneMessages(messages)

      // Check if Compress tool was called
      if ((globalThis as any).__helixCompressRequested) {
        ;(globalThis as any).__helixCompressRequested = false
        const totalTokens = countMessagesTokens(truncated)
        const summary = await compactContext(apiConfig, truncated)
        if (summary) {
          lastSummary = summary
          const lastToolResults = truncated.filter(m => m.role === 'tool').slice(-4)
          const lastMessages = truncated.filter(m => m.role !== 'system' && m.role !== 'tool').slice(-3)
          truncated = [
            truncated[0],
            { role: 'system', content: `<system-reminder>Context compressed. Previous conversation summary: ${summary}</system-reminder>` },
            ...lastMessages,
            ...lastToolResults,
          ]
          const savings = totalTokens - countMessagesTokens(truncated)
          onEvent?.({ type: 'compact', content: `Context compressed. Saved ~${savings} tokens.\n${summary.slice(0, 500)}`, timestamp: Date.now() })
        }
      } else if (!compacted && iteration > 3) {
        const totalTokens = countMessagesTokens(truncated)
        if (totalTokens > COMPACT_THRESHOLD) {
          const summary = await compactContext(apiConfig, truncated)
          if (summary) {
            lastSummary = summary
            const lastToolResults = truncated.filter(m => m.role === 'tool').slice(-4)
            const lastMessages = truncated.filter(m => m.role !== 'system' && m.role !== 'tool').slice(-3)
            truncated = [
              truncated[0],
              { role: 'system', content: `<system-reminder>Context compressed. Previous conversation summary: ${summary}</system-reminder>` },
              ...lastMessages,
              ...lastToolResults,
            ]
            compacted = true
            const savings = totalTokens - countMessagesTokens(truncated)
            onEvent?.({ type: 'compact', content: `Context compressed. Saved ~${savings} tokens.\n${summary.slice(0, 500)}`, timestamp: Date.now() })
          }
        }
      }

      if (openaiTools) {
        console.log(`[Agent] Sending ${openaiTools.length} tools to LLM: ${openaiTools.map(t => t.function.name).join(', ')}`)
      }

      result = await callLLMWithRetry(apiConfig, truncated, openaiTools, onDelta, onReasoning)

      console.log(`[Agent] Iter ${iteration + 1}: finish_reason=${result.finish_reason}, tool_calls=${result.tool_calls?.length || 0}, content=${result.content?.slice(0, 100) || 'null'}`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      onEvent?.({ type: 'error', content: errorMsg, timestamp: Date.now() })
      return errorMsg
    }

    if (result.reasoning) {
      onEvent?.({ type: 'reasoning', content: result.reasoning, timestamp: Date.now() })
    }

    if (result.tool_calls && result.tool_calls.length > 0) {
      console.log(`[Agent] Iter ${iteration + 1}: ${result.tool_calls.length} tool calls: ${result.tool_calls.map(tc => tc.function.name).join(', ')}`)
      if (result.reasoning) console.log(`[Agent] Reasoning: ${result.reasoning.slice(0, 200)}...`)
    }

    if (result.usage) {
      usageAccumulator.prompt_tokens += result.usage.prompt_tokens || 0
      usageAccumulator.completion_tokens += result.usage.completion_tokens || 0
      usageAccumulator.total_tokens += result.usage.total_tokens || 0

      const model = apiConfig.model.toLowerCase()
      let costPer1KInput = 0.003; let costPer1KOutput = 0.015
      if (model.includes('opus') || model.includes('mythos') || model.includes('fable')) {
        costPer1KInput = 0.015; costPer1KOutput = 0.075
      } else if (model.includes('sonnet')) {
        costPer1KInput = 0.003; costPer1KOutput = 0.015
      } else if (model.includes('haiku') || model.includes('4o-mini') || model.includes('gpt-4o-mini')) {
        costPer1KInput = 0.00015; costPer1KOutput = 0.0006
      } else if (model.includes('gpt-4') || model.includes('claude-3')) {
        costPer1KInput = 0.01; costPer1KOutput = 0.03
      }
      const cost = ((result.usage.prompt_tokens || 0) / 1000 * costPer1KInput) +
                   ((result.usage.completion_tokens || 0) / 1000 * costPer1KOutput)
      const totalCost = (usageAccumulator.prompt_tokens / 1000 * costPer1KInput) +
                        (usageAccumulator.completion_tokens / 1000 * costPer1KOutput)

      onEvent?.({
        type: 'usage',
        content: `Tokens: ${usageAccumulator.total_tokens} total | Cost: $${totalCost.toFixed(4)} | Model: ${apiConfig.model}`,
        usage: {
          prompt_tokens: usageAccumulator.prompt_tokens,
          completion_tokens: usageAccumulator.completion_tokens,
          total_tokens: usageAccumulator.total_tokens,
          cost: totalCost,
        },
        timestamp: Date.now(),
      })
    }

    if (result.finish_reason === 'length') {
      const warning = 'Response truncated due to token limit'
      onEvent?.({ type: 'error', content: warning, timestamp: Date.now() })
    }

    if (!result.tool_calls || result.tool_calls.length === 0) {
      // If the model hasn't made any tool calls at all on the first iteration,
      // give it one nudge to use tools. After that, trust its judgment.
      if (toolHistory.length === 0 && iteration === 0 && iteration + 1 < maxIterations) {
        onEvent?.({ type: 'thinking', content: '引导模型使用工具...', timestamp: Date.now() })
        messages.push({ role: 'assistant', content: result.content || '' })
        messages.push({
          role: 'user',
          content: 'Your text response is noted. Please continue working on the original task — read relevant files, make changes, or run commands as needed. Stop only when the task is complete.',
        })
        continue
      }

      const finalText = result.content || null
      if (finalText) {
        if (!onDelta) {
          onEvent?.({ type: 'text', content: finalText, timestamp: Date.now() })
        }
      } else if (toolHistory.length > 0) {
        const fileCount = toolHistory.filter(t => ['write_file', 'edit_file', 'create_file'].includes(t.name)).length
        const toolCount = toolHistory.length
        const summary = `完成 ${toolCount} 步工具调用，修改 ${fileCount} 个文件`
        onEvent?.({ type: 'text', content: summary, timestamp: Date.now() })
      }
      onEvent?.({
        type: 'done',
        content: `Agent loop completed in ${iteration + 1} iterations`,
        finishReason: result.finish_reason,
        timestamp: Date.now(),
      })
      return finalText || '(no response)'
    }

    const currentToolCalls = result.tool_calls.map(tc => {
      let params: Record<string, unknown> = {}
      try { params = JSON.parse(tc.function.arguments) } catch { params = {} }
      return { id: tc.id, name: tc.function.name, params }
    })

    // Doom loop detection: auto-guide model to break pattern without user approval
    if (!doomLoopTriggered && doomLoopCooldown <= 0) {
      const doomCheck = detectDoomLoop(toolHistory)
      if (doomCheck.isDoomLoop) {
        doomLoopTriggered = true
        doomLoopCooldown = 5
        onEvent?.({ type: 'thinking', content: `Detected repeated tool calls (${doomCheck.detail}). Guiding model to change approach.`, timestamp: Date.now() })
        messages.push({ role: 'assistant', content: result.content || '', tool_calls: result.tool_calls })
        messages.push({
          role: 'user',
          content: 'You appear to be repeating the same tool calls. Stop and reassess. Try a different approach or ask the user for clarification. Do not repeat the same tool calls.',
        })
        continue
      }
    }
    if (doomLoopCooldown > 0) doomLoopCooldown--

    messages.push({
      role: 'assistant',
      content: result.content || undefined,
      tool_calls: result.tool_calls,
    })

    const hasFileTools = result.tool_calls.some(tc =>
      ['write_file', 'edit_file', 'delete_file', 'create_file', 'rename_file', 'bash'].includes(tc.function.name)
    )
    if (hasFileTools) {
      capturePreSnapshot()
    }

    for (const toolCall of currentToolCalls) {
      const { id: tcId, name: toolName, params } = toolCall

      toolHistory.push({ name: toolName, params: JSON.stringify(params) })

      if (['read_file', 'write_file', 'edit_file'].includes(toolName) && params.path) {
        const resolved = safePath(params.path as string)
        if (!resolved) {
          let errorMsg = `Error: Path "${params.path}" is outside the working directory`
          if (toolName === 'edit_file') {
            errorMsg = `Error: edit_file 的路径 "${params.path}" 超出工作目录。文件已被修改，请先读取最新版本再编辑。尝试使用 read_file 获取当前文件内容后重新编辑。`
          }
          messages.push({ role: 'tool', tool_call_id: tcId, content: errorMsg })
          onEvent?.({ type: 'tool_result', content: errorMsg, toolName, timestamp: Date.now() })
          continue
        }
      }

      onEvent?.({
        type: 'tool_call',
        content: `Calling ${toolName}`,
        toolName,
        toolParams: params,
        timestamp: Date.now(),
      })

      if (toolName === 'question') {
        try {
          const qs = typeof params.questions === 'string' ? JSON.parse(params.questions as string) : params.questions
          const qid = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          params._questionId = qid
          onEvent?.({
            type: 'question_request',
            content: 'Question for user',
            questionId: qid,
            questions: qs,
            timestamp: Date.now(),
          })
        } catch { /* ignore parse errors, tool.execute will report them */ }
      }

      const startTime = Date.now()
      let toolResult = await executeTool(toolName, params, onApprovalRequest, permissions, allCustomTools)
      if (toolName === 'edit_file' && (toolResult.toLowerCase().includes('oldstring') || toolResult.toLowerCase().includes('could not find'))) {
        toolResult = '文件已被修改，请先读取最新版本再编辑。尝试使用 read_file 获取当前文件内容后重新编辑。\n\n' + toolResult
      }
      const duration = Date.now() - startTime

      logToolExecution({
        requestId,
        toolName,
        params,
        result: toolResult.slice(0, 500),
        duration,
      })

      if (toolName === 'plan_enter') {
        onEvent?.({
          type: 'plan',
          content: toolResult.slice(0, 2000),
          planText: (params.plan as string) || toolResult,
          timestamp: Date.now(),
        })
      }

      if (toolName === 'todowrite' && (params.action as string) === 'create') {
        onEvent?.({
          type: 'task',
          content: toolResult.slice(0, 2000),
          taskLabel: (params.label as string) || '',
          taskId: (params.id as string) || '',
          timestamp: Date.now(),
        })
      }

      onEvent?.({
        type: 'tool_result',
        content: smartTruncate(toolResult, toolName, 500),
        toolName,
        timestamp: Date.now(),
      })

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: smartTruncate(toolResult, toolName, 2000),
      })
    }

    if (hasFileTools) {
      const fileChanges = computeDiff()
      if (fileChanges.length > 0) {
        for (const fc of fileChanges) {
          recordFileChange({
            timestamp: Date.now(),
            requestId,
            filePath: fc.path,
            changeType: fc.type,
            toolName: currentToolCalls.find(t => ['write_file', 'edit_file', 'create_file', 'delete_file', 'bash'].includes(t.name))?.name || 'unknown',
            diff: fc.diff,
            rollbackAvailable: true,
          })
        }
        onEvent?.({
          type: 'file_change',
          content: `Modified ${fileChanges.length} file(s)`,
          fileChanges,
          timestamp: Date.now(),
        })
      }
      resetSnapshot()
    }
  }

  const totalCalls = toolHistory.length
  const fileChanges = computeDiff()
  onEvent?.({
    type: 'done',
    content: `Max iterations (${maxIterations}) reached. ${totalCalls} tool calls, ${fileChanges.length} file(s) changed.`,
    finishReason: 'max_iterations',
    timestamp: Date.now(),
  })
  return `Agent loop stopped after ${maxIterations} iterations`
}

interface LLMUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

async function callLLMWithRetry(
  apiConfig: ApiConfig,
  messages: AgentMessage[],
  tools?: ReturnType<typeof toolsToOpenAIFunctions>,
  onDelta?: (text: string) => void,
  onReasoning?: (text: string) => void,
  maxRetries: number = 5,
): Promise<{
  content: string | null
  reasoning?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  finish_reason?: string
  usage?: LLMUsage
}> {
  const policy: RetryPolicy = {
    ...defaultRetryPolicy(),
    maxAttempts: maxRetries,
  }

  const result = await withRetry(
    () => callLLM(apiConfig, messages, tools, onDelta, onReasoning),
    policy,
  )

  if (!result.ok) throw result.error
  return result.value
}

async function callLLM(
  apiConfig: ApiConfig,
  messages: AgentMessage[],
  tools?: ReturnType<typeof toolsToOpenAIFunctions>,
  onDelta?: (text: string) => void,
  onReasoning?: (text: string) => void,
): Promise<{
  content: string | null
  reasoning?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  finish_reason?: string
  usage?: LLMUsage
}> {
  const providerKey = apiConfig.provider as string
  const providerID = providerKey === 'custom' ? 'openai' : providerKey
  const apiKey = apiConfig.apiKey || getEnvApiKey(providerID) || ''

  const { url, headers, body } = buildRequestBody(providerID, {
    model: apiConfig.model,
    messages: messages as any,
    tools: tools as any,
    stream: true,
  }, apiConfig.baseUrl)

  // Debug: log request body
  console.log(`[LLM] Request to ${url}, body length: ${body.length}, starts with: ${body.slice(0, 50)}`)

  const authHeaders: Record<string, string> = { ...headers }
  if (providerID === 'anthropic') {
    authHeaders['x-api-key'] = apiKey
  } else if (providerID === 'google') {
    authHeaders['x-goog-api-key'] = apiKey
  } else {
    authHeaders['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders,
    body,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    let errorMsg = `LLM API error (${response.status})`

    // Extract retry-after header
    const retryAfter = response.headers.get('retry-after') || response.headers.get('retry-after-ms')
    if (retryAfter) {
      errorMsg += `\nretry-after: ${retryAfter}`
    }

    try {
      const errorJson = JSON.parse(errorBody)
      if (errorJson.error?.message) {
        errorMsg += `: ${errorJson.error.message}`
      }
    } catch {
      errorMsg += `: ${errorBody.slice(0, 300)}`
    }
    errorMsg += `\n\n请求 URL: ${url}\n模型: ${apiConfig.model}`

    if (response.status === 429) {
      errorMsg += '\n\n请求频率过高，retry-after: ' + (retryAfter || '未知')
    }

    // If tools caused the error, retry without tools
    if (response.status === 400 && body.includes('"tools"') && tools && tools.length > 0) {
      console.log('[LLM] Retrying without tools due to 400 error')
      const { body: retryBody } = buildRequestBody(providerID, {
        model: apiConfig.model,
        messages: messages as any,
        stream: true,
      }, apiConfig.baseUrl)
      const retryResponse = await fetch(url, {
        method: 'POST',
        headers: authHeaders,
        body: retryBody,
      })
      if (retryResponse.ok) {
        const retryResult = await retryResponse.json()
        const parsed = parseResponse(providerID, retryResult)
        return {
          content: parsed.content,
          tool_calls: undefined,
          finish_reason: parsed.finish_reason,
          usage: parsed.usage,
        }
      }
    }

    if (response.status === 404) {
      errorMsg += '\n可能原因：模型名称不存在或 API 端点不正确。请检查设置中的模型名称和 Base URL。'
    } else if (response.status === 401) {
      errorMsg += '\n\n可能原因：API Key 无效或已过期。'
    } else if (response.status === 429) {
      errorMsg += '\n\n可能原因：请求频率过高，请稍后重试。'
    }
    throw new Error(errorMsg)
  }

  if (!response.body) {
    const result = await response.json()
    const parsed = parseResponse(providerID, result)
    if (!parsed.content && !parsed.tool_calls) throw new Error('No response from LLM')
    return {
      content: parsed.content,
      tool_calls: parsed.tool_calls,
      finish_reason: parsed.finish_reason,
      usage: parsed.usage,
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let inReasoningBlock = false
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let finishReason: string | undefined
  const format = providerID === 'anthropic' ? 'anthropic' : providerID === 'google' ? 'google' : 'openai'
  let pendingToolIdx = -1
  let usageData: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') break

      try {
        const json = JSON.parse(data)

        if (format === 'anthropic') {
          if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
            inReasoningBlock = true
          } else if (json.type === 'content_block_delta' && json.delta?.thinking) {
            reasoning += json.delta.thinking
            onReasoning?.(json.delta.thinking)
          } else if (json.type === 'content_block_delta' && json.delta?.text) {
            if (inReasoningBlock) {
              reasoning += json.delta.text
              onReasoning?.(json.delta.text)
            } else {
              content += json.delta.text
              onDelta?.(json.delta.text)
            }
          } else if (json.type === 'content_block_stop' && inReasoningBlock) {
            inReasoningBlock = false
          } else if (json.type === 'message_start' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'tool_use') {
                const idx = toolCalls.size
                toolCalls.set(idx, { id: block.id, name: block.name, arguments: JSON.stringify(block.input) })
              }
            }
          } else if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
            pendingToolIdx++
            const cb = json.content_block
            toolCalls.set(pendingToolIdx, { id: cb.id, name: cb.name, arguments: '' })
          } else if (json.type === 'content_block_delta' && json.delta?.partial_json) {
            const existing = toolCalls.get(pendingToolIdx)
            if (existing) existing.arguments += json.delta.partial_json
          } else if (json.type === 'message_delta' && json.delta?.stop_reason) {
            finishReason = json.delta.stop_reason === 'end_turn' ? 'stop' : json.delta.stop_reason
          } else if (json.type === 'message_delta' && json.usage) {
            usageData = {
              prompt_tokens: json.usage.input_tokens,
              completion_tokens: json.usage.output_tokens,
              total_tokens: (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0),
            }
          }
        } else {
          // OpenAI / compatible
          const choice = json.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta
          if (!delta) continue

          if (json.choices?.[0]?.delta?.reasoning_content) {
            reasoning += json.choices[0].delta.reasoning_content
            onReasoning?.(json.choices[0].delta.reasoning_content)
          }
          if (json.choices?.[0]?.delta?.reasoning) {
            reasoning += json.choices[0].delta.reasoning
            onReasoning?.(json.choices[0].delta.reasoning)
          }

          if (delta.content) {
            content += delta.content
            onDelta?.(delta.content)
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' })
              }
              const existing = toolCalls.get(idx)!
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.arguments += tc.function.arguments
            }
          }

          // Collect usage data from OpenAI stream
          if (json.usage) {
            usageData = {
              prompt_tokens: json.usage.prompt_tokens,
              completion_tokens: json.usage.completion_tokens,
              total_tokens: json.usage.total_tokens,
            }
          }
        }
      } catch { /* parse error — skip malformed chunk */ }
    }
  }

  if (buffer.trim().startsWith('data: ')) {
    const data = buffer.trim().slice(6)
    if (data !== '[DONE]') {
      try {
        const json = JSON.parse(data)
        if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason
      } catch {}
    }
  }

  if (!reasoning) {
    const thinkRegex = /<thinking>([\s\S]*?)<\/thinking>/g
    let m: RegExpExecArray | null
    const extracted: string[] = []
    let cleanContent = content
    while ((m = thinkRegex.exec(content)) !== null) {
      extracted.push(m[1])
      cleanContent = cleanContent.replace(m[0], '')
    }
    if (extracted.length > 0) {
      reasoning = extracted.join('\n')
      content = cleanContent.trim()
    }
  }

  const toolCallsResult = toolCalls.size > 0
    ? Array.from(toolCalls.values()).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined

  return {
    content: content || null,
    reasoning: reasoning || undefined,
    tool_calls: toolCallsResult,
    finish_reason: finishReason,
    usage: usageData,
  }
}

let lastSummary: string | null = null
let lastSummaryTokenCount = 0

const COMPACT_TARGET_TOKENS = 4000

async function compactContext(apiConfig: ApiConfig, messages: AgentMessage[]): Promise<string | null> {
  const totalTokenEstimate = countMessagesTokens(messages)
  const preserveRatio = Math.min(COMPACT_TARGET_TOKENS / Math.max(totalTokenEstimate, 1), 0.8)

  const systemMsg = messages[0]
  const toolMessages = messages.filter(m => m.role === 'tool')
  const nonToolMessages = messages.filter(m => m.role !== 'system' && m.role !== 'tool')

  const lastAssistantWithTools = messages.filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0).slice(-3)
  const lastToolResults = toolMessages.slice(-4)
  const lastUserMessages = nonToolMessages.filter(m => m.role === 'user').slice(-2)
  const lastAssistantText = nonToolMessages.filter(m => m.role === 'assistant' && (!m.tool_calls || m.tool_calls.length === 0)).slice(-2)

  const keyMessages = [...lastUserMessages, ...lastAssistantText, ...lastAssistantWithTools, ...lastToolResults]

  const compactPrompt = lastSummary
    ? 'Continue the summary of this conversation. Previous summary:\n' +
      lastSummary + '\n\n' +
      'Update the JSON with any new developments:\n' +
      '{\n' +
      '  "decisions": ["decision 1", "decision 2"],\n' +
      '  "files_changed": [{"path": "src/foo.ts", "change": "added bar function"}],\n' +
      '  "current_status": "what is being worked on now",\n' +
      '  "remaining": ["step 1", "step 2"],\n' +
      '  "key_findings": ["important technical detail"]\n' +
      '}\n\n' +
      'Include relevant details from the previous summary in the new one.'
    : 'Summarize this conversation into a structured JSON-like format:\n' +
      '{\n' +
      '  "decisions": ["decision 1", "decision 2"],\n' +
      '  "files_changed": [{"path": "src/foo.ts", "change": "added bar function"}],\n' +
      '  "current_status": "what is being worked on now",\n' +
      '  "remaining": ["step 1", "step 2"],\n' +
      '  "key_findings": ["important technical detail"]\n' +
      '}\n\n' +
      'Keep each entry under 30 words. Omit tool call/result details.'

  const compactMessages: AgentMessage[] = [
    { role: 'system', content: 'You are a context compression assistant. Output ONLY valid JSON.' },
    ...keyMessages.slice(-10),
    { role: 'user', content: compactPrompt },
  ]

  try {
    const result = await callLLMWithRetry(apiConfig, compactMessages)
    const raw = result.content || ''
    const parsed = (() => { try { return JSON.parse(raw) } catch { return null } })()
    if (parsed) {
      lastSummary = raw
      lastSummaryTokenCount = approxTokens(raw)
      return raw
    }
    // If not valid JSON, still use it
    lastSummary = raw
    lastSummaryTokenCount = approxTokens(raw)
    return raw
  } catch {
    return lastSummary || null
  }
}
