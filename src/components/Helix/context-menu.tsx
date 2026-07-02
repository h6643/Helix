'use client'

import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  Pencil,
  Trash2,
  FilePlus,
  FolderPlus,
  Copy,
  Scissors,
  ClipboardPaste,
  Eye,
  FolderOpen,
  X,
} from 'lucide-react'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  shortcut?: string
  danger?: boolean
  divider?: boolean
  disabled?: boolean
  action: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

interface ContextMenuProps {
  state: ContextMenuState | null
  onClose: () => void
}

export function ContextMenu({ state, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    if (!state) return
    setActiveIndex(-1)
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    // Use timeout to avoid immediate close from the triggering right-click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
      document.addEventListener('keydown', handleKeyDown)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [state, onClose])

  // Adjust position to stay in viewport
  useEffect(() => {
    if (!menuRef.current || !state) return
    const rect = menuRef.current.getBoundingClientRect()
    const el = menuRef.current
    if (rect.right > window.innerWidth) {
      el.style.left = `${state.x - rect.width}px`
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${state.y - rect.height}px`
    }
  }, [state])

  if (!state) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-popover border border-border rounded-xl shadow-xl py-1 min-w-[180px] max-w-[260px] backdrop-blur-sm"
      style={{ left: state.x, top: state.y }}
      onKeyDown={(e) => {
        const items = state.items.filter(i => !i.disabled)
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIndex(i => Math.min(i + 1, items.length - 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex(i => Math.max(i - 1, 0))
        } else if (e.key === 'Enter' && activeIndex >= 0) {
          e.preventDefault()
          const enabledItems = state.items.filter(i => !i.disabled)
          if (enabledItems[activeIndex]) {
            enabledItems[activeIndex].action()
            onClose()
          }
        }
      }}
    >
      {state.items.map((item, idx) => {
        const enabledItems = state.items.filter(i => !i.disabled)
        const enabledIdx = enabledItems.indexOf(item)
        const isActive = enabledIdx === activeIndex

        if (item.divider) {
          return <div key={idx} className="my-1 border-t border-border" />
        }

        return (
          <button
            key={idx}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
              item.disabled
                ? 'text-muted-foreground/40 cursor-not-allowed'
                : item.danger
                ? 'text-destructive hover:bg-destructive/10'
                : isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground hover:bg-accent/50'
            }`}
            onClick={(e) => {
              e.stopPropagation()
              if (!item.disabled) {
                item.action()
                onClose()
              }
            }}
            onMouseEnter={() => setActiveIndex(enabledIdx)}
            disabled={item.disabled}
          >
            {item.icon && <span className="shrink-0 w-4 h-4 flex items-center justify-center">{item.icon}</span>}
            {!item.icon && <span className="w-4 shrink-0" />}
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0">{item.shortcut}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// Singleton context menu manager
let _setState: ((state: ContextMenuState | null) => void) | null = null
let _currentState: ContextMenuState | null = null

export function showContextMenu(e: React.MouseEvent | MouseEvent, items: ContextMenuItem[]) {
  e.preventDefault()
  e.stopPropagation()
  _currentState = { x: e.clientX, y: e.clientY, items }
  _setState?.(_currentState)
}

export function hideContextMenu() {
  _currentState = null
  _setState?.(null)
}

export function ContextMenuProvider() {
  const [state, setState] = useState<ContextMenuState | null>(null)

  useEffect(() => {
    _setState = setState
    return () => { _setState = null }
  }, [])

  return <ContextMenu state={state} onClose={() => setState(null)} />
}