'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Save, AlertTriangle, Code2, Zap, ChevronDown, ChevronRight, RotateCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isElectron } from '@/lib/electron-bridge'
import {
  type HooksConfig,
  type BackendHookEvent,
  type HookHandler,
  HOOK_EVENTS,
  HOOK_EVENT_LABELS,
  HOOK_EVENT_HINTS,
  EMPTY_HOOKS_CONFIG,
} from '@/lib/hooks-config'

// ── Local primitives (mirror api-settings.tsx for visual consistency) ──────
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

const SettingRow = ({ icon, label, description, children }: {
  icon: React.ReactNode; label: string; description: string; children: React.ReactNode
}) => (
  <div className="flex items-center justify-between px-4 py-3.5 rounded-xl border border-border/50 bg-card/50 shadow-sm gap-3">
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{description}</p>
      </div>
    </div>
    <div className="shrink-0">{children}</div>
  </div>
)

export function HookSettings() {
  const [config, setConfig] = useState<HooksConfig>(EMPTY_HOOKS_CONFIG)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<null | 'ok' | 'err'>(null)
  const [showJson, setShowJson] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<BackendHookEvent>>(new Set())

  const electronReady = isElectron()

  useEffect(() => {
    if (!electronReady) { setLoaded(true); return }
    window.electron.hooks.getConfig()
      .then((r) => { if (r.ok && r.config) setConfig(r.config) })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [electronReady])

  const setEnabled = (v: boolean) => setConfig((c) => ({ ...c, enabled: v }))

  const handlersOf = (ev: BackendHookEvent): HookHandler[] => config.hooks?.[ev] || []

  const updateHandlers = (ev: BackendHookEvent, handlers: HookHandler[]) =>
    setConfig((c) => ({ ...c, hooks: { ...c.hooks, [ev]: handlers } }))

  const addHandler = (ev: BackendHookEvent) =>
    updateHandlers(ev, [...handlersOf(ev), { command: '' }])

  const removeHandler = (ev: BackendHookEvent, hi: number) =>
    updateHandlers(ev, handlersOf(ev).filter((_, i) => i !== hi))

  const patchHandler = (ev: BackendHookEvent, hi: number, patch: Partial<HookHandler>) =>
    updateHandlers(ev, handlersOf(ev).map((h, i) => (i === hi ? { ...h, ...patch } : h)))

  const save = useCallback(async () => {
    if (!electronReady) return
    setSaving(true)
    try {
      const r = await window.electron.hooks.setConfig(config)
      setSaveState(r.ok ? 'ok' : 'err')
    } catch {
      setSaveState('err')
    } finally {
      setSaving(false)
    }
  }, [config, electronReady])

  const importJson = () => {
    setJsonError(null)
    try {
      const parsed = JSON.parse(jsonText)
      if (!parsed || typeof parsed !== 'object' || typeof parsed.hooks !== 'object') {
        setJsonError('结构无效：需要 { enabled?, hooks: { 事件名: [ { command, matcher?, timeout? } ] } }')
        return
      }
      // Keep only known backend event names; drop unknowns to avoid writing
      // something Hermes would silently ignore.
      const cleanHooks: HooksConfig['hooks'] = {}
      for (const ev of HOOK_EVENTS) {
        if (Array.isArray(parsed.hooks[ev])) {
          cleanHooks[ev] = parsed.hooks[ev]
            .filter((h: HookHandler) => h && typeof h.command === 'string' && h.command.trim())
            .map((h: HookHandler) => ({
              command: h.command,
              ...(typeof h.matcher === 'string' && h.matcher.trim() ? { matcher: h.matcher } : {}),
              ...(typeof h.timeout === 'number' && h.timeout > 0 ? { timeout: h.timeout } : {}),
            }))
        }
      }
      setConfig({ enabled: parsed.enabled !== false, hooks: cleanHooks })
      setShowJson(false)
      setSaveState(null)
    } catch (e) {
      setJsonError('JSON 解析失败：' + (e as Error).message)
    }
  }

  if (!electronReady) {
    return (
      <div className="max-w-2xl space-y-6">
        <SectionTitle>Hooks</SectionTitle>
        <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm p-4">
          <div className="flex items-center gap-2 text-amber-500 mb-2">
            <AlertTriangle className="size-5" />
            <p className="text-sm font-medium text-foreground">Hooks 需要在桌面端使用</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Hooks 由 Helix 写入外部 Hermes 后端的 config.yaml，仅在 Helix 桌面应用中可配置。当前为非桌面环境，无法配置或运行 Hooks。
          </p>
        </div>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="max-w-2xl space-y-6">
        <SectionTitle>Hooks</SectionTitle>
        <p className="text-sm text-muted-foreground">加载 Hooks 配置中…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      <SectionTitle>Hooks</SectionTitle>

      {/* Master enable */}
      <SettingRow
        icon={<Zap className="size-4 text-muted-foreground" />}
        label="启用 Hooks"
        description="开启后，Hermes 后端会在对应的生命周期点触发你配置的命令"
      >
        <Toggle enabled={config.enabled !== false} onToggle={() => setEnabled(!(config.enabled !== false))} />
      </SettingRow>

      {/* Per-event groups */}
      <div className="space-y-4">
        {HOOK_EVENTS.map((ev) => {
          const handlers = handlersOf(ev)
          const isCollapsed = collapsed.has(ev)
          const toggle = () => setCollapsed((s) => {
            const next = new Set(s)
            isCollapsed ? next.delete(ev) : next.add(ev)
            return next
          })
          return (
            <div key={ev} className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
              <div
                role="button"
                tabIndex={0}
                className="w-full px-4 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between gap-2 hover:bg-muted/50 transition-colors cursor-pointer"
                onClick={toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle() }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Zap className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-foreground truncate">{HOOK_EVENT_LABELS[ev]}</span>
                  {handlers.length > 0 && (
                    <span className="text-xs text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-full">{handlers.length}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="outline" onClick={() => addHandler(ev)}>
                    <Plus className="size-3.5 mr-1" /> 添加命令
                  </Button>
                  {isCollapsed
                    ? <ChevronRight className="size-4 text-muted-foreground" />
                    : <ChevronDown className="size-4 text-muted-foreground" />}
                </div>
              </div>
              <div className={`p-4 space-y-3 ${isCollapsed ? 'hidden' : ''}`}>
                <p className="text-xs text-muted-foreground/70">{HOOK_EVENT_HINTS[ev]}</p>

                {handlers.length === 0 && (
                  <p className="text-xs text-muted-foreground/60 italic">暂无命令</p>
                )}

                {handlers.map((h, hi) => (
                  <div key={hi} className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={h.command}
                        onChange={(e) => patchHandler(ev, hi, { command: e.target.value })}
                        placeholder="命令，如 python3 ~/.helix/hooks/notify.py"
                        className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <Button size="sm" variant="ghost" onClick={() => removeHandler(ev, hi)}>
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        value={h.matcher || ''}
                        onChange={(e) => patchHandler(ev, hi, { matcher: e.target.value })}
                        placeholder="matcher 正则（工具名，留空=全部）"
                        className="px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      />
                      <input
                        type="number"
                        min={1}
                        value={h.timeout ?? ''}
                        onChange={(e) => patchHandler(ev, hi, { timeout: e.target.value ? Number(e.target.value) : undefined })}
                        placeholder="超时(秒)"
                        className="px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Raw JSON import/export */}
      <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
        <button
          className="w-full px-4 py-3 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
          onClick={() => { setShowJson((v) => !v); if (!showJson) setJsonText(JSON.stringify(config, null, 2)) }}
        >
          <Code2 className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground flex-1">原始 JSON</span>
          {showJson ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        </button>
        {showJson && (
          <div className="p-4 border-t border-border/50 space-y-3">
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
            {jsonError && <p className="text-xs text-destructive">{jsonError}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={importJson}>导入 JSON</Button>
              <Button size="sm" variant="outline" onClick={() => setJsonText(JSON.stringify(config, null, 2))}>用当前配置刷新</Button>
            </div>
            <p className="text-xs text-muted-foreground/70">
              格式对应 Hermes 的 <code className="font-mono text-[13px] bg-muted/60 px-1 py-0.5 rounded text-foreground">hooks:</code> 块：
              <code className="font-mono text-[13px] bg-muted/60 px-1 py-0.5 rounded text-foreground">{'{ "enabled": true, "hooks": { "pre_tool_call": [ { "command": "…", "matcher": "Bash", "timeout": 30 } ] } }'}</code>。
            </p>
          </div>
        )}
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3 pt-1">
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
