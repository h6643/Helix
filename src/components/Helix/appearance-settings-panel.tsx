'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, SectionHeading, PopupSelect, NumberField } from './settings-ui'
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
        className="w-40 ui-text-sm2 text-foreground border border-border bg-muted/20 rounded-md px-3 py-1.5 flex items-center justify-between gap-2 text-left focus:outline-none focus:border-primary/40 transition-colors"
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
    className="w-40 ui-text-sm2 text-foreground border border-border bg-muted/20 rounded-md px-3 py-1.5 focus:outline-none focus:border-primary/40 transition-colors"
  />
)

const stepper = (value: number, min: number, max: number, onChange: (v: number) => void) => (
  <NumberField value={value} min={min} max={max} onCommit={onChange} small />
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
    <div className="space-y-4">
      <SectionHeading>外观</SectionHeading>

      <SettingGroup>
        <SettingRow label="配色风格" hint="选择浅色、深色或跟随系统主题。">
          <ThemeStylePicker value={themeStyle} onChange={onSelectThemeStyle} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="编辑器" description="设置代码内容的字体和字号，不受界面字号影响。">
        <SettingRow label="代码字体" hint="调整代码内容使用的等宽字体。">
          {fontSelect(fontFamily, setFontFamily, FONT_OPTIONS)}
        </SettingRow>
        <SettingRow label="代码字号" hint="调整代码块、文件预览和差异视图的默认字号。">
          {stepper(fontSize, 10, 32, setFontSize)}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="界面" description="调整应用界面文字的大小与字体，图标和布局尺寸不受影响。">
        <SettingRow label="UI 字体" hint="调整界面文字使用的字体。">
          {fontSelect(interfaceFont, setInterfaceFont, UI_FONT_OPTIONS)}
        </SettingRow>
        <SettingRow label="界面字号" hint="调整应用界面的文字大小，图标和布局尺寸不受影响。">
          {stepper(transcriptFontSize, 10, 28, setTranscriptFontSize)}
        </SettingRow>
      </SettingGroup>
    </div>
  )
}
