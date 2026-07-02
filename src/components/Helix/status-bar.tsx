'use client'

import React, { useState, useCallback } from 'react'
import {
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  Target,
  Brain,
  Wrench,
  FolderOpen,
  ListChecks,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useHelixStore, type TaskNode } from '@/stores/helix-store'

function TaskItem({ task, depth = 0 }: { task: TaskNode; depth?: number }) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = task.children && task.children.length > 0

  const statusIcon = {
    done: <CheckCircle2 className="size-3.5 text-green-500" />,
    in_progress: <Loader2 className="size-3.5 text-blue-500 animate-spin" />,
    blocked: <AlertCircle className="size-3.5 text-yellow-500" />,
    pending: <Circle className="size-3.5 text-muted-foreground" />,
  }[task.status]

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 cursor-pointer hover:bg-accent/30 rounded transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          expanded ? <ChevronDown className="size-3 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3 text-muted-foreground shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {statusIcon}
        <span className={`text-[11px] truncate ${task.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
          {task.label}
        </span>
      </div>
      {hasChildren && expanded && task.children!.map(child => (
        <TaskItem key={child.id} task={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export function StatusBar() {
  const {
    tasks,
    goal,
    isChatLoading,
    subAgents,
    agentExecutionSteps,
    accessedDirectories,
  } = useHelixStore()

  const completedTasks = tasks.filter(t => t.status === 'done').length
  const totalTasks = tasks.length
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const runningSubAgents = subAgents.filter(a => a.status === 'running')

  // Execution step stats
  const thinkingCount = agentExecutionSteps.filter(s => s.type === 'thinking').length
  const toolCallCount = agentExecutionSteps.filter(s => s.type === 'tool_call').length
  const resultCount = agentExecutionSteps.filter(s => s.type === 'tool_result').length
  const hasExecution = agentExecutionSteps.length > 0

  return (
    <div className="w-56 border-l border-border bg-card flex flex-col shrink-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Target className="size-3.5 text-primary" />
          <span className="text-[11px] font-medium text-foreground">状态</span>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Goal */}
          {goal && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">目标</div>
              <p className="text-[11px] text-foreground/80 leading-relaxed">{goal}</p>
            </div>
          )}

          {/* Progress */}
          {totalTasks > 0 && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">进度</div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{completedTasks}/{totalTasks} 完成</span>
                  <span className="text-primary font-medium">{progress}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tasks */}
          {tasks.length > 0 && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">任务</div>
              <div className="space-y-0.5">
                {tasks.map(task => (
                  <TaskItem key={task.id} task={task} />
                ))}
              </div>
            </div>
          )}

          {/* Agent Execution Steps */}
          {hasExecution && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <ListChecks className="size-3 text-primary" />
                <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">任务步骤</span>
              </div>
              <div className="space-y-1">
                {thinkingCount > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded-md">
                    <Brain className="size-3 text-gray-400 shrink-0" />
                    <span className="text-[10px] text-gray-600">{thinkingCount} 次思考</span>
                  </div>
                )}
                {toolCallCount > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-green-50 border border-green-200 rounded-md">
                    <Wrench className="size-3 text-green-600 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] text-green-700">{toolCallCount} 次工具调用</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {[...new Set(agentExecutionSteps.filter(s => s.type === 'tool_call').map(s => s.toolName).filter(Boolean))].map(name => (
                          <span key={name} className="text-[8px] bg-green-100 text-green-700 px-1 rounded">{name}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {resultCount > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-sky-50 border border-sky-200 rounded-md">
                    <CheckCircle2 className="size-3 text-sky-600 shrink-0" />
                    <span className="text-[10px] text-sky-700">{resultCount} 个结果返回</span>
                  </div>
                )}
                {agentExecutionSteps.filter(s => s.type === 'done').length > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-emerald-50 border border-emerald-200 rounded-md">
                    <CheckCircle2 className="size-3 text-emerald-600 shrink-0" />
                    <span className="text-[10px] text-emerald-700">执行完成</span>
                  </div>
                )}
                {agentExecutionSteps.filter(s => s.type === 'error').length > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded-md">
                    <AlertCircle className="size-3 text-red-500 shrink-0" />
                    <span className="text-[10px] text-red-600">{agentExecutionSteps.filter(s => s.type === 'error').length} 个错误</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Accessed Directories */}
          {accessedDirectories.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <FolderOpen className="size-3 text-primary" />
                <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">使用到的目录</span>
              </div>
              <div className="space-y-0.5">
                {accessedDirectories.map(dir => (
                  <div key={dir} className="flex items-center gap-1.5 px-2 py-1 hover:bg-accent/30 rounded transition-colors">
                    <FolderOpen className="size-2.5 text-muted-foreground/40 shrink-0" />
                    <span className="text-[10px] text-foreground/70 font-mono truncate">{dir}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sub Agents */}
          {runningSubAgents.length > 0 && (
            <div>
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">子任务</div>
              <div className="space-y-1">
                {runningSubAgents.map(agent => (
                  <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 bg-primary/5 border border-primary/20 rounded-md">
                    <Loader2 className="size-3 text-primary animate-spin shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium text-foreground truncate">{agent.name}</p>
                      <p className="text-[9px] text-muted-foreground truncate">{agent.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty State */}
          {totalTasks === 0 && runningSubAgents.length === 0 && !goal && !hasExecution && (
            <div className="text-center py-6">
              <Target className="size-6 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-[10px] text-muted-foreground/40">暂无任务</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Loading Indicator */}
      {isChatLoading && (
        <div className="px-3 py-2 border-t border-border bg-primary/5">
          <div className="flex items-center gap-2">
            <Loader2 className="size-3 text-primary animate-spin" />
            <span className="text-[10px] text-primary">AI 正在思考...</span>
          </div>
        </div>
      )}
    </div>
  )
}
