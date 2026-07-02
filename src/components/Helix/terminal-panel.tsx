'use client'

import React, { useRef, useEffect, useState, useCallback } from 'react'
import { Terminal, X, Maximize2, Minus } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

export function TerminalPanel() {
  const {
    terminalOutput,
    addTerminalOutput,
    clearTerminal,
    isTerminalOpen,
    toggleTerminal,
    pushTerminalHistory,
    navigateTerminalHistory,
  } = useHelixStore()
  const [input, setInput] = useState('')
  const [tempHistoryInput, setTempHistoryInput] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]')
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
      }
    }
  }, [terminalOutput])

  const handleCommand = useCallback(
    (cmd: string) => {
      addTerminalOutput(`$ ${cmd}`)

      const trimmed = cmd.trim().toLowerCase()
      if (!trimmed) return

      pushTerminalHistory(cmd)

      if (trimmed === 'clear') {
        clearTerminal()
        return
      }

      if (trimmed === 'help') {
        addTerminalOutput(
          `Available commands:\n` +
          `  help         Show help\n` +
          `  clear        Clear terminal\n` +
          `  ls           List files\n` +
          `  tree         Show file tree\n` +
          `  pwd          Current path\n` +
          `  cat <file>   View file\n` +
          `  touch <file> Create file\n` +
          `  rm <file>    Delete file`
        )
        return
      }

      if (trimmed === 'ls' || trimmed === 'ls -la') {
        const state = useHelixStore.getState()
        const listFiles = (nodes: typeof state.files, prefix = '', isLast = true) => {
          nodes.forEach((n, i) => {
            const isNodeLast = i === nodes.length - 1
            const connector = prefix ? (isLast ? '└── ' : '├── ') : ''
            const icon = n.type === 'folder' ? '📁' : '📄'
            addTerminalOutput(`${connector}${icon} ${n.name}`)
            if (n.children) {
              const childPrefix = prefix + (isLast ? '    ' : '│   ')
              listFiles(n.children, childPrefix, isNodeLast)
            }
          })
        }
        listFiles(state.files)
        return
      }

      if (trimmed === 'tree') {
        const state = useHelixStore.getState()
        addTerminalOutput('.')
        const showTree = (nodes: typeof state.files, prefix = '', isLast = true) => {
          nodes.forEach((n, i) => {
            const isNodeLast = i === nodes.length - 1
            const connector = prefix ? (isLast ? '└── ' : '├── ') : ''
            addTerminalOutput(`${connector}${n.name}`)
            if (n.children) {
              showTree(n.children, prefix + (isLast ? '    ' : '│   '), isNodeLast)
            }
          })
        }
        showTree(state.files)
        return
      }

      if (trimmed === 'pwd') {
        addTerminalOutput('/home/user/project')
        return
      }

      if (trimmed.startsWith('echo ')) {
        addTerminalOutput(cmd.trim().slice(5))
        return
      }

      if (trimmed.startsWith('cat ')) {
        const filename = cmd.trim().slice(4).trim()
        const state = useHelixStore.getState()
        const allFiles = state.getAllFiles()
        const file = allFiles.find(f => f.name === filename || f.name.endsWith('/' + filename))
        if (file?.content) {
          const lines = file.content.split('\n')
          lines.forEach((line, i) => {
            addTerminalOutput(`${String(i + 1).padStart(3)} │ ${line}`)
          })
          addTerminalOutput(`\n${lines.length} lines`)
        } else {
          addTerminalOutput(`File not found: ${filename}`)
        }
        return
      }

      if (trimmed.startsWith('touch ')) {
        const filename = cmd.trim().slice(6).trim()
        if (filename) {
          useHelixStore.getState().createFile(null, filename, 'file')
          addTerminalOutput(`✓ Created: ${filename}`)
        }
        return
      }

      if (trimmed.startsWith('rm ')) {
        const filename = cmd.trim().slice(3).trim()
        const state = useHelixStore.getState()
        const allFiles = state.getAllFiles()
        const file = allFiles.find(f => f.name === filename || f.name.endsWith('/' + filename))
        if (file) {
          state.deleteFile(file.id)
          addTerminalOutput(`✓ Deleted: ${filename}`)
        } else {
          addTerminalOutput(`File not found: ${filename}`)
        }
        return
      }

      addTerminalOutput(`Command not found: ${trimmed}`)
      addTerminalOutput('Type help for available commands')
    },
    [addTerminalOutput, clearTerminal, pushTerminalHistory]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleCommand(input)
        setInput('')
        setTempHistoryInput('')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!tempHistoryInput) setTempHistoryInput(input)
        const prev = navigateTerminalHistory('up')
        setInput(prev)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = navigateTerminalHistory('down')
        if (!next && tempHistoryInput) {
          setInput(tempHistoryInput)
          setTempHistoryInput('')
        } else {
          setInput(next)
        }
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault()
        clearTerminal()
      }
    },
    [input, handleCommand, navigateTerminalHistory, tempHistoryInput, clearTerminal]
  )

  if (!isTerminalOpen) return null

  const terminalHeight = isMaximized ? '100%' : '160px'

  return (
    <div className="flex flex-col bg-[#0d1117] border-t border-border shrink-0 font-mono" style={{ height: terminalHeight }}>
      <div className="flex items-center justify-between px-3 py-1 bg-[#161b22] border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <Terminal className="size-3" />
            <span>terminal</span>
            <span className="text-[10px] text-gray-500">zsh</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-gray-400 hover:text-gray-200"
            onClick={() => setIsMaximized(!isMaximized)}
          >
            {isMaximized ? <Minus className="size-3" /> : <Maximize2 className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-gray-400 hover:text-gray-200"
            onClick={toggleTerminal}
          >
            <X className="size-3" />
          </Button>
        </div>
      </div>

      <ScrollArea ref={scrollRef} className="flex-1">
        <div className="px-3 py-2 text-xs leading-5">
          {terminalOutput.map((line, i) => (
            <div key={i} className="text-gray-300 whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
          <div className="flex items-center">
            <span className="text-primary mr-1 shrink-0">$</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-gray-300 font-mono text-xs"
              autoFocus
              spellCheck={false}
              placeholder=""
            />
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
