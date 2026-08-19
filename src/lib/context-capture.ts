/**
 * context-capture.ts — 上下文分类数据（context_breakdown）的捕获与本地持久化。
 *
 * 从 context-usage.tsx 拆出的纯逻辑模块（组件文件导出非组件成员会破坏 React
 * Fast Refresh），供 ContextUsageIndicator 与 agent-flow-panel（run 结束兜底
 * 捕获）共用。
 *
 * 为什么需要 run 结束捕获：`session.context_breakdown` 在后端 agent 构建完成前
 * 返回空分类（categories: []）。会话创建瞬间的捕获必然拿到空值；只有 run 结束
 * 时 agent 才完整、分类数据才权威。若只在弹窗打开时捕获，没打开过弹窗的会话
 * 重启后分类数据必丢（"重启后有的会消失"根因）。
 */

import { hermesApi } from '@/lib/electron-bridge'
import { resolveBackendSid } from '@/lib/session-map'
import { useHelixStore } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'

interface ContextBreakdownData {
  context_max: number
  context_used: number
  context_percent: number
  estimated_total?: number
  categories: Array<{ id: string; label: string; tokens: number; color: string }>
}

/**
 * 前端把本地用量快照写回后端：后端的 session.context_breakdown 会优先返回这份
 * 值，实现前端 → 后端的双向同步。
 */
export async function syncContextUsageToBackend(
  conversationId: string | null | undefined,
  size: number,
  used: number,
  backendSid?: string | null,
): Promise<void> {
  const sid =
    backendSid ||
    (await resolveBackendSid(conversationId || null)) ||
    useHermesStore.getState().hermesSessionId
  if (!sid || !size || !used) return
  try {
    await hermesApi()?.send('session.context_usage.sync', {
      session_id: sid,
      context_max: size,
      context_used: used,
    })
  } catch {
    // Backend may not support this yet — degrade gracefully
  }
}

/**
 * 拉取某对话的上下文分类并写入本地快照（contextUsage[conversationId]）。
 *
 * - conversationId: Helix 会话 id（跨重启稳定），本地记录键。draft（null）时
 *   退化为用后端 sid 作键——与旧行为一致。
 * - backendSid: 调用方已知的后端 sid（如 handleRun 刚 session/new 出来的）；
 *   省略时按 session-map（epoch 校验）→ 全局 hermesSessionId 顺序解析。
 *
 * 写回规则与 context-usage.tsx 旧逻辑一致：
 * - 仅当后端回报非零用量**或**分类非空才写（避免空会话把本地真实值覆盖成 0）；
 * - context_max 用 `后端值 || 本地已有值` 兜底，used 取 `max(后端, 本地)`。
 *
 * @returns 是否实际写入了本地快照（供调用方决定是否标记"已捕获"）。
 */
export async function captureContextBreakdown(
  conversationId: string | null | undefined,
  backendSid?: string | null,
): Promise<boolean> {
  const sid =
    backendSid ||
    (await resolveBackendSid(conversationId || null)) ||
    useHermesStore.getState().hermesSessionId
  if (!sid) return false
  try {
    const result = await hermesApi()?.send('session.context_breakdown', { session_id: sid })
    if (!result || typeof result !== 'object') return false
    const data = result as ContextBreakdownData
    const hasRealUsage = (data.context_used || 0) > 0 && (data.context_max || 0) > 0
    if (!hasRealUsage && (data.categories?.length ?? 0) === 0) return false
    const key = conversationId || sid
    const localPrev = useHelixStore.getState().contextUsage[key]
    const isMeasured = (data.context_used || 0) > 0 && (data.context_used || 0) !== Number(data.estimated_total || 0)
    useHelixStore.getState().setContextUsage(
      key,
      data.context_max || localPrev?.size || 0,
      isMeasured
        ? Math.max(data.context_used || 0, localPrev?.used || 0)
        : (localPrev?.used || 0),
      data.categories?.map((c) => ({ id: c.id, label: c.label, tokens: c.tokens, color: c.color })),
    )
    await syncContextUsageToBackend(
      conversationId,
      data.context_max || localPrev?.size || 0,
      isMeasured
        ? Math.max(data.context_used || 0, localPrev?.used || 0)
        : (localPrev?.used || 0),
      sid,
    )
    return true
  } catch {
    // Backend may not support this — degrade gracefully
    return false
  }
}
