import { exec } from 'child_process'
import { promisify } from 'util'
import { getCwd } from '@/lib/helix/context'
import type { ToolDefinition } from '@/lib/agent/tools'

const execAsync = promisify(exec)

const MAX_OUTPUT = 30000

async function execGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`git ${args.join(' ')}`, {
      cwd: cwd || getCwd(),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
    let result = stdout || ''
    if (stderr) result += `\n[stderr]\n${stderr}`
    if (result.length > MAX_OUTPUT) {
      result = result.slice(0, MAX_OUTPUT) + '\n... (output truncated)'
    }
    return result || '(no output)'
  } catch (err: any) {
    if (err.stderr) return err.stderr.slice(0, MAX_OUTPUT)
    return `Error: ${err.message}`
  }
}

async function gitStatus(_params: Record<string, unknown>): Promise<string> {
  const result = await execGit(['status', '--short', '--branch'])
  const isRepo = result.includes('fatal: not a git repository')
  if (isRepo) return 'Error: Not a git repository'
  return result
}

async function gitDiff(params: Record<string, unknown>): Promise<string> {
  const target = params.target as string || 'HEAD'
  const staged = params.staged === true
  const path = params.path as string
  const args = ['diff']
  if (staged) args.push('--cached')
  args.push(target)
  if (path) args.push('--', path)
  const result = await execGit(args)
  if (result.includes('fatal: not a git repository')) return 'Error: Not a git repository'
  return result
}

async function gitLog(params: Record<string, unknown>): Promise<string> {
  const maxCount = params.max_count ? String(params.max_count) : '20'
  const branch = params.branch as string || 'HEAD'
  const path = params.path as string
  const args = ['log', `--max-count=${maxCount}`, '--oneline', '--decorate', branch]
  if (path) args.push('--', path)
  const result = await execGit(args)
  if (result.includes('fatal: not a git repository')) return 'Error: Not a git repository'
  return result
}

async function gitBranch(params: Record<string, unknown>): Promise<string> {
  const action = params.action as string
  const name = params.name as string
  const args = ['branch']
  if (action === 'create' && name) {
    args.push(name)
  } else if (action === 'delete' && name) {
    args.push('-d', name)
  } else if (action === 'delete-force' && name) {
    args.push('-D', name)
  } else if (action === 'switch' && name) {
    await execGit(['checkout', name])
    return `Switched to branch "${name}"`
  } else if (action === 'create-switch' && name) {
    args.push(name)
    const result = await execGit(args)
    await execGit(['checkout', name])
    return result + `\nSwitched to new branch "${name}"`
  }
  const result = await execGit(args)
  if (result.includes('fatal: not a git repository')) return 'Error: Not a git repository'
  return result
}

async function gitCommit(params: Record<string, unknown>): Promise<string> {
  const message = params.message as string
  const addAll = params.add_all !== false
  const paths = params.paths as string[] | undefined
  let isRepo = false
  if (addAll) {
    const result = await execGit(['add', '-A'])
    isRepo = result.includes('fatal: not a git repository')
  } else if (paths && paths.length > 0) {
    const result = await execGit(['add', '--', ...paths])
    isRepo = result.includes('fatal: not a git repository')
  }
  if (isRepo) return 'Error: Not a git repository'
  if (!message) return 'Error: commit message is required'
  const result = await execGit(['commit', '-m', `"${message.replace(/"/g, '\\"')}"`])
  if (result.includes('fatal: not a git repository')) return 'Error: Not a git repository'
  return result
}

export const GIT_TOOLS: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Show the working tree status (modified, staged, untracked files). Run this first to understand the current state.',
    parameters: {},
    execute: gitStatus,
  },
  {
    name: 'git_diff',
    description: 'Show changes between commits, commit and working tree, etc. Shows unstaged changes by default. Use staged=true for staged changes.',
    parameters: {
      target: { type: 'string', description: 'Target ref (default: HEAD)', required: false },
      staged: { type: 'boolean', description: 'Show staged changes instead of unstaged', required: false },
      path: { type: 'string', description: 'Filter by file path', required: false },
    },
    execute: gitDiff,
  },
  {
    name: 'git_log',
    description: 'Show commit logs in one-line format with branch decorations.',
    parameters: {
      max_count: { type: 'string', description: 'Maximum number of commits to show (default: 20)', required: false },
      branch: { type: 'string', description: 'Branch or ref (default: HEAD)', required: false },
      path: { type: 'string', description: 'Filter by file path', required: false },
    },
    execute: gitLog,
  },
  {
    name: 'git_branch',
    description: 'List, create, delete, or switch branches. Use action=list (default), create, delete, switch, or create-switch.',
    parameters: {
      action: { type: 'string', description: 'Action: list, create, delete, delete-force, switch, create-switch (default: list)', required: false },
      name: { type: 'string', description: 'Branch name (required for create/delete/switch)', required: false },
    },
    execute: gitBranch,
  },
  {
    name: 'git_commit',
    description: 'Stage all changes (or specific paths) and commit with a message. Adds all changes by default.',
    parameters: {
      message: { type: 'string', description: 'Commit message (required)', required: true },
      add_all: { type: 'boolean', description: 'Stage all changes first (default: true)', required: false },
      paths: { type: 'string', description: 'Specific paths to stage (JSON array of strings)', required: false },
    },
    execute: gitCommit,
  },
]
