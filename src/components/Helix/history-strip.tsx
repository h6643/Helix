'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelixStore } from '@/stores/helix-store'

/**
 * 消息区左侧「消息定位」栏：针对**当前对话**，每条消息渲染一根细线标记
 * （用户消息偏蓝、助手消息偏灰）。默认只显示细线、不显示文字。
 *
 * 交互：
 * - **滚动跟随高亮**：消息列表滚动时，当前视口中心附近的消息对应的细线自动加亮（蓝色），
 *   像截图里的进度指示器——你滚到哪条，哪条就亮。
 * - **悬停显示文字**：鼠标移到任意一条上时，所有文字一起浮现；所在那条额外高亮背景。
 * - **点击定位**：点击某条 → 滚动到对应该消息并居中。
 */
export function HistoryStrip() {
  const chatMessages = useHelixStore((s) => s.chatMessages)
  const currentSessionId = useHelixStore((s) => s.currentSessionId)
  // 当前被 hover 的条（null = 未悬停，所有文字隐藏）。
  const [hovered, setHovered] = useState<string | null>(null)
  // 当前视口中心最接近的消息 id（滚动时自动更新）。
  const [activeId, setActiveId] = useState<string | null>(null)

  // 仅当前会话、且为用户消息（模型输出不显示条）。
  const messages = useMemo(
    () =>
      chatMessages.filter(
        (m) => (!m.sessionId || m.sessionId === currentSessionId) && m.role === 'user',
      ),
    [chatMessages, currentSessionId],
  )

  // 点击：在消息滚动容器内定位到对应 data-message-id 的元素并居中。
  const locate = useCallback((id: string) => {
    const viewport = document.querySelector('.msg-scroll-viewport') as HTMLElement | null
    const root = viewport ?? document
    const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

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
      className="absolute left-5 top-[6%] bottom-[12%] z-30 flex flex-col gap-1 overflow-y-auto hide-scrollbar py-1"
      onMouseLeave={() => setHovered(null)}
    >
      {messages.map((m) => {
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
            className={`flex items-center gap-2.5 h-5 px-1.5 rounded-md transition-colors duration-150 ${
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
    </div>
  )
}
