'use client'

import React from 'react'
import {
  FileCode2, Square, CheckCircle2, AlertCircle, Circle, Pencil,
  Terminal, FolderSearch, FolderOpen, ChevronRight, ChevronDown,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'

// ── Types ──────────────────────────────────────────────

interface OutlineStep {
  num: number
  label: string
  detail: string
  status: 'done' | 'running' | 'pending' | 'error'
  icon: React.ReactNode
}

// ── Extraction ─────────────────────────────────────────

function extractTaskOutline(
  steps: Array<{
    type: string
    toolName?: string
    path?: string
    content?: string
    toolParams?: Record<string, unknown>
    timestamp: number
  }>,
): OutlineStep[] {
  const items: OutlineStep[] = []
  let num = 0

  // Phase tracking
  let phaseExploring = false
  let exploreCount = 0

  // File ops: keyed by normalized path, last-write-wins
  const fileOps = new Map<string, {
    tool: string
    path: string
    timestamp: number
    error?: boolean
  }>()

  // Bash commands: keyed by first 30 chars, last-write-wins
  const bashOps = new Map<string, {
    cmd: string
    timestamp: number
    error?: boolean
  }>()

  // Phase tracking helpers
  const startPhase = () => { phaseExploring = true; exploreCount = 0 }
  const endPhase = () => {
    if (phaseExploring && exploreCount > 0) {
      num++
      items.push({
        num,
        label: '探索',
        detail: `读取了 ${exploreCount} 个文件/目录`,
        status: 'done',
        icon: <FolderSearch className="size-3.5 text-violet-500" />,
      })
    }
    phaseExploring = false
  }

  const isReadTool = (name?: string) =>
    ['read_file', 'glob', 'grep', 'list_directory'].includes(name || '')

  const isWriteTool = (name?: string) =>
    ['write_file', 'edit_file', 'delete_file', 'create_file', 'rename_file'].includes(name || '')

  const isBashTool = (name?: string) =>
    name === 'bash' || name === 'run_bash'

  for (const step of steps) {
    if (step.type === 'tool_call' && step.toolName) {
      // Phase transitions: read → write/bash means end read phase
      if (phaseExploring && !isReadTool(step.toolName)) {
        endPhase()
      }

      if (isReadTool(step.toolName)) {
        if (!phaseExploring) startPhase()
        exploreCount++
        continue
      }

      if (isWriteTool(step.toolName)) {
        const toolPath = (step.toolParams?.path as string) || step.path
        if (toolPath) {
          endPhase()
          const norm = toolPath.split(/[/\\]/).pop() || toolPath
          fileOps.set(norm, {
            tool: step.toolName,
            path: toolPath,
            timestamp: step.timestamp,
          })
        }
        continue
      }

      if (isBashTool(step.toolName)) {
        const cmd = (step.toolParams?.command as string) || ''
        const trimmed = cmd.trim()
        if (trimmed) {
          endPhase()
          const short = trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed
          bashOps.set(short, { cmd: short, timestamp: step.timestamp })
        }
        continue
      }
    }

    // Error detection on tool_result
    if (step.type === 'tool_result' && step.content) {
      const isErr = step.content.includes('Error') || step.content.includes('failed')
      if (isErr) {
        for (const [key, op] of fileOps) {
          const opTool = op.tool.split('_')[0] // 'write' from 'write_file'
          if (step.toolName?.toLowerCase().includes(opTool)) {
            op.error = true
          }
        }
        for (const [, op] of bashOps) {
          op.error = true
        }
      }
    }
  }
  endPhase()

  // Build ordered list: interleaved file ops + bash ops by timestamp
  const allOps: Array<{ ts: number; type: 'file' | 'bash'; key: string }> = []
  for (const [key, op] of fileOps) allOps.push({ ts: op.timestamp, type: 'file', key })
  for (const [key, op] of bashOps) allOps.push({ ts: op.timestamp, type: 'bash', key })
  allOps.sort((a, b) => a.ts - b.ts)

  for (const op of allOps) {
    num++
    if (op.type === 'file') {
      const fileOp = fileOps.get(op.key)!
      const isEdit = fileOp.tool === 'edit_file'
      const isDelete = fileOp.tool === 'delete_file'
      const isCreate = fileOp.tool === 'create_file'
      const isRename = fileOp.tool === 'rename_file'
      items.push({
        num,
        label: isEdit ? '编辑' : isDelete ? '删除' : isCreate ? '新建' : isRename ? '重命名' : '写入',
        detail: op.key,
        status: fileOp.error ? 'error' : 'done',
        icon: isEdit
          ? <Pencil className="size-3.5 text-amber-500" />
          : <FileCode2 className="size-3.5 text-emerald-500" />,
      })
    } else {
      const bashOp = bashOps.get(op.key)!
      items.push({
        num,
        label: '运行',
        detail: bashOp.cmd,
        status: bashOp.error ? 'error' : 'done',
        icon: <Terminal className="size-3.5 text-blue-500" />,
      })
    }
  }

  return items
}

// ── Rendering ──────────────────────────────────────────

function TaskOutline({ items, isRunning }: { items: OutlineStep[]; isRunning: boolean }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-foreground/40">
        {isRunning ? '正在分析任务…' : '暂无任务步骤'}
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {items.map((item) => (
        <div
          key={item.num}
          className="group flex items-start gap-3 px-2.5 py-1.5 rounded-lg hover:bg-sidebar-accent/50 transition-colors"
        >
          {/* Number badge */}
          <div className="flex flex-col items-center pt-0.5 shrink-0">
            <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-[10px] font-semibold text-primary border border-primary/20">
              {item.num}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-1.5">
              {item.icon}
              <span className="text-xs font-medium text-foreground/70">{item.label}</span>
              {item.status === 'error' && (
                <AlertCircle className="size-3 text-red-500 shrink-0" />
              )}
            </div>
            <span className="text-[11px] text-foreground/40 truncate block ml-5 mt-0.5 font-mono">
              {item.detail}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── File Tree ──────────────────────────────────────────

function FileTreeNode({
  node,
  depth,
}: {
  node: { id: string; name: string; type: string; children?: any[] }
  depth: number
}) {
  const [expanded, setExpanded] = React.useState(depth < 2)
  const isDir = node.type === 'folder'

  return (
    <div>
      <button
        onClick={() => isDir && setExpanded(!expanded)}
        className="w-full flex items-center gap-1 py-0.5 text-[11px] rounded hover:bg-sidebar-accent/50 transition-colors text-left"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {isDir && (
          <ChevronDown
            className={`size-3 shrink-0 text-foreground/30 transition-transform ${expanded ? '' : '-rotate-90'}`}
          />
        )}
        {!isDir && <div className="w-3" />}
        {isDir ? (
          <FolderOpen className="size-3 shrink-0 text-amber-500/60" />
        ) : (
          <FileCode2 className="size-3 shrink-0 text-foreground/30" />
        )}
        <span className="truncate text-foreground/60">{node.name}</span>
      </button>
      {isDir && expanded && node.children?.map((child) => (
        <FileTreeNode key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────

export function RightSidebar() {
  const { agentExecutionSteps, isChatLoading, selectedWorkDir, files } = useHelixStore()
  const projectName = selectedWorkDir
    ? selectedWorkDir.split(/[/\\]/).pop() || selectedWorkDir
    : ''

  const taskOutline = React.useMemo(
    () => extractTaskOutline(agentExecutionSteps),
    [agentExecutionSteps],
  )

  const handleStopAgent = () => {
    window.dispatchEvent(new CustomEvent('agent:stop'))
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Stop button when running */}
      {isChatLoading && (
        <div className="border-b border-border/40 px-3 py-2 shrink-0">
          <button
            onClick={handleStopAgent}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500 transition-colors w-full justify-center"
          >
            <Square className="size-3" fill="currentColor" />
            <span className="text-sm font-medium">停止执行</span>
          </button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Task outline */}
        <Section title="任务步骤" count={taskOutline.length}>
          <TaskOutline items={taskOutline} isRunning={isChatLoading} />
        </Section>

        {/* Project name + file tree */}
        {projectName && (
          <div className="px-3 py-2 border-b border-border/30">
            <h2 className="text-sm font-semibold text-foreground truncate mb-1">
              {projectName}
            </h2>
            {files && files.length > 0 ? (
              <div className="space-y-0.5 max-h-[180px] overflow-y-auto">
                {files.map((node) => (
                  <FileTreeNode key={node.id} node={node} depth={0} />
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-foreground/30 py-1">暂无文件</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="border-t border-border/30 first:border-t-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium text-foreground/60">{title}</span>
        {count > 0 && (
          <span className="text-xs text-foreground/30">{count}</span>
        )}
      </div>
      <div className="px-3 pb-2">{children}</div>
    </div>
  )
}
