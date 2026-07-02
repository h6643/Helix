/**
 * context.mjs — 上下文管理
 * 维护消息历史数组，token 预算裁剪，工具结果摘要截断
 */

const DEFAULT_MAX_TOKENS = 8000
const TOOL_RESULT_MAX_LENGTH = 2000

export class ContextManager {
  constructor(maxTokens = DEFAULT_MAX_TOKENS) {
    this.messages = []
    this.maxTokens = maxTokens
  }

  /**
   * 添加消息
   */
  addMessage(role, content) {
    this.messages.push({ role, content })
    this.trimToBudget()
  }

  /**
   * 添加系统提示
   */
  setSystemPrompt(prompt) {
    const idx = this.messages.findIndex(m => m.role === 'system')
    if (idx >= 0) {
      this.messages[idx].content = prompt
    } else {
      this.messages.unshift({ role: 'system', content: prompt })
    }
  }

  /**
   * 添加工具结果
   */
  addToolResult(toolCallId, content) {
    // 截断过长的结果
    const truncated = content.length > TOOL_RESULT_MAX_LENGTH
      ? content.slice(0, TOOL_RESULT_MAX_LENGTH) + '\n... (truncated)'
      : content

    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: truncated,
    })
    this.trimToBudget()
  }

  /**
   * 裁剪到 token 预算
   * 保留 system prompt，裁剪早期消息
   */
  trimToBudget() {
    const estimatedTokens = this.estimateTokens()
    if (estimatedTokens <= this.maxTokens) return

    // 保留 system prompt
    const systemMsg = this.messages.find(m => m.role === 'system')
    const otherMessages = this.messages.filter(m => m.role !== 'system')

    // 从最早的消息开始裁剪，保留最新的
    while (otherMessages.length > 2 && this.estimateTokens() > this.maxTokens) {
      otherMessages.shift()
    }

    this.messages = systemMsg ? [systemMsg, ...otherMessages] : otherMessages
  }

  /**
   * 估算 token 数（粗略：1 token ≈ 4 字符）
   */
  estimateTokens() {
    const totalChars = this.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0)
    return Math.ceil(totalChars / 4)
  }

  /**
   * 获取当前消息列表
   */
  getMessages() {
    return [...this.messages]
  }

  /**
   * 清空历史（保留 system prompt）
   */
  clear() {
    const systemMsg = this.messages.find(m => m.role === 'system')
    this.messages = systemMsg ? [systemMsg] : []
  }
}
