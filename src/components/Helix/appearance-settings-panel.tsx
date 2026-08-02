'use client'

import React from 'react'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, SectionHeading } from './settings-ui'
import { THEME_SELECT_GROUPS } from '@/lib/themes'

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
  <select value={value} onChange={(e) => onChange(e.target.value)}
    className="w-56 px-2.5 py-1 rounded border border-border/30 bg-popover text-popover-foreground text-xs focus:outline-none focus:border-primary/30 cursor-pointer appearance-none justify-self-end">
    {options.map(f => (
      <option key={f.value} value={f.value}>{f.label}</option>
    ))}
  </select>
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
    <div className="max-w-xl space-y-1">
      <SectionHeading>外观</SectionHeading>

      <SettingRow label="配色风格">
        <select
          value={themeStyle}
          onChange={(e) => onSelectThemeStyle(e.target.value)}
          className="w-96 px-2.5 py-1 rounded border border-border/30 bg-popover text-popover-foreground text-xs focus:outline-none focus:border-primary/30 cursor-pointer"
        >
          {THEME_SELECT_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
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
