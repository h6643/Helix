'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, SectionHeading, PopupSelect, NumberField, useLockScrollOnOpen } from './settings-ui'
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
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  // 展开期间锁定背景滚动容器，避免 fixed 弹层与触发器错位。
  useLockScrollOnOpen(open, btnRef)

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
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); (document.activeElement as HTMLElement)?.blur?.() }
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
    // popup 与触发器同宽（w-40 = 160px），右对齐后两者左缘也对齐。
    const left = Math.max(8, r.right - 160)
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

  // 打开时自动滚动到当前选中的主题，而不是每次都从列表顶部开始。
  useEffect(() => {
    if (!open || !pos || !popRef.current || !selectedRef.current) return
    const container = popRef.current
    const el = selectedRef.current
    const cTop = container.scrollTop
    const elTop = el.offsetTop
    const cH = container.clientHeight
    const elH = el.offsetHeight
    if (elTop < cTop || elTop + elH > cTop + cH) {
      container.scrollTop = Math.max(0, elTop - (cH - elH) / 2)
    }
  }, [open, pos])

  // 列表展开期间滚轮只滚动列表本身，绝不滚动背后的设置页：列表可滚动时在
  // 列表内滚动，滚到边界或列表本身不可滚动（内容没超出 max-h）时 preventDefault
  // 阻止滚动链冒泡到页面（passive:false 才能 preventDefault）。
  useEffect(() => {
    if (!open || !popRef.current) return
    const el = popRef.current
    const onWheel = (e: WheelEvent) => {
      const canDown = el.scrollHeight > el.clientHeight && el.scrollTop + el.clientHeight < el.scrollHeight - 1
      const canUp = el.scrollTop > 0
      const down = e.deltaY > 0
      if ((down && !canDown) || (!down && !canUp)) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
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
          className="fixed z-50 w-40 bg-popover border-0 rounded-xl shadow-xl py-1 max-h-[70vh] overflow-y-auto overscroll-contain backdrop-blur-sm"
          style={{ left: pos.left, top: pos.top }}
        >
          {THEME_SELECT_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="px-3 pt-2 pb-1 text-[calc(var(--helix-transcript-size)*0.7143)] font-medium uppercase tracking-wider text-muted-foreground/60">
                {g.label}
              </div>
              {g.options.map((o) => (
                <button
                  key={o.value}
                  ref={o.value === value ? selectedRef : undefined}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); btnRef.current?.focus({ preventScroll: true }) }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] transition-colors text-left ${
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

      {/* 编辑器：标题和描述在卡片上方，卡片内放代码字体/字号 */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">编辑器</h4>
        </div>
        <SettingGroup>
          <SettingRow label="代码字体" hint="调整代码内容使用的等宽字体。">
            {fontSelect(fontFamily, setFontFamily, FONT_OPTIONS)}
          </SettingRow>
          <SettingRow label="代码字号" hint="调整代码块、文件预览和差异视图的默认字号。">
            {stepper(fontSize, 10, 32, setFontSize)}
          </SettingRow>
        </SettingGroup>
      </div>

      {/* 界面：标题和描述在卡片上方，卡片内放 UI 字体/字号 */}
      <div className="pt-1">
        <div className="px-4 pt-3 pb-2">
          <h4 className="ui-subtitle font-semibold text-foreground">界面</h4>
        </div>
        <SettingGroup>
          <SettingRow label="UI 字体" hint="调整界面文字使用的字体。">
            {fontSelect(interfaceFont, setInterfaceFont, UI_FONT_OPTIONS)}
          </SettingRow>
          <SettingRow label="界面字号" hint="调整应用界面的文字大小，图标和布局尺寸不受影响。">
            {stepper(transcriptFontSize, 10, 28, setTranscriptFontSize)}
          </SettingRow>
        </SettingGroup>
      </div>
    </div>
  )
}
