import { spawn, type ChildProcess } from 'child_process'
import type { ToolDefinition } from '@/lib/agent/tools'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: {
    type: 'object'
    properties?: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

export interface McpServerConfig {
  type: 'local' | 'remote'
  command?: string[]
  url?: string
  environment?: Record<string, string>
  enabled?: boolean
  cwd?: string
  timeout?: number
  headers?: Record<string, string>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

function toToolDef(name: string, desc: string | undefined, schema: McpTool['inputSchema']): ToolDefinition {
  const params: ToolDefinition['parameters'] = {}
  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const rawType = prop.type === 'array' || prop.type === 'object' ? 'string' : (prop.type || 'string')
      const paramType: 'string' | 'number' | 'boolean' = rawType === 'number' ? 'number' : rawType === 'boolean' ? 'boolean' : 'string'
      params[key] = {
        type: paramType,
        description: prop.description || '',
        required: schema.required?.includes(key) || false,
      }
    }
  }
  return {
    name: `mcp_${name}`,
    description: desc || `MCP tool: ${name}`,
    parameters: params,
    execute: async (args: Record<string, unknown>) => {
      // This execute function is a placeholder - it will be replaced
      // when the MCP server is initialized and tools are listed
      return `Error: MCP tool "${name}" not yet initialized`
    },
  }
}

export class McpClient {
  private serverName: string
  private config: McpServerConfig
  private process: ChildProcess | null = null
  private buffer = ''
  private pending = new Map<string | number, PendingRequest>()
  private idCounter = 0
  private tools: ToolDefinition[] = []
  private _connected = false
  private abortController = new AbortController()
  private requestTimeout: number

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName
    this.config = config
    this.requestTimeout = config.timeout ?? 5000
  }

  get connected(): boolean {
    return this._connected
  }

  getStatus(): { name: string; connected: boolean; type: string } {
    return { name: this.serverName, connected: this._connected, type: this.config.type }
  }

  private nextId(): number {
    return ++this.idCounter
  }

  private sendMessage(msg: JsonRpcRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.requestTimeout
      const timer = setTimeout(() => {
        this.pending.delete(msg.id)
        reject(new Error(`MCP request "${msg.method}" timed out (${timeoutMs / 1000}s)`))
      }, timeoutMs)

      this.pending.set(msg.id, { resolve, reject, timer })
      const line = JSON.stringify(msg) + '\n'

      if (this.process?.stdin?.writable) {
        this.process.stdin.write(line)
      } else if (this.config.type === 'remote') {
        this.sendSSE(line, msg.id).then(resolve, reject).finally(() => clearTimeout(timer))
      } else {
        clearTimeout(timer)
        this.pending.delete(msg.id)
        reject(new Error('MCP transport not available'))
      }
    })
  }

  private async sendSSE(body: string, id: string | number): Promise<unknown> {
    const url = this.config.url
    if (!url) throw new Error('Remote MCP server requires url')

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`MCP remote error: HTTP ${response.status}`)
      }

      const result = await response.json()
      return result?.result ?? result
    } finally {
      clearTimeout(timeout)
    }
  }

  async initialize(): Promise<void> {
    if (this.config.type === 'local') {
      await this.startStdio()
    } else if (this.config.type === 'remote') {
      this._connected = true
    } else {
      throw new Error(`Unknown MCP transport type: ${(this.config as any).type}`)
    }

    const initResult = await this.sendMessage({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'helix', version: '1.0.0' },
      },
    }) as any

    const toolsResult = await this.sendMessage({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/list',
      params: {},
    }) as any

    const mcpTools: McpTool[] = (toolsResult as any)?.tools || []
    this.tools = mcpTools.map(t => {
      const def = toToolDef(t.name, t.description, t.inputSchema)
      def.execute = async (args: Record<string, unknown>) => {
        try {
          const result = await this.callTool(t.name, args)
          const content = (result as any)?.content || []
          return content
            .map((c: any) => {
              if (c.type === 'text') return c.text
              if (c.type === 'resource') return JSON.stringify(c.resource)
              return JSON.stringify(c)
            })
            .join('\n')
        } catch (err) {
          return `MCP tool error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      return def
    })
  }

  private startStdio(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cmd = this.config.command?.[0]
      const args = this.config.command?.slice(1) || []
      if (!cmd) {
        reject(new Error('Local MCP server requires command'))
        return
      }

      // Resolve environment variable references like ${VAR_NAME}
      const resolvedEnv: Record<string, string> = {}
      if (this.config.environment) {
        for (const [key, value] of Object.entries(this.config.environment)) {
          if (typeof value === 'string') {
            resolvedEnv[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => {
              return process.env[varName] || ''
            })
          } else {
            resolvedEnv[key] = String(value)
          }
        }
      }
      const env = { ...process.env, ...resolvedEnv }

      this.process = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd: this.config.cwd,
        shell: process.platform === 'win32',
      })

      const onData = (data: Buffer) => {
        this.buffer += data.toString()
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line) as JsonRpcResponse
            const pending = this.pending.get(msg.id)
            if (pending) {
              clearTimeout(pending.timer)
              this.pending.delete(msg.id)
              if (msg.error) {
                pending.reject(new Error(`MCP error: ${msg.error.message}`))
              } else {
                pending.resolve(msg.result)
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }

      this.process.stdout?.on('data', onData)
      this.process.stderr?.on('data', (data) => {
        const text = data.toString()
        if (!text.startsWith('{')) {
          console.error(`[MCP:${this.serverName}] ${text.trim()}`)
        } else {
          onData(data)
        }
      })

      this.process.on('error', (err) => {
        this._connected = false
        reject(err)
      })

      this.process.on('exit', (code) => {
        this._connected = false
        // Reject all pending requests
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error(`MCP server exited with code ${code}`))
        }
        this.pending.clear()
      })

      this._connected = true
      resolve()
    })
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.sendMessage({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    })
  }

  getTools(): ToolDefinition[] {
    return this.tools
  }

  async close(): Promise<void> {
    this.abortController.abort()
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP client closed'))
    }
    this.pending.clear()
    this._connected = false
  }
}

let mcpClients: McpClient[] = []

export async function initializeMcpServers(configs: Record<string, McpServerConfig>): Promise<ToolDefinition[]> {
  await destroyMcpServers()

  const entries = Object.entries(configs).filter(([, c]) => c.enabled !== false)
  const allTools: ToolDefinition[] = []

  for (const [name, config] of entries) {
    try {
      const client = new McpClient(name, config)
      await client.initialize()
      mcpClients.push(client)
      const tools = client.getTools()
      allTools.push(...tools)
    } catch (err) {
      console.error(`[MCP] Failed to initialize server "${name}":`, err)
    }
  }

  return allTools
}

export async function destroyMcpServers(): Promise<void> {
  for (const client of mcpClients) {
    await client.close().catch(() => {})
  }
  mcpClients = []
}

export function getMcpStatus(): Array<{ name: string; connected: boolean; type: string }> {
  return mcpClients.map(c => c.getStatus())
}
