'use client'

import React, { useState, useMemo, useEffect } from 'react'
import {
  X,
  Puzzle,
  Zap,
  BookOpen,
  ImageIcon,
  Code,
  Wrench,
  Terminal,
  MessageSquare,
  Sparkles,
  Search,
  Check,
  Plus,
  Trash2,
  RotateCcw,
  Settings,
} from 'lucide-react'
import { useHermes } from '@/hooks/use-hermes'
import { useHelixStore } from '@/stores/helix-store'
import { ScrollArea } from '@/components/ui/scroll-area'

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

const iconSet = [
  { Icon: Puzzle, color: 'bg-purple-500', iconColor: 'text-white' },
  { Icon: Zap, color: 'bg-amber-500', iconColor: 'text-white' },
  { Icon: BookOpen, color: 'bg-rose-500', iconColor: 'text-white' },
  { Icon: ImageIcon, color: 'bg-cyan-500', iconColor: 'text-white' },
  { Icon: Code, color: 'bg-emerald-500', iconColor: 'text-white' },
  { Icon: Wrench, color: 'bg-indigo-500', iconColor: 'text-white' },
  { Icon: Terminal, color: 'bg-slate-600', iconColor: 'text-white' },
  { Icon: MessageSquare, color: 'bg-blue-500', iconColor: 'text-white' },
  { Icon: Sparkles, color: 'bg-pink-500', iconColor: 'text-white' },
]

function getCommandStyle(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return iconSet[Math.abs(hash) % iconSet.length]
}

export function SkillPanel({ onClose }: SkillPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('plugins')
  const [searchQuery, setSearchQuery] = useState('')
  const { dispatchCommand } = useHermes()
  const availableCommands = useHelixStore(s => s.availableCommands)

  // Skills state
  const [skills, setSkills] = useState<HelixSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

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

  useEffect(() => { loadSkills() }, [])

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

  const filteredCommands = useMemo(() => {
    if (activeTab !== 'plugins') return []
    const q = searchQuery.trim().toLowerCase()
    return availableCommands.filter(cmd => {
      if (!q) return true
      return (
        cmd.name.toLowerCase().includes(q) ||
        (cmd.description || '').toLowerCase().includes(q)
      )
    })
  }, [activeTab, availableCommands, searchQuery])

  const isEmpty = activeTab === 'plugins' ? filteredCommands.length === 0 : filteredSkills.length === 0

  return (
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
        <div className="flex items-center gap-1 bg-muted/60 rounded-full p-1">
          <button
            onClick={() => setActiveTab('plugins')}
            className={`px-3.5 py-1 text-xs font-medium rounded-full transition-colors ${
              activeTab === 'plugins'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            插件
          </button>
          <button
            onClick={() => setActiveTab('skills')}
            className={`px-3.5 py-1 text-xs font-medium rounded-full transition-colors ${
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
            title={activeTab === 'plugins' ? '插件需通过配置添加' : '打开技能目录'}
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="关闭"
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
              className="w-full h-10 pl-10 pr-4 rounded-full border border-border/60 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
            />
          </div>

          {/* Section header */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-foreground">
              {activeTab === 'plugins' ? '已安装' : `已安装 (${filteredSkills.length})`}
            </h2>
          </div>

          {/* Grid */}
          {!isEmpty ? (activeTab === 'plugins' ? (
            <div className="grid grid-cols-2 gap-3">
              {filteredCommands.map(cmd => {
                const { Icon, color, iconColor } = getCommandStyle(cmd.name)
                return (
                  <button
                    key={cmd.name}
                    onClick={() => dispatchCommand(`/${cmd.name}`)}
                    className="flex items-center gap-3 p-3 text-left rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 hover:border-border transition-colors group"
                  >
                    <div className={`size-10 rounded-lg ${color} flex items-center justify-center shrink-0`}>
                      <Icon className={`size-5 ${iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">/{cmd.name}</p>
                    </div>
                    <div className="size-6 rounded-full border border-border/50 flex items-center justify-center text-emerald-500 bg-emerald-500/10 shrink-0">
                      <Check className="size-3.5" />
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {skillsLoading && skills.length === 0 && (
                <p className="text-sm text-muted-foreground/60 text-center py-8">加载中...</p>
              )}
              {filteredSkills.map(skill => (
                <div
                  key={skill.id}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 hover:border-border transition-colors"
                >
                  <span className="text-lg shrink-0 text-muted-foreground/40">&gt;</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{skill.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        skill.isBuiltin
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {skill.isBuiltin ? '内置' : '自定义'}
                      </span>
                      {skill.callCount > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/50 text-accent-foreground">
                          {skill.callCount}次
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{skill.description}</p>
                    )}
                  </div>
                  {!skill.isBuiltin && (
                    <button
                      onClick={() => onDeleteSkill(skill)}
                      className="p-1.5 text-muted-foreground/60 hover:text-red-500 rounded-lg transition-colors shrink-0"
                      title="删除技能"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )) : (
            <div className="text-center py-12 text-sm text-muted-foreground/60">
              {activeTab === 'plugins' ? '暂无可用插件或命令' : '暂无技能'}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
