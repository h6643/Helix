'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  GitBranch,
  Plus,
  Trash2,
  Lock,
  Unlock,
  FolderOpen,
  RefreshCw,
  Check,
  Loader2,
  AlertCircle,
  ChevronRight,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron, electronGit } from '@/lib/electron-bridge'

interface WorktreeInfo {
  path: string
  head?: string
  branch?: string
  bare?: boolean
  detached?: boolean
  locked?: boolean
  prunable?: boolean
  isMain?: boolean
}

interface WorktreePanelProps {
  onClose: () => void
}

export function WorktreePanel({ onClose }: WorktreePanelProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [createFromBranch, setCreateFromBranch] = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const showToast = useHelixStore(s => s.showToast)
  const setWorkDir = useHelixStore(s => s.setWorkDir)

  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)

  const loadWorktrees = useCallback(async () => {
    if (!isElectron()) return
    if (!selectedWorkDir) {
      setError('未选择工作目录')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await electronGit.worktreeList()
      if (result.ok) {
        setWorktrees(result.worktrees || [])
      } else {
        setError(result.error || '无法获取 worktree 列表')
      }
    } catch (e) {
      const msg = String(e)
      if (msg.includes('not a git repository')) {
        setError('当前目录不是 git 仓库')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [selectedWorkDir])

  useEffect(() => {
    loadWorktrees()
  }, [loadWorktrees])

  const handleAdd = async () => {
    if (!newPath.trim()) return
    setActionLoading('add')
    try {
      const result = await electronGit.worktreeAdd({
        path: newPath.trim(),
        branch: newBranch.trim() || undefined,
        newBranch: createFromBranch.trim() || undefined,
      })
      if (result.ok) {
        setShowAddForm(false)
        setNewPath('')
        setNewBranch('')
        setCreateFromBranch('')
        await loadWorktrees()
      } else {
        showToast({ type: 'error', title: '创建失败', description: result.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '创建失败', description: String(e) })
    } finally {
      setActionLoading(null)
    }
  }

  const handleRemove = async (wt: WorktreeInfo) => {
    if (wt.isMain) {
      showToast({ type: 'warning', title: '无法删除主工作树' })
      return
    }
    setActionLoading(wt.path)
    try {
      const result = await electronGit.worktreeRemove(wt.path)
      if (result.ok) {
        await loadWorktrees()
      } else {
        showToast({ type: 'error', title: '删除失败', description: result.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '删除失败', description: String(e) })
    } finally {
      setActionLoading(null)
    }
  }

  const handleToggleLock = async (wt: WorktreeInfo) => {
    setActionLoading(wt.path)
    try {
      const fn = wt.locked ? electronGit.worktreeUnlock : electronGit.worktreeLock
      const result = await fn(wt.path)
      if (result.ok) {
        showToast({ type: 'success', title: wt.locked ? '已解锁' : '已锁定' })
        await loadWorktrees()
      } else {
        showToast({ type: 'error', title: '操作失败', description: result.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '操作失败', description: String(e) })
    } finally {
      setActionLoading(null)
    }
  }

  const handlePrune = async () => {
    setActionLoading('prune')
    try {
      const result = await electronGit.worktreePrune()
      if (result.ok) {
        await loadWorktrees()
      }
    } catch (e) {
      showToast({ type: 'error', title: '清理失败', description: String(e) })
    } finally {
      setActionLoading(null)
    }
  }

  const handleSwitchTo = async (wt: WorktreeInfo) => {
    try {
      await setWorkDir(wt.path)
    } catch (e) {
      showToast({ type: 'error', title: '切换失败', description: String(e) })
    }
  }

  if (!isElectron()) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Worktree 功能仅在桌面版可用</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background select-none">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-border/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Worktree 管理</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePrune}
            disabled={actionLoading === 'prune'}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-50"
            title="清理过期 worktree"
          >
            {actionLoading === 'prune' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </button>
          <button
            onClick={() => setShowAddForm(v => !v)}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
            title="添加 worktree"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
          >
            <span className="text-xs">关闭</span>
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="shrink-0 px-4 py-3 border-b border-border/40 bg-muted/20 space-y-2">
          <input
            type="text"
            value={newPath}
            onChange={e => setNewPath(e.target.value)}
            placeholder="路径 (e.g. ../project-feature)"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
          <div className="flex gap-2">
            <input
              type="text"
              value={newBranch}
              onChange={e => setNewBranch(e.target.value)}
              placeholder="已有分支名 (留空=detached)"
              className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
            <input
              type="text"
              value={createFromBranch}
              onChange={e => setCreateFromBranch(e.target.value)}
              placeholder="新建分支 (可选)"
              className="flex-1 px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowAddForm(false)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 transition-colors">
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={!newPath.trim() || actionLoading === 'add'}
              className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'add' ? <Loader2 className="size-3 animate-spin" /> : '创建'}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-red-500">
            <AlertCircle className="size-5" />
            <p className="text-sm">{error}</p>
            <button onClick={loadWorktrees} className="text-xs text-muted-foreground hover:text-foreground">重试</button>
          </div>
        ) : worktrees.length === 0 ? (
          <p className="text-sm text-muted-foreground/60 text-center py-12">暂无 worktree</p>
        ) : (
          <div className="space-y-2">
            {worktrees.map((wt) => (
              <div
                key={wt.path}
                className="rounded-xl border border-border/50 bg-card/50 overflow-hidden"
              >
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {wt.isMain && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/10 text-primary font-medium">主</span>
                      )}
                      {wt.locked && (
                        <Lock className="size-3 text-amber-500" />
                      )}
                      {wt.detached && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">detached</span>
                      )}
                      {wt.prunable && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/10 text-red-500">可清理</span>
                      )}
                      {wt.branch && (
                        <span className="flex items-center gap-1 text-xs font-mono text-foreground/70">
                          <GitBranch className="size-3" />
                          {wt.branch}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/60 font-mono truncate mt-1">{wt.path}</p>
                    {wt.head && (
                      <p className="text-[10px] text-muted-foreground/40 font-mono mt-0.5">{wt.head.slice(0, 8)}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {!wt.isMain && (
                      <button
                        onClick={() => handleSwitchTo(wt)}
                        className="p-1.5 text-muted-foreground/40 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
                        title="切换到此目录"
                      >
                        <FolderOpen className="size-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleToggleLock(wt)}
                      disabled={actionLoading === wt.path}
                      className="p-1.5 text-muted-foreground/40 hover:text-amber-500 hover:bg-amber-500/10 rounded-lg transition-colors disabled:opacity-50"
                      title={wt.locked ? '解锁' : '锁定'}
                    >
                      {actionLoading === wt.path ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : wt.locked ? (
                        <Unlock className="size-3.5" />
                      ) : (
                        <Lock className="size-3.5" />
                      )}
                    </button>
                    {!wt.isMain && (
                      <button
                        onClick={() => handleRemove(wt)}
                        disabled={actionLoading === wt.path}
                        className="p-1.5 text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                        title="删除"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="shrink-0 px-4 py-2 border-t border-border/40">
        <p className="text-[10px] text-muted-foreground/40">
          {worktrees.length} 个工作树 · 在不同分支上并行工作
        </p>
      </div>
    </div>
  )
}
