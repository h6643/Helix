'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Pencil } from 'lucide-react'
import { useHelixStore, DEFAULT_SHORTCUTS } from '@/stores/helix-store'

export function ShortcutsPage() {
  const { customShortcuts, updateCustomShortcut, showToast } = useHelixStore()

  const shortcuts = Object.entries(customShortcuts)
  const defaultIds = Object.keys(DEFAULT_SHORTCUTS)
  const noopActions = new Set(['archive-chat', 'rename-chat', 'search-chats', 'next-chat', 'prev-chat'])
  const systemShortcuts = shortcuts.filter(([id]) => defaultIds.includes(id) && !noopActions.has(id)).filter(([, s]) => s.keys.length > 0)

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const startRecording = (id: string) => {
    setEditingId(id)
    setPendingKeys(customShortcuts[id]?.keys || [])
    setRecording(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const handleRecordKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const keys: string[] = []
    if (e.ctrlKey) keys.push('Ctrl')
    if (e.shiftKey) keys.push('Shift')
    if (e.altKey) keys.push('Alt')
    if (e.metaKey) keys.push('Meta')
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      keys.push(key)
    }
    if (keys.length > 0) {
      setPendingKeys(keys)
    }
  }, [])

  const confirmRecording = () => {
    if (editingId && pendingKeys.length > 0) {
      updateCustomShortcut(editingId, {
        ...customShortcuts[editingId],
        keys: pendingKeys,
      })
    }
    setRecording(false)
    setEditingId(null)
    setPendingKeys([])
  }

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleRecordKeyDown, { capture: true })
      return () => window.removeEventListener('keydown', handleRecordKeyDown, { capture: true })
    }
  }, [recording, handleRecordKeyDown])

  const cancelRecording = () => {
    setRecording(false)
    setEditingId(null)
    setPendingKeys([])
  }

  return (
    <div className="space-y-6">
      {systemShortcuts.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-lg font-bold text-foreground">系统快捷键</h3>
          <div className="rounded-xl border border-border/50 bg-card/50 shadow-sm overflow-hidden">
            <div className="divide-y divide-border/50">
              {systemShortcuts.map(([id, s]) => (
                <div key={id} className="flex items-center px-4 py-2.5 hover:bg-accent/20 transition-colors group">
                  <span className="flex-1 text-sm font-medium text-foreground/80">{s.description}</span>
                  <span className="text-sm font-mono text-foreground/80 bg-muted px-2 py-1 rounded">{s.keys.join(' + ')}</span>
                  <button
                    onClick={() => startRecording(id)}
                    className="ml-3 p-1.5 rounded text-muted-foreground/20 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-all"
                    title="编辑快捷键"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Recording overlay */}
      {recording && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card/50 border border-border/50 rounded-xl p-6 shadow-xl max-w-sm w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-medium text-foreground">正在录制快捷键</span>
            </div>
            <div className="flex items-center justify-center gap-2 py-4 bg-muted rounded-lg mb-4">
              <input
                ref={inputRef}
                type="text"
                readOnly
                value={pendingKeys.length > 0 ? pendingKeys.join(' + ') : ''}
                placeholder="按快捷键..."
                className="bg-transparent text-center text-lg font-mono text-foreground/80 outline-none w-full"
              />
            </div>
            <p className="text-xs text-foreground/40 text-center mb-3">按下新的按键组合，然后点击确定保存</p>
            <div className="flex gap-2">
              <button
                onClick={cancelRecording}
                className="flex-1 py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-muted transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmRecording}
                disabled={pendingKeys.length === 0}
                className="flex-1 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {shortcuts.length === 0 && (
        <p className="text-sm text-muted-foreground/50 text-center py-4">暂无快捷键</p>
      )}
    </div>
  )
}
