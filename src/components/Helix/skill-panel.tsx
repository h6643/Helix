'use client'

import {
  X,
  Search,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Plus,
} from 'lucide-react'
import React, { useState, useMemo, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useHermes } from '@/hooks/use-hermes'
import { hermesApi, electronFS } from '@/lib/electron-bridge'
import type { BackendPlugin } from '@/stores/helix-types'

interface SkillPanelProps {
  onClose: () => void
}

interface HelixSkill {
  id: string
  name: string
  description: string
  isBuiltin: boolean
  path: string
  callCount: number
}

type TabKey = 'plugins' | 'skills'

export function SkillPanel({ onClose }: SkillPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('plugins')
  const [searchQuery, setSearchQuery] = useState('')
  const { dispatchCommand } = useHermes()

  // Plugins state
  const [plugins, setPlugins] = useState<BackendPlugin[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)

  // Skills state
  const [skills, setSkills] = useState<HelixSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  // 模型供应商由独立的 provider UI 管理，不应作为通用插件出现在插件页。
  // 两类都要拦：
  //   1) 命名空间式：`model-providers/openai`、`provider/xxx`（bundled 目录，key 带斜杠）
  //   2) entry-point 式：`anthropic-provider`、`openai-provider`…（pip 安装的独立包，
  //      key = ep.name，直接以 `-provider` 结尾，不在 model-providers/ 命名空间下）
  const isProviderPlugin = (p: BackendPlugin): boolean => {
    const k = (p.key || p.name || '').toLowerCase()
    return (
      k === 'model-providers' || k.startsWith('model-providers/') ||
      k === 'provider' || k.startsWith('provider/') ||
      k.endsWith('-provider')
    )
  }

  const loadPlugins = async () => {
    setPluginsLoading(true)
    try {
      const api = hermesApi()
      if (!api) return
      const res = await api.send('plugins.manage', { action: 'list' }) as any
      if (Array.isArray(res?.plugins)) {
        const seen = new Set<string>()
        setPlugins(res.plugins.filter((p: BackendPlugin) => {
          if (isProviderPlugin(p)) return false
          if (seen.has(p.name)) return false
          seen.add(p.name)
          return true
        }))
      }
    } catch (e) {
      console.error('loadPlugins error:', e)
    }
    setPluginsLoading(false)
  }

  const loadSkills = async () => {
    setSkillsLoading(true)
    try {
      const list = await window.electron?.hermesSkills.listSkills()
      if (Array.isArray(list)) setSkills(list)
    } catch (e) {
      console.error('loadSkills error:', e)
    }
    setSkillsLoading(false)
  }

  useEffect(() => { loadPlugins(); loadSkills() }, [])

  // Refresh skills when window regains focus
  useEffect(() => {
    const handleFocus = () => { loadSkills() }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const onDeleteSkill = async (skill: HelixSkill) => {
    if (skill.isBuiltin) return
    setSkillsLoading(true)
    try {
      await window.electron?.hermesSkills.deleteDir(skill.path)
      await loadSkills()
    } catch (e) {
      console.error('deleteSkill error:', e)
    }
    setSkillsLoading(false)
  }

  const handleTogglePlugin = async (plugin: BackendPlugin) => {
    const enable = plugin.status !== 'enabled'
    try {
      const api = hermesApi()
      if (!api) return
      await api.send('plugins.manage', { action: 'toggle', name: plugin.name, enable })
      await loadPlugins()
    } catch (e) {
      console.error('togglePlugin error:', e)
    }
  }

  const handleDeletePlugin = async (plugin: BackendPlugin) => {
    if (plugin.source === 'bundled') return
    try {
      const pluginsDir = await window.electron?.hermesSkills.getPluginsDir()
      if (!pluginsDir) return
      const pluginPath = `${pluginsDir}/${plugin.name}`
      await electronFS.deleteFile(pluginPath)
      await loadPlugins()
    } catch (e) {
      console.error('deletePlugin error:', e)
    }
  }

  const filteredSkills = useMemo(() => {
    if (activeTab !== 'skills') return []
    const q = searchQuery.trim().toLowerCase()
    return skills.filter(s => {
      if (!q) return true
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
      )
    })
  }, [activeTab, skills, searchQuery])

  const filteredPlugins = useMemo(() => {
    if (activeTab !== 'plugins') return []
    const q = searchQuery.trim().toLowerCase()
    return plugins.filter(p => {
      if (isProviderPlugin(p)) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      )
    })
  }, [activeTab, plugins, searchQuery])

  const isEmpty = activeTab === 'plugins' ? filteredPlugins.length === 0 : filteredSkills.length === 0

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
        <div className="flex items-center gap-1 bg-muted/60 rounded-full p-1">
          <button
            onClick={() => setActiveTab('plugins')}
            className={`px-3.5 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
              activeTab === 'plugins'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            插件
          </button>
          <button
            onClick={() => setActiveTab('skills')}
            className={`px-3.5 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium rounded-full transition-colors ${
              activeTab === 'skills'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            技能
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              if (activeTab === 'skills') {
                if (window.electron?.hermesSkills) {
                  const dir = await window.electron.hermesSkills.getDir()
                  if (dir) {
                    window.electron.shell.showItemInFolder(dir)
                  }
                }
              }
            }}
            className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            data-tip={activeTab === 'plugins' ? '插件需通过配置添加' : '打开技能目录'}
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            data-tip="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-6 pt-2 pb-8">

          {/* Search */}
          <div className="relative mb-6">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === 'plugins' ? '搜索插件...' : '搜索技能...'}
              className="w-full h-10 pl-10 pr-4 rounded-full border border-border/60 bg-background text-[length:var(--helix-transcript-size)] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
            />
          </div>

          {/* Section header */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
              {activeTab === 'plugins' ? `已安装 (${filteredPlugins.length})` : `已安装 (${filteredSkills.length})`}
            </h2>
          </div>

          {/* Grid */}
          {!isEmpty ? (activeTab === 'plugins' ? (
            <div className="space-y-2">
              {pluginsLoading && plugins.length === 0 && (
                <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 text-center py-8">加载中...</p>
              )}
              {filteredPlugins.map(plugin => (
                  <div
                    key={plugin.name}
                    className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 hover:border-border transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground truncate">{plugin.name}</p>
                        {plugin.source === 'bundled' && (
                          <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-primary/10 text-primary">内置</span>
                        )}
                      </div>
                      {plugin.description && (
                        <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate mt-0.5">{plugin.description}</p>
                      )}
                      {plugin.version && (
                        <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50 mt-0.5">v{plugin.version}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleTogglePlugin(plugin)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          plugin.status === 'enabled'
                            ? 'text-emerald-500 hover:bg-emerald-500/10'
                            : 'text-muted-foreground/60 hover:bg-accent/60'
                        }`}
                        data-tip={plugin.status === 'enabled' ? '点击禁用' : '点击启用'}
                      >
                        {plugin.status === 'enabled' ? (
                          <ToggleRight className="size-5" />
                        ) : (
                          <ToggleLeft className="size-5" />
                        )}
                       </button>
                      {plugin.source !== 'bundled' && (
                        <button
                          onClick={() => handleDeletePlugin(plugin)}
                          className="p-1.5 rounded-lg text-muted-foreground/60 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          data-tip="删除插件"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div className="space-y-2">
              {skillsLoading && skills.length === 0 && (
                <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 text-center py-8">加载中...</p>
              )}
              {filteredSkills.map(skill => (
                <div
                  key={skill.id}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 hover:border-border transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">{skill.name}</span>
                      <span className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded font-medium ${
                        skill.isBuiltin
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {skill.isBuiltin ? '内置' : '自定义'}
                      </span>
                      {skill.callCount > 0 && (
                        <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-accent/50 text-accent-foreground">
                          {skill.callCount}次
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate mt-0.5">{skill.description}</p>
                    )}
                  </div>
                  {!skill.isBuiltin && (
                    <button
                      onClick={() => onDeleteSkill(skill)}
                      className="p-1.5 text-muted-foreground/60 hover:text-red-500 rounded-lg transition-colors shrink-0"
                      data-tip="删除技能"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )) : (
            <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
              {activeTab === 'plugins' ? '暂无已安装插件' : '暂无技能'}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
