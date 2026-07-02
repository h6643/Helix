'use client'

import React, { useCallback, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useHelixStore } from '@/stores/helix-store'
import { FileCode, Search, Terminal, MessageSquare, Keyboard } from 'lucide-react'

const SHORTCUTS = [
  { keys: 'Ctrl+K', label: '命令面板' },
  { keys: 'Ctrl+P', label: '快速打开文件' },
  { keys: 'Ctrl+S', label: '保存文件' },
  { keys: 'Ctrl+W', label: '关闭标签页' },
  { keys: 'Tab', label: '切换模式' },
]

export function CodeEditor() {
  const { activeTabId, openTabs, updateFileContent, getFileById, setCursorPosition, editorTheme } =
    useHelixStore()
  const editorRef = useRef<any>(null)

  const activeTab = openTabs.find((t) => t.id === activeTabId)
  const activeFile = activeTab ? getFileById(activeTab.fileId) : null

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor
    editor.focus()

    editor.onDidChangeCursorPosition((e) => {
      setCursorPosition({
        line: e.position.lineNumber,
        column: e.position.column,
      })
    })
  }, [setCursorPosition])

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeTab && value !== undefined) {
        updateFileContent(activeTab.fileId, value)
      }
    },
    [activeTab, updateFileContent]
  )

  if (!activeTab || !activeFile) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-6 bg-background text-muted-foreground font-mono">
        <div className="relative">
          <FileCode className="size-16 opacity-10" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
              <FileCode className="size-4 text-primary/60" />
            </div>
          </div>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-foreground/60">选择文件进行编辑</p>
          <p className="text-xs mt-1 text-muted-foreground/50">从侧边栏选择或使用快捷键</p>
        </div>
        <div className="grid grid-cols-1 gap-y-1.5 text-[11px] text-muted-foreground/40">
          {SHORTCUTS.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <kbd className="px-2 py-0.5 bg-muted/50 rounded text-[10px] font-mono min-w-[72px] text-center border border-border/50">
                {s.keys}
              </kbd>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden bg-background">
      <Editor
        key={activeTab.fileId}
        height="100%"
        language={activeFile.language || 'plaintext'}
        value={activeFile.content || ''}
        onChange={handleChange}
        onMount={handleEditorMount}
        theme={editorTheme}
        options={{
          fontSize: 13,
          fontFamily: "'Geist Mono', 'Fira Code', 'Consolas', monospace",
          fontLigatures: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'all',
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: true },
          autoClosingBrackets: 'always',
          autoClosingQuotes: 'always',
          formatOnPaste: true,
          formatOnType: true,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'on',
          lineNumbers: 'on',
          glyphMargin: false,
          folding: true,
          links: true,
          padding: { top: 12, bottom: 12 },
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
        }}
        loading={
          <div className="flex items-center justify-center h-full bg-background text-muted-foreground text-xs font-mono">
            加载中...
          </div>
        }
      />
    </div>
  )
}
