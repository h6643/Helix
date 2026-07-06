/**
 * tools.mjs — 工具定义
 * 定义 Agent 可调用的工具
 */

import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

let workDir = process.cwd()

export function setWorkDir(dir) {
  workDir = path.resolve(dir)
}

export function getWorkDir() {
  return workDir
}

function safePath(filePath) {
  const resolved = path.resolve(workDir, filePath)
  if (!resolved.startsWith(workDir)) return null
  return resolved
}

/**
 * 读取文件
 */
async function readFile(params) {
  const resolved = safePath(params.path)
  if (!resolved) return `Error: Path "${params.path}" is outside working directory`
  try {
    return await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    return `Error: ${err.message}`
  }
}

/**
 * 写入文件
 */
async function writeFile(params) {
  const resolved = safePath(params.path)
  if (!resolved) return `Error: Path "${params.path}" is outside working directory`
  try {
    const dir = path.dirname(resolved)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolved, params.content, 'utf-8')
    return `File written: ${params.path}`
  } catch (err) {
    return `Error: ${err.message}`
  }
}

/**
 * 编辑文件
 */
async function editFile(params) {
  const resolved = safePath(params.path)
  if (!resolved) return `Error: Path "${params.path}" is outside working directory`
  try {
    let content = await fs.readFile(resolved, 'utf-8')
    if (!content.includes(params.old_string)) {
      return `Error: old_string not found in ${params.path}`
    }
    content = content.replace(params.old_string, params.new_string)
    await fs.writeFile(resolved, content, 'utf-8')
    return `File edited: ${params.path}`
  } catch (err) {
    return `Error: ${err.message}`
  }
}

/**
 * 执行命令
 */
async function runBash(params) {
  try {
    const { stdout, stderr } = await execAsync(params.command, {
      cwd: workDir,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
    let result = ''
    if (stdout) result += stdout
    if (stderr) result += `\n[stderr]\n${stderr}`
    return result || '(no output)'
  } catch (err) {
    return `Error: ${err.message}`
  }
}

/**
 * 列出文件
 */
async function listFiles(params) {
  const dir = params.path ? safePath(params.path) : workDir
  if (!dir) return `Error: Path is outside working directory`
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .map(e => `${e.isDirectory() ? '' : ''} ${e.name}`)
      .join('\n')
  } catch (err) {
    return `Error: ${err.message}`
  }
}

/**
 * 搜索文件内容
 */
async function searchFiles(params) {
  try {
    const { stdout } = await execAsync(
      `rg -n "${params.pattern}" "${workDir}" ${params.include ? `--include="${params.include}"` : ''}`,
      { timeout: 15000 }
    )
    return stdout || '(no matches found)'
  } catch (err) {
    return `Error: ${err.message}`
  }
}

export const tools = [
  {
    name: 'read_file',
    description: 'Read file content',
    parameters: {
      path: { type: 'string', description: 'File path', required: true },
    },
    execute: readFile,
  },
  {
    name: 'write_file',
    description: 'Write content to file',
    parameters: {
      path: { type: 'string', description: 'File path', required: true },
      content: { type: 'string', description: 'File content', required: true },
    },
    execute: writeFile,
  },
  {
    name: 'edit_file',
    description: 'Edit file by find and replace',
    parameters: {
      path: { type: 'string', description: 'File path', required: true },
      old_string: { type: 'string', description: 'String to find', required: true },
      new_string: { type: 'string', description: 'Replacement string', required: true },
    },
    execute: editFile,
  },
  {
    name: 'bash',
    description: 'Execute bash command',
    parameters: {
      command: { type: 'string', description: 'Command to execute', required: true },
    },
    execute: runBash,
  },
  {
    name: 'list_files',
    description: 'List files in directory',
    parameters: {
      path: { type: 'string', description: 'Directory path (optional)' },
    },
    execute: listFiles,
  },
  {
    name: 'search_files',
    description: 'Search file content',
    parameters: {
      pattern: { type: 'string', description: 'Search pattern', required: true },
      include: { type: 'string', description: 'File filter (e.g., "*.ts")' },
    },
    execute: searchFiles,
  },
]

export function getToolByName(name) {
  return tools.find(t => t.name === name)
}

export function toolsToOpenAIFunctions() {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, param]) => [
            key,
            { type: param.type, description: param.description },
          ])
        ),
        required: Object.entries(tool.parameters)
          .filter(([, p]) => p.required)
          .map(([k]) => k),
      },
    },
  }))
}
