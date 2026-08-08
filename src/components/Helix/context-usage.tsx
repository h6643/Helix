'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { hermesApi } from '@/lib/electron-bridge'
import { formatTokens } from '@/lib/format'
import { debug } from '@/lib/logger'
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
  categories: ContextBreakdown[]
}

// Backend categories carry a CSS-var color; map to our own tailwind classes.
const CATEGORY_COLORS: Record<string, string> = {
  system_prompt: 'bg-gray-500',
  tool_definitions: 'bg-orange-500',
  rules: 'bg-emerald-500',
  skills: 'bg-sky-500',
  mcp: 'bg-pink-500',
  subagent_definitions: 'bg-purple-500',
  memory: 'bg-teal-500',
  conversation: 'bg-blue-500',
}

function colorFor(id: string): string {
  return CATEGORY_COLORS[id] || 'bg-gray-500'
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
        <span className="text-sm font-semibold text-foreground">~{formatTokens(used)}</span>
        <span className="text-[10px] text-muted-foreground">
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
              className={`h-full ${cat.color} transition-all duration-300 first:rounded-l-full last:rounded-r-full`}
              style={{ width: `${Math.max(catPercent, 0.5)}%` }}
              title={`${cat.label}: ~${formatTokens(cat.tokens)}`}
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
          <div className="text-xs text-muted-foreground">
            暂无上下文分类数据（需要正在运行的 Hermes 会话）
          </div>
        ) : categories.filter(c => c.tokens > 0).map(item => {
          const pct = total > 0 ? (item.tokens / total) * 100 : 0
          return (
            <div key={item.id} className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-sm ${item.color}`} />
                <span className="text-xs text-foreground">{item.label}</span>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
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
      const sessionId = useHermesStore.getState().hermesSessionId
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
                  if (currentSessionId === sessionId) {
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

  // 不轮询：只在用户点击打开弹层时查询一次，避免每 10s 空跑 RPC。
  useEffect(() => {
    if (open) fetchContextData()
  }, [open, fetchContextData])

  // Only backend RPC data — no client-side estimation fallback.
  const total = backendData?.context_max || 0
  const used = backendData?.context_used || 0

  const categories: ContextBreakdown[] = backendData?.categories?.length
    ? backendData.categories.map(c => ({ ...c, color: colorFor(c.id) }))
    : []

  // When there's no backend data, the ring renders empty (progress arc at 0).

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="size-10 rounded-lg flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
        title="上下文使用情况"
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
