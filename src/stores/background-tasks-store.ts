import { create } from 'zustand'

/**
 * background-tasks-store.ts — 后台任务状态（真实后台任务，不做普通命令面板）。
 *
 * 按会话隔离：每个任务记录所属 sessionId，前端（顶栏按钮/面板）只显示当前
 * 会话的任务。数据来源：
 *  - 显式 background=true 的 terminal/process/bash/docker → startTask
 *  - /btw prompt.background 派发的后台任务 → startTask
 *  - tool.complete / process.exit / background.complete → finishTask
 *
 * 不做流式输出累积——面板只需任务名 + 执行时间 + 状态。
 */

export interface BackgroundTask {
  /** 工具调用的唯一 id（tool_call_id），也是任务的 key */
  id: string
  /** 命令原文（tool.start 的 context/command） */
  command: string
  status: 'running' | 'completed' | 'failed'
  /** 用户暂停标记：进程树已被后端挂起（process.pause） */
  paused?: boolean
  /** process_registry 会话 id（proc_xxx），tool.complete 结果里带回，
   *  pause/resume RPC 的直查凭据 */
  procSessionId?: string
  startedAt: number
  finishedAt?: number
  /** 所属会话 id —— 顶栏/面板按它过滤，各对话只见自己的任务 */
  sessionId: string
}

interface BackgroundTasksState {
  tasks: BackgroundTask[]
  /** 工具启动时登记任务（terminal/process/bash/docker）；已存在则忽略 */
  startTask: (id: string, command: string, sessionId: string) => void
  /** 标记任务完成/失败（仅 running → 终态，避免重复标记） */
  finishTask: (id: string, status: 'completed' | 'failed') => void
  /** 记录暂停/恢复状态（本地乐观更新，由面板 RPC 成功后调用） */
  setTaskPaused: (id: string, paused: boolean) => void
  /** 记录 process_registry 会话 id（tool.complete 结果带回） */
  setTaskProcId: (id: string, procSessionId: string) => void
  /** 清空已完成/失败的任务（保留运行中的） */
  clearFinished: () => void
  /** 移除单个任务 */
  removeTask: (id: string) => void
}

export const useBackgroundTasksStore = create<BackgroundTasksState>((set) => ({
  tasks: [],

  startTask: (id, command, sessionId) => {
    if (!id) return
    set((s) => {
      if (s.tasks.some((t) => t.id === id)) return s
      const task: BackgroundTask = {
        id,
        command: command || '…',
        status: 'running',
        startedAt: Date.now(),
        sessionId,
      }
      return { tasks: [...s.tasks, task] }
    })
  },

  finishTask: (id, status) => {
    if (!id) return
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === 'running'
          ? { ...t, status, finishedAt: Date.now(), paused: false }
          : t
      ),
    }))
  },

  setTaskPaused: (id, paused) => {
    if (!id) return
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id && t.status === 'running' ? { ...t, paused } : t
      ),
    }))
  },

  setTaskProcId: (id, procSessionId) => {
    if (!id || !procSessionId) return
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, procSessionId } : t
      ),
    }))
  },

  clearFinished: () => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'running') }))
  },

  removeTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
  },
}))
