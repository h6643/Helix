'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { hermesApi } from '@/lib/electron-bridge'
import { captureContextBreakdown } from '@/lib/context-capture'
import { formatTokens } from '@/lib/format'
import { debug } from '@/lib/logger'
import { resolveBackendSid } from '@/lib/session-map'
import { useHelixStore } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'

// ---- Types ----

interface ContextBreakdown {
  id: string
  label: string
  tokens: number
  color: string
}

interface ContextUsageData {
  context_max: number
  context_used: number
  context_percent: number
  estimated_total?: number
  categories: ContextBreakdown[]
}


// ---- ContextUsageBar (segmented horizontal bar — Hermes Desktop style) ----

function ContextUsageBar({ used, total, categories }: { used: number; total: number; categories: ContextBreakdown[] }) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100)
  // Segment widths are proportional to each category's share, normalized to the
  // used fill — so the bar always reads as used/total regardless of whether the
  // category tokens come from the backend or the local session stats.
  const catTotal = categories.reduce((s, c) => s + c.tokens, 0) || 1

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">~{formatTokens(used)}</span>
        <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
          / {formatTokens(total)} &middot; {percentage.toFixed(1)}%
        </span>
      </div>
      {/* Segmented bar */}
      <div className="h-2 w-full bg-muted rounded-full overflow-hidden flex">
        {categories.map((cat) => {
          const catPercent = used > 0 ? (cat.tokens / catTotal) * percentage : 0
          if (catPercent <= 0) return null
          return (
            <div
              key={cat.id}
              className="h-full transition-all duration-300 first:rounded-l-full last:rounded-r-full"
              style={{ width: `${Math.max(catPercent, 0.5)}%`, backgroundColor: cat.color }}
              data-tip={`${cat.label}: ~${formatTokens(cat.tokens)}`}
            />
          )
        })}
      </div>
    </div>
  )
}

// ---- Panel (detailed breakdown popover) ----

function ContextUsagePanel({ used, total, categories, onClose }: { used: number; total: number; categories: ContextBreakdown[]; onClose: () => void }) {
  return (
    <div className="absolute bottom-full right-0 mb-2 w-72 bg-card border border-border/60 rounded-xl shadow-lg p-3 z-50">
      <ContextUsageBar used={used} total={total} categories={categories} />
      {/* Legend list */}
      <div className="mt-3 space-y-1.5">
        {categories.filter(c => c.tokens > 0).length === 0 ? (
          <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
            暂无上下文分类数据
          </div>
        ) : categories.filter(c => c.tokens > 0).map(item => {
          const pct = total > 0 ? (item.tokens / total) * 100 : 0
          return (
            <div key={item.id} className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: item.color }} />
                <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground">{item.label}</span>
              </div>
              <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground tabular-nums">
                ~{formatTokens(item.tokens)} <span className="text-foreground/60">{pct.toFixed(1)}%</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- Main indicator (button + popover combo) ----

export function ContextUsageIndicator() {
  const [open, setOpen] = useState(false)
  const [backendData, setBackendData] = useState<ContextUsageData | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Auto-compaction: trigger when context usage exceeds 80% and setting is enabled
  const autoCompactCooldownRef = useRef(false)

  // Fetch context breakdown from backend via RPC
  const fetchContextData = useCallback(async () => {
    try {
      const currentSessionId = useHelixStore.getState().currentSessionId
      const sessionId = (await resolveBackendSid(currentSessionId)) || useHermesStore.getState().hermesSessionId
      // No live Hermes session for THIS conversation (e.g. it was never run this
      // session, or the gateway restarted and invalidated it). Don't query with an
      // empty id — the backend would return the GLOBAL session's breakdown and the
      // ring would show identical usage for every conversation. Instead fall back
      // to the per-conversation store (contextUsage[currentSessionId], already
      // persisted and correct) and render an empty breakdown.
      if (!sessionId) {
        setBackendData(null)
        return
      }
      const result = await hermesApi()?.send('session.context_breakdown', { session_id: sessionId })
      if (result && typeof result === 'object') {
        const data = result as ContextUsageData
        setBackendData(data)
        // 本地快照写回统一收敛到 captureContextBreakdown（context-capture.ts）：
        // - 仅当后端回报非零用量或分类非空才写，避免空会话把本地真实值覆盖成 0；
        // - size/used 用本地已有值兜底（used 取 max），避免估算偏低时把环缩水；
        // - 分类数据只要有就持久化（唯一来源，不写重启后必显示"暂无上下文分类数据"）。
        await captureContextBreakdown(currentSessionId, sessionId)

        // Auto-compaction check (Hermes Desktop style)
        if (data.context_percent >= 80 && !autoCompactCooldownRef.current) {
          const { autoCompactContext } = useHelixStore.getState()
          if (autoCompactContext) {
            autoCompactCooldownRef.current = true
            // Cooldown: don't trigger again for 60 seconds
            setTimeout(() => { autoCompactCooldownRef.current = false }, 60_000)
            try {
              const result = await hermesApi()?.send('session.compress', { session_id: sessionId })
              if (result && typeof result === 'object') {
                const r = result as any
                if (r.status === 'compressed' && Array.isArray(r.messages)) {
                  // Update frontend messages with compressed messages
                  const currentSessionId = useHelixStore.getState().currentSessionId
                  if (currentSessionId) {
                    const msgs = r.messages.map((m: any) => ({
                      id: m.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      role: m.role as 'user' | 'assistant' | 'system',
                      content: m.content || '',
                      images: m.images,
                      timestamp: m.timestamp || Date.now(),
                      reasoning: m.reasoning,
                      steps: m.steps,
                      sessionId: currentSessionId,
                    }))
                    useHelixStore.setState({ chatMessages: msgs })
                  }
                }
              }
              debug('[ContextUsage] auto-compaction triggered at', data.context_percent.toFixed(1), '%')
            } catch { /* backend may not support */ }
          }
        }
      }
    } catch {
      // Backend may not support this — degrade gracefully
    }
  }, [])

  // 打开弹层时查询，并在打开期间每 5s 刷新一次：后端 agent 可能刚构建完成，
  // 分类数据不会在会话创建瞬间就绪，只查一次容易永久停留在"暂无上下文分类数据"。
  useEffect(() => {
    if (!open) return
    fetchContextData()
    const timer = setInterval(fetchContextData, 5000)
    return () => clearInterval(timer)
  }, [open, fetchContextData])

  // Quietly capture the category breakdown once per new live Hermes session and
  // persist it into the local snapshot — WITHOUT overriding the displayed ring
  // data (which reflects THIS conversation's persisted usage). Previously the
  // breakdown was only saved when the popover was opened mid-session, so a cold
  // restart always fell back to the "需要正在运行的 Hermes 会话" empty state
  // even though the total percentage had been persisted.
  const hermesSessionId = useHermesStore((s) => s.hermesSessionId)
  const currentSessionId = useHelixStore((s) => s.currentSessionId)
  // 防重位只在成功写入后才置：会话创建瞬间 agent 尚未构建，后端返回空分类，
  // 若此时标记"已捕获"，该 sid 永不重试——run 结束后的权威分类就丢了
  // （"重启后有的会话分类消失"根因之一）。留空可在下次 dep 变化（新 run 换
  // sid / 切换会话）时重试；run 结束的兜底捕获在 agent-flow-panel finally 里。
  const quietFetchedSidRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const capture = async () => {
      const sid = (await resolveBackendSid(currentSessionId)) || hermesSessionId
      const key = `${currentSessionId ?? ''}:${sid ?? ''}`
      if (!sid || quietFetchedSidRef.current === key || cancelled) return
      const written = await captureContextBreakdown(currentSessionId, sid)
      if (written) quietFetchedSidRef.current = key
    }
    capture()
    return () => { cancelled = true }
  }, [hermesSessionId, currentSessionId])

  // Prefer live backend RPC data. When there is no live Hermes session
  // (app/gateway restarted, or the conversation was never run this session) fall
  // back to the locally persisted per-conversation store
  // (contextUsage[currentSessionId]) so the ring does NOT reset to 0 after a
  // restart. The snapshot is written in agent-flow-panel.tsx on
  // `usage_prompt_complete`. (No client-side estimation - real saved values.)
  const localCtx = useHelixStore(s =>
    s.currentSessionId ? s.contextUsage[s.currentSessionId] : undefined,
  )
  // Only let the live RPC payload drive the ring when it carries a real
  // current-window reading. `session.context_breakdown` returns 0/0 while the
  // backend agent is not built yet; preferring that transient payload over the
  // persisted snapshot made the ring visibly shrink after opening/refreshing
  // the popover even though no compression had run.
  const backendHasRealUsage =
    (backendData?.context_used || 0) > 0 &&
    (backendData?.context_max || 0) > 0 &&
    (backendData!.context_used || 0) !== Number(backendData!.estimated_total || 0)
  const total = backendHasRealUsage ? backendData!.context_max : (localCtx?.size || 0)
  const used = backendHasRealUsage ? backendData!.context_used : (localCtx?.used || 0)

  const categories: ContextBreakdown[] = backendData?.categories?.length
    ? backendData.categories.map(c => ({ ...c }))
    : (localCtx?.categories?.length
        ? localCtx.categories.map(c => ({ ...c }))
        : [])

  // When there's no backend data, the ring renders empty (progress arc at 0).

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="size-10 rounded-lg flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
        data-tip="上下文使用情况"
      >
        <ContextUsageRing used={used} total={total} />
      </button>
      {open && <ContextUsagePanel used={used} total={total} categories={categories} onClose={() => setOpen(false)} />}
    </div>
  )
}

// ---- Ring component (small circular progress indicator) ----

function ContextUsageRing({ used, total }: { used: number; total: number }) {
  const safeTotal = total > 0 ? total : 1
  const percentage = Math.min(Math.max((used / safeTotal) * 100, 0), 100)
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (percentage / 100) * circumference
  const colorClass = percentage > 90 ? 'text-red-500' : percentage > 70 ? 'text-amber-500' : 'text-primary'

  return (
    <div className="relative size-7 flex items-center justify-center">
      <svg className="size-6 -rotate-90" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="3" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={`${colorClass} transition-all duration-300`}
        />
      </svg>
    </div>
  )
}
