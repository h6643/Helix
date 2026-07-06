import fs from 'fs/promises'
import path from 'path'
import { safePath, getWorkDir } from './sandbox'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { replace, normalizeLineEndings, detectLineEnding, convertToLineEnding } from '@/lib/helix/replace'
import { getCwd, setCwd, addFile, getFiles } from '@/lib/helix/context'
import { trackFileWrite } from './snapshot'
import { isSandboxEnabled, checkDockerAvailable, runInDocker } from './docker-sandbox'
import { TASK_TOOL_DEFINITION } from '@/lib/helix/task-tool'
import { WEBFETCH_TOOL_DEFINITION } from '@/lib/helix/webfetch'
import { QUESTION_TOOL_DEFINITION } from '@/lib/helix/question-tool'
import { SKILL_TOOL_DEFINITION } from '@/lib/helix/skill-tool'
import { TODOWRITE_TOOL_DEFINITION } from '@/lib/helix/todowrite'
import { TODOREAD_TOOL_DEFINITION } from '@/lib/helix/todoread'
import { COMPRESS_TOOL_DEFINITION } from '@/lib/helix/compress-tool'
import { applyAllToolHooks } from '@/lib/helix/plugin'
import { APPLY_PATCH_TOOL_DEFINITION } from '@/lib/helix/apply-patch'
import { PLAN_TOOLS } from '@/lib/helix/plan-tools'
import { MEMORY_TOOLS } from '@/lib/helix/memory-tools'
import { WEB_EXTRACTOR_TOOL_DEFINITION } from '@/lib/helix/web-extractor'
import { BROWSER_TOOLS } from '@/lib/helix/browser-tool'
import { GIT_TOOLS } from '@/lib/helix/git-tools'
import { ARTIFACT_TOOL_DEFINITION } from '@/lib/helix/artifact-tool'
import { SUB_AGENT_TOOL, SUB_AGENT_RESULT_TOOL } from './sub-agent-executor'

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

async function readFile(params: Record<string, unknown>): Promise<string> {
  const filePath = params.path as string | undefined
  if (!filePath) return 'Error: missing required parameter "path"'
  const offset = params.offset ? Number(params.offset) : undefined
  const limit = params.limit ? Number(params.limit) : undefined
  const resolved = safePath(filePath)
  if (!resolved) {
    return `Error: Path "${filePath}" is outside the working directory`
  }
  try {
    const stat = await fs.stat(resolved)
    if (stat.size > 1024 * 1024) {
      return `Error: File is too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum is 1 MB.`
    }
    let content = await fs.readFile(resolved, 'utf-8')
    addFile(filePath)
    const lines = content.split('\n')
    if (offset !== undefined && limit !== undefined) {
      const start = Math.max(0, offset - 1)
      const end = Math.min(lines.length, start + limit)
      content = lines.slice(start, end).join('\n')
      return `Showing lines ${start + 1}-${end} of ${lines.length}\n\n${content}`
    }
    if (offset !== undefined) {
      content = lines.slice(Math.max(0, offset - 1)).join('\n')
    }
    return content
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function writeFile(params: Record<string, unknown>): Promise<string> {
  const filePath = params.path as string | undefined
  if (!filePath) return 'Error: missing required parameter "path"'
  const content = params.content as string
  const resolved = safePath(filePath)
  if (!resolved) {
    return `Error: Path "${filePath}" is outside the working directory`
  }
  try {
    trackFileWrite(resolved)
    const dir = require('path').dirname(resolved)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolved, content, 'utf-8')
    addFile(filePath)
    return `File written successfully: ${filePath}`
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function editFile(params: Record<string, unknown>): Promise<string> {
  const filePath = params.path as string | undefined
  if (!filePath) return 'Error: missing required parameter "path"'
  const oldString = params.old_string as string
  const newString = params.new_string as string
  const replaceAll = params.replace_all === true
  const resolved = safePath(filePath)
  if (!resolved) {
    return `Error: Path "${filePath}" is outside the working directory`
  }
  try {
    trackFileWrite(resolved)
    let content = await fs.readFile(resolved, 'utf-8')
    addFile(filePath)
    const originalEnding = detectLineEnding(content)
    content = normalizeLineEndings(content)
    const result = replace(content, oldString, newString, replaceAll)
    const output = convertToLineEnding(result, originalEnding)
    await fs.writeFile(resolved, output, 'utf-8')
    return `File edited successfully: ${filePath}`
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : String(err)}`
  }
}

const BLOCKED_PATTERNS = [
  // Destructive file operations
  /\brm\s+(-[rRf]+\s+|--recursive)/,
  /\brm\s+[^|&;]*\*/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  // Permission and system
  /\bchmod\s+777\b/,
  /\bsudo\b/,
  /\bkill\s+-9\b/,
  />\s*\/dev\/sd/,
  /\bmount\b/,
  /\bbash\s+-i\b/,
  /\bsh\s+-i\b/,
  // Remote code execution
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*\|\s*(ba)?sh/,
  /\bpowershell\b.*\|\s*(iex|Invoke-Expression)/i,
  // Fork bomb
  /:\(\)\s*\{/,
  // Crypto miners and network scanning
  /\bnmap\b/,
  /\bmasscan\b/,
  // System modification
  /\bpasswd\b/,
  /\bchown\b/,
  /\bchroot\b/,
  /\bnc\s+-l\b/,
  // Package manager
  /\bnpm\s+install\s+-g\b/,
  /\bnpx\s+.*--ignore-scripts/,
  // Environment variable exfiltration
  /\benv\b.*\|\s*(curl|wget|nc)/i,
  /\bprintenv\b.*\|\s*(curl|wget)/i,
  // Obfuscation attempts
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /\bString\.fromCharCode/i,
]

function validateCommand(cmd: string): { ok: boolean; reason?: string } {
  const trimmed = cmd.trim()
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `blocked command: ${pattern.source}` }
    }
  }
  if (/\$\(.*\)/.test(trimmed) || /`[^`]+`/.test(trimmed)) {
    return { ok: false, reason: 'command substitution forbidden' }
  }
  if (/;\s*;/.test(trimmed)) {
    return { ok: false, reason: 'empty command in chain' }
  }
  return { ok: true }
}

const MAX_OUTPUT_LENGTH = 100000

function censorSensitiveEnv(cmd: string): string {
  const sensitiveVars = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'PASS', 'API_KEY', 'ACCESS_TOKEN']
  let censored = cmd
  for (const v of sensitiveVars) {
    const val = process.env[v]
    if (val) censored = censored.replaceAll(val, `<${v}_REDACTED>`)
  }
  return censored
}

async function runBash(params: Record<string, unknown>): Promise<string> {
  const command = params.command as string | undefined
  if (!command) return 'Error: missing required parameter "command"'
  const validation = validateCommand(command)
  if (!validation.ok) {
    return `Error: Command rejected — ${validation.reason}`
  }

  const isBackground = command.trim().endsWith('&')
  const cwd = getCwd()

  // Docker sandbox mode
  if (isSandboxEnabled()) {
    const dockerOk = await checkDockerAvailable()
    if (dockerOk) {
      const { stdout, stderr, exitCode } = await runInDocker(command, {
        workDir: cwd,
        timeout: isBackground ? 5000 : 60000,
      })
      let result = ''
      if (stdout) {
        const truncated = stdout.length > MAX_OUTPUT_LENGTH
          ? stdout.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)'
          : stdout
        result += truncated
      }
      if (stderr) result += `\n[stderr]\n${stderr}`
      if (exitCode !== 0 && exitCode !== null) result += `\n[exit code: ${exitCode}]`
      return result || '(no output)'
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: isBackground ? 5000 : 60000,
      maxBuffer: 1024 * 1024,
    })
    let result = ''
    if (stdout) {
      const truncated = stdout.length > MAX_OUTPUT_LENGTH
        ? stdout.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)'
        : stdout
      result += truncated
    }
    if (stderr) result += `\n[stderr]\n${stderr}`
    return result || '(no output)'
  } catch (err: any) {
    if (err.stdout || err.stderr) {
      let out = ''
      if (err.stdout) out += err.stdout
      if (err.stderr) out += `\n[stderr]\n${err.stderr}`
      out += `\n[exit code: ${err.code ?? 'unknown'}]`
      return out || `Command failed with exit code ${err.code ?? 'unknown'}`
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function glob(params: Record<string, unknown>): Promise<string> {
  const pattern = params.pattern as string
  try {
    const workDir = getWorkDir()
    const results: string[] = []
    const realFs = require('fs')
    const path = require('path')

    // Convert glob pattern to regex
    function globToRegex(glob: string): RegExp {
      let regexStr = glob
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*')
      return new RegExp(`^${regexStr}$`, 'i')
    }

    const regex = globToRegex(pattern)

    function walkDir(dir: string, relativePath: string) {
      try {
        const entries = realFs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue
            walkDir(fullPath, relPath)
          } else if (entry.isFile()) {
            if (regex.test(relPath)) {
              results.push(relPath)
            }
          }
        }
      } catch { }
    }
    walkDir(workDir, '')
    return results.length > 0 ? results.slice(0, 100).join('\n') : '(no files found)'
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// Cache rg availability to avoid spawning a missing process every time
let rgAvailable: boolean | null = null

async function checkRgAvailable(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable
  return new Promise<boolean>((resolve) => {
    const proc = spawn('rg', ['--version'], { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] })
    proc.on('close', (code) => { rgAvailable = code === 0; resolve(rgAvailable!) })
    proc.on('error', () => { rgAvailable = false; resolve(false) })
  })
}

function buildRgArgs(pattern: string, include: string | undefined, workDir: string): { args: string[]; normalizedPattern: string } {
  const args: string[] = ['-n', '--binary', '--max-filesize', '100K']

  // Handle PCRE-style inline flags: (?i), (?m), (?s)
  let normalizedPattern = pattern
  const pcreMatch = pattern.match(/^\(\?([imsx]+)\)(.*)/)
  if (pcreMatch) {
    const pcreFlags = pcreMatch[1]
    normalizedPattern = pcreMatch[2]
    if (pcreFlags.includes('i')) args.push('-i')
    if (pcreFlags.includes('m')) args.push('--multiline')
  }

  args.push('--', normalizedPattern, workDir)

  if (include) {
    args.push('-g', include)
  }

  return { args, normalizedPattern }
}

async function grepTool(params: Record<string, unknown>): Promise<string> {
  const pattern = params.pattern as string
  const include = params.include as string | undefined
  const workDir = getWorkDir()

  if (!(await checkRgAvailable())) {
    return fallbackGrep(pattern, include, workDir)
  }

  const { args } = buildRgArgs(pattern, include, workDir)

  return new Promise<string>((resolve) => {
    const proc = spawn('rg', args, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', (code) => {
      if (code === 0 || stdout) {
        resolve(stdout || '(no matches found)')
      } else {
        // rg failed (invalid regex) — fall back to Node.js search
        fallbackGrep(pattern, include, workDir).then(resolve)
      }
    })
    proc.on('error', () => {
      rgAvailable = false
      fallbackGrep(pattern, include, workDir).then(resolve)
    })
  })
}

function normalizeRegexPattern(pattern: string): { source: string; flags: string } {
  let flags = 'gi'
  let source = pattern
  // Strip PCRE-style inline flags: (?i), (?m), (?s), (?im), etc.
  const pcreMatch = source.match(/^\(\?([imsx]+)\)(.*)/)
  if (pcreMatch) {
    const pcreFlags = pcreMatch[1]
    source = pcreMatch[2]
    if (pcreFlags.includes('i')) flags += 'i'
    if (pcreFlags.includes('m')) flags += 'm'
    // Remove duplicate flags
    flags = [...new Set(flags)].join('')
  }
  return { source, flags }
}

async function fallbackGrep(pattern: string, include: string | undefined, workDir: string): Promise<string> {
  try {
    const { source, flags } = normalizeRegexPattern(pattern)
    const regex = new RegExp(source, flags)
    const results: string[] = []
    const maxResults = 30
    const maxFiles = 200
    let fileCount = 0
    const startTime = Date.now()
    const timeout = 5000 // 5 seconds max

    async function walkDir(dir: string): Promise<void> {
      if (results.length >= maxResults || fileCount >= maxFiles || Date.now() - startTime > timeout) return
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (results.length >= maxResults || fileCount >= maxFiles || Date.now() - startTime > timeout) return
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next' || entry.name === '.next') continue
            await walkDir(fullPath)
          } else if (entry.isFile()) {
            fileCount++
            if (include && !entry.name.match(new RegExp(include.replace('*', '.*')))) continue
            try {
              const stat = await fs.stat(fullPath)
              if (stat.size > 1024 * 100) continue // Skip files > 100KB
              const content = await fs.readFile(fullPath, 'utf-8')
              const lines = content.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) return
                if (regex.test(lines[i])) {
                  const relPath = path.relative(workDir, fullPath)
                  results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`)
                }
                regex.lastIndex = 0
              }
            } catch {}
          }
        }
      } catch {}
    }

    await walkDir(workDir)
    const elapsed = Date.now() - startTime
    if (results.length > 0) {
      return results.join('\n')
    }
    return `(no matches found, searched ${fileCount} files in ${elapsed}ms)`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function listFiles(params: Record<string, unknown>): Promise<string> {
  const dir = (params.directory as string) || '.'
  const resolved = safePath(dir)
  if (!resolved) return `Error: Path "${dir}" is outside the working directory`
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const listing = entries.map(e => {
      let name = e.name
      if (e.isDirectory()) name += '/'
      return name
    })
    if (listing.length === 0) return '(empty directory)'
    return listing.sort().join('\n')
  } catch (err) {
    return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read file content. Optionally specify offset (1-indexed line) to start from. Limit controls max lines returned.',
    parameters: {
      path: { type: 'string', description: 'File path', required: true },
      offset: { type: 'number', description: 'Starting line number (1-indexed, optional)' },
      limit: { type: 'number', description: 'Max lines to return (optional)' },
    },
    execute: readFile,
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites). Creates parent directories if needed.',
    parameters: {
      path: { type: 'string', description: 'File path', required: true },
      content: { type: 'string', description: 'File content to write', required: true },
    },
    execute: writeFile,
  },
  {
    name: 'edit_file',
    description: 'Edit a file by finding and replacing text. Uses 9-layer matching (exact, trimmed, block-anchor, whitespace-normalized, indentation-flexible, escape-normalized, trimmed-boundary, context-aware, multi-occurrence).',
    parameters: {
      path: { type: 'string', description: 'File path', required: true },
      old_string: { type: 'string', description: 'Text to find and replace', required: true },
      new_string: { type: 'string', description: 'Replacement text', required: true },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    execute: editFile,
  },
  {
    name: 'run_bash',
    description: 'Execute a bash command. Output is capped at 25KB. Use this to run scripts, git operations, build tools, etc.',
    parameters: {
      command: { type: 'string', description: 'Bash command to execute', required: true },
    },
    execute: runBash,
  },
  {
    name: 'glob',
    description: 'List files matching a glob pattern (e.g., "**/*.ts", "*.json").',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern', required: true },
    },
    execute: glob,
  },
  {
    name: 'grep',
    description: 'Search file content using regex pattern. Uses ripgrep if available.',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern', required: true },
      include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
    },
    execute: grepTool,
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a given directory.',
    parameters: {
      directory: { type: 'string', description: 'Directory path (defaults to current)' },
    },
    execute: listFiles,
  },
  TASK_TOOL_DEFINITION,
  WEBFETCH_TOOL_DEFINITION,
  QUESTION_TOOL_DEFINITION,
  SKILL_TOOL_DEFINITION,
  TODOWRITE_TOOL_DEFINITION,
  TODOREAD_TOOL_DEFINITION,
  COMPRESS_TOOL_DEFINITION,
  APPLY_PATCH_TOOL_DEFINITION,
  ...PLAN_TOOLS,
  ...MEMORY_TOOLS,
  WEB_EXTRACTOR_TOOL_DEFINITION,
  ...BROWSER_TOOLS,
  ...GIT_TOOLS,
  ARTIFACT_TOOL_DEFINITION,
  SUB_AGENT_TOOL,
  SUB_AGENT_RESULT_TOOL,
]

export function getToolByName(name: string): ToolDefinition | undefined {
  return tools.find(t => t.name === name)
}

export function getApprovalRequiredTools(): string[] {
  return ['write_file', 'edit_file', 'run_bash', 'question', 'apply_patch']
}

export function toolsToOpenAIFunctions(filter?: string[], customTools?: ToolDefinition[]) {
  const staticTools = filter ? tools.filter(t => filter.includes(t.name)) : tools
  const source = [...staticTools, ...(customTools || [])]
  const hooked = applyAllToolHooks(source)
  return hooked.map(tool => ({
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
