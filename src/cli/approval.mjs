/**
 * approval.mjs — 审批交互
 * 读操作直接放行，写操作暂停等待用户确认
 */

import readline from 'readline'
import { displayDiff, displayToolCall, displayStatus } from './display.mjs'

const READ_TOOLS = ['read_file', 'list_files', 'search_files']
const WRITE_TOOLS = ['write_file', 'edit_file', 'bash']

/**
 * 创建 readline 接口
 */
function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
}

/**
 * 询问用户确认
 */
function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase())
    })
  })
}

/**
 * 检查工具是否需要审批
 */
export function needsApproval(toolName) {
  return WRITE_TOOLS.includes(toolName)
}

/**
 * 请求审批
 * @returns {Promise<boolean>} 是否批准
 */
export async function requestApproval(toolName, params, noApprove = false) {
  // 读操作直接放行
  if (READ_TOOLS.includes(toolName)) {
    return true
  }

  // --no-approve 模式全部放行
  if (noApprove) {
    return true
  }

  const rl = createReadline()

  try {
    displayStatus(`需要审批: ${toolName}`)

    // 显示操作详情
    if (toolName === 'write_file') {
      console.log(`\n  📄 文件: ${params.path}`)
      console.log(`  📝 内容预览:`)
      const content = params.content || ''
      const preview = content.length > 300 ? content.slice(0, 300) + '\n...' : content
      console.log(`  ${preview.split('\n').map(l => `  │ ${l}`).join('\n')}`)
    } else if (toolName === 'edit_file') {
      console.log(`\n  📄 文件: ${params.path}`)
      if (params.old_string && params.new_string) {
        displayDiff(params.old_string, params.new_string, params.path)
      }
    } else if (toolName === 'bash') {
      console.log(`\n  🔧 命令: ${params.command}`)
    }

    // 询问确认
    const answer = await askQuestion(rl, '\n  执行? (y/n): ')
    const approved = ['y', 'yes'].includes(answer)

    if (approved) {
      console.log(`  ${'\x1b[32m'}✅ 已批准${'\x1b[0m'}`)
    } else {
      console.log(`  ${'\x1b[33m'}⏭️  已跳过${'\x1b[0m'}`)
    }

    return approved
  } finally {
    rl.close()
  }
}
