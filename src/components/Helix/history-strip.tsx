'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

/** 历史对话竖条：每页最多显示 20 根消息线（与左侧会话列表分页一致）。 */
const PAGE_SIZE = 20

/**
 * 消息区左侧「消息定位」栏：针对**当前对话**，每条消息渲染一根细线标记
 * （用户消息偏蓝、助手消息偏灰）。默认只显示细线、不显示文字。
 *
 * 交互：
 * - **滚动跟随高亮**：消息列表滚动时，当前视口中心附近的消息对应的细线自动加亮（蓝色），
 *   像截图里的进度指示器——你滚到哪条，哪条就亮。
 * - **悬停显示文字**：鼠标移到任意一条上时，所有文字一起浮现；所在那条额外高亮背景。
 * - **点击定位**：点击某条 → 滚动到对应该消息并居中。
 * - **分页**：每页最多 20 条（默认最新一页），竖条上滚轮翻页（上=更早、下=更新），底部 ↑/↓ 按钮兜底。
 */
export function HistoryStrip() {
  const chatMessages = useHelixStore((s) => s.chatMessages)
  const currentSessionId = useHelixStore((s) => s.currentSessionId)
  // 当前被 hover 的条（null = 未悬停，所有文字隐藏）。
  const [hovered, setHovered] = useState<string | null>(null)
  // 当前视口中心最接近的消息 id（滚动时自动更新）。
  const [activeId, setActiveId] = useState<string | null>(null)
  // 分页偏移：0 = 最新一页，1 = 往前一页……（基于末尾偏移，新消息到达时窗口自动跟随）。
  const [pageOffset, setPageOffset] = useState(0)

  // 仅当前会话、且为用户消息（模型输出不显示条）。
  const messages = useMemo(
    () =>
      chatMessages.filter(
        (m) => (!m.sessionId || m.sessionId === currentSessionId) && m.role === 'user',
      ),
    [chatMessages, currentSessionId],
  )

  const totalPages = Math.max(1, Math.ceil(messages.length / PAGE_SIZE))
  // 切换会话时回到最新一页；消息减少导致越界时也 clamp 回有效页。
  useEffect(() => {
    setPageOffset(0)
  }, [currentSessionId])
  const safeOffset = Math.min(pageOffset, totalPages - 1)
  const pageStart = Math.max(0, messages.length - (safeOffset + 1) * PAGE_SIZE)
  const pageMessages = messages.slice(pageStart, pageStart + PAGE_SIZE)
  const curPage = safeOffset + 1

  // 点击：在消息滚动容器内定位到对应 data-message-id 的元素并居中。
  const locate = useCallback((id: string) => {
    const viewport = document.querySelector('.msg-scroll-viewport') as HTMLElement | null
    const root = viewport ?? document
    const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  // 滚轮翻页：竖条内滚轮向上 = 更早一页，向下 = 更新一页。
  // 内容本身不足一屏时（不会滚出边界），preventDefault 阻止冒泡到背后页面。
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (totalPages <= 1) return
      e.preventDefault()
      if (e.deltaY < 0) {
        setPageOffset((p) => Math.min(p + 1, totalPages - 1))
      } else if (e.deltaY > 0) {
        setPageOffset((p) => Math.max(p - 1, 0))
      }
    },
    [totalPages],
  )

  // ── 滚动监听：实时追踪视口中心最近的消息 ───────────────────────
  useEffect(() => {
    const viewport = document.querySelector('.msg-scroll-viewport') as HTMLElement | null
    if (!viewport || messages.length === 0) return

    let raf = 0
    const update = () => {
      const vTop = viewport.scrollTop
      const vCenter = vTop + viewport.clientHeight / 2
      let best: string | null = null
      let bestDist = Infinity
      for (const m of messages) {
        const el = viewport.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`) as HTMLElement | null
        if (!el) continue
        const elCenter = el.offsetTop + el.offsetHeight / 2
        const dist = Math.abs(elCenter - vCenter)
        if (dist < bestDist) {
          bestDist = dist
          best = m.id
        }
      }
      setActiveId(best)
    }

    // 初始计算 + 滚动节流
    update()
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [messages])

  if (messages.length === 0) return null

  return (
    <div
      className="absolute left-5 top-[6%] bottom-[12%] z-30 flex flex-col gap-1.5 overflow-y-auto hide-scrollbar py-1"
      onMouseLeave={() => setHovered(null)}
      onWheel={onWheel}
    >
      {pageMessages.map((m) => {
        const raw = (m.content ?? '').trim() || '(空消息)'
        const text = raw.replace(/\s+/g, ' ').slice(0, 10)
        const isActive = activeId === m.id
        const isHovered = hovered === m.id
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => locate(m.id)}
            onMouseEnter={() => setHovered(m.id)}
            className={`flex items-center gap-2.5 h-2.5 px-1.5 rounded-md transition-colors duration-150 ${
              isHovered ? 'bg-muted/60' : ''
            }`}
          >
            {/* 细线标记：视口中心最近的消息加亮蓝色，其余淡蓝 */}
            <span
              className={`w-5 h-1 rounded-full shrink-0 transition-colors duration-200 ${
                isActive ? 'bg-primary' : 'bg-primary/30'
              }`}
            />
            {/* 文字：默认折叠隐藏；只要鼠标在某条上就全部浮现 */}
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-150 text-foreground/75 ${
                isHovered ? 'text-primary/80' : ''
              } ${hovered !== null ? 'max-w-[180px] opacity-100' : 'max-w-0 opacity-0'}`}
              style={{ fontSize: 'calc(var(--helix-transcript-size) * 0.8571)' }}
            >
              {text}
            </span>
          </button>
        )
      })}
      {/* 分页控件：仅当消息超过一页时显示（↑ 翻向更早，↓ 翻回更新） */}
      {totalPages > 1 && (
        <div className="flex items-center gap-0.5 pt-1 mt-0.5 border-t border-border/40">
          <button
            type="button"
            onClick={() => setPageOffset((p) => Math.min(p + 1, totalPages - 1))}
            disabled={safeOffset >= totalPages - 1}
            className="p-0.5 rounded text-sidebar-foreground/40 hover:text-sidebar-foreground disabled:opacity-25 transition-colors"
            data-tip="更早的消息"
          >
            <ChevronUp className="size-3" />
          </button>
          <span
            className="px-0.5 text-[calc(var(--helix-transcript-size)*0.6429)] text-sidebar-foreground/30 select-none"
            style={{ lineHeight: 1 }}
          >
            {curPage}/{totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPageOffset((p) => Math.max(p - 1, 0))}
            disabled={safeOffset <= 0}
            className="p-0.5 rounded text-sidebar-foreground/40 hover:text-sidebar-foreground disabled:opacity-25 transition-colors"
            data-tip="更新的消息"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
