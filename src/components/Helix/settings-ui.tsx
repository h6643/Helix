'use client'

import React from 'react'

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
  <div className="flex items-center justify-between gap-4 py-2.5 px-1 -mx-1 rounded-md hover:bg-muted/30 transition-colors">
    <span className={`text-[13px] text-foreground ${labelClassName}`}>{label}</span>
    <div className="shrink-0">{children}</div>
  </div>
)

export const SettingGroup = ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <div className="pt-5 first:pt-0">
    <div className="mb-1 px-0.5 pb-2 border-b border-border/25 flex items-center justify-between gap-2">
      <h4 className="text-base font-semibold text-foreground">{title}</h4>
      {action}
    </div>
    <div className="divide-y divide-border/25">{children}</div>
  </div>
)

export const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-base font-semibold text-foreground tracking-tight mb-5">{children}</h3>
)
