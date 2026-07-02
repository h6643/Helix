'use client'

import React, { useState } from 'react'
import {
  Brain,
  StickyNote,
  Save,
  Plus,
  X,
  Trash2,
  Tag,
  History,
} from 'lucide-react'
import { useHelixStore, type MemoryEntry } from '@/stores/helix-store'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/format'

const CATEGORIES: { id: MemoryEntry['category']; label: string; color: string }[] = [
  { id: 'architecture', label: '架构', color: 'bg-blue-500/20 text-blue-400' },
  { id: 'rule', label: '规则', color: 'bg-emerald-500/20 text-emerald-400' },
  { id: 'decision', label: '决策', color: 'bg-purple-500/20 text-purple-400' },
  { id: 'pattern', label: '模式', color: 'bg-amber-500/20 text-amber-400' },
  { id: 'gotcha', label: '陷阱', color: 'bg-red-500/20 text-red-400' },
]

export function MemoryPanel() {
  const { memories, notes, updateNotes, addMemory, removeMemory, checkpoints, saveCheckpoint, showToast } = useHelixStore()
  const [activeTab, setActiveTab] = useState<'memory' | 'notes' | 'checkpoints'>('memory')
  const [isAdding, setIsAdding] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState<MemoryEntry['category']>('architecture')

  const handleAdd = () => {
    if (newContent.trim()) {
      addMemory({ content: newContent.trim(), category: newCategory })
      setNewContent('')
      setIsAdding(false)
      showToast({ type: 'success', title: '已添加记忆' })
    }
  }

  const tabs = [
    { id: 'memory' as const, label: '记忆', icon: Brain, count: memories.length },
    { id: 'notes' as const, label: '笔记', icon: StickyNote },
    { id: 'checkpoints' as const, label: '检查点', icon: History, count: checkpoints.length },
  ]

  return (
    <div className="h-full flex flex-col bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          记忆系统
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => {
            saveCheckpoint()
            showToast({ type: 'success', title: '检查点已保存' })
          }}
          title="保存检查点"
        >
          <Save className="size-3.5" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-border px-2">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <tab.icon className="size-3" />
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="text-[10px] bg-muted px-1 rounded-full">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        {activeTab === 'memory' && (
          <div className="py-2">
            {memories.map(entry => {
              const cat = CATEGORIES.find(c => c.id === entry.category)
              return (
                <div key={entry.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-accent/30 transition-colors">
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium mt-0.5 ${cat?.color}`}>
                    {cat?.label}
                  </span>
                  <p className="flex-1 text-xs leading-relaxed">{entry.content}</p>
                  <span className="text-[10px] text-muted-foreground/50 shrink-0 mt-0.5">{timeAgo(entry.createdAt)}</span>
                  <button
                    onClick={() => removeMemory(entry.id)}
                    className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-destructive/20 rounded shrink-0"
                  >
                    <Trash2 className="size-3 text-destructive/60" />
                  </button>
                </div>
              )
            })}

            {isAdding ? (
              <div className="px-3 py-2 border-t border-border/50 mt-1">
                <div className="flex items-center gap-1 mb-2">
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => setNewCategory(cat.id)}
                      className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${newCategory === cat.id ? cat.color : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    value={newContent}
                    onChange={(e) => setNewContent(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setIsAdding(false) }}
                    placeholder="添加项目知识..."
                    className="flex-1 bg-background border border-input rounded px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                  <button onClick={handleAdd}><Save className="size-3 text-emerald-400" /></button>
                  <button onClick={() => setIsAdding(false)}><X className="size-3 text-muted-foreground" /></button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setIsAdding(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="size-3" />
                添加记忆
              </button>
            )}

            {memories.length === 0 && !isAdding && (
              <div className="px-4 py-6 text-center">
                <Brain className="size-6 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">暂无项目记忆</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">AI 会在对话中积累项目知识</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="p-3">
            <textarea
              value={notes}
              onChange={(e) => updateNotes(e.target.value)}
              placeholder="在这里记录临时笔记、想法、TODO..."
              className="w-full h-48 bg-background border border-input rounded-md px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-ring resize-none font-mono leading-relaxed"
            />
            <p className="text-[10px] text-muted-foreground/50 mt-1">笔记会作为上下文注入 AI 对话</p>
          </div>
        )}

        {activeTab === 'checkpoints' && (
          <div className="py-2">
            {checkpoints.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <History className="size-6 text-muted-foreground/20 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">暂无检查点</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">点击保存按钮创建检查点</p>
              </div>
            ) : (
              checkpoints.slice().reverse().map(cp => (
                <div key={cp.id} className="flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors">
                  <div className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium">{cp.label}</p>
                    <p className="text-[10px] text-muted-foreground">{timeAgo(cp.timestamp)} · {cp.taskIds.length} 个任务</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}