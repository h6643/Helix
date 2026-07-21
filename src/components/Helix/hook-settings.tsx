'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Save, AlertTriangle, Zap, ChevronDown, ChevronRight, RotateCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isElectron } from '@/lib/electron-bridge'
import {
  type HookType,
  type HookConfig,
  type HooksSettings,
  HOOK_META,
  HOOK_TYPES,
  EMPTY_HOOKS_SETTINGS,
  generateHookId,
} from '@/lib/hooks-config'

// ── Local primitives ───────────────────────────────────────────────────────
const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-baseline gap-2 mb-4">
    <h3 className="text-lg font-semibold text-foreground">{children}</h3>
  </div>
)

const Toggle = ({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) => (
  <button
    onClick={onToggle}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${enabled ? 'bg-primary' : 'bg-muted-foreground/20'}`}
  >
    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${enabled ? 'translate-x-4' : ''}`} />
  </button>
)

export function HookSettings() {
  const [settings, setSettings] = useState<HooksSettings>(EMPTY_HOOKS_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<null | 'ok' | 'err'>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const electronReady = isElectron()

  useEffect(() => {
    if (!electronReady) { setLoaded(true); return }
    window.electron.hooks.getConfig()
      .then((r) => {
        if (r.ok && r.config) {
          // Convert legacy format if needed
          const hooks: HookConfig[] = []
          if (r.config.hooks && typeof r.config.hooks === 'object') {
            // Legacy format: { enabled, hooks: { event: [{ command, matcher }] } }
            for (const [event, handlers] of Object.entries(r.config.hooks)) {
              if (Array.isArray(handlers)) {
                for (const h of handlers) {
                  hooks.push({
                    id: generateHookId(),
                    type: event as HookType,
                    command: h.command || '',
                    matcher: h.matcher || '',
                    enabled: true,
                  })
                }
              }
            }
          }
          setSettings({ enabled: r.config.enabled !== false, hooks })
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [electronReady])

  const setMasterEnabled = (v: boolean) => setSettings(s => ({ ...s, enabled: v }))

  const hooksOfType = (type: HookType) => settings.hooks.filter(h => h.type === type)

  const addHook = (type: HookType) => {
    const newHook: HookConfig = {
      id: generateHookId(),
      type,
      command: '',
      matcher: '',
      enabled: true,
    }
    setSettings(s => ({ ...s, hooks: [...s.hooks, newHook] }))
  }

  const removeHook = (id: string) => {
    setSettings(s => ({ ...s, hooks: s.hooks.filter(h => h.id !== id) }))
  }

  const updateHook = (id: string, patch: Partial<HookConfig>) => {
    setSettings(s => ({
      ...s,
      hooks: s.hooks.map(h => h.id === id ? { ...h, ...patch } : h),
    }))
  }

  const toggleHook = (id: string) => {
    setSettings(s => ({
      ...s,
      hooks: s.hooks.map(h => h.id === id ? { ...h, enabled: !h.enabled } : h),
    }))
  }

  const save = useCallback(async () => {
    if (!electronReady) return
    setSaving(true)
    try {
      // Convert to backend format
      const hooksConfig: Record<string, { command: string; matcher?: string }[]> = {}
      for (const hook of settings.hooks) {
        if (!hook.command.trim()) continue
        if (!hooksConfig[hook.type]) hooksConfig[hook.type] = []
        hooksConfig[hook.type].push({
          command: hook.command,
          ...(hook.matcher ? { matcher: hook.matcher } : {}),
        })
      }
      const r = await window.electron.hooks.setConfig({ enabled: settings.enabled, hooks: hooksConfig })
      setSaveState(r.ok ? 'ok' : 'err')
    } catch {
      setSaveState('err')
    } finally {
      setSaving(false)
    }
  }, [settings, electronReady])

  if (!electronReady) {
    return (
      <div className="max-w-2xl">
        <SectionTitle>Hooks</SectionTitle>
        <div className="py-4 border-b border-border/30">
          <div className="flex items-center gap-2 text-amber-500 mb-2">
            <AlertTriangle className="size-5" />
            <p className="text-sm font-medium text-foreground">Hooks 需要在桌面端使用</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Hooks 由 Helix 写入外部 Hermes 后端的 config.yaml，仅在 Helix 桌面应用中可配置。
          </p>
        </div>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="max-w-2xl">
        <SectionTitle>Hooks</SectionTitle>
        <p className="text-sm text-muted-foreground">加载 Hooks 配置中…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <SectionTitle>Hooks</SectionTitle>

      {/* Master enable */}
      <div className="flex items-center justify-between py-3 gap-3 border-b border-border/30">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Zap className="size-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">启用 Hooks</p>
          </div>
        </div>
        <Toggle enabled={settings.enabled} onToggle={() => setMasterEnabled(!settings.enabled)} />
      </div>

      {/* Per-type sections */}
      {HOOK_TYPES.map((type) => {
        const meta = HOOK_META[type]
        const hooks = hooksOfType(type)
        const isCollapsed = collapsed.has(type)
        const toggle = () => setCollapsed(s => {
          const next = new Set(s)
          isCollapsed ? next.delete(type) : next.add(type)
          return next
        })

        return (
          <div key={type} className="border-b border-border/30">
            <div
              role="button"
              tabIndex={0}
              className="w-full py-2.5 flex items-center justify-between gap-2 pl-[22px] hover:bg-muted/20 transition-colors rounded-lg cursor-pointer"
              onClick={toggle}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle() }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium text-foreground truncate">{meta.label}</span>
                {hooks.length > 0 && (
                  <span className="text-xs text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-full">{hooks.length}</span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="outline" onClick={() => addHook(type)}>
                  <Plus className="size-3.5 mr-1" /> 添加
                </Button>
                {isCollapsed
                  ? <ChevronRight className="size-4 text-muted-foreground" />
                  : <ChevronDown className="size-4 text-muted-foreground" />}
              </div>
            </div>

            {!isCollapsed && (
              <div className="pb-4 pl-[22px] space-y-3">

                {hooks.map((hook) => (
                  <div key={hook.id} className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Toggle enabled={hook.enabled} onToggle={() => toggleHook(hook.id)} />
                      <input
                        value={hook.command}
                        onChange={(e) => updateHook(hook.id, { command: e.target.value })}
                        placeholder="命令，如 python3 ~/.helix/hooks/notify.py"
                        className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <Button size="sm" variant="ghost" onClick={() => removeHook(hook.id)}>
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                    {meta.supportsMatcher && (
                      <input
                        value={hook.matcher}
                        onChange={(e) => updateHook(hook.id, { matcher: e.target.value })}
                        placeholder="matcher 正则（工具名，留空=全部）"
                        className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Save bar */}
      <div className="flex items-center gap-3 pt-3">
        <Button onClick={save} disabled={saving}>
          {saving
            ? <><Loader2 className="size-4 mr-1 animate-spin" /> 保存并重启网关…</>
            : <><Save className="size-4 mr-1" /> 保存 Hooks 配置</>}
        </Button>
        {saveState === 'ok' && (
          <span className="text-sm text-primary flex items-center gap-1">
            <RotateCw className="size-3.5" /> 已保存，网关已重启
          </span>
        )}
        {saveState === 'err' && <span className="text-sm text-destructive">保存失败，请重试</span>}
      </div>
    </div>
  )
}
