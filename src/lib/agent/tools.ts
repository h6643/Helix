/**
 * Tool definitions for the Agent system.
 * Each tool has a name, description, parameters schema, and execution function.
 */

import fs from 'fs/promises'
import { safePath, getWorkDir } from './sandbox'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean'
  description: string
  required?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, ToolParameter>
  execute: (params: Record<string, unknown>) => Promise<string>
}

/**
 * Read file content
 */
async function readFile(params: Record<string, unknown>): Promise<string> {
  const filePath = params.path as string
  const resolved = safePath(filePath)
  if (!resolved) {
    return `Error: Path "${filePath}" is outside the working directory`
  }
  try {
    const content = await fs.readFile(resolved, 'utf-8')
    return content
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Write file content
 */
async function writeFile(params: Record<string, unknown>): Promise<string> {
  const filePath = params.path as string
  const content = params.content as string
  const resolved = safePath(filePath)
  if (!resolved) {
    return `Error: Path "${filePath}" is outside the working directory`
  }
  try {
    // Ensure directory exists
    const dir = require('path').dirname(resolved)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolved, content, 'utf-8')
    return `File written successfully: ${filePath}`
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Edit file content (find and replace)
 */
async function editFile(params: Record<string, unknown>): Promise<string> {
  const filePath = params.path as string
  const oldString = params.old_string as string
  const newString = params.new_string as string
  const resolved = safePath(filePath)
  if (!resolved) {
    return `Error: Path "${filePath}" is outside the working directory`
  }
  try {
    let content = await fs.readFile(resolved, 'utf-8')
    if (!content.includes(oldString)) {
      return `Error: old_string not found in ${filePath}`
    }
    content = content.replace(oldString, newString)
    await fs.writeFile(resolved, content, 'utf-8')
    return `File edited successfully: ${filePath}`
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Validate command for safety (blocks dangerous commands)
 */
function validateCommand(cmd: string): { ok: boolean; reason?: string } {
  const trimmed = cmd.trim()
  
  // Block dangerous commands
  const BLOCKED_PATTERNS = [
    /\brm\s+(-[rRf]+\s+|--recursive)/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\bcurl\b.*\|\s*(ba)?sh/,
    /\bwget\b.*\|\s*(ba)?sh/,
    /\bchmod\s+777\b/,
    /\bsudo\b/,
    /\bkill\s+-9/,
    />\s*\/dev\/sd/,
    /\bmount\b/,
    /\bnc\s+-l/,
    /\bbash\s+-i/,
  ]
  
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `blocked command: ${pattern.source}` }
    }
  }
  
  // Block command substitution
  if (/\$\(.*\)/.test(trimmed) || /`[^`]+`/.test(trimmed)) {
    return { ok: false, reason: 'command substitution forbidden' }
  }
  
  // Limit pipe count
  if ((trimmed.match(/\|/g) || []).length > 2) {
    return { ok: false, reason: 'too many pipes' }
  }
  
  return { ok: true }
}

/**
 * Run bash command (with validation to prevent injection)
 */
async function runBash(params: Record<string, unknown>): Promise<string> {
  const command = params.command as string
  
  // Validate command before execution
  const validation = validateCommand(command)
  if (!validation.ok) {
    return `Error: Command rejected — ${validation.reason}`
  }
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: getWorkDir(),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
    let result = ''
    if (stdout) result += stdout
    if (stderr) result += `\n[stderr]\n${stderr}`
    return result || '(no output)'
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * List files using glob pattern
 */
async function glob(params: Record<string, unknown>): Promise<string> {
  const pattern = params.pattern as string
  try {
    const workDir = getWorkDir()
    const results: string[] = []
    const fs = require('fs')
    const path = require('path')

    function walkDir(dir: string, relativePath: string) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

          if (entry.isDirectory()) {
            walkDir(fullPath, relPath)
          } else if (entry.isFile()) {
            // Simple pattern matching
            if (pattern === '**/*' || pattern === '*' || relPath.includes(pattern.replace(/\*/g, ''))) {
              results.push(relPath)
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    walkDir(workDir, '')
    return results.length > 0 ? results.join('\n') : '(no files found)'
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Search file content using grep (with spawn to prevent command injection)
 */
async function grepTool(params: Record<string, unknown>): Promise<string> {
  const pattern = params.pattern as string
  const include = params.include as string | undefined
  const workDir = getWorkDir()
  const args = ['-n', pattern, workDir]
  if (include) args.push('--include', include)

  return new Promise<string>((resolve) => {
    const proc = spawn('rg', args, { 
      timeout: 15000, 
      stdio: ['ignore', 'pipe', 'pipe'] 
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', (code) => {
      resolve(code === 0 || stdout ? (stdout || '(no matches found)')
        : `Error: ${stderr || 'rg failed'}`)
    })
    proc.on('error', () => resolve('Error: rg not found'))
  })
}

/**
 * List all available tools
 */
export const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the content of a file',
    parameters: {
      path: { type: 'string', description: 'File path relative to work directory', required: true },
    },
    execute: readFile,
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites)',
    parameters: {
      path: { type: 'string', description: 'File path relative to work directory', required: true },
      content: { type: 'string', description: 'File content to write', required: true },
    },
    execute: writeFile,
  },
  {
    name: 'edit_file',
    description: 'Edit a file by finding and replacing a string',
    parameters: {
      path: { type: 'string', description: 'File path relative to work directory', required: true },
      old_string: { type: 'string', description: 'String to find and replace', required: true },
      new_string: { type: 'string', description: 'Replacement string', required: true },
    },
    execute: editFile,
  },
  {
    name: 'run_bash',
    description: 'Execute a bash command',
    parameters: {
      command: { type: 'string', description: 'Bash command to execute', required: true },
    },
    execute: runBash,
  },
  {
    name: 'glob',
    description: 'List files matching a glob pattern',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")', required: true },
    },
    execute: glob,
  },
  {
    name: 'grep',
    description: 'Search file content using regex pattern',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern to search for', required: true },
      include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
    },
    execute: grepTool,
  },
]

/**
 * Get tool definition by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return tools.find(t => t.name === name)
}

/**
 * Get tools that require approval before execution
 */
export function getApprovalRequiredTools(): string[] {
  return ['write_file', 'edit_file', 'run_bash']
}

/**
 * Convert tools to OpenAI function calling format
 */
export function toolsToOpenAIFunctions() {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, param]) => [
            key,
            {
              type: param.type,
              description: param.description,
            },
          ])
        ),
        required: Object.entries(tool.parameters)
          .filter(([, param]) => param.required)
          .map(([key]) => key),
      },
    },
  }))
}
