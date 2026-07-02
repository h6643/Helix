/**
 * display.mjs — 终端渲染
 * Agent 思考、工具调用、工具结果、Diff 展示
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
}

const TRUNCATE_LENGTH = 500

/**
 * 显示思考过程（灰色斜体）
 */
export function displayThinking(text) {
  console.log(`${COLORS.dim}${COLORS.gray}💭 ${text}${COLORS.reset}`)
}

/**
 * 显示工具调用（绿色）
 */
export function displayToolCall(toolName, params) {
  const paramsStr = formatParams(params)
  console.log(`${COLORS.green}🔧 ${toolName}(${paramsStr})${COLORS.reset}`)
}

/**
 * 显示工具结果（缩进，超长截断）
 */
export function displayToolResult(toolName, result, isError = false) {
  const color = isError ? COLORS.red : COLORS.gray
  const prefix = isError ? '❌' : '📦'
  const lines = result.split('\n')

  if (lines.length <= 3 && result.length <= TRUNCATE_LENGTH) {
    console.log(`${color}   ${prefix} ${result}${COLORS.reset}`)
  } else {
    console.log(`${color}   ${prefix} (${lines.length} lines, ${result.length} chars)${COLORS.reset}`)
    const truncated = result.slice(0, TRUNCATE_LENGTH)
    const truncatedLines = truncated.split('\n').slice(0, 10)
    for (const line of truncatedLines) {
      console.log(`${color}   │ ${line}${COLORS.reset}`)
    }
    if (result.length > TRUNCATE_LENGTH) {
      console.log(`${color}   │ ... (truncated)${COLORS.reset}`)
    }
  }
}

/**
 * 显示 Diff（红绿色标注）
 */
export function displayDiff(oldStr, newStr, filePath) {
  console.log(`${COLORS.cyan}📝 Diff: ${filePath}${COLORS.reset}`)

  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')

  // Simple diff display
  const maxLen = Math.max(oldLines.length, newLines.length)
  let hasChanges = false

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]

    if (oldLine === newLine) {
      console.log(`${COLORS.gray}   ${COLORS.dim}${i + 1}${COLORS.reset}  ${COLORS.gray} ${oldLine || ''}${COLORS.reset}`)
    } else {
      hasChanges = true
      if (oldLine !== undefined) {
        console.log(`${COLORS.red}   -${i + 1} ${oldLine}${COLORS.reset}`)
      }
      if (newLine !== undefined) {
        console.log(`${COLORS.green}   +${i + 1} ${newLine}${COLORS.reset}`)
      }
    }
  }

  if (!hasChanges) {
    console.log(`${COLORS.gray}   (no changes)${COLORS.reset}`)
  }
}

/**
 * 显示最终回复
 */
export function displayResponse(text) {
  console.log()
  console.log(`${COLORS.bold}${COLORS.white}${text}${COLORS.reset}`)
  console.log()
}

/**
 * 显示错误
 */
export function displayError(text) {
  console.log(`${COLORS.red}❌ Error: ${text}${COLORS.reset}`)
}

/**
 * 显示分隔线
 */
export function displaySeparator() {
  console.log(`${COLORS.gray}${'─'.repeat(50)}${COLORS.reset}`)
}

/**
 * 显示状态
 */
export function displayStatus(text) {
  console.log(`${COLORS.cyan}ℹ️  ${text}${COLORS.reset}`)
}

/**
 * 显示成功
 */
export function displaySuccess(text) {
  console.log(`${COLORS.green}✅ ${text}${COLORS.reset}`)
}

/**
 * 格式化工具参数
 */
function formatParams(params) {
  const entries = Object.entries(params)
  if (entries.length === 0) return ''

  return entries
    .map(([key, value]) => {
      if (typeof value === 'string') {
        // 截断长字符串
        const truncated = value.length > 50 ? value.slice(0, 50) + '...' : value
        return `${key}="${truncated}"`
      }
      return `${key}=${JSON.stringify(value)}`
    })
    .join(', ')
}
