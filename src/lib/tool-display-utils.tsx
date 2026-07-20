/**
 * Tool display utilities — extracted from agent-flow-panel.tsx.
 * Functions for rendering tool names, icons, and labels in the UI.
 */
import React from 'react'
import { Eye, Pencil, Search, Terminal, FolderOpen, Wrench } from 'lucide-react'
import type { ExecutionStep } from '@/stores/helix-store'

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  patch: '编辑文件',
  list_directory: '读取目录',
  glob: '搜索文件',
  grep: '搜索内容',
  run_bash: '执行命令',
  bash: '执行命令',
  webfetch: '获取网页',
  websearch: '搜索网页',
  web_extractor: '获取网页',
  question: '提—',
  run_task: '执行任务',
  apply_patch: '””补丁',
  create_artifact: '创建制品',
  spawn_agent: '启动子代理',
  get_sub_agent_result: '获取子代理结果',
  memory_add: '添加记忆',
  memory_read: '读取记忆',
  git_status: '查看状态',
  git_diff: '查看差异',
  git_log: '查看日志',
  git_branch: '查看分支',
  git_commit: '提交代码',
  plan_enter: '进入计划',
  plan_exit: '退出计划',
  task_create: '创建任务',
  task_update: '更新任务',
  task_complete: '完成任务',
  todo_write: '写入待办',
  skill: '执行技能',
  browser_navigate: '浏览器导航',
  browser_click: '浏览器点击',
  browser_type: '浏览器输入',
  browser_screenshot: '浏览器截图',
  browser_get_html: '获取页面HTML',
}

export function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || toolName
}

export function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase()
  if (name.includes('read') || name.includes('view')) return <Eye className="size-3.5" />
  if (name.includes('write') || name.includes('create')) return <Pencil className="size-3.5" />
  if (name.includes('edit') || name.includes('modify')) return <Pencil className="size-3.5" />
  if (name.includes('grep') || name.includes('search')) return <Search className="size-3.5" />
  if (name.includes('bash') || name.includes('shell') || name.includes('terminal')) return <Terminal className="size-3.5" />
  if (name.includes('glob') || name.includes('list')) return <FolderOpen className="size-3.5" />
  return <Wrench className="size-3.5" />
}

export function extractCommandSnippet(params?: Record<string, unknown>): string | undefined {
  if (!params) return undefined
  const keys = ['command', 'script', 'cmd', 'args', 'code', 'input', 'query', 'text', 'tool_input']
  for (const k of keys) {
    const v = params[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const k of keys) {
    const v = params[k]
    if (Array.isArray(v) && v.length > 0) {
      const s = v.map(x => String(x)).filter(Boolean).join(' ')
      if (s) return s
    }
  }
  if (typeof params.raw === 'string') {
    const raw = params.raw.trim()
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'string') return parsed
        if (parsed && typeof parsed === 'object') {
          for (const k of keys) {
            if (typeof parsed[k] === 'string' && parsed[k].trim()) return parsed[k].trim()
            if (Array.isArray(parsed[k])) {
              const s = parsed[k].map((x: any) => String(x)).filter(Boolean).join(' ')
              if (s) return s
            }
          }
          for (const v of Object.values(parsed)) {
            if (typeof v === 'string' && v.trim()) return v.trim()
          }
        }
      } catch {
        return raw
      }
    }
  }
  return undefined
}

export function getToolDisplayLabel(toolName: string, toolKind?: string, path?: string, params?: Record<string, unknown>): string {
  // If toolName is a raw ACP-style string like "search: ..." or "read: src/...",
  // try to extract a clean label from it first.
  if (toolName && toolName !== 'tool') {
    // Check if it's already a known short tool name → translate via TOOL_LABELS
    if (TOOL_LABELS[toolName]) {
      const label = TOOL_LABELS[toolName]
      let snippet = ''
      if (path && typeof path === 'string') {
        snippet = path
      } else {
        const cmd = extractCommandSnippet(params)
        if (cmd) snippet = cmd
      }
      if (snippet) {
        snippet = snippet.length > 60 ? snippet.slice(0, 60) + '…' : snippet
      }
      return snippet ? `${label}  ${snippet}` : label
    }

    // toolName looks like "action: description" — use kind-based labels
    const colonIdx = toolName.indexOf(':')
    if (colonIdx > 0) {
      const action = toolName.slice(0, colonIdx).trim().toLowerCase()
      const desc = toolName.slice(colonIdx + 1).trim()
      const kindLabels: Record<string, string> = {
        read: '读取文件', write: '写入文件', edit: '编辑文件', delete: '删除文件', move: '移动文件',
        search: '搜索', execute: '执行命令', run: '执行命令', bash: '执行命令',
        think: '思考', fetch: '获取网页', webfetch: '获取网页',
        switch_mode: '切换模式', terminal: '执行命令',
        glob: '搜索文件', grep: '搜索内容',
        browser: '浏览器操作', skill: '执行技能', task: '任务操作',
      }
      const baseLabel = kindLabels[action] || getToolLabel(action) || '执行工具'
      // Truncate the long description part
      const shortDesc = desc.length > 50 ? desc.slice(0, 50) + '…' : desc
      return `${baseLabel}  ${shortDesc}`
    }

    // Fallback: unknown short name — truncate to prevent overflow
    return toolName.length > 40 ? toolName.slice(0, 37) + '…' : toolName
  }
  const kindLabels: Record<string, string> = {
    read: '读取文件', write: '写入文件', edit: '编辑文件', delete: '删除文件', move: '移动文件',
    search: '搜索', execute: '执行命令', think: '思考', fetch: '获取网页',
    switch_mode: '切换模式', other: '执行工具',
  }
  let label = ''
  if (toolKind && kindLabels[toolKind]) {
    label = kindLabels[toolKind]
  } else {
    label = getToolLabel(toolName)
  }
  let snippet = ''
  if (path && typeof path === 'string') {
    snippet = path
  } else {
    const cmd = extractCommandSnippet(params)
    if (cmd) snippet = cmd
  }
  if (snippet) {
    snippet = snippet.length > 60 ? snippet.slice(0, 60) + '…' : snippet
  }
  return snippet ? `${label}  ${snippet}` : label
}

export function extractToolPath(step: ExecutionStep): string {
  if (step.toolParams?.path && typeof step.toolParams.path === 'string') {
    return step.toolParams.path as string
  }
  if (step.toolParams?.file_path && typeof step.toolParams.file_path === 'string') {
    return step.toolParams.file_path as string
  }
  // Try to parse content as JSON
  try {
    const parsed = JSON.parse(step.content)
    if (typeof parsed.path === 'string') return parsed.path
    if (typeof parsed.file_path === 'string') return parsed.file_path
    if (typeof parsed.filePath === 'string') return parsed.filePath
  } catch {}
  // Fallback: extract first absolute-looking path from content
  const match = step.content.match(/[A-Za-z]:\\[^\s]+|(?:\/[^\s]+)+/)
  return match ? match[0] : ''
}
