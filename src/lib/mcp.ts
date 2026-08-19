import type { McpServerConfig } from '@/stores/hermes-store'

interface AcpEnvVar {
  name: string
  value: string
}

interface AcpHttpHeader {
  name: string
  value: string
}

interface AcpMeta {
  cwd?: string
  timeout?: number
  envPassthrough?: boolean
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: AcpEnvVar[]; _meta?: AcpMeta }
  | { name: string; url: string; headers: AcpHttpHeader[]; _meta?: AcpMeta }

/**
 * Convert the store's MCP server map into the ACP `session/new` mcpServers
 * payload. Hermes registers these servers per-session (acp_adapter.session /
 * gateway session/new), so MCP config must be passed here — writing a
 * camelCase `mcpServers:` key into config.yaml was never read by the backend.
 */
export function buildAcpMcpServers(
  servers: Record<string, McpServerConfig> | null | undefined,
): AcpMcpServer[] {
  const out: AcpMcpServer[] = []
  for (const [name, cfg] of Object.entries(servers || {})) {
    if (!cfg || cfg.enabled === false) continue
    const meta: AcpMeta = {
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      ...(typeof cfg.timeout === 'number' ? { timeout: cfg.timeout } : {}),
      ...(cfg.envPassthrough ? { envPassthrough: true } : {}),
    }
    if (cfg.type === 'remote' && cfg.url) {
      out.push({
        name,
        url: cfg.url,
        headers: Object.entries(cfg.headers || {}).map(([n, v]) => ({ name: n, value: String(v) })),
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      })
    } else if (cfg.type === 'local' && cfg.command?.length) {
      const cmd = Array.isArray(cfg.command) ? cfg.command : [String(cfg.command)]
      out.push({
        name,
        command: cmd[0],
        args: cmd.slice(1),
        env: Object.entries(cfg.environment || {}).map(([n, v]) => ({ name: n, value: String(v) })),
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      })
    }
  }
  return out
}
