'use client'

import {
  ToggleLeft,
  ToggleRight,
  Loader2,
  X,
  RefreshCw,
} from 'lucide-react'
import React, { useState, useEffect, useCallback } from 'react'
import { helixApi } from '@/lib/electron-bridge'
import type { BackendPlugin } from '@/stores/helix-types'

interface PluginManagerProps {
  onClose: () => void
}

export function PluginManager({ onClose }: PluginManagerProps) {
  const [backendPlugins, setBackendPlugins] = useState<BackendPlugin[]>([])
  const [backendLoading, setBackendLoading] = useState(false)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [backendToggling, setBackendToggling] = useState<string | null>(null)

  const loadBackendPlugins = useCallback(async () => {
    setBackendLoading(true)
    setBackendError(null)
    try {
      const api = helixApi()
      if (!api?.send) throw new Error('Helix 网关不可用')
      // Guard against a serve gateway that never answers plugins.manage: the
      // underlying WS RPC can block up to 60s, which would pin this panel on
      // "正在加载后端插件…" for a full minute. Race it with a 20s timeout so
      // the user gets an actionable error + retry instead.
      const res = await Promise.race([
        api.send('plugins.manage', { action: 'list' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('插件列表请求超时（20s），网关可能未实现 plugins.manage')), 20_000)),
      ])
      const plugins: BackendPlugin[] = Array.isArray(res?.plugins) ? res.plugins : []
      const seen = new Set<string>()
      setBackendPlugins(plugins.filter(p => {
        if (seen.has(p.name)) return false
        seen.add(p.name)
        return true
      }))
    } catch (e) {
      setBackendError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackendLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBackendPlugins()
  }, [loadBackendPlugins])

  const handleToggle = async (p: BackendPlugin) => {
    const enable = p.status !== 'enabled'
    setBackendToggling(p.name)
    try {
      const api = helixApi()
      if (!api?.send) throw new Error('Helix 网关不可用')
      const res = await api.send('plugins.manage', { action: 'toggle', name: p.name, enable })
      if (res?.plugin) {
        setBackendPlugins(prev => prev.map(x => x.name === res.plugin.name ? res.plugin : x))
      }
    } catch (e) {
      setBackendError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackendToggling(null)
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-[calc(var(--helix-transcript-size)*1.2857)] font-semibold">插件管理</h2>
          <span className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 font-mono ml-1">
            {backendPlugins.length} 个 Helix 插件
          </span>
        </div>
        <button onClick={onClose} className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 pb-8 space-y-2">

          <div className="flex items-center justify-between">
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/50 pb-1">
              Helix 网关托管插件，与 helix plugins / Plugins Hub 同源
            </p>
            <button
              onClick={() => loadBackendPlugins()}
              className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-accent/60 transition-colors"
              data-tip="刷新"
            >
              <RefreshCw className={`size-3.5 ${backendLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {backendLoading && backendPlugins.length === 0 ? (
            <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60 flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" /> 正在加载后端插件...
            </div>
          ) : backendError ? (
            <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-red-500/80">
              <p>无法连接 Helix 网关加载插件</p>
              <p className="text-muted-foreground/50 mt-1 text-[calc(var(--helix-transcript-size)*0.8571)]">{backendError}</p>
              <button
                onClick={() => loadBackendPlugins()}
                className="mt-3 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[calc(var(--helix-transcript-size)*0.8571)] font-medium hover:bg-primary/20 transition-colors"
              >
                重试
              </button>
            </div>
          ) : backendPlugins.length === 0 ? (
            <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
              暂无后端插件，可在 Helix 中执行 helix plugins install owner/repo 安装
            </div>
          ) : (
            backendPlugins.map((p, i) => (
              <div key={`${p.source}:${p.name}:${i}`}
                className="flex items-start gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">{p.name}</span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40 font-mono">v{p.version || '-'}</span>
                    {p.source === 'bundled' ? (
                      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">内置</span>
                    ) : (
                      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">用户</span>
                    )}
                    {p.status === 'enabled' ? (
                      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">已启用</span>
                    ) : (
                      <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">已禁用</span>
                    )}
                  </div>
                  <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 mt-0.5">{p.description || '（无描述）'}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {backendToggling === p.name ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <button
                      onClick={() => handleToggle(p)}
                      className={`p-1.5 rounded-lg transition-colors ${
                        p.status === 'enabled'
                          ? 'text-emerald-500 hover:bg-emerald-500/10'
                          : 'text-muted-foreground/40 hover:text-foreground hover:bg-accent/60'
                      }`}
                      data-tip={p.status === 'enabled' ? '禁用' : '启用'}
                    >
                      {p.status === 'enabled' ? <ToggleRight className="size-4" /> : <ToggleLeft className="size-4" />}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

        </div>
      </div>
    </div>
  )
}
