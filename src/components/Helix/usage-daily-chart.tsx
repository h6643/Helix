'use client'

import React from 'react'
import { formatTokens } from '@/lib/format'

export interface DailyUsagePoint {
  day: string
  totalTokens: number
  totalCost: number
  requestCount: number
}

function dayLabel(day: string): string {
  const today = new Date()
  const y = today.getFullYear()
  const m = String(today.getMonth() + 1).padStart(2, '0')
  const d = String(today.getDate()).padStart(2, '0')
  const todayKey = `${y}-${m}-${d}`
  if (day === todayKey) return '今天'
  const yesterday = new Date(Date.now() - 86400000)
  const yy = yesterday.getFullYear()
  const ym = String(yesterday.getMonth() + 1).padStart(2, '0')
  const yd = String(yesterday.getDate()).padStart(2, '0')
  if (day === `${yy}-${ym}-${yd}`) return '昨天'
  return day.slice(5)
}

export function DailyUsageChart({ data, selectedDay, onSelect }: { data: DailyUsagePoint[]; selectedDay?: string; onSelect?: (day: string) => void }) {
  const width = 620
  const height = 260
  const padLeft = 64
  const padBottom = 26
  const padTop = 18
  const padRight = 8
  const innerW = width - padLeft - padRight
  const innerH = height - padTop - padBottom

  const max = Math.max(1, ...data.map(d => d.totalTokens))
  const niceMax = max * 1.1
  const step = niceMax / 4

  const barGap = data.length > 20 ? 3 : 5
  const barW = Math.max(2, (innerW - barGap * (data.length - 1)) / data.length)

  const gridY = (v: number) => padTop + innerH - (v / niceMax) * innerH

  const daysSinceToday = (day: string) => {
    const t = new Date(`${dayLabelForToday()}T00:00:00`).getTime()
    const d = new Date(`${day}T00:00:00`).getTime()
    return Math.round((t - d) / 86400000)
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="每日用量柱状图">
      {/* Y-axis gridlines */}
      {[0, 1, 2, 3, 4].map(i => {
        const v = step * i
        const y = gridY(v)
        return (
          <g key={i}>
            <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="var(--border)" strokeWidth={1} strokeOpacity={0.5} strokeDasharray={i === 0 ? 'none' : '3 3'} />
            <text x={padLeft - 8} y={y + 3} fontSize={10} textAnchor="end" fill="var(--foreground)" fillOpacity={0.5}>
              {v >= 10000 ? formatTokens(v) : Math.round(v).toLocaleString()}
            </text>
          </g>
        )
      })}

      {/* Bars */}
      {data.map((d, i) => {
        if (d.totalTokens <= 0) return null
        const x = padLeft + i * (barW + barGap)
        const h = (d.totalTokens / niceMax) * innerH
        const y = padTop + innerH - h
        const isToday = d.day === dayLabelForToday()
        const isSelected = d.day === selectedDay
        const opacity = isSelected ? 1 : isToday ? 1 : 0.45 + 0.4 * (d.totalTokens / max)
        return (
          <g key={d.day}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={Math.min(3, barW / 2)}
              fill="var(--primary)"
              fillOpacity={opacity}
              className={onSelect ? 'cursor-pointer' : undefined}
              onClick={onSelect ? () => onSelect(d.day) : undefined}
            >
              <title>{`${d.day} · ${formatTokens(d.totalTokens)} Tokens · $${d.totalCost.toFixed(4)}`}</title>
            </rect>
            {h > 26 && (
              <text
                x={x + barW / 2}
                y={y - 6}
                fontSize={10}
                textAnchor="middle"
                fill="var(--foreground)"
                fillOpacity={0.7}
              >
                {formatTokens(d.totalTokens)}
              </text>
            )}
          </g>
        )
      })}

      {/* X-axis labels — dense (30天) mode shows one date per week (anchored at today) */}
      {data.map((d, i) => {
        const dense = data.length > 14
        const x = padLeft + i * (barW + barGap) + barW / 2
        const isToday = d.day === dayLabelForToday()
        if (dense && daysSinceToday(d.day) % 7 !== 0) return null
        const label = dense ? d.day.slice(5) : dayLabel(d.day)
        return (
          <text
            key={d.day}
            x={x}
            y={height - (dense ? 10 : 8)}
            fontSize={dense ? 9 : 10}
            textAnchor="middle"
            fill="var(--foreground)"
            fillOpacity={isToday ? 0.9 : 0.5}
            fontWeight={isToday ? 600 : 400}
          >
            {label}
          </text>
        )
      })}
    </svg>
  )
}

function dayLabelForToday(): string {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}
