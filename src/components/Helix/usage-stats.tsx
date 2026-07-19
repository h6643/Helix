'use client'

import React, { useState, useEffect } from 'react'
import { Zap, Activity, Target, ArrowDown, ArrowUp } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { formatTokens } from '@/lib/format'

export function ModelUsageStats() {
  const modelUsage = useHelixStore(s => s.modelUsage)
  const entries = Object.entries(modelUsage)

  if (entries.length === 0) return null

  const totalCost = entries.reduce((sum, [, u]) => sum + u.cost, 0)

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-foreground">模型 Token 使用量</h3>
      <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
        <div className="grid grid-cols-4 gap-2 px-4 py-2 bg-muted/30 border-b border-border/50 text-xs font-medium text-foreground/60">
          <span>模型</span>
          <span className="text-right">输入</span>
          <span className="text-right">输出</span>
          <span className="text-right">成本</span>
        </div>
        {entries.sort((a, b) => b[1].total - a[1].total).map(([model, usage]) => (
          <div key={model} className="grid grid-cols-4 gap-2 px-4 py-2.5 border-b border-border/50 last:border-0 text-sm">
            <span className="font-mono text-foreground truncate">{model}</span>
            <span className="text-right text-foreground/70 font-mono">{formatTokens(usage.prompt)}</span>
            <span className="text-right text-foreground/70 font-mono">{formatTokens(usage.completion)}</span>
            <span className="text-right text-foreground/70 font-mono">${usage.cost.toFixed(4)}</span>
          </div>
        ))}
        <div className="grid grid-cols-4 gap-2 px-4 py-2.5 bg-muted/30 text-sm font-medium">
          <span>总计</span>
          <span className="text-right font-mono">{formatTokens(entries.reduce((s, [, u]) => s + u.prompt, 0))}</span>
          <span className="text-right font-mono">{formatTokens(entries.reduce((s, [, u]) => s + u.completion, 0))}</span>
          <span className="text-right font-mono">${totalCost.toFixed(4)}</span>
        </div>
      </div>
    </section>
  )
}

export function UsageSummary() {
  const agentSteps = useHelixStore(s => s.agentExecutionSteps)
  const [usageHistory, setUsageHistory] = useState<Array<{ prompt: number; completion: number; cost: number; timestamp: number }>>([])

  useEffect(() => {
    const usages: Array<{ prompt: number; completion: number; cost: number; timestamp: number }> = []
    for (const step of agentSteps) {
      if (step.type === 'usage' && step.content) {
        const match = step.content.match(/Tokens: (\d+) total \| Cost: \$([\d.]+)/)
        if (match) {
          usages.push({
            prompt: 0,
            completion: 0,
            cost: parseFloat(match[2]),
            timestamp: step.timestamp,
          })
        }
      }
    }
    if (usages.length > 0) setUsageHistory(usages)
  }, [agentSteps])

  const totalCost = usageHistory.reduce((sum, u) => sum + u.cost, 0)
  const callCount = usageHistory.length

  if (callCount === 0) return null

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-foreground">本次会话用量</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl border border-border/50 bg-card/50 shadow-sm">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">API 调用</p>
          <p className="text-2xl font-semibold text-foreground mt-1">{callCount}</p>
        </div>
        <div className="p-3 rounded-xl border border-border/50 bg-card/50 shadow-sm">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">预估成本</p>
          <p className="text-2xl font-semibold text-foreground mt-1">${totalCost.toFixed(4)}</p>
        </div>
      </div>
      {totalCost > 1 && (
        <p className="text-xs text-amber-500">本次会话成本已超过 $1.00</p>
      )}
    </section>
  )
}

export function UsageDetail() {
  const agentSteps = useHelixStore(s => s.agentExecutionSteps)
  const [rows, setRows] = useState<Array<{ tokens: number; cost: number; model: string; timestamp: number }>>([])

  useEffect(() => {
    const list: Array<{ tokens: number; cost: number; model: string; timestamp: number }> = []
    for (const step of agentSteps) {
      if (step.type === 'usage' && step.content) {
        const m = step.content.match(/Tokens:\s*(\d+)\s*total\s*\|\s*Cost:\s*\$([\d.]+)(?:\s*\|\s*Model:\s*(\S+))?/)
        if (m) {
          list.push({
            tokens: parseInt(m[1]) || 0,
            cost: parseFloat(m[2]) || 0,
            model: (m[3] || '').trim() || '-',
            timestamp: step.timestamp,
          })
        }
      }
    }
    setRows(list)
  }, [agentSteps])

  if (rows.length === 0) return null

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-foreground">用量明细</h3>
      <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
        <div className="grid grid-cols-4 gap-2 px-4 py-2 bg-muted/30 border-b border-border/50 text-xs font-medium text-foreground/60">
          <span>时间</span>
          <span>模型</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">成本</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-4 gap-2 px-4 py-2 border-b border-border/50 last:border-0 text-sm">
            <span className="text-foreground/60">{new Date(r.timestamp).toLocaleTimeString()}</span>
            <span className="font-mono text-foreground truncate">{r.model}</span>
            <span className="text-right font-mono text-foreground/70">{formatTokens(r.tokens)}</span>
            <span className="text-right font-mono text-foreground/70">${r.cost.toFixed(4)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function TokenUsagePanel() {
  const stats = useHelixStore(s => s.sessionUsageStats)

  if (stats.requestCount === 0) {
    return (
      <section className="rounded-xl border border-border/40 bg-muted/20 px-5 py-12 text-center">
        <p className="text-sm text-muted-foreground/70">尚未获取到用量数据</p>
        <p className="text-xs text-muted-foreground/50 mt-1.5">运行一次对话后，这里会自动显示 Token 消耗情况</p>
      </section>
    )
  }

  const formatBig = (n: number) => {
    if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`
    if (n >= 10_000) return `${(n / 10_000).toFixed(2)} 万`
    return n.toLocaleString()
  }

  const totalInput = stats.inputTokens + stats.cachedReadTokens
  const cacheHitRate = totalInput > 0 ? (stats.cachedReadTokens / totalInput) * 100 : 0

  return (
    <section className="space-y-4">
      {/* Total consumed tokens — large hero card */}
      <div className="rounded-xl border border-border/40 bg-card p-5">
        <div className="flex items-start gap-4">
          <div className="rounded-xl bg-blue-500/10 p-3">
            <Zap className="size-6 text-blue-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground/70">真实消耗 Tokens</p>
            <p className="text-3xl font-semibold tabular-nums text-foreground mt-1">{stats.totalTokens.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground/50 mt-0.5">≈ {formatBig(stats.totalTokens)}</p>
          </div>
        </div>
      </div>

      {/* Request count + cache hit */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border/40 bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground/70">
            <Activity className="size-3.5" />
            <span className="text-xs">总请求数</span>
          </div>
          <p className="text-lg font-semibold tabular-nums text-foreground mt-1.5">{stats.requestCount.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-border/40 bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground/70">
            <Target className="size-3.5" />
            <span className="text-xs">缓存命中</span>
          </div>
          <p className="text-lg font-semibold tabular-nums text-foreground mt-1.5">{formatBig(stats.cachedReadTokens)}</p>
        </div>
      </div>

      {/* Input + Output */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border/40 bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground/70">
            <ArrowDown className="size-3.5" />
            <span className="text-xs">新增输入</span>
          </div>
          <p className="text-lg font-semibold tabular-nums text-foreground mt-1.5">{formatBig(stats.inputTokens)}</p>
        </div>
        <div className="rounded-xl border border-border/40 bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground/70">
            <ArrowUp className="size-3.5" />
            <span className="text-xs">Output</span>
          </div>
          <p className="text-lg font-semibold tabular-nums text-foreground mt-1.5">{formatBig(stats.outputTokens)}</p>
        </div>
      </div>

      {/* Cache hit rate */}
      <div className="rounded-xl border border-border/40 bg-card p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground/70">缓存命中率</span>
          <span className="text-sm font-medium text-emerald-500">{cacheHitRate.toFixed(1)}%</span>
        </div>
        <div className="h-2 w-full rounded-full bg-muted mt-2.5 overflow-hidden">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.min(100, cacheHitRate)}%` }}
          />
        </div>
      </div>
    </section>
  )
}
