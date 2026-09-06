import { helixApi } from '@/lib/electron-bridge'
import { loadSessionMap, resolveBackendSid } from '@/lib/session-map'
import { useHelixStore } from '@/stores/helix-store'
import { useGatewayStore } from '@/stores/gateway-store'
import type { ChatMessage } from '@/stores/helix-types'

function genId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Single source of truth for the backend → frontend message mapping. Every place
 * that ingests a backend message array (session.compress / session.resume / etc.)
 * MUST go through this — do not hand-roll the projection, or the call sites drift.
 *
 * Notes on the backend shape (tui_gateway/server.py::_history_to_messages):
 *  - the body lives in `text`, NOT `content`, so we read `m.text ?? m.content`;
 *  - `tool` roles are collapsed to `assistant` (tool results render as assistant turns);
 *  - `row_id` is preserved so local withdraw/delete can sync to the backend history.
 */
export function mapBackendMessages(
  msgs: any[] | null | undefined,
  sessionId: string,
): ChatMessage[] {
  if (!Array.isArray(msgs)) return []
  return msgs.map((m: any) => ({
    id: m.id || m.row_id || genId(),
    role: (m.role === 'tool' ? 'assistant' : m.role) as 'user' | 'assistant' | 'system',
    content: m.text ?? m.content ?? '',
    images: m.images,
    timestamp: m.timestamp || Date.now(),
    reasoning: m.reasoning ?? m.reasoning_content,
    steps: m.steps,
    rowId: m.row_id,
    sessionId,
    fileChanges: m.fileChanges,
    blocks: m.blocks,
  }))
}

export interface ResyncOptions {
  /** Session to resync; defaults to the active session. */
  sessionId?: string
  /** Show a toast when done / on error. Default false. */
  showToast?: boolean
  /** Override the success toast text (default: 已从后端重新同步). */
  toastMessage?: string
}

/**
 * Pull the authoritative message history for a session straight from the backend
 * (session.resume → state.db, the same source the compressor writes to) and replace
 * ONLY that session's messages in the global `chatMessages` array. Other sessions are
 * untouched (chatMessages is a cross-session array keyed by `sessionId`).
 *
 * Used in three places:
 *  - the manual `/resync` slash command
 *  - an automatic self-heal right after compaction (so a finished compression can
 *    never leave the view empty without the user typing anything)
 *  - the anomaly guard that fires when a compress returns a broken/empty payload
 */
export async function resyncCurrentSessionFromBackend(opts: ResyncOptions = {}): Promise<number> {
  const store = useHelixStore.getState()
  const currentSessionId = opts.sessionId ?? store.currentSessionId
  if (!currentSessionId) {
    if (opts.showToast) store.showToast({ type: 'warning', title: '当前没有活跃会话' })
    return 0
  }
  if (store.isChatLoading) {
    if (opts.showToast) store.showToast({ type: 'warning', title: '对话进行中', description: '请等待当前回复完成后再同步' })
    return 0
  }
  try {
    const sid = (await resolveBackendSid(currentSessionId)) || useGatewayStore.getState().helixSessionId
    if (!sid) {
      if (opts.showToast) store.showToast({ type: 'warning', title: '当前会话还没有后端会话', description: '先发送一条消息建立会话后再同步' })
      return 0
    }
    let res: any = await helixApi()?.send('session.resume', { session_id: sid }).catch(() => null)
    // 会话不在内存（网关重启 / 空闲回收后）：用 storedId 从 state.db 透明恢复
    if (!res || (typeof res === 'object' && (res as any).error)) {
      const map = await loadSessionMap()
      const storedId = map.get(currentSessionId)?.storedId || sid
      res = await helixApi()?.send('session.resume', { session_id: storedId }).catch(() => null)
    }
    if (!res || !Array.isArray((res as any).messages)) {
      if (opts.showToast) store.showToast({ type: 'error', title: '同步失败', description: '后端未返回该会话的消息' })
      return 0
    }
    const msgs = mapBackendMessages((res as any).messages, currentSessionId)
    useHelixStore.setState((state) => ({
      chatMessages: [
        ...state.chatMessages.filter((m) => m.sessionId && m.sessionId !== currentSessionId),
        ...msgs,
      ],
    }))
    if (opts.showToast) {
      store.showToast({
        type: 'success',
        title: opts.toastMessage || '已从后端重新同步',
        description: `恢复 ${msgs.length} 条消息`,
      })
    }
    return msgs.length
  } catch (e) {
    if (opts.showToast) store.showToast({ type: 'error', title: '同步失败', description: String((e as Error)?.message || e) })
    return 0
  }
}

/**
 * Heuristic guard: did the current session end up with non-empty-but-broken content?
 * Returns true when the session has messages but every one of them is blank — the
 * signature of the old "compression wiped the view" bug. Used to decide whether an
 * automatic resync is warranted.
 */
export function isCurrentSessionRenderBroken(sessionId: string | null): boolean {
  if (!sessionId) return false
  const msgs = useHelixStore.getState().chatMessages.filter((m) => m.sessionId === sessionId)
  if (msgs.length === 0) return false
  return msgs.every((m) => !m.content || !m.content.trim())
}
