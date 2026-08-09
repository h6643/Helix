'use client'

import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { loadLanguage } from '@uiw/codemirror-extensions-langs'
import CodeMirror from '@uiw/react-codemirror'
import { FileCode2, X, AlertTriangle } from 'lucide-react'
import React, { useEffect, useMemo, useState } from 'react'
import { electronFS } from '@/lib/electron-bridge'
import { useHelixStore } from '@/stores/helix-store'

// Map a file extension to a CodeMirror language id (the keys accepted by
// `@uiw/codemirror-extensions-langs` loadLanguage).
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'sass',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  m: 'objectivec',
  mm: 'objectivec',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmake: 'cmake',
  ini: 'ini',
  conf: 'nginx',
  log: 'log',
  txt: 'text',
  gitignore: 'text',
  env: 'shell',
}

function langFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower === 'makefile') return lower
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return EXT_LANG[ext] || 'text'
}

export function CodeEditorPanel({ onClose }: { onClose: () => void }) {
  const editorTabs = useHelixStore((s) => s.editorTabs)
  const activeId = useHelixStore((s) => s.activeEditorTabId)
  const editorTheme = useHelixStore((s) => s.editorTheme)
  const setActiveEditorTab = useHelixStore((s) => s.setActiveEditorTab)
  const closeEditorTab = useHelixStore((s) => s.closeEditorTab)
  const updateEditorTabContent = useHelixStore((s) => s.updateEditorTabContent)
  const markEditorTabSaved = useHelixStore((s) => s.markEditorTabSaved)
  const showToast = useHelixStore((s) => s.showToast)

  const active = editorTabs.find((t) => t.id === activeId) || null

  // Editor tab waiting for an unsaved-changes confirmation before it closes.
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const pendingClose = editorTabs.find((t) => t.id === pendingCloseId) || null

  const handleSave = async (id: string): Promise<boolean> => {
    const tab = useHelixStore.getState().editorTabs.find((t) => t.id === id)
    if (!tab) return false
    try {
      await electronFS.writeFile(tab.path, tab.content)
      markEditorTabSaved(id)
      showToast({ type: 'success', title: '已保存', description: tab.name })
      return true
    } catch (e: any) {
      showToast({ type: 'error', title: '保存失败', description: e?.message || '写入文件出错' })
      return false
    }
  }

  // Closing a tab: clean tabs close immediately; dirty tabs prompt first.
  const requestCloseTab = (id: string) => {
    const tab = useHelixStore.getState().editorTabs.find((t) => t.id === id)
    if (!tab || !tab.dirty) {
      closeEditorTab(id)
      return
    }
    setPendingCloseId(id)
  }

  const confirmSaveAndClose = async () => {
    if (!pendingCloseId) return
    const id = pendingCloseId
    const ok = await handleSave(id)
    if (ok) closeEditorTab(id)
    setPendingCloseId(null)
  }

  const confirmDiscardClose = () => {
    if (!pendingCloseId) return
    closeEditorTab(pendingCloseId)
    setPendingCloseId(null)
  }

  // Ctrl/Cmd+S → save active tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (active && active.dirty) {
          e.preventDefault()
          handleSave(active.id)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const langExt = useMemo(() => {
    const highlight = syntaxHighlighting(defaultHighlightStyle, { fallback: true })
    if (!active) return [highlight]
    const ext = loadLanguage(langFromName(active.name) as Parameters<typeof loadLanguage>[0])
    return ext ? [highlight, ext] : [highlight]
  }, [active])

  const themeMode = editorTheme === 'vs-dark' ? 'dark' : 'light'

  if (!active) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/50 gap-2 bg-card">
        <FileCode2 className="size-10" />
        <p className="text-sm">从左侧文件树点击文件即可在此编辑</p>
        <button
          onClick={onClose}
          className="mt-2 px-3 py-1.5 text-xs rounded-lg border border-border/60 hover:bg-accent/50 transition-colors"
        >
          关闭编辑器
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-card">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-1.5 h-9 shrink-0 border-b border-border/40 bg-card overflow-x-auto">
        {editorTabs.map((tab) => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-t-md cursor-pointer text-[12px] max-w-[220px] border-b-2 ${
              tab.id === activeId
                ? 'bg-card border-primary text-foreground'
                : 'text-foreground/60 border-transparent hover:bg-accent/40'
            }`}
            onClick={() => setActiveEditorTab(tab.id)}
            title={tab.path}
          >
            <span className="truncate">{tab.name}</span>
            {tab.dirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" title="未保存" />
            )}
            <button
              className="opacity-40 hover:opacity-100 hover:text-destructive transition-opacity ml-0.5"
              onClick={(e) => {
                e.stopPropagation()
                requestCloseTab(tab.id)
              }}
              title={tab.dirty ? '关闭（未保存）' : '关闭'}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <div className="flex-1" />
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <CodeMirror
          value={active.content}
          height="100%"
          theme={themeMode}
          extensions={langExt}
          onChange={(val) => updateEditorTabContent(active.id, val)}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            autocompletion: true,
            bracketMatching: true,
            indentOnInput: true,
          }}
          style={{
            height: '100%',
            fontSize: 'var(--helix-font-size, 13px)',
            fontFamily: 'var(--helix-font-family, monospace)',
          }}
        />
      </div>

      {pendingClose && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40">
          <div className="bg-card border border-border/80 rounded-lg shadow-xl w-[380px] p-5 flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">未保存的修改</h3>
                <p className="text-xs text-muted-foreground mt-1 break-words">
                  <span className="font-mono text-foreground/80">{pendingClose.name}</span> 有未保存的修改，关闭前要保存吗？
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingCloseId(null)}
                className="px-3 py-1.5 text-xs rounded-md text-muted-foreground/80 hover:bg-accent/60 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmDiscardClose}
                className="px-3 py-1.5 text-xs rounded-md text-destructive border border-destructive/40 hover:bg-destructive/10 transition-colors"
              >
                不保存
              </button>
              <button
                onClick={confirmSaveAndClose}
                className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-colors"
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
