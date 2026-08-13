'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TipState {
  text: string
  x: number
  y: number
  placement: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * Themed replacement for the native `data-tip=""` tooltip.
 *
 * Every icon button in the app previously relied on the browser-native
 * `title` attribute, which the OS renders in its own un-themable style
 * (yellow box on Windows, grey box on Linux/WebKitGTK) — it never follows
 * the Catppuccin/shadcn tokens. Those `title=` attributes have been renamed
 * to `data-tip=` across the codebase; this single component reads them via
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
  const tipRef = useRef<HTMLDivElement | null>(null)

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
      // Approximate tooltip dimensions. Width is estimated from text length;
      // real width will be capped by max-w-[280px]. Height is usually one line
      // (~28px) plus padding; allow a small safety margin.
      const approximateWidth = Math.min(280, Math.max(48, text.length * 12 + 16))
      const approximateHeight = 32
      const gap = 8
      // Tooltips sit BELOW the trigger button (never on the same row as it), with
      // the text laid out horizontally on one line. Bottom is preferred because
      // header buttons have little horizontal room and the area below is the chat
      // panel (plenty of space). Fall back to top/side only when bottom would
      // overflow the viewport.
      let placement: TipState['placement'] = 'bottom'
      if (rect.bottom + gap + approximateHeight <= window.innerHeight) {
        placement = 'bottom'
      } else if (rect.top - gap - approximateHeight >= 0) {
        placement = 'top'
      } else if (rect.right + gap + approximateWidth <= window.innerWidth) {
        placement = 'right'
      } else {
        placement = 'left'
      }

      let x = 0
      let y = 0
      switch (placement) {
        case 'top':
          x = rect.left + rect.width / 2
          y = rect.top - gap
          break
        case 'bottom':
          x = rect.left + rect.width / 2
          y = rect.bottom + gap
          break
        case 'left':
          x = rect.left - gap
          y = rect.top + rect.height / 2
          break
        case 'right':
          x = rect.right + gap
          y = rect.top + rect.height / 2
          break
      }

      setState({ text, x, y, placement })
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

  const transform =
    state.placement === 'top'
      ? 'translate(-50%, -100%)'
      : state.placement === 'bottom'
        ? 'translate(-50%, 0)'
        : state.placement === 'left'
          ? 'translate(-100%, -50%)'
          : 'translate(0, -50%)'

  const style: React.CSSProperties = {
    position: 'fixed',
    left: state.x,
    top: state.y,
    transform,
  }

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      style={style}
      className="pointer-events-none z-[9999] max-w-[280px] whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs leading-relaxed text-foreground shadow-md"
    >
      {state.text}
    </div>,
    document.body,
  )
}
