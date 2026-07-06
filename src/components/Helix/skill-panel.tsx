'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
  X,
  Upload,
  Trash2,
  Zap,
  Pencil,
  RefreshCw,
} from 'lucide-react'

interface FileSkill {
  name: string
  description: string
  path: string
}

interface SkillPanelProps {
  onClose: () => void
}

export function SkillPanel({ onClose }: SkillPanelProps) {
  const [fileSkills, setFileSkills] = useState<FileSkill[]>([])
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [currentPage, setCurrentPage] = useState(0)
  const PAGE_SIZE = 4
  const totalPages = Math.max(1, Math.ceil(fileSkills.length / PAGE_SIZE))
  const paginatedSkills = fileSkills.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  const loadSkills = async () => {
    try {
      const res = await fetch('/api/skills')
      const data = await res.json()
      setFileSkills(data.skills || [])
      setCurrentPage(0)
    } catch { /* ignore */ }
  }

  useEffect(() => { loadSkills() }, [])

  const handleSaveEdit = async () => {
    if (!editingName || !editContent.trim()) return
    setLoading(true)
    try {
      await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editingName, description: editDesc, content: editContent }),
      })
      setEditingName(null)
      await loadSkills()
    } catch { /* ignore */ }
    setLoading(false)
  }

  const handleDelete = async (name: string) => {
    setLoading(true)
    try {
      await fetch(`/api/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await loadSkills()
    } catch { /* ignore */ }
    setLoading(false)
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      await fetch('/api/skills', { method: 'POST', body: form })
      await loadSkills()
    } catch { /* ignore */ }
    setLoading(false)
    e.target.value = ''
  }

  const startEdit = (skill: FileSkill) => {
    setEditingName(skill.name)
    setEditDesc(skill.description)
    fetch(`/api/skills?name=${encodeURIComponent(skill.name)}`)
      .then(r => r.json())
      .then(data => {
        if (data.content) {
          const body = data.content.replace(/^---[\s\S]*?---\n*/, '')
          setEditContent(body.trim())
        }
      })
      .catch(() => setEditContent(''))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">技能管理</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={loadSkills}
              className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              title="刷新"
            >
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {paginatedSkills.map(skill => (
            <div
              key={skill.name}
              className="p-3 rounded-lg border border-border/30 bg-card/50 shadow-sm hover:bg-card/80 transition-colors"
            >
              {editingName === skill.name ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={skill.name}
                    className="w-full px-2 py-1 bg-muted border border-border/50 rounded text-sm text-muted-foreground"
                    disabled
                  />
                  <input
                    type="text"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    className="w-full px-2 py-1 bg-muted border border-border rounded text-xs"
                    placeholder="描述"
                  />
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full px-2 py-1 bg-muted border border-border rounded text-xs font-mono min-h-[120px]"
                    placeholder="Skill 内容（Markdown）"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingName(null)}
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      disabled={loading}
                      className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded disabled:opacity-50"
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <span className="text-lg shrink-0">&gt;</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{skill.name}</span>
                      </div>
                      {skill.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{skill.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      onClick={() => startEdit(skill)}
                      className="p-1 text-muted-foreground hover:text-foreground rounded"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      onClick={() => handleDelete(skill.name)}
                      className="p-1 text-muted-foreground/60 hover:text-red-500 rounded transition-colors"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {paginatedSkills.length === 0 && (
            <p className="text-sm text-muted-foreground/60 text-center py-6">暂无技能</p>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 py-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="px-2.5 py-1 text-xs rounded border border-border/50 disabled:opacity-30 hover:bg-accent/60 transition-colors"
              >
                ← 上一页
              </button>
              <span className="text-xs text-muted-foreground font-mono">
                {currentPage + 1} / {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage >= totalPages - 1}
                className="px-2.5 py-1 text-xs rounded border border-border/50 disabled:opacity-30 hover:bg-accent/60 transition-colors"
              >
                下一页 →
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 p-3 rounded-lg border border-dashed border-border/50 hover:border-primary/50 hover:bg-accent/30 transition-colors flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <Upload className="size-4" />
              添加技能
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md"
              className="hidden"
              onChange={handleUpload}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
