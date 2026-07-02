'use client'

import React, { useState } from 'react'
import {
  X,
  Plus,
  Trash2,
  Zap,
  Pencil,
  Save,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useHelixStore, type Skill } from '@/stores/helix-store'

interface SkillPanelProps {
  onClose: () => void
}

export function SkillPanel({ onClose }: SkillPanelProps) {
  const { skills, addSkill, removeSkill, updateSkill } = useHelixStore()
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newSkill, setNewSkill] = useState({ name: '', description: '', prompt: '', icon: '⚡' })
  const [editSkill, setEditSkill] = useState<Skill | null>(null)

  const handleAdd = () => {
    if (!newSkill.name.trim() || !newSkill.prompt.trim()) return
    addSkill({
      name: newSkill.name,
      description: newSkill.description,
      prompt: newSkill.prompt,
      icon: newSkill.icon || '⚡',
      isBuiltin: false,
    })
    setNewSkill({ name: '', description: '', prompt: '', icon: '⚡' })
    setIsAdding(false)
  }

  const handleEdit = (skill: Skill) => {
    setEditingId(skill.id)
    setEditSkill({ ...skill })
  }

  const handleSaveEdit = () => {
    if (!editSkill || !editSkill.name.trim() || !editSkill.prompt.trim()) return
    updateSkill(editSkill.id, {
      name: editSkill.name,
      description: editSkill.description,
      prompt: editSkill.prompt,
      icon: editSkill.icon,
    })
    setEditingId(null)
    setEditSkill(null)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditSkill(null)
  }

  const handleDelete = (skillId: string) => {
    removeSkill(skillId)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">技能管理</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Skills list */}
          {skills.map(skill => (
            <div
              key={skill.id}
              className="p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              {editingId === skill.id && editSkill ? (
                /* Edit mode */
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editSkill.icon}
                      onChange={(e) => setEditSkill({ ...editSkill, icon: e.target.value })}
                      className="w-10 px-2 py-1 bg-muted border border-border rounded text-center text-sm"
                      placeholder="图标"
                    />
                    <input
                      type="text"
                      value={editSkill.name}
                      onChange={(e) => setEditSkill({ ...editSkill, name: e.target.value })}
                      className="flex-1 px-2 py-1 bg-muted border border-border rounded text-sm"
                      placeholder="技能名称"
                    />
                  </div>
                  <input
                    type="text"
                    value={editSkill.description}
                    onChange={(e) => setEditSkill({ ...editSkill, description: e.target.value })}
                    className="w-full px-2 py-1 bg-muted border border-border rounded text-xs"
                    placeholder="描述"
                  />
                  <textarea
                    value={editSkill.prompt}
                    onChange={(e) => setEditSkill({ ...editSkill, prompt: e.target.value })}
                    className="w-full px-2 py-1 bg-muted border border-border rounded text-xs font-mono min-h-[80px]"
                    placeholder="提示词模板（使用 {code} 插入代码，{error} 插入错误信息）"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={handleCancelEdit}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded"
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2">
                    <span className="text-lg">{skill.icon || '⚡'}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{skill.name}</span>
                        {skill.isBuiltin && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">内置</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{skill.description}</p>
                      <p className="text-[10px] text-muted-foreground/50 font-mono mt-1 line-clamp-2">{skill.prompt}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      onClick={() => handleEdit(skill)}
                      className="p-1 text-muted-foreground hover:text-foreground rounded"
                    >
                      <Pencil className="size-3" />
                    </button>
                    {!skill.isBuiltin && (
                      <button
                        onClick={() => handleDelete(skill.id)}
                        className="p-1 text-muted-foreground hover:text-red-500 rounded"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Add new skill form */}
          {isAdding ? (
            <div className="p-3 rounded-lg border border-primary/50 bg-primary/5 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSkill.icon}
                  onChange={(e) => setNewSkill({ ...newSkill, icon: e.target.value })}
                  className="w-10 px-2 py-1 bg-muted border border-border rounded text-center text-sm"
                  placeholder="图标"
                />
                <input
                  type="text"
                  value={newSkill.name}
                  onChange={(e) => setNewSkill({ ...newSkill, name: e.target.value })}
                  className="flex-1 px-2 py-1 bg-muted border border-border rounded text-sm"
                  placeholder="技能名称"
                />
              </div>
              <input
                type="text"
                value={newSkill.description}
                onChange={(e) => setNewSkill({ ...newSkill, description: e.target.value })}
                className="w-full px-2 py-1 bg-muted border border-border rounded text-xs"
                placeholder="描述"
              />
              <textarea
                value={newSkill.prompt}
                onChange={(e) => setNewSkill({ ...newSkill, prompt: e.target.value })}
                className="w-full px-2 py-1 bg-muted border border-border rounded text-xs font-mono min-h-[80px]"
                placeholder="提示词模板（使用 {code} 插入代码，{error} 插入错误信息）"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setIsAdding(false)}
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  取消
                </button>
                <button
                  onClick={handleAdd}
                  className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded"
                >
                  添加
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full p-3 rounded-lg border border-dashed border-border hover:border-primary/50 hover:bg-muted/30 transition-colors flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-4" />
              添加自定义技能
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-muted/30 shrink-0">
          <p className="text-[10px] text-muted-foreground/50">
            使用 /技能名称 在对话中调用技能
          </p>
        </div>
      </div>
    </div>
  )
}