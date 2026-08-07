'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, SectionHeading, PopupSelect } from './settings-ui'
import { THEME_SELECT_GROUPS } from '@/lib/themes'

/**
 * Custom theme picker. Native `<select>` + `<optgroup>` popups are unreliable
 * in WebKitGTK (the 3rd group can silently disappear from the popup), so the
 * options render as an HTML list instead of a GTK ComboBox popup.
 */
function ThemeStylePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const currentLabel =
    THEME_SELECT_GROUPS.flatMap((g) => g.options).find((o) => o.value === value)?.label ?? '默认'

  // Close on outside click / Escape.
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

  // Anchor below the trigger, right-aligned; flip above if it would overflow.
  useEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    // popup 与触发器同宽（w-56 = 224px），右对齐后两者左缘也对齐。
    const left = Math.max(8, r.right - 224)
    setPos({ left, top: r.bottom + 4 })
  }, [open])

  useEffect(() => {
    if (!open || !popRef.current) return
    const pr = popRef.current.getBoundingClientRect()
    if (pr.bottom > window.innerHeight - 8 && btnRef.current) {
      const br = btnRef.current.getBoundingClientRect()
      popRef.current.style.top = `${Math.max(8, br.top - pr.height - 4)}px`
    }
  }, [open, pos])

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-xs font-mono text-foreground/70 focus:outline-none focus:border-primary/30 transition-colors flex items-center justify-between gap-2 text-left"
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && pos && (
        <div
          ref={popRef}
          className="fixed z-50 w-56 bg-popover border border-border rounded-xl shadow-xl py-1 max-h-[70vh] overflow-y-auto backdrop-blur-sm"
          style={{ left: pos.left, top: pos.top }}
        >
          {THEME_SELECT_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {g.label}
              </div>
              {g.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false) }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors text-left ${
                    o.value === value
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-accent/50'
                  }`}
                >
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.value === value && <Check className="size-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const FONT_OPTIONS = [
  { label: '默认', value: "'Geist Mono', 'Fira Code', 'Consolas', monospace" },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'SF Mono', value: '"SF Mono", monospace' },
]

const UI_FONT_OPTIONS = [
  { label: '默认', value: 'var(--font-geist-sans)' },
  { label: 'Inter', value: '"Inter", sans-serif' },
  { label: 'SF Pro', value: '"-apple-system", "SF Pro", sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'Consolas', value: 'Consolas, monospace' },
]

const fontSelect = (value: string, onChange: (v: string) => void, options: { label: string; value: string }[]) => (
  <PopupSelect
    value={value}
    onChange={onChange}
    options={options}
    placeholder="默认"
    className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-xs font-mono text-foreground/70 focus:outline-none focus:border-primary/30 transition-colors"
  />
)

const stepper = (value: number, min: number, max: number, onChange: (v: number) => void) => (
  <div className="flex items-center gap-1.5 justify-self-end">
    <button onClick={() => onChange(Math.max(min, value - 1))}
      className="w-6 h-6 rounded border border-border/20 bg-muted/20 text-muted-foreground/50 hover:text-foreground text-xs flex items-center justify-center">−</button>
    <span className="w-7 text-center text-xs font-mono">{value}</span>
    <button onClick={() => onChange(Math.min(max, value + 1))}
      className="w-6 h-6 rounded border border-border/20 bg-muted/20 text-muted-foreground/50 hover:text-foreground text-xs flex items-center justify-center">+</button>
  </div>
)

export function AppearanceSettingsPanel({ themeStyle, onSelectThemeStyle }: {
  themeStyle: string
  onSelectThemeStyle: (styleId: string) => void
}) {
  const fontFamily = useHelixStore(s => s.fontFamily)
  const setFontFamily = useHelixStore(s => s.setFontFamily)
  const fontSize = useHelixStore(s => s.fontSize)
  const setFontSize = useHelixStore(s => s.setFontSize)
  const interfaceFont = useHelixStore(s => s.interfaceFont)
  const setInterfaceFont = useHelixStore(s => s.setInterfaceFont)
  const transcriptFontSize = useHelixStore(s => s.transcriptFontSize)
  const setTranscriptFontSize = useHelixStore(s => s.setTranscriptFontSize)

  return (
    <div className="space-y-1">
      <SectionHeading>外观</SectionHeading>

      <SettingRow label="配色风格">
        <ThemeStylePicker value={themeStyle} onChange={onSelectThemeStyle} />
      </SettingRow>

      <SettingGroup title="编辑器">
        <SettingRow label="代码字体">
          {fontSelect(fontFamily, setFontFamily, FONT_OPTIONS)}
        </SettingRow>
        <SettingRow label="字号">
          {stepper(fontSize, 10, 32, setFontSize)}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="界面">
        <SettingRow label="UI 字体">
          {fontSelect(interfaceFont, setInterfaceFont, UI_FONT_OPTIONS)}
        </SettingRow>
        <SettingRow label="界面字号">
          {stepper(transcriptFontSize, 10, 28, setTranscriptFontSize)}
        </SettingRow>
      </SettingGroup>
    </div>
  )
}
