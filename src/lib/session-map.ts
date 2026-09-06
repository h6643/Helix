/**
 * session-map.ts — conversation → 后端 Helix 会话映射的读写。
 *
 * 从 agent-flow-panel.tsx 拆出（该文件导出非组件成员会破坏 React Fast
 * Refresh，导致 Vite 每次 HMR 全量刷新页面）。会话恢复逻辑（/resync、
 * 压缩自愈）通过 resolveBackendSid 读取映射。
 */

export type SessionMapEntry = { sid: string; epoch: number; storedId?: string }

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

/** 供会话恢复逻辑（/resync、压缩自愈）读取 conversation→后端会话映射：
 *  返回某对话 id 对应的后端 sid。
 *  2026-08-31 对齐官方桌面版语义：后端 SessionManager 把会话持久化到
 *  state.db，内存未命中时 get_session() 会透明恢复（_restore 重建 AIAgent
 *  + 历史）。因此 epoch 不匹配（网关重启）不再视为会话死亡——直接把
 *  持久化 sid 交给调用方，由后端判定死活（恢复成功 or 真正 not found），
 *  调用方各自兜底。 */
export async function resolveBackendSid(conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null
  const map = await loadSessionMap()
  return map.get(conversationId)?.sid ?? null
}
