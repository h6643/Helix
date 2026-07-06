import { NextRequest } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import { runAgentLoop, type AgentMessage, type AgentEvent } from '@/lib/agent/loop'
import { runWithContext } from '@/lib/agent/sandbox'
import { resetContext, setCwd } from '@/lib/helix/context'
import type { ApiConfig } from '@/stores/helix-store'
import { getProvider, getBaseUrl } from '@/lib/helix/providers'
import { getAgentProfile, filterToolsByProfile } from '@/lib/agent/types'
import { tools } from '@/lib/agent/tools'
import { loadConfig, filterToolsByConfig, getAgentConfig } from '@/lib/helix/helix-config'
import { initializeMcpServers, destroyMcpServers, type McpServerConfig } from '@/lib/helix/mcp'
import { createApprovalRequest, waitForApproval } from '@/lib/agent/approval'
import { initLsp, shutdownLsp, LSP_TOOLS } from '@/lib/helix/lsp-tools'
import { buildAvailableSkillsXml, loadSkill } from '@/lib/helix/skill-tool'
import { closeBrowser } from '@/lib/helix/browser-tool'

async function resolveInstructions(config: { instructions?: string[] }, workDir: string): Promise<string> {
  const entries = config.instructions
  if (!entries || entries.length === 0) return ''

  const results: string[] = []

  for (const entry of entries) {
    // Remote URL
    if (entry.startsWith('http://') || entry.startsWith('https://')) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        const res = await fetch(entry, { signal: controller.signal })
        clearTimeout(timeout)
        if (res.ok) {
          const text = await res.text()
          results.push(`<instruction source="${entry}">\n${text}\n</instruction>`)
        }
      } catch { /* skip unreachable URLs */ }
      continue
    }

    // Glob pattern
    if (entry.includes('*') || entry.includes('?')) {
      try {
        const globPattern = entry.replace(/\\/g, '/')
        const baseDir = globPattern.startsWith('/') ? '/' : workDir
        const fullPattern = path.resolve(baseDir, globPattern)
        const dirName = path.dirname(fullPattern)
        const fileNamePattern = path.basename(fullPattern)

        try {
          await fs.access(dirName)
          const files = await fs.readdir(dirName)
          const regex = new RegExp('^' + fileNamePattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
          const matched = files.filter(f => regex.test(f)).slice(0, 20)
          for (const file of matched) {
            const filePath = path.join(dirName, file)
            const content = await fs.readFile(filePath, 'utf-8')
            results.push(`<instruction source="${path.relative(workDir, filePath)}">\n${content}\n</instruction>`)
          }
        } catch { /* skip unreadable globs */ }
      } catch { /* skip */ }
      continue
    }

    // Local file path
    const fullPath = path.resolve(workDir, entry)
    try {
      await fs.access(fullPath)
      const stat = await fs.stat(fullPath)
      if (stat.isFile() && stat.size < 1024 * 1024) {
        const content = await fs.readFile(fullPath, 'utf-8')
        results.push(`<instruction source="${entry}">\n${content}\n</instruction>`)
      }
    } catch { /* skip unreadable files */ }
  }

  return results.length > 0 ? '\n\n--- 项目自定义指令（来自配置文件） ---\n' + results.join('\n\n') : ''
}

async function resolveMentions(text: string, baseDir: string): Promise<string> {
  const mentionRegex = /@([\w./\\-]+(?:\.[\w]+)?)/g
  const matches = Array.from(text.matchAll(mentionRegex))
  if (matches.length === 0) return text

  let resolved = text
  for (const match of matches) {
    const ref = match[1]
    const fullPath = path.resolve(baseDir, ref)
    try {
      await fs.access(fullPath)
      const stat = await fs.stat(fullPath)
      if (stat.isFile() && stat.size < 1024 * 1024) {
        const content = await fs.readFile(fullPath, 'utf-8')
        const fileName = ref.split(/[/\\]/).pop() || ref
        resolved = resolved.replace(match[0], `\n\n<file name="${fileName}" path="${ref}">\n${content}\n</file>`)
      }
    } catch {}
  }
  return resolved
}

interface RunRequest {
  messages: Array<{
    role: string
    content: string | Array<{ type: string; [key: string]: unknown }>
  }>
  apiConfig: ApiConfig
  workDir?: string
  agentType?: string
  skillName?: string
  mcpServers?: Record<string, McpServerConfig>
  customInstructions?: string
}

export async function POST(req: NextRequest) {
  try {
    const body: RunRequest = await req.json()
    const { messages, apiConfig } = body
    const workDir = body.workDir || process.cwd()
    const agentType = body.agentType || 'build'

    const provider = getProvider(apiConfig.provider === 'custom' ? 'openai' : apiConfig.provider)
    if (!provider) {
      return new Response(
        JSON.stringify({ error: `Unknown provider: ${apiConfig.provider}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const resolvedConfig: ApiConfig = {
      ...apiConfig,
      baseUrl: apiConfig.baseUrl || getBaseUrl(apiConfig.provider) || provider.baseUrl,
    }

    const profile = getAgentProfile(agentType)
    if (!profile) {
      return new Response(
        JSON.stringify({ error: `Unknown agent type: ${agentType}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const config = await loadConfig()
    const fileMcpConfig = config.mcp || {}
    // Merge browser-side MCP config (from settings UI) with file-based config
    // File-based config takes precedence for environment variables
    const browserMcpConfig = body.mcpServers || {}
    const mcpConfig: Record<string, any> = { ...browserMcpConfig }
    for (const [name, fileConfig] of Object.entries(fileMcpConfig)) {
      if (mcpConfig[name]) {
        // Merge environment variables, with file-based config taking precedence
        mcpConfig[name] = {
          ...mcpConfig[name],
          environment: {
            ...(mcpConfig[name].environment || {}),
            ...(fileConfig as any).environment || {},
          },
        }
      } else {
        mcpConfig[name] = fileConfig
      }
    }
    const mcpTools = await initializeMcpServers(mcpConfig)

    await initLsp(workDir)
    const lspTools = LSP_TOOLS

    const customTools = [...mcpTools, ...lspTools]
    const allowedTools = filterToolsByProfile(tools, profile)
    const allowedNames = allowedTools.map(t => t.name)

    const globalToolsConfig = config.tools
    const agentToolsConfig = config.agent?.[agentType]?.tools as Record<string, boolean> | undefined

    const filteredAllowedNames = filterToolsByConfig(
      allowedNames,
      globalToolsConfig,
      agentToolsConfig,
    )
    const filteredAllowedTools = allowedTools.filter(t => filteredAllowedNames.includes(t.name))

    const filteredCustomNames = filterToolsByConfig(
      customTools.map(t => t.name),
      globalToolsConfig,
      agentToolsConfig,
    )
    const filteredCustomTools = customTools.filter(t => filteredCustomNames.includes(t.name))
    const allowedCustomNames = [...filteredAllowedNames, ...filteredCustomNames]

    // Read per-agent steps config
    const agentCfg = await getAgentConfig(agentType)
    const agentSteps = agentCfg?.steps || 50

    resetContext()
    setCwd(workDir)

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const sendEvent = (event: AgentEvent) => {
          const data = `data: ${JSON.stringify(event)}\n\n`
          controller.enqueue(encoder.encode(data))
        }

        // Send initial status so the frontend knows the agent is starting
        sendEvent({
          type: 'thinking',
          content: '正在初始化 Agent...',
          timestamp: Date.now(),
        })

        runWithContext(`req-${Date.now()}`, workDir, async () => {
          try {
            // Make API config available to tools like run_task
            ;(globalThis as any).__helixApiConfig = resolvedConfig

            const agentMessages: AgentMessage[] = await Promise.all(
              messages.map(async m => {
                if (Array.isArray(m.content)) {
                  // Multimodal content - extract text parts for mention resolution
                  const textParts = m.content.filter(p => p.type === 'text')
                  const resolvedText = await resolveMentions(
                    textParts.map(p => (p as { text?: string }).text || '').join('\n'),
                    workDir
                  )
                  return {
                    role: m.role as 'user' | 'assistant' | 'system',
                    content: m.content.map(p =>
                      p.type === 'text' ? { ...p, text: resolvedText } : p
                    ),
                  }
                }
                return {
                  role: m.role as 'user' | 'assistant' | 'system',
                  content: m.role === 'user' ? await resolveMentions(m.content as string, workDir) : m.content as string,
                }
              })
            )

            const [skillsXml, skillContent, configInstructions] = await Promise.all([
              buildAvailableSkillsXml(),
              body.skillName ? loadSkill(body.skillName) : null,
              resolveInstructions(config, workDir),
            ])
            const envBlock = [
              '<env>',
              `  Working directory: ${workDir}`,
              `  Platform: ${process.platform}`,
              '</env>',
              `Today's date: ${new Date().toDateString()}`,
            ].join('\n')

            const systemPrompt = envBlock +
              (profile.systemPrompt ? '\n\n' + profile.systemPrompt : '') +
              (body.customInstructions ? '\n\n--- 项目自定义指令 ---\n' + body.customInstructions : '') +
              (configInstructions || '') +
              (skillContent ? '\n\n<injected_skill>\n' + skillContent + '\n</injected_skill>' : '') +
              (skillsXml ? '\n\n' + skillsXml : '')

            await runAgentLoop({
              apiConfig: resolvedConfig,
              messages: agentMessages,
              systemPrompt,
              maxIterations: agentSteps,
              allowedTools: allowedCustomNames,
              customTools: filteredCustomTools,
              onEvent: (event) => sendEvent(event),
              onDelta: (text) => {
                sendEvent({ type: 'text', content: text, timestamp: Date.now() })
              },
              onReasoning: (text) => {
                sendEvent({ type: 'reasoning', content: text, timestamp: Date.now() })
              },
              onApprovalRequest: async (approvalId, toolName, params) => {
                createApprovalRequest(approvalId, toolName, params)
                sendEvent({
                  type: 'approval_request',
                  approvalId,
                  toolName,
                  toolParams: params,
                  content: `Approval requested for ${toolName}`,
                  timestamp: Date.now(),
                })
                return waitForApproval(approvalId, toolName)
              },
              permissions: profile.defaultPermissions === 'plan'
                ? [
                    { action: 'read', resource: '*', effect: 'allow' },
                    { action: 'write', resource: '*', effect: 'deny' },
                    { action: 'edit', resource: '*', effect: 'deny' },
                    { action: 'bash', resource: '*', effect: 'deny' },
                    { action: 'glob', resource: '*', effect: 'allow' },
                    { action: 'grep', resource: '*', effect: 'allow' },
                    { action: 'list_directory', resource: '*', effect: 'allow' },
                    { action: 'webfetch', resource: '*', effect: 'allow' },
                    { action: 'question', resource: '*', effect: 'ask' },
                  ]
                : undefined,
            })
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            try {
              sendEvent({ type: 'error', content: errorMsg, timestamp: Date.now() })
            } catch { /* stream may already be closed */ }
          } finally {
            try {
              controller.close()
            } catch { /* stream may already be closed */ }
            await destroyMcpServers().catch(() => {})
            await shutdownLsp().catch(() => {})
            await closeBrowser().catch(() => {})
          }
        })
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await destroyMcpServers().catch(() => {})
    await shutdownLsp().catch(() => {})
    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
