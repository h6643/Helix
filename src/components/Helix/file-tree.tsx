'use client'

import React, { useState, useCallback, useMemo } from 'react'
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Trash2,
  FilePlus,
  FolderPlus,
  Pencil,
  Check,
  X,
  Search,
  Copy,
  ClipboardPaste,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useHelixStore, type FileNode } from '@/stores/helix-store'
import { showContextMenu, type ContextMenuItem } from './context-menu'

function FileIcon({ node }: { node: FileNode }) {
  if (node.type === 'folder') {
    return <Folder className="size-4 text-muted-foreground shrink-0" />
  }

  const name = node.name.toLowerCase()
  let color = 'text-muted-foreground'
  if (name.endsWith('.tsx') || name.endsWith('.ts')) color = 'text-blue-400'
  else if (name.endsWith('.js') || name.endsWith('.jsx')) color = 'text-yellow-400'
  else if (name.endsWith('.css') || name.endsWith('.scss')) color = 'text-pink-400'
  else if (name.endsWith('.json')) color = 'text-green-400'
  else if (name.endsWith('.md')) color = 'text-purple-400'
  else if (name.endsWith('.py')) color = 'text-emerald-400'
  else if (name.endsWith('.html')) color = 'text-orange-400'

  return <File className={`size-4 ${color} shrink-0`} />
}

function matchesFilter(node: FileNode, filter: string): boolean {
  if (!filter) return true
  const q = filter.toLowerCase()
  if (node.name.toLowerCase().includes(q)) return true
  if (node.children) return node.children.some(c => matchesFilter(c, q))
  return false
}

function FileTreeNode({
  node,
  depth = 0,
  filter,
}: {
  node: FileNode
  depth?: number
  filter: string
}) {
  const {
    selectedFileId,
    expandedFolders,
    selectFile,
    toggleFolder,
    openFile,
    deleteFile,
    renameFile,
    createFile,
    showToast,
  } = useHelixStore()

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(node.name)
  const [showActions, setShowActions] = useState(false)

  const isExpanded = expandedFolders.has(node.id)
  const isSelected = selectedFileId === node.id
  const isFolder = node.type === 'folder'

  const handleClick = useCallback(() => {
    if (isFolder) {
      toggleFolder(node.id)
    } else {
      selectFile(node.id)
      openFile(node.id)
    }
  }, [isFolder, node.id, selectFile, toggleFolder, openFile])

  const handleRename = useCallback(() => {
    if (renameValue.trim() && renameValue !== node.name) {
      renameFile(node.id, renameValue.trim())
    }
    setIsRenaming(false)
  }, [renameValue, node.id, node.name, renameFile])

  const handleDelete = useCallback(() => {
    deleteFile(node.id)
    showToast({ type: 'info', title: '已删除', description: node.name })
  }, [node.id, node.name, deleteFile, showToast])

  const handleAddFile = useCallback(() => {
    const name = prompt('文件名:')
    if (name?.trim()) {
      createFile(node.id, name.trim(), 'file')
    }
  }, [node.id, createFile])

  const handleAddFolder = useCallback(() => {
    const name = prompt('文件夹名:')
    if (name?.trim()) {
      createFile(node.id, name.trim(), 'folder')
    }
  }, [node.id, createFile])

  const handleCopyPath = useCallback(() => {
    const path = useHelixStore.getState().getFilePath(node.id)
    navigator.clipboard.writeText(path)
    showToast({ type: 'success', title: '已复制', description: path })
  }, [node.id, showToast])

  const handleCopyContent = useCallback(() => {
    if (node.type === 'file' && node.content) {
      navigator.clipboard.writeText(node.content)
      showToast({ type: 'success', title: '已复制', description: `${node.name} 内容` })
    }
  }, [node])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const items: ContextMenuItem[] = [
      {
        label: isFolder ? '新建文件' : '重命名',
        icon: isFolder ? <FilePlus className="size-3.5" /> : <Pencil className="size-3.5" />,
        shortcut: isFolder ? '' : 'F2',
        action: isFolder ? handleAddFile : () => { setIsRenaming(true); setRenameValue(node.name) },
      },
    ]

    if (isFolder) {
      items.push({
        label: '新建文件夹',
        icon: <FolderPlus className="size-3.5" />,
        action: handleAddFolder,
      })
    }

    if (!isFolder) {
      items.push(
        { label: '复制路径', icon: <Copy className="size-3.5" />, shortcut: 'Ctrl+Shift+C', action: handleCopyPath },
        { label: '复制内容', icon: <ClipboardPaste className="size-3.5" />, action: handleCopyContent, disabled: !node.content },
      )
    }

    items.push({ divider: true, label: '', action: () => {} })

    items.push({
      label: '删除',
      icon: <Trash2 className="size-3.5" />,
      danger: true,
      shortcut: 'Del',
      action: handleDelete,
    })

    showContextMenu(e, items)
  }, [isFolder, node, handleAddFile, handleAddFolder, handleCopyPath, handleCopyContent, handleDelete])

  if (!matchesFilter(node, filter)) return null

  const filteredChildren = isFolder && node.children
    ? node.children.filter(c => matchesFilter(c, filter))
    : node.children

  const shouldExpand = filter ? true : isExpanded

  return (
    <>
      <div
        className={`group flex items-center gap-1 px-2 py-1 cursor-pointer text-xs hover:bg-accent/50 transition-colors rounded-lg ${
          isSelected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
        onContextMenu={handleContextMenu}
      >
        {isFolder && (
          <span className="shrink-0">
            {shouldExpand ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </span>
        )}
        {!isFolder && <span className="w-3.5 shrink-0" />}

        {isFolder && shouldExpand ? (
          <FolderOpen className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <FileIcon node={node} />
        )}

        {isRenaming ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <input
              className="flex-1 min-w-0 bg-background border border-input rounded px-1 py-0 text-xs focus:outline-none focus:ring-1 focus:ring-ring font-mono"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') setIsRenaming(false)
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <button onClick={(e) => { e.stopPropagation(); handleRename() }} className="shrink-0">
              <Check className="size-3 text-primary" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); setIsRenaming(false) }} className="shrink-0">
              <X className="size-3 text-destructive" />
            </button>
          </div>
        ) : (
          <span className="truncate flex-1 font-mono">{node.name}</span>
        )}

        {showActions && !isRenaming && (
          <span className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setIsRenaming(true); setRenameValue(node.name) }}
              className="p-0.5 hover:bg-accent rounded"
            >
              <Pencil className="size-3" />
            </button>
            {isFolder && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); handleAddFile() }}
                  className="p-0.5 hover:bg-accent rounded"
                >
                  <FilePlus className="size-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleAddFolder() }}
                  className="p-0.5 hover:bg-accent rounded"
                >
                  <FolderPlus className="size-3" />
                </button>
              </>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete() }}
              className="p-0.5 hover:bg-destructive/20 rounded"
            >
              <Trash2 className="size-3 text-destructive" />
            </button>
          </span>
        )}
      </div>

      {isFolder && shouldExpand && filteredChildren && filteredChildren.length > 0 && (
        <div>
          {filteredChildren
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((child) => (
              <FileTreeNode key={child.id} node={child} depth={depth + 1} filter={filter} />
            ))}
        </div>
      )}
    </>
  )
}

export function FileTree() {
  const { files, createFile, showToast } = useHelixStore()
  const [filter, setFilter] = useState('')

  const handleNewFile = useCallback(() => {
    const name = prompt('文件名:')
    if (name?.trim()) {
      createFile(null, name.trim(), 'file')
      showToast({ type: 'success', title: '已创建', description: name.trim() })
    }
  }, [createFile, showToast])

  const handleNewFolder = useCallback(() => {
    const name = prompt('文件夹名:')
    if (name?.trim()) {
      createFile(null, name.trim(), 'folder')
    }
  }, [createFile])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const items: ContextMenuItem[] = [
      {
        label: '新建文件',
        icon: <FilePlus className="size-3.5" />,
        action: handleNewFile,
      },
      {
        label: '新建文件夹',
        icon: <FolderPlus className="size-3.5" />,
        action: handleNewFolder,
      },
    ]
    showContextMenu(e, items)
  }, [handleNewFile, handleNewFolder])

  const filteredFiles = useMemo(
    () => files.filter(f => matchesFilter(f, filter)),
    [files, filter]
  )

  return (
    <div className="h-full flex flex-col bg-card font-mono" onContextMenu={handleContextMenu}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          文件资源管理器
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={handleNewFile}
          >
            <FilePlus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={handleNewFolder}
          >
            <FolderPlus className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="px-2 py-1.5 border-b border-border">
        <div className="flex items-center gap-1.5 bg-background rounded-xl px-2 py-1 border border-input">
          <Search className="size-3 text-muted-foreground shrink-0" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索文件..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/40 font-mono"
          />
          {filter && (
            <button onClick={() => setFilter('')} className="shrink-0">
              <X className="size-3 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {filteredFiles
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((node) => (
              <FileTreeNode key={node.id} node={node} filter={filter} />
            ))}
          {filteredFiles.length === 0 && filter && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground font-mono">
              没有找到 &quot;{filter}&quot;
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
