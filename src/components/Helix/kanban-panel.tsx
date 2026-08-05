'use client'

import {
  SquareKanban,
  Plus,
  X,
  RefreshCw,
  Loader2,
  AlertCircle,
  User,
  MessageSquare,
  Archive,
  Circle,
  Flag,
  Hash,
  Clock,
  Users,
  ChevronDown,
  FileText,
  Trash2,
} from 'lucide-react'
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { isElectron } from '@/lib/electron-bridge'
import { timeAgo } from '@/lib/format'
import {
  kanbanListBoards,
  kanbanListTasks,
  kanbanTaskDetail,
  kanbanCreateTask,
  kanbanAssign,
  kanbanAddComment,
  kanbanBlock,
  kanbanUnblock,
  kanbanPromote,
  kanbanComplete,
  kanbanArchive,
  kanbanBoardCreate,
  kanbanBoardDelete,
  kanbanAssignees,
  type KanbanBoard,
  type KanbanTask,
  type KanbanTaskDetail,
  type KanbanStatus,
  type KanbanAssignee,
  KANBAN_COLUMNS,
  STATUS_ICONS,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
} from '@/lib/kanban'
import { cn } from '@/lib/utils'
import { useHelixStore } from '@/stores/helix-store'

interface KanbanPanelProps {}

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
}

const STATUS_COLORS: Record<KanbanStatus, { bar: string; chip: string; dot: string }> = {
  triage: { bar: 'bg-slate-400', chip: 'bg-slate-400/10 text-slate-500', dot: 'text-slate-400' },
  todo: { bar: 'bg-sky-500', chip: 'bg-sky-500/10 text-sky-600', dot: 'text-sky-500' },
  scheduled: { bar: 'bg-amber-500', chip: 'bg-amber-500/10 text-amber-600', dot: 'text-amber-500' },
  ready: { bar: 'bg-emerald-500', chip: 'bg-emerald-500/10 text-emerald-600', dot: 'text-emerald-500' },
  running: { bar: 'bg-indigo-500', chip: 'bg-indigo-500/10 text-indigo-600', dot: 'text-indigo-500' },
  blocked: { bar: 'bg-rose-500', chip: 'bg-rose-500/10 text-rose-600', dot: 'text-rose-500' },
  review: { bar: 'bg-violet-500', chip: 'bg-violet-500/10 text-violet-600', dot: 'text-violet-500' },
  done: { bar: 'bg-foreground/40', chip: 'bg-muted text-muted-foreground', dot: 'text-muted-foreground' },
  archived: { bar: 'bg-border', chip: 'bg-muted text-muted-foreground/60', dot: 'text-muted-foreground/60' },
}

export function KanbanPanel(_props: KanbanPanelProps) {
  const showToast = useHelixStore(s => s.showToast)

  const [boards, setBoards] = useState<KanbanBoard[]>([])
  const [activeBoard, setActiveBoard] = useState<string | null>(null)
  const [tasks, setTasks] = useState<KanbanTask[]>([])
  const [assignees, setAssignees] = useState<KanbanAssignee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [showEvents, setShowEvents] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)

  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<KanbanStatus | null>(null)
  const [overTrash, setOverTrash] = useState(false)

  const [createForm, setCreateForm] = useState({ title: '', body: '', assignee: '', priority: 0, initialStatus: '' as '' | 'blocked' | 'running' })
  const [boardForm, setBoardForm] = useState({ slug: '', name: '' })

  const loadBoards = useCallback(async () => {
    const res = await kanbanListBoards()
    if (!res.ok) {
      setError(res.error || '无法加载看板')
      return
    }
    const list = res.data || []
    setBoards(list)
    const cur = list.find(b => b.is_current)?.slug || list[0]?.slug || 'default'
    setActiveBoard(prev => (prev && list.some(b => b.slug === prev) ? prev : cur))
  }, [])

  const loadTasks = useCallback(async (board: string) => {
    setLoading(true)
    setError(null)
    const res = await kanbanListTasks(board)
    if (!res.ok) setError(res.error || '无法加载任务')
    else setTasks(res.data || [])
    setLoading(false)
  }, [])

  const loadAssignees = useCallback(async (board: string) => {
    const res = await kanbanAssignees(board)
    if (res.ok) setAssignees(res.data || [])
  }, [])

  const refresh = useCallback(async () => {
    await loadBoards()
    if (activeBoard) {
      await loadTasks(activeBoard)
      loadAssignees(activeBoard)
    }
  }, [activeBoard, loadBoards, loadTasks, loadAssignees])

  useEffect(() => {
    loadBoards()
  }, [loadBoards])

  useEffect(() => {
    if (!activeBoard) return
    loadTasks(activeBoard)
    loadAssignees(activeBoard)
    setDetailId(null)
  }, [activeBoard, loadTasks, loadAssignees])

  useEffect(() => {
    let cancelled = false
    if (!detailId || !activeBoard) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    setAssignOpen(false)
    kanbanTaskDetail(detailId, activeBoard).then(res => {
      if (cancelled) return
      if (res.ok) setDetail(res.data || null)
      else showToast({ type: 'error', title: '加载任务失败', description: res.error })
      setDetailLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [detailId, activeBoard, showToast])

  const grouped = useMemo(() => {
    const map = new Map<KanbanStatus, KanbanTask[]>()
    for (const s of KANBAN_COLUMNS) map.set(s, [])
    const other: KanbanTask[] = []
    for (const t of tasks) {
      if (map.has(t.status)) map.get(t.status)!.push(t)
      else other.push(t)
    }
    return { map, other }
  }, [tasks])

  if (!isElectron()) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">看板功能仅在桌面版可用</p>
      </div>
    )
  }

  const moveTask = async (task: KanbanTask, toStatus: KanbanStatus) => {
    const allowed = STATUS_TRANSITIONS[task.status] || []
    if (!allowed.includes(toStatus)) {
      showToast({
        type: 'warning',
        title: `不能从「${STATUS_LABELS[task.status]}」移到「${STATUS_LABELS[toStatus]}」`,
      })
      return
    }
    if (!activeBoard) return
    setBusy(task.id)
    try {
      let res
      if (toStatus === 'done') res = await kanbanComplete(task.id, activeBoard)
      else if (toStatus === 'blocked') res = await kanbanBlock(task.id, '从看板移动', activeBoard)
      else if (toStatus === 'ready') res = await (task.status === 'todo' || task.status === 'blocked'
        ? kanbanPromote(task.id, activeBoard)
        : kanbanUnblock(task.id, activeBoard))
      else res = { ok: false, error: `不支持的状态流转: ${task.status} → ${toStatus}` }
      if (res.ok) {
        showToast({ type: 'success', title: `已移到「${STATUS_LABELS[toStatus]}」` })
        await loadTasks(activeBoard)
        if (detailId === task.id) await kanbanTaskDetail(task.id, activeBoard).then(r => { if (r.ok) setDetail(r.data || null) })
      } else {
        showToast({ type: 'error', title: '移动失败', description: res.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '移动失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const handleDrop = (toStatus: KanbanStatus) => {
    const id = dragId
    setOverCol(null)
    setDragId(null)
    if (!id) return
    const task = tasks.find(t => t.id === id)
    if (!task || task.status === toStatus) return
    void moveTask(task, toStatus)
  }

  const handleTrashDrop = async () => {
    const id = dragId
    setOverTrash(false)
    setOverCol(null)
    setDragId(null)
    if (!id || !activeBoard) return
    const task = tasks.find(t => t.id === id)
    if (!task) return
    setBusy(id)
    try {
      const res = await kanbanArchive(id, activeBoard)
      if (res.ok) {
        showToast({ type: 'success', title: '已删除任务' })
        await loadTasks(activeBoard)
        if (detailId === id) setDetailId(null)
      } else {
        showToast({ type: 'error', title: '删除失败', description: res.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '删除失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const handleCreate = async () => {
    if (!createForm.title.trim()) {
      showToast({ type: 'warning', title: '请填写任务标题' })
      return
    }
    if (!activeBoard) return
    setBusy('create')
    try {
      const res = await kanbanCreateTask(
        {
          title: createForm.title.trim(),
          body: createForm.body.trim() || undefined,
          assignee: createForm.assignee || undefined,
          priority: createForm.priority,
          initialStatus: createForm.initialStatus || undefined,
        },
        activeBoard,
      )
      if (res.ok) {
        showToast({ type: 'success', title: '任务已创建' })
        setShowCreate(false)
        setCreateForm({ title: '', body: '', assignee: '', priority: 0, initialStatus: '' })
        await loadTasks(activeBoard)
        if (res.data?.id) setDetailId(res.data.id)
      } else {
        showToast({ type: 'error', title: '创建失败', description: res.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '创建失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const handleCreateBoard = async () => {
    const slug = boardForm.slug.trim().toLowerCase().replace(/\s+/g, '-')
    if (!slug) {
      showToast({ type: 'warning', title: '请填写看板 slug' })
      return
    }
    setBusy('newboard')
    try {
      const res = await kanbanBoardCreate(slug, { name: boardForm.name.trim() || undefined, switchTo: true })
      if (res.ok) {
        showToast({ type: 'success', title: '看板已创建' })
        setShowNewBoard(false)
        setBoardForm({ slug: '', name: '' })
        await loadBoards()
        setActiveBoard(slug)
      } else {
        showToast({ type: 'error', title: '创建看板失败', description: res.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '创建看板失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteBoard = async () => {
    if (!activeBoard) return
    if (boards.length <= 1) {
      showToast({ type: 'warning', title: '至少保留一个看板' })
      return
    }
    setBusy('deleteboard')
    try {
      const res = await kanbanBoardDelete(activeBoard)
      if (res.ok) {
        showToast({ type: 'success', title: '看板已删除' })
        await loadBoards()
      } else {
        showToast({ type: 'error', title: '删除看板失败', description: res.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '删除看板失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const runDetailAction = async (fn: (board: string) => Promise<{ ok: boolean; error?: string }>, successMsg: string) => {
    if (!activeBoard || !detail) return
    setBusy(detail.task.id)
    try {
      const res = await fn(activeBoard)
      if (res.ok) {
        showToast({ type: 'success', title: successMsg })
        await loadTasks(activeBoard)
        const r = await kanbanTaskDetail(detail.task.id, activeBoard)
        if (r.ok) setDetail(r.data || null)
      } else {
        showToast({ type: 'error', title: '操作失败', description: res.error })
      }
    } catch (e) {
      showToast({ type: 'error', title: '操作失败', description: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const handleComment = async () => {
    if (!commentText.trim() || !activeBoard || !detail) return
    const text = commentText.trim()
    setCommentText('')
    const res = await kanbanAddComment(detail.task.id, text, 'helix-user', activeBoard)
    if (!res.ok) {
      showToast({ type: 'error', title: '评论失败', description: res.error })
      setCommentText(text)
      return
    }
    const r = await kanbanTaskDetail(detail.task.id, activeBoard)
    if (r.ok) setDetail(r.data || null)
  }

  const activeTask = detail?.task
  const activeTransitions = activeTask ? (STATUS_TRANSITIONS[activeTask.status] || []) : []

  const renderColumn = (status: KanbanStatus, tasksInCol: KanbanTask[], droppable: boolean, label?: string, icon?: string, color?: typeof STATUS_COLORS[KanbanStatus]) => {
    const colors = color ?? STATUS_COLORS[status]
    const headerLabel = label ?? STATUS_LABELS[status]
    const headerIcon = icon ?? STATUS_ICONS[status]
    const isOver = droppable && overCol === status && dragId != null
    return (
      <div
        key={status + (label ?? '')}
        onDragOver={e => { if (droppable) { e.preventDefault(); if (overCol !== status) setOverCol(status) } }}
        onDragLeave={() => { if (overCol === status) setOverCol(null) }}
        onDrop={() => { if (droppable) handleDrop(status) }}
        className={cn(
          'w-64 shrink-0 max-h-full flex flex-col rounded-xl border bg-muted/20 transition-colors',
          isOver ? 'border-primary/60 bg-primary/5' : 'border-border/60',
        )}
      >
        <div className={cn('shrink-0 h-0.5 rounded-t-xl', colors.bar)} />
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <span className={cn('text-[13px] font-semibold', colors.chip)}>{headerIcon}</span>
          <span className="text-[13px] font-semibold text-foreground/80">{headerLabel}</span>
          <span className="ml-auto text-[11px] text-muted-foreground/60">{tasksInCol.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
          {tasksInCol.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 py-6 text-center text-[11px] text-muted-foreground/40">
              空
            </div>
          ) : (
            tasksInCol.map(task => (
              <div
                key={task.id}
                draggable
                onDragStart={e => { setDragId(task.id); e.dataTransfer.effectAllowed = 'move' }}
                onDragEnd={() => { setDragId(null); setOverCol(null); setOverTrash(false) }}
                onClick={() => setDetailId(task.id)}
                className={cn(
                  'group cursor-grab active:cursor-grabbing rounded-lg border border-border/60 bg-card px-2 py-1.5 hover:border-primary/40 hover:shadow-sm transition-all select-none',
                  dragId === task.id && 'opacity-40',
                  busy === task.id && 'opacity-60',
                )}
              >
                {/* 上半部分：标题 + 状态 */}
                <div className="flex items-start justify-between gap-1.5">
                  <p className="text-[11px] leading-snug text-foreground/90 line-clamp-2 break-words flex-1">{task.title}</p>
                  <span className={cn('shrink-0 text-[10px] font-medium px-1 py-0.5 rounded', STATUS_COLORS[task.status].chip)}>
                    {STATUS_ICONS[task.status]}
                  </span>
                </div>
                {/* 下半部分：元信息 */}
                <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground/60">
                  {task.assignee && (
                    <span className="flex items-center gap-0.5">
                      <User className="size-2.5" />
                      {task.assignee}
                    </span>
                  )}
                  {task.priority > 0 && <span>P{task.priority}</span>}
                  {task.created_at && <span>{timeAgo(task.created_at * 1000)}</span>}
                  <span className="ml-auto font-mono text-muted-foreground/40">{task.id.slice(-6)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  // 渲染组合列（上下两个状态）
  const renderCombinedColumn = (topStatus: KanbanStatus, bottomStatus: KanbanStatus, topTasks: KanbanTask[], bottomTasks: KanbanTask[]) => {
    const topColors = STATUS_COLORS[topStatus]
    const bottomColors = STATUS_COLORS[bottomStatus]
    const isTopOver = overCol === topStatus && dragId != null
    const isBottomOver = overCol === bottomStatus && dragId != null

    return (
      <div
        key={`${topStatus}-${bottomStatus}`}
        className="w-44 shrink-0 max-h-full flex flex-col rounded-lg border border-border/60 bg-muted/10 transition-colors"
      >
        {/* 上半部分 */}
        <div
          onDragOver={e => { e.preventDefault(); if (overCol !== topStatus) setOverCol(topStatus) }}
          onDragLeave={() => { if (overCol === topStatus) setOverCol(null) }}
          onDrop={() => handleDrop(topStatus)}
          className={cn('flex-1 flex flex-col transition-colors min-h-0', isTopOver && 'bg-primary/5')}
        >
          <div className={cn('shrink-0 h-0.5 rounded-t-lg', topColors.bar)} />
          <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
            <span className={cn('text-[10px] font-semibold', topColors.chip)}>{STATUS_ICONS[topStatus]}</span>
            <span className="text-[10px] font-semibold text-foreground/80">{STATUS_LABELS[topStatus]}</span>
            <span className="ml-auto text-[9px] text-muted-foreground/60">{topTasks.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-1.5 pb-1 space-y-0.5">
            {topTasks.length === 0 ? (
              <div className="rounded border border-dashed border-border/60 py-1.5 text-center text-[9px] text-muted-foreground/40">空</div>
            ) : (
              topTasks.map(task => renderCompactCard(task))
            )}
          </div>
        </div>
        {/* 分隔线 */}
        <div className="h-px bg-border/40 mx-1.5" />
        {/* 下半部分 */}
        <div
          onDragOver={e => { e.preventDefault(); if (overCol !== bottomStatus) setOverCol(bottomStatus) }}
          onDragLeave={() => { if (overCol === bottomStatus) setOverCol(null) }}
          onDrop={() => handleDrop(bottomStatus)}
          className={cn('flex-1 flex flex-col transition-colors min-h-0', isBottomOver && 'bg-primary/5')}
        >
          <div className={cn('shrink-0 h-0.5', bottomColors.bar)} />
          <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
            <span className={cn('text-[10px] font-semibold', bottomColors.chip)}>{STATUS_ICONS[bottomStatus]}</span>
            <span className="text-[10px] font-semibold text-foreground/80">{STATUS_LABELS[bottomStatus]}</span>
            <span className="ml-auto text-[9px] text-muted-foreground/60">{bottomTasks.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-1.5 pb-1 space-y-0.5">
            {bottomTasks.length === 0 ? (
              <div className="rounded border border-dashed border-border/60 py-1.5 text-center text-[9px] text-muted-foreground/40">空</div>
            ) : (
              bottomTasks.map(task => renderCompactCard(task))
            )}
          </div>
        </div>
      </div>
    )
  }

  // 紧凑卡片渲染
  const renderCompactCard = (task: KanbanTask) => (
    <div
      key={task.id}
      draggable
      onDragStart={e => { setDragId(task.id); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={() => { setDragId(null); setOverCol(null); setOverTrash(false) }}
      onClick={() => setDetailId(task.id)}
      className={cn(
        'group cursor-grab active:cursor-grabbing rounded bg-card px-1.5 py-0.5 hover:bg-accent/50 transition-all select-none border border-transparent hover:border-primary/30',
        dragId === task.id && 'opacity-40',
        busy === task.id && 'opacity-60',
      )}
    >
      <p className="text-[10px] leading-[1.15] text-foreground/80 line-clamp-1 break-words truncate">{task.title}</p>
    </div>
  )

  return (
    <div className="h-full w-full flex flex-col bg-background relative select-none">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-border/40">
        <SquareKanban className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">看板</h2>

        <div className="flex items-center gap-2 ml-2">
          <div className="relative">
            <select
              value={activeBoard ?? ''}
              onChange={e => setActiveBoard(e.target.value)}
              className="h-8 pl-3 pr-8 rounded-lg border border-border/60 bg-muted/40 text-xs text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
              title="切换看板"
            >
              {boards.length === 0 && <option value="">加载中…</option>}
              {boards.map(b => {
                const activeCount = b.total - (b.counts?.archived || 0)
                return (
                  <option key={b.slug} value={b.slug}>
                    {b.name || b.slug} ({activeCount})
                  </option>
                )
              })}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          </div>
          <button
            onClick={() => setShowNewBoard(true)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
            title="新建看板"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            onClick={handleDeleteBoard}
            disabled={!activeBoard || busy === 'deleteboard'}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
            title="删除当前看板"
          >
            {busy === 'deleteboard' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </button>
        </div>

        <div className="flex items-center gap-1 ml-auto shrink-0">
          {/* Trash zone */}
          <div
            onDragOver={e => { if (dragId) { e.preventDefault(); setOverTrash(true) } }}
            onDragLeave={() => setOverTrash(false)}
            onDrop={handleTrashDrop}
            className={cn(
              'flex items-center gap-1.5 px-40 h-8 rounded-lg border-2 border-dashed transition-all shrink-0 justify-center -ml-2',
              overTrash
                ? 'border-red-400 bg-red-500/10 text-red-500'
                : dragId
                  ? 'border-red-300/50 text-red-400/60'
                  : 'border-transparent text-transparent pointer-events-none',
            )}
          >
            <Trash2 className="size-3.5" />
            <span className="text-xs font-medium">拖到这里删除</span>
          </div>
          <button
            onClick={refresh}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
            title="刷新"
          >
            <RefreshCw className="size-4" />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            disabled={busy === 'create'}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-border/60 text-xs font-medium text-foreground hover:bg-accent/60 transition-colors disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            新建任务
          </button>
        </div>
      </div>

      {/* Columns */}
      <div className="flex-1 min-h-0 flex gap-2 overflow-x-auto p-3">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-red-500 mx-auto">
            <AlertCircle className="size-5" />
            <p className="text-sm">{error}</p>
            <button onClick={refresh} className="text-xs text-muted-foreground hover:text-foreground">重试</button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-16 mx-auto">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {renderCombinedColumn('triage', 'todo', grouped.map.get('triage') || [], grouped.map.get('todo') || [])}
            {renderCombinedColumn('scheduled', 'ready', grouped.map.get('scheduled') || [], grouped.map.get('ready') || [])}
            {renderCombinedColumn('running', 'blocked', grouped.map.get('running') || [], grouped.map.get('blocked') || [])}
            {renderCombinedColumn('review', 'done', grouped.map.get('review') || [], grouped.map.get('done') || [])}
            {grouped.other.length > 0 && renderColumn('archived', grouped.other, false, '其他', '⋯', { bar: 'bg-border', chip: 'bg-muted text-muted-foreground/70', dot: 'text-muted-foreground/70' })}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-5 py-2 border-t border-border/40 flex items-center gap-3">
        <span className="text-[10px] text-muted-foreground/50">
          看板 {activeBoard} · {tasks.length} 个任务 · 拖动卡片切换状态
        </span>
      </div>

      {/* Create task modal */}
      {showCreate && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="w-[460px] max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-foreground">新建任务</h3>
              <button onClick={() => setShowCreate(false)} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60">
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={createForm.title}
                onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
                placeholder="任务标题 *"
                autoFocus
                className="w-full px-3 py-2 rounded-lg border border-border/60 bg-muted/30 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <textarea
                value={createForm.body}
                onChange={e => setCreateForm(f => ({ ...f, body: e.target.value }))}
                placeholder="任务描述（可选）"
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-border/60 bg-muted/30 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">指派给</label>
                  <select
                    value={createForm.assignee}
                    onChange={e => setCreateForm(f => ({ ...f, assignee: e.target.value }))}
                    className="w-full h-9 px-3 rounded-lg border border-border/60 bg-muted/30 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">未指派</option>
                    {assignees.map(a => (
                      <option key={a.name} value={a.name}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">初始状态</label>
                  <select
                    value={createForm.initialStatus}
                    onChange={e => setCreateForm(f => ({ ...f, initialStatus: e.target.value as '' | 'blocked' | 'running' }))}
                    className="w-full h-9 px-3 rounded-lg border border-border/60 bg-muted/30 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">就绪 (ready)</option>
                    <option value="blocked">受阻 (blocked)</option>
                    <option value="running">进行中 (running)</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy === 'create'}
                  className="px-4 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {busy === 'create' && <Loader2 className="size-3 animate-spin" />}
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create board modal */}
      {showNewBoard && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="w-[380px] rounded-xl border border-border bg-card shadow-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-foreground">新建看板</h3>
              <button onClick={() => setShowNewBoard(false)} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60">
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={boardForm.slug}
                onChange={e => setBoardForm(f => ({ ...f, slug: e.target.value }))}
                placeholder="slug (kebab-case，如 my-project) *"
                autoFocus
                className="w-full px-3 py-2 rounded-lg border border-border/60 bg-muted/30 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                type="text"
                value={boardForm.name}
                onChange={e => setBoardForm(f => ({ ...f, name: e.target.value }))}
                placeholder="显示名称（可选）"
                className="w-full px-3 py-2 rounded-lg border border-border/60 bg-muted/30 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowNewBoard(false)}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleCreateBoard}
                  disabled={busy === 'newboard'}
                  className="px-4 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {busy === 'newboard' && <Loader2 className="size-3 animate-spin" />}
                  创建并切换
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {detailId && (
        <div className="absolute inset-0 z-30">
          <div className="absolute inset-0 bg-black/20" onClick={() => setDetailId(null)} />
          <div className="absolute inset-y-0 right-0 w-[400px] max-w-[85%] flex flex-col border-l border-border bg-background shadow-2xl">
            {/* Detail header */}
            <div className="shrink-0 px-4 py-3 border-b border-border/40 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {activeTask && (
                    <span className={cn('shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded', STATUS_COLORS[activeTask.status].chip)}>
                      {STATUS_ICONS[activeTask.status]} {STATUS_LABELS[activeTask.status]}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-muted-foreground/50">{detailId}</span>
                </div>
                <h3 className="text-sm font-semibold text-foreground mt-1.5 break-words">
                  {activeTask ? activeTask.title : (detailLoading ? '加载中…' : '—')}
                </h3>
              </div>
              <button
                onClick={() => setDetailId(null)}
                className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            {detailLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : activeTask ? (
              <>
                {/* Actions */}
                <div className="shrink-0 px-4 py-2.5 border-b border-border/40 flex flex-wrap gap-1.5">
                  {activeTransitions.map(to => (
                    <button
                      key={to}
                      onClick={() => moveTask(activeTask, to)}
                      disabled={busy === activeTask.id}
                      className={cn(
                        'px-2.5 py-1 text-[11px] font-medium rounded-lg transition-colors disabled:opacity-50',
                        to === 'done' && 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20',
                        to === 'blocked' && 'bg-rose-500/10 text-rose-600 hover:bg-rose-500/20',
                        to === 'ready' && 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20',
                      )}
                    >
                      {to === 'done' ? '完成' : to === 'blocked' ? '受阻' : to === 'ready' ? '就绪' : STATUS_LABELS[to]}
                    </button>
                  ))}
                  <button
                    onClick={() => runDetailAction(board => kanbanArchive(activeTask.id, board), '已归档')}
                    disabled={busy === activeTask.id}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-muted text-muted-foreground hover:bg-accent/60 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    <Archive className="size-3" />
                    归档
                  </button>
                </div>

                {/* Meta */}
                <div className="shrink-0 px-4 py-3 border-b border-border/40 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Hash className="size-3 shrink-0" />
                    <span className="truncate">{activeTask.id}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <User className="size-3 shrink-0" />
                    <span className="truncate">{activeTask.created_by || '—'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3 shrink-0" />
                    <span className="truncate">{activeTask.created_at ? timeAgo(activeTask.created_at * 1000) : '—'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Flag className="size-3 shrink-0" />
                    <span className="truncate">{activeTask.priority ? `P${activeTask.priority}` : '—'}</span>
                  </div>
                  <div className="col-span-2 relative">
                    <button
                      onClick={() => setAssignOpen(v => !v)}
                      className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                    >
                      <Users className="size-3 shrink-0" />
                      <span className="truncate">指派给：{activeTask.assignee || '未指派'}</span>
                      <ChevronDown className={cn('ml-auto size-3 transition-transform', assignOpen && 'rotate-180')} />
                    </button>
                    {assignOpen && (
                      <div className="absolute right-0 left-0 top-full mt-1 z-40 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-xl py-1">
                        <button
                          onClick={async () => {
                            if (activeBoard) {
                              const res = await kanbanAssign(activeTask.id, null, activeBoard)
                              if (res.ok) {
                                const r = await kanbanTaskDetail(activeTask.id, activeBoard)
                                if (r.ok) setDetail(r.data || null)
                                await loadTasks(activeBoard)
                              } else showToast({ type: 'error', title: '取消指派失败', description: res.error })
                            }
                            setAssignOpen(false)
                          }}
                          className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60"
                        >
                          未指派
                        </button>
                        {assignees.map(a => (
                          <button
                            key={a.name}
                            onClick={async () => {
                              if (activeBoard) {
                                const res = await kanbanAssign(activeTask.id, a.name, activeBoard)
                                if (res.ok) {
                                  const r = await kanbanTaskDetail(activeTask.id, activeBoard)
                                  if (r.ok) setDetail(r.data || null)
                                  await loadTasks(activeBoard)
                                } else showToast({ type: 'error', title: '指派失败', description: res.error })
                              }
                              setAssignOpen(false)
                            }}
                            className={cn(
                              'w-full px-3 py-1.5 text-left text-xs hover:bg-accent/60',
                              activeTask.assignee === a.name ? 'text-primary font-medium' : 'text-foreground/80',
                            )}
                          >
                            {a.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Body + comments */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                  {activeTask.body ? (
                    <div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1.5">
                        <FileText className="size-3" />
                        描述
                      </div>
                      <p className="text-[13px] text-foreground/85 whitespace-pre-wrap break-words">{activeTask.body}</p>
                    </div>
                  ) : null}

                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-2">
                      <MessageSquare className="size-3" />
                      评论（{(detail?.comments || []).length}）
                    </div>
                    {detail && detail.comments.length > 0 ? (
                      <div className="space-y-2">
                        {detail.comments.map((c, i) => (
                          <div key={c.id ?? i} className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[11px] font-medium text-foreground/80">{c.author || '未知'}</span>
                              {c.created_at != null && (
                                <span className="text-[10px] text-muted-foreground/50">{timeAgo(c.created_at * 1000)}</span>
                              )}
                            </div>
                            <p className="text-[12px] text-foreground/80 whitespace-pre-wrap break-words">{c.body}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground/50">暂无评论</p>
                    )}
                    <div className="flex gap-2 mt-2">
                      <input
                        type="text"
                        value={commentText}
                        onChange={e => setCommentText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void handleComment() }}
                        placeholder="添加评论…"
                        className="flex-1 px-3 h-8 rounded-lg border border-border/60 bg-muted/30 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <button
                        onClick={handleComment}
                        disabled={!commentText.trim()}
                        className="px-3 h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        发送
                      </button>
                    </div>
                  </div>

                  {detail && detail.events.length > 0 && (
                    <div>
                      <button
                        onClick={() => setShowEvents(v => !v)}
                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Clock className="size-3" />
                        事件记录（{detail.events.length}）
                        <ChevronDown className={cn('size-3 transition-transform', showEvents && 'rotate-180')} />
                      </button>
                      {showEvents && (
                        <div className="mt-2 space-y-1">
                          {detail.events.map((ev, i) => (
                            <div key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground/70">
                              <Circle className="size-2 mt-1 shrink-0" />
                              <div className="min-w-0">
                                <span className="font-mono">{ev.kind}</span>
                                {ev.created_at != null && <span className="ml-1.5 text-muted-foreground/40">{fmtDate(ev.created_at)}</span>}
                                {ev.payload && (
                                  <pre className="mt-1 text-[10px] text-muted-foreground/50 whitespace-pre-wrap break-words">{JSON.stringify(ev.payload, null, 1)}</pre>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-muted-foreground/60">任务不存在或已删除</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
