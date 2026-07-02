#!/usr/bin/env node

/**
 * Helix Agent CLI
 * 用法:
 *   npx helix                    # 交互模式
 *   npx helix "指令"             # 单次模式
 *   npx helix --no-approve       # 跳过审批
 *   npx helix --workdir ./src    # 指定工作目录
 */

import readline from 'readline'
import { runAgentLoop } from './loop.mjs'
import { setWorkDir } from './tools.mjs'
import { displaySeparator, displayStatus, displayError } from './display.mjs'

// 解析命令行参数
const args = process.argv.slice(2)
let noApprove = false
let workDir = process.cwd()
let userMessage = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-approve') {
    noApprove = true
  } else if (args[i] === '--workdir' && args[i + 1]) {
    workDir = args[++i]
  } else if (!args[i].startsWith('--')) {
    userMessage = args[i]
  }
}

// 设置工作目录
setWorkDir(workDir)

// API 配置（从环境变量读取）
const apiConfig = {
  apiKey: process.env.HELIX_API_KEY || process.env.OPENAI_API_KEY || '',
  baseUrl: process.env.HELIX_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.HELIX_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
}

if (!apiConfig.apiKey) {
  displayError('请设置环境变量 HELIX_API_KEY 或 OPENAI_API_KEY')
  process.exit(1)
}

displaySeparator()
console.log('🤖 Helix Agent v1.0.0')
displaySeparator()
displayStatus(`工作目录: ${workDir}`)
displayStatus(`模型: ${apiConfig.model}`)
if (noApprove) {
  displayStatus('审批模式: 已禁用 (--no-approve)')
}
displaySeparator()

/**
 * 单次模式
 */
async function runOnce(message) {
  const result = await runAgentLoop({
    apiConfig,
    userMessage: message,
    noApprove,
  })
  process.exit(result ? 0 : 1)
}

/**
 * 交互模式
 */
async function runInteractive() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  console.log('\n输入消息开始对话，输入 /quit 退出\n')

  const ask = () => {
    rl.question('\x1b[36m❯ \x1b[0m', async (input) => {
      const trimmed = input.trim()

      if (!trimmed) {
        ask()
        return
      }

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\n👋 再见!\n')
        rl.close()
        process.exit(0)
      }

      if (trimmed === '/clear') {
        console.clear()
        ask()
        return
      }

      if (trimmed === '/help') {
        console.log('\n命令:')
        console.log('  /quit    - 退出')
        console.log('  /clear   - 清屏')
        console.log('  /help    - 显示帮助\n')
        ask()
        return
      }

      await runAgentLoop({
        apiConfig,
        userMessage: trimmed,
        noApprove,
      })

      ask()
    })
  }

  ask()
}

// 启动
if (userMessage) {
  runOnce(userMessage)
} else {
  runInteractive()
}
