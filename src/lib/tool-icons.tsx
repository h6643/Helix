/**
 * Tool icon utilities
 */

import React from 'react'
import { Eye, Pencil, Terminal, FolderOpen, Wrench, Search } from 'lucide-react'

/**
 * Get icon component for tool name
 */
export function getToolIcon(name: string): React.ReactNode {
  const n = name.toLowerCase()
  if (n.includes('read') || n.includes('view')) return React.createElement(Eye, { className: 'size-3.5' })
  if (n.includes('write') || n.includes('create') || n.includes('edit')) return React.createElement(Pencil, { className: 'size-3.5' })
  if (n.includes('grep') || n.includes('search')) return React.createElement(Search, { className: 'size-3.5' })
  if (n.includes('bash') || n.includes('terminal')) return React.createElement(Terminal, { className: 'size-3.5' })
  if (n.includes('glob') || n.includes('list')) return React.createElement(FolderOpen, { className: 'size-3.5' })
  return React.createElement(Wrench, { className: 'size-3.5' })
}

/**
 * Get display label for tool name
 */
export function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    edit_file: '编辑文件',
    run_bash: '运行命令',
    glob: '搜索文件',
    grep: '搜索内容',
  }
  return labels[name] || name
}