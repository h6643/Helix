'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { X, Keyboard, FileText, Palette, Pencil } from 'lucide-react'
import { useHelixStore, DEFAULT_SHORTCUTS } from '@/stores/helix-store'
import { ScrollArea } from '@/components/ui/scroll-area'

interface CustomizePanelProps {
  onClose: () => void
}

type CustomizeSection = 'shortcuts' | 'instructions' | 'appearance'

export function CustomizePanel({ onClose }: CustomizePanelProps) {
  const [activeSection, setActiveSection] = useState<CustomizeSection>('shortcuts')

  const sections = [
    { id: 'shortcuts' as const, label: '快捷键', icon: Keyboard },
    { id: 'instructions' as const, label: '自定义指令', icon: FileText },
    { id: 'appearance' as const, label: '外观', icon: Palette },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-4xl bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2">
            <Palette className="size-4 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">自定义设置</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Left nav */}
          <div className="w-48 border-r border-border/40 shrink-0">
            <div className="p-2 space-y-0.5">
              {sections.map(section => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                    activeSection === section.id
                      ? 'bg-muted font-medium'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  <section.icon className="size-4" />
                  {section.label}
                </button>
              ))}
            </div>
          </div>

          {/* Right content */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6">
                {activeSection === 'shortcuts' && <ShortcutsSection />}
                {activeSection === 'instructions' && <InstructionsSection />}
                {activeSection === 'appearance' && <AppearanceSection />}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Shortcuts Section ────────────────────────────────────────────────────

function ShortcutsSection() {
  const { customShortcuts, updateCustomShortcut, showToast } = useHelixStore()

  const shortcuts = Object.entries(customShortcuts)
  const defaultIds = Object.keys(DEFAULT_SHORTCUTS)
  const noopActions = new Set(['archive-chat', 'rename-chat', 'search-chats', 'next-chat', 'prev-chat'])
  const systemShortcuts = shortcuts.filter(([id]) => defaultIds.includes(id) && !noopActions.has(id)).filter(([, s]) => s.keys.length > 0)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<string[]>([])
  const inputRef = React.useRef<HTMLInputElement>(null)

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
      showToast({ type: 'success', title: '快捷键已更新', description: `${pendingKeys.join(' + ')} → ${customShortcuts[editingId].description}` })
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
          <h3 className="text-base font-bold text-foreground">系统快捷键</h3>
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

// ─── Instructions Section ─────────────────────────────────────────────────

function InstructionsSection() {
  const { customInstructions, setCustomInstructions, showToast } = useHelixStore()
  const [localInstructions, setLocalInstructions] = useState(customInstructions)

  const handleSave = () => {
    setCustomInstructions(localInstructions)
    showToast({ type: 'success', title: '已保存', description: '自定义指令已更新' })
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-base font-medium text-foreground">自定义指令</h3>
        <p className="text-sm text-muted-foreground">
          添加自定义指令，这些指令会被注入到 AI 的系统提示中，影响 AI 的行为。
        </p>
        <textarea
          value={localInstructions}
          onChange={(e) => setLocalInstructions(e.target.value)}
          placeholder="例如：始终使用中文回复，代码注释使用中文..."
          className="w-full h-48 p-3 text-sm rounded-xl border border-border/50 bg-card/50 resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
        />
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            保存
          </button>
        </div>
      </section>
    </div>
  )
}

// ─── Appearance Section ───────────────────────────────────────────────────

function AppearanceSection() {
  const { fontFamily, setFontFamily, fontSize, setFontSize, interfaceFont, setInterfaceFont, showToast } = useHelixStore()

  const fontOptions = [
    { value: 'Inter', label: 'Inter' },
    { value: 'SF Pro', label: 'SF Pro' },
    { value: 'system-ui', label: 'System UI' },
    { value: 'monospace', label: 'Monospace' },
  ]

  const interfaceFontOptions = [
    { value: 'Inter', label: 'Inter' },
    { value: 'SF Pro', label: 'SF Pro' },
    { value: 'system-ui', label: 'System UI' },
  ]

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-base font-medium text-foreground">编辑器字体</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">字体系列</label>
            <select
              value={fontFamily}
              onChange={(e) => {
                setFontFamily(e.target.value)
              }}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-card/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {fontOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">字体大小</label>
            <input
              type="number"
              min={10}
              max={24}
              value={fontSize}
              onChange={(e) => {
                setFontSize(Number(e.target.value))
              }}
              className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-card/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-medium text-foreground">界面字体</h3>
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">字体系列</label>
          <select
            value={interfaceFont}
            onChange={(e) => {
              setInterfaceFont(e.target.value)
            }}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-card/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {interfaceFontOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </section>
    </div>
  )
}