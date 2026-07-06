import fs from 'fs/promises'
import path from 'path'
import type { McpServerConfig } from './mcp'

export interface HelixPermissions {
  [action: string]: 'allow' | 'deny' | 'ask'
}

export interface AgentConfig {
  mode: 'full' | 'plan'
  description?: string
  systemPrompt?: string
  steps?: number
  tools?: {
    read?: boolean
    write?: boolean
    edit?: boolean
    bash?: boolean
    glob?: boolean
    grep?: boolean
    webfetch?: boolean
    question?: boolean
    task?: boolean
  }
}

export interface HelixConfig {
  permissions?: HelixPermissions
  tools?: {
    [tool: string]: boolean
  }
  agent?: {
    [name: string]: AgentConfig
  }
  model?: string
  provider?: string
  instructions?: string[]
  mcp?: Record<string, McpServerConfig>
}

const CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc', 'helix.json', '.helixrc.json']

let cachedConfig: HelixConfig | null = null

function findConfigPaths(): string[] {
  const paths: string[] = []

  const globalDir = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.config', 'helix')
  paths.push(path.join(globalDir, 'helix.json'))

  const envConfig = process.env.HELIX_CONFIG
  if (envConfig) {
    paths.push(path.resolve(envConfig))
  }

  for (const name of CONFIG_FILENAMES) {
    paths.push(path.resolve(process.cwd(), name))
  }

  const envDir = process.env.HELIX_CONFIG_DIR
  if (envDir) {
    for (const name of CONFIG_FILENAMES) {
      paths.push(path.resolve(envDir, name))
    }
  }

  return paths
}

export async function loadConfig(): Promise<HelixConfig> {
  if (cachedConfig) return cachedConfig

  const paths = findConfigPaths()
  let merged: HelixConfig = {}

  for (const configPath of paths) {
    try {
      const content = await fs.readFile(configPath, 'utf-8')
      const parsed = JSON.parse(content) as HelixConfig
      // Basic validation
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn(`[Config] Invalid config in ${configPath}, skipping`)
        continue
      }
      merged = mergeConfigs(merged, parsed)
    } catch (err) {
      console.warn(`[Config] Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`)
      continue
    }
  }

  cachedConfig = merged
  return merged
}

export function invalidateCache(): void {
  cachedConfig = null
}

function mergeConfigs(base: HelixConfig, override: HelixConfig): HelixConfig {
  return {
    ...base,
    ...override,
    permissions: { ...base.permissions, ...override.permissions } as HelixPermissions,
    tools: { ...base.tools, ...override.tools },
    agent: { ...base.agent, ...override.agent } as { [name: string]: AgentConfig },
    instructions: [...(base.instructions || []), ...(override.instructions || [])],
    mcp: { ...base.mcp, ...override.mcp },
  }
}

export async function getPermission(action: string): Promise<'allow' | 'deny' | 'ask'> {
  const config = await loadConfig()
  return config.permissions?.[action] || 'ask'
}

export async function isToolEnabled(tool: string): Promise<boolean> {
  const config = await loadConfig()
  if (config.tools && tool in config.tools) {
    return config.tools[tool] !== false
  }
  return true
}

export function isToolEnabledByConfig(toolName: string, toolsConfig?: Record<string, boolean>): boolean | undefined {
  if (!toolsConfig) return undefined
  for (const [pattern, enabled] of Object.entries(toolsConfig)) {
    if (globMatch(toolName, pattern)) return enabled
  }
  return undefined
}

export function filterToolsByConfig(
  toolNames: string[],
  toolsConfig?: Record<string, boolean>,
  agentToolsConfig?: Record<string, boolean>,
): string[] {
  return toolNames.filter(name => {
    const agentSetting = isToolEnabledByConfig(name, agentToolsConfig)
    if (agentSetting !== undefined) return agentSetting
    const globalSetting = isToolEnabledByConfig(name, toolsConfig)
    if (globalSetting !== undefined) return globalSetting
    return true
  })
}

function globMatch(text: string, pattern: string): boolean {
  let idx = 0, pidx = 0, textIdx = -1, patIdx = -1
  while (idx < text.length) {
    if (pidx < pattern.length && (pattern[pidx] === text[idx] || pattern[pidx] === '?')) {
      idx++; pidx++
    } else if (pidx < pattern.length && pattern[pidx] === '*') {
      patIdx = pidx; textIdx = idx; pidx++
    } else if (patIdx !== -1) {
      pidx = patIdx + 1; idx = ++textIdx
    } else {
      return false
    }
  }
  while (pidx < pattern.length && pattern[pidx] === '*') pidx++
  return pidx === pattern.length
}

export async function getAgentConfig(name: string): Promise<AgentConfig | undefined> {
  const config = await loadConfig()
  return config.agent?.[name]
}
