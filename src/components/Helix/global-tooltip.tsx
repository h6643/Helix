'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TipState {
  text: string
  x: number
  y: number
  above: boolean
}

/**
 * Themed replacement for the native `data-tip=""` tooltip.
 *
 * Every icon button in the app previously relied on the browser-native
 * `title` attribute, which the OS renders in its own un-themable style
 * (yellow box on Windows, grey box on Linux/WebKitGTK) — it never follows
 * the Catppuccin/shadcn tokens. Those `title=` attributes have been renamed
 * to `title=` across the codebase; this single component reads them via
 * event delegation and renders one portal tooltip styled with the app's
 * semantic tokens, so it tracks light/dark and all 25 themes automatically.
 *
 * Event-delegated (one global listener) so it works for any element that
 * gains a `data-tip` attribute without per-call wiring.
 */
export function GlobalTooltip() {
  const [state, setState] = useState<TipState | null>(null)
  const timer = useRef<number | null>(null)
  const current = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    const hide = () => {
      clearTimer()
      current.current = null
      setState(null)
    }
    const showFor = (el: HTMLElement) => {
      const text = (el.getAttribute('data-tip') || '').trim()
      if (!text) return
      const rect = el.getBoundingClientRect()
      const above = rect.top > 40
      setState({
        text,
        x: rect.left + rect.width / 2,
        y: above ? rect.top : rect.bottom,
        above,
      })
    }
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      const el = t.closest('[data-tip]') as HTMLElement | null
      if (!el || !(el.getAttribute('data-tip') || '').trim()) {
        hide()
        return
      }
      if (el === current.current) return
      current.current = el
      clearTimer()
      timer.current = window.setTimeout(() => showFor(el), 350)
    }
    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null
      if (!related || !related.closest('[data-tip]')) hide()
    }
    const onScroll = () => hide()

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('scroll', onScroll, true)
      clearTimer()
    }
  }, [])

  if (!state || typeof document === 'undefined') return null

  const style: React.CSSProperties = state.above
    ? { position: 'fixed', left: state.x, top: state.y - 8, transform: 'translate(-50%, -100%)' }
    : { position: 'fixed', left: state.x, top: state.y + 8, transform: 'translate(-50%, 0)' }

  return createPortal(
    <div
      role="tooltip"
      style={style}
      className="pointer-events-none z-[9999] max-w-[280px] whitespace-pre-wrap break-words rounded-md border border-border bg-popover px-2 py-1 text-xs leading-relaxed text-foreground shadow-md"
    >
      {state.text}
    </div>,
    document.body,
  )
}
