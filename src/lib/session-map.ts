/**
 * session-map.ts — conversation → 后端 Hermes 会话映射的读写。
 *
 * 从 agent-flow-panel.tsx 拆出（该文件导出非组件成员会破坏 React Fast
 * Refresh，导致 Vite 每次 HMR 全量刷新页面）。兄弟面板（rollback /
 * backend-sessions / projects）通过 resolveBackendSid 读取映射。
 */

export type SessionMapEntry = { sid: string; epoch: number }

export const SESSION_MAP_KEY = 'conversationSessions'

export async function loadSessionMap(): Promise<Map<string, SessionMapEntry>> {
  try {
    const { persistence } = await import('@/lib/persist')
    const raw = await persistence.loadSetting<Record<string, SessionMapEntry>>(SESSION_MAP_KEY)
    const map = new Map<string, SessionMapEntry>()
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.sid === 'string' && typeof v.epoch === 'number') map.set(k, v)
      }
    }
    return map
  } catch {
    return new Map()
  }
}

/** 供兄弟面板（rollback / 后端会话 / 项目）读取 conversation→后端会话映射：
 *  返回某对话 id 对应的后端 sid，epoch 不匹配视为失效返回 null。 */
export async function resolveBackendSid(conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null
  const map = await loadSessionMap()
  const entry = map.get(conversationId)
  if (!entry) return null
  const { useHermesStore } = await import('@/stores/hermes-store')
  return entry.epoch === useHermesStore.getState().gatewayEpoch ? entry.sid : null
}
