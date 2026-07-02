/**
 * loop.mjs — Agent Loop 主循环
 * think → call_tool → observe → loop
 * 最多循环 20 轮
 */

import { tools, getToolByName, toolsToOpenAIFunctions, getApprovalRequiredTools } from './tools.mjs'
import { needsApproval, requestApproval } from './approval.mjs'
import { ContextManager } from './context.mjs'
import {
  displayThinking,
  displayToolCall,
  displayToolResult,
  displayResponse,
  displayError,
  displaySeparator,
} from './display.mjs'

const MAX_ITERATIONS = 20
const DEFAULT_SYSTEM_PROMPT = `你是 Helix Agent，一个专业的 AI 编程助手。
你可以使用工具来读写文件、执行命令、搜索代码。
请用中文回答，直接给出可执行的操作。`

/**
 * 调用 LLM API（OpenAI 格式）
 */
async function callLLM(apiConfig, messages, toolsList) {
  const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const body = {
    model: apiConfig.model,
    messages,
  }

  if (toolsList && toolsList.length > 0) {
    body.tools = toolsList
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
 * 主 Agent 循环
 */
export async function runAgentLoop(options) {
  const {
    apiConfig,
    userMessage,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    maxIterations = MAX_ITERATIONS,
    noApprove = false,
    onResult,
  } = options

  const context = new ContextManager()
  context.setSystemPrompt(systemPrompt)
  context.addMessage('user', userMessage)

  const openaiTools = toolsToOpenAIFunctions()

  displaySeparator()
  console.log(`🤖 Agent 启动`)
  displaySeparator()

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    displayThinking(`思考中... (轮次 ${iteration + 1}/${maxIterations})`)

    // 调用 LLM
    let result
    try {
      result = await callLLM(apiConfig, context.getMessages(), openaiTools)
    } catch (err) {
      displayError(err.message)
      onResult?.(null, err.message)
      return null
    }

    // 如果没有工具调用，返回文本响应
    if (!result.tool_calls || result.tool_calls.length === 0) {
      const finalText = result.content || '(no response)'
      context.addMessage('assistant', finalText)
      displaySeparator()
      displayResponse(finalText)
      onResult?.(finalText, null)
      return finalText
    }

    // 添加助手消息（含工具调用）
    context.addMessage('assistant', result.content || undefined)
    // 存储 tool_calls 信息
    const lastMsg = context.messages[context.messages.length - 1]
    lastMsg.tool_calls = result.tool_calls

    // 执行每个工具调用
    for (const toolCall of result.tool_calls) {
      const toolName = toolCall.function.name
      let params = {}
      try {
        params = JSON.parse(toolCall.function.arguments)
      } catch {
        params = {}
      }

      // 显示工具调用
      displayToolCall(toolName, params)

      // 检查是否需要审批
      const approved = await requestApproval(toolName, params, noApprove)
      if (!approved) {
        // 用户拒绝，跳过此工具调用
        context.addToolResult(toolCall.id, '(操作已跳过)')
        displayToolResult(toolName, '(操作已跳过)', false)
        continue
      }

      // 执行工具
      const tool = getToolByName(toolName)
      if (!tool) {
        const error = `Unknown tool: ${toolName}`
        context.addToolResult(toolCall.id, error)
        displayToolResult(toolName, error, true)
        continue
      }

      let toolResult
      try {
        toolResult = await tool.execute(params)
      } catch (err) {
        toolResult = `Error: ${err.message}`
      }

      // 显示工具结果
      const isError = toolResult.startsWith('Error:')
      displayToolResult(toolName, toolResult, isError)

      // 添加到上下文
      context.addToolResult(toolCall.id, toolResult)
    }
  }

  // 达到最大迭代次数
  const warning = `Agent 循环已达到最大次数 (${maxIterations})`
  displaySeparator()
  displayError(warning)
  onResult?.(null, warning)
  return null
}
