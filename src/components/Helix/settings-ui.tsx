'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

// Obsidian 风格设置界面基础组件：平铺设置行 + 分组标题 + 开关。
// 无卡片、无折叠，设置项以行列出，控件右对齐。

export const Toggle = ({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) => (
  <button
    role="switch"
    aria-checked={enabled}
    onClick={onToggle}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
      enabled ? 'bg-primary' : 'bg-muted-foreground/20'
    }`}
  >
    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
      enabled ? 'translate-x-4' : ''
    }`} />
  </button>
)

export const SettingRow = ({ label, labelClassName = '', children }: { label: string; labelClassName?: string; children: React.ReactNode }) => (
  <div className="flex items-center gap-3 py-2.5 px-1 -mx-1 rounded-md hover:bg-muted/30 transition-colors">
    <span className={`text-sm text-foreground min-w-0 flex-1 ${labelClassName}`}>{label}</span>
    <div className="shrink-0">{children}</div>
  </div>
)

export const SettingGroup = ({ title, action, children, className = '', divider = 'bottom' }: { title?: string; action?: React.ReactNode; children?: React.ReactNode; className?: string; divider?: 'top' | 'bottom' }) => (
  <div className={`pt-5 first:pt-0 ${className}`}>
    {(title || action) && (
      <div className={`mb-1 px-0.5 flex items-center justify-between gap-2 ${
        divider === 'top'
          ? 'pt-2 border-t border-border/25'
          : 'pb-2 border-b border-border/25'
      }`}>
        <h4 className="text-base font-semibold text-foreground">{title}</h4>
        {action}
      </div>
    )}
    {children && <div className="divide-y divide-border/25">{children}</div>}
  </div>
)

export const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-lg font-semibold text-foreground tracking-tight mb-5">{children}</h3>
)

export interface PopupSelectOption {
  label: string
  value: string | number
  hint?: string
}

interface PopupSelectProps {
  value: string
  onChange: (v: string) => void
  options: PopupSelectOption[]
  placeholder?: string
  className?: string
  popupWidth?: number
  disabled?: boolean
}

/**
 * 自定义下拉选择。原生 `<select>` 的弹出列表在 WebKitGTK 下不可靠
 * （配色风格选择器因此改用 HTML 列表），这里做成通用组件：触发器 +
 * 固定定位的 HTML 弹出列表，点击外部 / Escape 关闭，选中项高亮打勾，
 * 展开样式与「配色风格」选择器保持一致。
 */
export function PopupSelect({
  value,
  onChange,
  options,
  placeholder = '请选择',
  className = 'w-56',
  popupWidth = 224,
  disabled = false,
}: PopupSelectProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const current = options.find((o) => String(o.value) === value)
  const currentLabel = current?.label ?? placeholder

  // 点击外部 / Escape 关闭。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 锚定在触发器下方、右对齐；超出视口则翻转到上方。
  useEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    setPos({ left: r.right - popupWidth, top: r.bottom + 4 })
  }, [open, popupWidth])

  useEffect(() => {
    if (!open || !pos || !popRef.current) return
    const pr = popRef.current.getBoundingClientRect()
    let top = pos.top
    if (pr.bottom > window.innerHeight - 8 && btnRef.current) {
      const br = btnRef.current.getBoundingClientRect()
      top = Math.max(8, br.top - pr.height - 4)
    }
    const left = Math.max(8, Math.min(pos.left, window.innerWidth - pr.width - 8))
    popRef.current.style.top = `${top}px`
    popRef.current.style.left = `${left}px`
  }, [open, pos])

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`${className} flex items-center justify-between gap-2 text-left disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && pos && (
        <div
          ref={popRef}
          className="fixed z-50 bg-popover border border-border rounded-xl shadow-xl py-1 max-h-[70vh] overflow-y-auto backdrop-blur-sm"
          style={{ left: pos.left, top: pos.top, width: popupWidth }}
        >
          {options.map((o) => {
            const selected = String(o.value) === value
            return (
              <button
                key={String(o.value)}
                type="button"
                onClick={() => { onChange(String(o.value)); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors text-left ${
                  selected
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/50'
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && (
                    <span className="block text-[10px] text-muted-foreground/60 truncate">{o.hint}</span>
                  )}
                </span>
                {selected && <Check className="size-3.5 shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
