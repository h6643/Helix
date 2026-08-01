'use client'

import { Plus } from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
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
import { Toggle, SettingRow, SettingGroup, SectionHeading } from './settings-ui'

export function HookSettings() {
  const [settings, setSettings] = useState<HooksSettings>(EMPTY_HOOKS_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<null | 'ok' | 'err'>(null)

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
      <div className="max-w-xl">
        <SectionHeading>Hooks</SectionHeading>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="max-w-xl">
        <SectionHeading>Hooks</SectionHeading>
        <p className="text-sm text-muted-foreground">加载 Hooks 配置中…</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-1">
      <SectionHeading>Hooks</SectionHeading>

      <SettingRow label="启用 Hooks">
        <Toggle enabled={settings.enabled} onToggle={() => setMasterEnabled(!settings.enabled)} />
      </SettingRow>

      {HOOK_TYPES.map((type) => {
        const meta = HOOK_META[type]
        const hooks = hooksOfType(type)
        return (
          <SettingGroup
            key={type}
            title={meta.label}
            action={
              <Button size="icon" variant="outline" onClick={() => addHook(type)} aria-label="添加">
                <Plus className="size-4" />
              </Button>
            }
          >
            {hooks.map((hook) => (
              <div key={hook.id} className="py-2.5 px-1 -mx-1 space-y-2 hover:bg-muted/30 rounded-md transition-colors">
                <div className="flex items-center gap-2">
                  <Toggle enabled={hook.enabled} onToggle={() => toggleHook(hook.id)} />
                  <input
                    value={hook.command}
                    onChange={(e) => updateHook(hook.id, { command: e.target.value })}
                    placeholder="命令，如 python3 ~/.helix/hooks/notify.py"
                    className="flex-1 min-w-0 px-2.5 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 font-mono transition-colors"
                  />
                  <Button size="sm" variant="ghost" onClick={() => removeHook(hook.id)}>
                    删除
                  </Button>
                </div>
                {meta.supportsMatcher && (
                  <input
                    value={hook.matcher}
                    onChange={(e) => updateHook(hook.id, { matcher: e.target.value })}
                    placeholder="matcher 正则（工具名，留空=全部）"
                    className="w-full px-2.5 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 font-mono transition-colors"
                  />
                )}
              </div>
            ))}
          </SettingGroup>
        )
      })}

      <div className="flex items-center justify-end gap-3 pt-4">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? '保存并重启网关…' : '保存 Hooks 配置'}
        </Button>
        {saveState === 'ok' && (
          <span className="text-sm text-primary">已保存，网关已重启</span>
        )}
        {saveState === 'err' && <span className="text-sm text-destructive">保存失败，请重试</span>}
      </div>
    </div>
  )
}
