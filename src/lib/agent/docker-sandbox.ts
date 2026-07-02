/**
 * Docker sandbox for Agent command execution.
 * Executes commands in isolated Docker containers.
 * Feature-flagged behind ENABLE_DOCKER_SANDBOX environment variable.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function runInDocker(
  command: string,
  workDir: string,
  options: { memory?: string; timeout?: number } = {}
): Promise<string> {
  const { memory = '512m', timeout = 30000 } = options
  
  // Escape double quotes in command for shell safety
  const escapedCommand = command.replace(/"/g, '\\"')
  
  const dockerCmd = [
    'docker run --rm',
    '--network none',
    `--memory ${memory}`,
    `-v "${workDir}:/workspace"`,
    '-w /workspace',
    'node:18-slim',
    `sh -c "${escapedCommand}"`,
  ].join(' ')
  
  try {
    const { stdout, stderr } = await execAsync(dockerCmd, { timeout })
    return stdout || stderr || '(no output)'
  } catch (err) {
    return `Docker error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function isDockerSandboxEnabled(): boolean {
  return process.env.ENABLE_DOCKER_SANDBOX === 'true'
}