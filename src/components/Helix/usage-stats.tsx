'use client'

import React, { useState, useEffect } from 'react'
import { formatTokens } from '@/lib/format'
import { useHelixStore } from '@/stores/helix-store'
import { DailyUsageChart, type DailyUsagePoint } from './usage-daily-chart'

export function ModelUsageStats() {
  const modelUsage = useHelixStore(s => s.modelUsage)
  const entries = Object.entries(modelUsage)

  if (entries.length === 0) return null

  const totalCost = entries.reduce((sum, [, u]) => sum + u.cost, 0)

  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold text-foreground">模型 Token 使用量</h3>
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
      <h3 className="text-base font-semibold text-foreground">本次会话用量</h3>
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
      <h3 className="text-base font-semibold text-foreground">用量明细</h3>
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
  const dailyUsage = useHelixStore(s => s.dailyUsage)
  const [rangeDays, setRangeDays] = useState<7 | 30>(30)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

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

  const dayKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const addDays = (d: Date, n: number) => {
    const r = new Date(d)
    r.setDate(r.getDate() + n)
    return r
  }

  const dailyMap = new Map(Object.entries(dailyUsage))
  const days: DailyUsagePoint[] = []
  for (let i = rangeDays - 1; i >= 0; i--) {
    const key = dayKeyOf(addDays(new Date(), -i))
    const v = dailyMap.get(key)
    days.push({
      day: key,
      totalTokens: v?.totalTokens ?? 0,
      totalCost: v?.totalCost ?? 0,
      requestCount: v?.requestCount ?? 0,
    })
  }

  const today = days[days.length - 1]
  const activeDay = selectedDay && days.some(p => p.day === selectedDay) ? selectedDay : today.day

  const dayEntry = dailyMap.get(activeDay)
  const modelRows = dayEntry?.models
    ? Object.entries(dayEntry.models).sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    : []

  return (
    <section className="space-y-4">
      {/* Total consumed tokens — large hero card */}
      <div className="rounded-xl border border-border/40 bg-card p-5">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground/70">真实消耗 Tokens</p>
          <p className="text-3xl font-semibold tabular-nums text-foreground mt-1">{stats.totalTokens.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground/50 mt-0.5">≈ {formatBig(stats.totalTokens)}</p>
        </div>
      </div>

      {/* Daily usage bar chart */}
      <div className="rounded-xl border border-border/40 bg-card p-4">
        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium text-foreground">每日用量</h3>
            <div className="flex items-center rounded-lg border border-border/40 p-0.5">
              {([7, 30] as const).map(n => (
                <button
                  key={n}
                  onClick={() => setRangeDays(n)}
                  className={`px-2 py-0.5 rounded-md text-xs transition-colors ${
                    rangeDays === n
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground/60 hover:text-foreground'
                  }`}
                >
                  {n} 天
                </button>
              ))}
            </div>
          </div>
          {today.totalTokens > 0 && (
            <span className="text-xs text-muted-foreground/60">
              今日 {formatBig(today.totalTokens)} Tokens · ${today.totalCost.toFixed(4)}
            </span>
          )}
        </div>
        <div className="mt-3">
          <DailyUsageChart data={days} selectedDay={activeDay} onSelect={setSelectedDay} />
        </div>
      </div>

      {/* Activity heatmap */}
      <div className="rounded-xl border border-border/40 bg-card p-4">
        <h3 className="text-sm font-medium text-foreground">活跃热力图</h3>
        <img src="/usage-heatmap.png" alt="活跃热力图" className="mt-3 w-full h-auto rounded-lg" />
      </div>

      {/* Per-model breakdown for the selected day */}
      <div className="rounded-xl border border-border/40 bg-card">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h3 className="text-sm font-medium text-foreground">模型用量明细</h3>
          <span className="text-xs text-muted-foreground/60">{activeDay}</span>
        </div>
        {modelRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-xs text-muted-foreground/60">
                  <th className="text-left font-medium px-4 py-2">模型</th>
                  <th className="text-right font-medium px-4 py-2">Tokens</th>
                  <th className="text-right font-medium px-4 py-2">成本</th>
                  <th className="text-right font-medium px-4 py-2">请求数</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map(([model, m]) => (
                  <tr key={model} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2 font-mono text-foreground truncate">{model}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{formatTokens(m.totalTokens)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">${m.totalCost.toFixed(4)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{m.requestCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 pb-4 text-sm text-muted-foreground/50">该日无用量数据</p>
        )}
      </div>

    </section>
  )
}
