import type { McpServerConfig } from '@/stores/hermes-store'

export interface AcpEnvVar {
  name: string
  value: string
}

export interface AcpHttpHeader {
  name: string
  value: string
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: AcpEnvVar[] }
  | { name: string; url: string; headers: AcpHttpHeader[] }

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
    if (cfg.type === 'remote' && cfg.url) {
      out.push({
        name,
        url: cfg.url,
        headers: Object.entries(cfg.headers || {}).map(([n, v]) => ({ name: n, value: String(v) })),
      })
    } else if (cfg.type === 'local' && cfg.command?.length) {
      const cmd = Array.isArray(cfg.command) ? cfg.command : [String(cfg.command)]
      out.push({
        name,
        command: cmd[0],
        args: cmd.slice(1),
        env: Object.entries(cfg.environment || {}).map(([n, v]) => ({ name: n, value: String(v) })),
      })
    }
  }
  return out
}
