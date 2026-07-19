'use client'

import React, { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { formatTokens } from '@/lib/format'

// ---- Types ----

interface ContextBreakdown {
  label: string
  tokens: number
  color: string
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

// ---- Panel (detailed breakdown popover) ----

function ContextUsagePanel({ used, total, breakdown, onClose }: { used: number; total: number; breakdown: ContextBreakdown[]; onClose: () => void }) {
  const percentage = Math.min(Math.max((used / total) * 100, 0), 100)
  const color = percentage > 90 ? 'bg-red-500' : percentage > 70 ? 'bg-amber-500' : 'bg-primary'

  return (
    <div className="absolute bottom-full right-0 mb-2 w-64 bg-card border border-border/60 rounded-xl shadow-lg p-3 z-50">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-1">
          <span className="text-sm font-semibold text-foreground">~{formatTokens(used)}</span>
          <span className="text-[10px] text-muted-foreground">/ {formatTokens(total)}</span>
          <span className={`text-[10px] font-medium ${percentage > 70 ? 'text-amber-500' : 'text-emerald-500'}`}>
            {percentage.toFixed(1)}% 上下文已用
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="h-1 w-full bg-muted rounded-full overflow-hidden mb-2">
        <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${percentage}%` }} />
      </div>
      <div className="space-y-1.5">
        {breakdown.map(item => (
          <div key={item.label} className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-sm ${item.color}`} />
              <span className="text-xs text-foreground">{item.label}</span>
            </div>
            <span className="text-xs text-muted-foreground">~{formatTokens(item.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- Main indicator (button + popover combo) ----

export function ContextUsageIndicator() {
  const [open, setOpen] = useState(false)
  const chatMessages = useHelixStore(s => s.chatMessages)
  const customInstructions = useHelixStore(s => s.customInstructions)
  const mcpServers = useHelixStore(s => s.mcpServers)
  const skills = useHelixStore(s => s.skills)
  const contextUsage = useHelixStore(s => s.contextUsage)
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

  // Use real backend data when available, fall back to local estimation
  const estimate = (text: string) => Math.max(0, Math.round(text.length / 3.5))

  const systemTokens = 8000 + estimate(customInstructions)
  const toolsTokens = 30 * 400
  const messagesText = chatMessages.map(m => m.content || '').join('\n')
  const messagesTokens = estimate(messagesText)
  const mcpCount = Object.values(mcpServers).filter(s => s.enabled !== false).length
  const mcpTokens = mcpCount * 30
  const skillsText = skills.map(s => `${s.name}: ${s.description || ''}`).join('\n')
  const skillsTokens = estimate(skillsText)

  const fallbackUsed = systemTokens + toolsTokens + messagesTokens + mcpTokens + skillsTokens

  // Prefer real backend context usage data
  const total = contextUsage?.size || 128000
  const used = contextUsage?.used || fallbackUsed

  const breakdown: ContextBreakdown[] = contextUsage ? [
    { label: '系统提示词', tokens: systemTokens, color: 'bg-gray-500' },
    { label: '工具及子智能体', tokens: toolsTokens, color: 'bg-purple-500' },
    { label: '对话消息', tokens: messagesTokens, color: 'bg-orange-500' },
    { label: '连接器及MCP', tokens: mcpTokens, color: 'bg-pink-500' },
    { label: '技能', tokens: skillsTokens, color: 'bg-sky-500' },
  ] : [
    { label: '系统提示词', tokens: systemTokens, color: 'bg-gray-500' },
    { label: '工具及子智能体', tokens: toolsTokens, color: 'bg-purple-500' },
    { label: '对话消息', tokens: messagesTokens, color: 'bg-orange-500' },
    { label: '连接器及MCP', tokens: mcpTokens, color: 'bg-pink-500' },
    { label: '技能', tokens: skillsTokens, color: 'bg-sky-500' },
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
      {open && <ContextUsagePanel used={used} total={total} breakdown={breakdown} onClose={() => setOpen(false)} />}
    </div>
  )
}
