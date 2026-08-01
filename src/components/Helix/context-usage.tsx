'use client'

import { Shrink, Loader2 } from 'lucide-react'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { electronHermes } from '@/lib/electron-bridge'
import { formatTokens } from '@/lib/format'
import { debug } from '@/lib/logger'
import { useHelixStore } from '@/stores/helix-store'

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

// ---- Model-aware context window size lookup (fallback when backend unavailable) ----

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000, 'gpt-4o-mini': 128_000, 'gpt-4-turbo': 128_000, 'gpt-4': 8_192,
  'o1': 200_000, 'o3-mini': 200_000,
  'claude-sonnet-4': 200_000, 'claude-sonnet-4-20250514': 200_000,
  'claude-3-7-sonnet-20250219': 200_000, 'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000, 'claude-3-opus-20240229': 200_000,
  'gemini-2.5-pro': 1_000_000, 'gemini-2.5-flash': 1_000_000, 'gemini-2.0-flash': 1_000_000,
  'deepseek-chat': 64_000, 'deepseek-coder': 64_000, 'deepseek-reasoner': 64_000,
  'qwen3-235b-a22b': 131_072, 'qwen-max': 32_000, 'qwen-plus': 131_072,
  'kimi-k2.5': 128_000, 'grok-3': 131_072, 'mistral-large-latest': 128_000,
  'default': 128_000,
}

export function getModelContextWindow(modelName?: string): number {
  if (!modelName) return MODEL_CONTEXT_WINDOWS['default']
  const lower = modelName.toLowerCase()
  if (MODEL_CONTEXT_WINDOWS[modelName]) return MODEL_CONTEXT_WINDOWS[modelName]
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key !== 'default' && lower.includes(key.toLowerCase())) return size
  }
  return MODEL_CONTEXT_WINDOWS['default']
}

// ---- ContextUsageBar (segmented horizontal bar — Hermes Desktop style) ----

function ContextUsageBar({ used, total, categories }: { used: number; total: number; categories: ContextBreakdown[] }) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100)

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
          const catPercent = used > 0 ? (cat.tokens / total) * 100 : 0
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
  const [compacting, setCompacting] = useState(false)

  const handleCompact = async () => {
    setCompacting(true)
    try {
      await electronHermes.send('compaction.compact', {})
      useHelixStore.getState().showToast({ type: 'success', title: '已请求压缩上下文' })
    } catch {
      useHelixStore.getState().showToast({ type: 'error', title: '压缩失败或网关不支持' })
    } finally {
      setCompacting(false)
      onClose()
    }
  }

  return (
    <div className="absolute bottom-full right-0 mb-2 w-72 bg-card border border-border/60 rounded-xl shadow-lg p-3 z-50">
      <ContextUsageBar used={used} total={total} categories={categories} />
      {/* Legend list */}
      <div className="mt-3 space-y-1.5">
        {categories.filter(c => c.tokens > 0).map(item => (
          <div key={item.id} className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-sm ${item.color}`} />
              <span className="text-xs text-foreground">{item.label}</span>
            </div>
            <span className="text-xs text-muted-foreground">~{formatTokens(item.tokens)}</span>
          </div>
        ))}
      </div>
      <button
        onClick={handleCompact}
        disabled={compacting}
        className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
      >
        {compacting ? <Loader2 className="size-3.5 animate-spin" /> : <Shrink className="size-3.5" />}
        {compacting ? '压缩中…' : '压缩上下文'}
      </button>
    </div>
  )
}

// ---- Main indicator (button + popover combo) ----

export function ContextUsageIndicator() {
  const [open, setOpen] = useState(false)
  const [backendData, setBackendData] = useState<ContextUsageData | null>(null)
  const activeModel = useHelixStore(s => s.activeModel)
  const apiConfig = useHelixStore(s => s.apiConfig)
  const isStreaming = useHelixStore(s => s.isChatLoading)
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
      const result = await electronHermes.send('session.context_breakdown', {})
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
              await electronHermes.send('compaction.compact', {})
              debug('[ContextUsage] auto-compaction triggered at', data.context_percent.toFixed(1), '%')
            } catch { /* backend may not support */ }
          }
        }
      }
    } catch {
      // Backend may not support this — degrade gracefully
    }
  }, [])

  useEffect(() => {
    fetchContextData()
    if (!isStreaming) return // Only poll while streaming
    const interval = setInterval(fetchContextData, 10000)
    return () => clearInterval(interval)
  }, [isStreaming, fetchContextData])

  const modelName = activeModel || apiConfig?.model || ''
  const total = backendData?.context_max || getModelContextWindow(modelName)
  const used = backendData?.context_used || 0

  const categories: ContextBreakdown[] = backendData?.categories || [
    { id: 'system', label: '系统提示词', tokens: 0, color: 'bg-gray-500' },
    { id: 'tools', label: '工具及子智能体', tokens: 0, color: 'bg-blue-500' },
    { id: 'messages', label: '对话消息', tokens: 0, color: 'bg-orange-500' },
    { id: 'mcp', label: '连接器及MCP', tokens: 0, color: 'bg-pink-500' },
    { id: 'skills', label: '技能', tokens: 0, color: 'bg-sky-500' },
  ]

  if (used === 0) return null

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="size-9 rounded-lg flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
        title="上下文使用情况"
      >
        <ContextUsageRing used={used} total={total} />
      </button>
      {open && <ContextUsagePanel used={used} total={total} categories={categories} onClose={() => setOpen(false)} />}
    </div>
  )
}

// ---- Ring component (small circular progress indicator) ----

export function ContextUsageRing({ used, total = 128000 }: { used: number; total?: number }) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100)
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (percentage / 100) * circumference
  const colorClass = percentage > 90 ? 'text-red-500' : percentage > 70 ? 'text-amber-500' : 'text-primary'

  return (
    <div className="relative size-5 flex items-center justify-center">
      <svg className="size-4 -rotate-90" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={`${colorClass} transition-all duration-300`}
        />
      </svg>
    </div>
  )
}
