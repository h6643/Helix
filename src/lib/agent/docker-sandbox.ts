import { exec, spawn } from 'child_process'
import path from 'path'

const DOCKER_IMAGE = process.env.DOCKER_SANDBOX_IMAGE || 'node:20-slim'
const SANDBOX_ENABLED = process.env.ENABLE_DOCKER_SANDBOX === 'true' || process.env.ENABLE_DOCKER_SANDBOX === '1'

let dockerAvailable: boolean | null = null

export function isSandboxEnabled(): boolean {
  return SANDBOX_ENABLED
}

export async function checkDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable
  return new Promise<boolean>((resolve) => {
    const proc = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.on('close', (code) => {
      dockerAvailable = code === 0 && stdout.trim().length > 0
      resolve(dockerAvailable!)
    })
    proc.on('error', () => {
      dockerAvailable = false
      resolve(false)
    })
  })
}

export function resetDockerCheck(): void {
  dockerAvailable = null
}

export interface SandboxOptions {
  workDir?: string
  timeout?: number
  image?: string
  envVars?: Record<string, string>
}

export async function runInDocker(
  command: string,
  options: SandboxOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const workDir = options.workDir || process.cwd()
  const timeout = options.timeout || 60000
  const image = options.image || DOCKER_IMAGE

  const containerWorkDir = '/workspace'
  const mountArg = `"${workDir}":"${containerWorkDir}"`

  const envArgs: string[] = []
  if (options.envVars) {
    for (const [key, value] of Object.entries(options.envVars)) {
      envArgs.push('-e', `${key}=${value}`)
    }
  }

  const dockerArgs = [
    'run', '--rm',
    '-v', mountArg,
    '-w', containerWorkDir,
    ...envArgs,
    '--network', 'none',
    '--read-only',
    '--memory', '512m',
    '--cpus', '1',
    '--pids-limit', '50',
    image,
    'sh', '-c', command,
  ]

  return new Promise((resolve) => {
    const proc = spawn('docker', dockerArgs, {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code })
    })
    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: `Docker error: ${err.message}`, exitCode: -1 })
    })
  })
}

export interface SandboxResult {
  output: string
  sandboxed: boolean
}
