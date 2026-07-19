"use client"

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Terminal, X } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { isElectron, electronTerminal } from '@/lib/electron-bridge'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  onClose: () => void
}

// Light theme matching the app chrome (white bg / dark text, standard ANSI).
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  selectionBackground: '#cfe3ff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#8a8a8a',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#9a9a9a',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
}

// Transparent theme — blends with the app background
const TRANSPARENT_THEME = {
  background: 'rgba(255,255,255,0.7)',
  foreground: '#333333',
  cursor: '#333333',
  cursorAccent: 'rgba(255,255,255,0.7)',
  selectionBackground: 'rgba(147,197,253,0.4)',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#8a8a8a',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#9a9a9a',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
}

export function TerminalPanel({ onClose }: TerminalPanelProps) {
  const { selectedWorkDir, terminalRawBuffer, setTerminalRawBuffer, isTerminalOpen } = useHelixStore()
  const [electronReady, setElectronReady] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const bufferRef = useRef(terminalRawBuffer || '')
  const lastCwdRef = useRef<string | null>(null)

  // Create the xterm instance + PTY exactly once. The component is mounted
  // permanently by the layout (never unmounted on conversation switch), so
  // the terminal keeps its full scrollback and live shell across sessions.
  useEffect(() => {
    if (!isElectron()) {
      setElectronReady(false)
      return
    }
    setElectronReady(true)

    const term = new XTerm({
      fontFamily: 'Consolas, "Cascadia Code", "Microsoft YaHei Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TRANSPARENT_THEME,
      scrollback: 5000,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current!)
    termRef.current = term
    fitRef.current = fitAddon

    const fitAndResize = () => {
      try {
        fitAddon.fit()
        electronTerminal.resize(term.cols, term.rows)
      } catch {
        /* element not laid out yet */
      }
    }

    // Restore previous session output if we switched away and came back.
    if (bufferRef.current) {
      try { term.write(bufferRef.current) } catch { /* ignore */ }
    }

    // Start the PTY with the current dimensions + the project path as cwd.
    // Never use a bare drive root as cwd; fall back to the main process workDir.
    const isDriveRoot = typeof selectedWorkDir === 'string' && /^[a-zA-Z]:[\\/]?$/.test(selectedWorkDir)
    const cwd = selectedWorkDir && !isDriveRoot ? selectedWorkDir : undefined
    lastCwdRef.current = cwd || null
    electronTerminal.start(term.cols, term.rows, cwd).catch(() => {})

    const unsub = electronTerminal.onData((data) => {
      term.write(data)
      bufferRef.current += data
      setTerminalRawBuffer(bufferRef.current)
    })

    // Forward raw keystrokes from xterm to the PTY (native line editing).
    term.onData((d) => {
      electronTerminal.write(d)
    })

    // ── Copy / paste ────────────────────────────────────────────────────
    // Copy the current selection to the system clipboard whenever it changes.
    const onSelectionChange = () => {
      const sel = term.getSelection()
      if (sel) {
        try {
          navigator.clipboard.writeText(sel).catch(() => {})
        } catch { /* clipboard unavailable */ }
      }
    }
    term.onSelectionChange(onSelectionChange)

    // Ctrl+C inside the terminal: if there is a selection, copy it (don't
    // forward the keystroke to the shell); otherwise let it through as
    // SIGINT. Ctrl+V: paste from the system clipboard.
    term.attachCustomKeyEventHandler((ev) => {
      if (!ev.ctrlKey || ev.altKey || ev.metaKey) return true
      if (ev.key === 'c' && !ev.shiftKey) {
        const sel = term.getSelection()
        if (sel) {
          try { navigator.clipboard.writeText(sel) } catch { /* ignore */ }
          return false // consume: copy, do not send SIGINT
        }
        return true // no selection → let Ctrl+C be SIGINT
      }
      if (ev.key === 'v' && !ev.shiftKey) {
        try {
          navigator.clipboard.readText().then((text) => {
            if (text) electronTerminal.write(text)
          }).catch(() => {})
        } catch { /* ignore */ }
        return false // consume: we handle paste ourselves
      }
      return true
    })

    // Keep the PTY size in sync with the container.
    const ro = new ResizeObserver(() => fitAndResize())
    ro.observe(containerRef.current!)
    const raf = requestAnimationFrame(fitAndResize)
    if (isTerminalOpen) requestAnimationFrame(fitAndResize)

    // Only dispose when the whole app unmounts (component is never unmounted
    // on conversation switch, so the terminal survives session changes).
    return () => {
      unsub()
      ro.disconnect()
      cancelAnimationFrame(raf)
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fit whenever the panel becomes visible again (hidden uses
  // display:none, which collapses the container to 0 size).
  useEffect(() => {
    if (isTerminalOpen && termRef.current && fitRef.current) {
      const raf = requestAnimationFrame(() => {
        try {
          fitRef.current!.fit()
          electronTerminal.resize(termRef.current!.cols, termRef.current!.rows)
        } catch {
          /* not laid out yet */
        }
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [isTerminalOpen])

  // When the project directory changes, tell the running shell to cd there.
  // This keeps the terminal in sync with the conversation/project context.
  useEffect(() => {
    if (!isTerminalOpen || !selectedWorkDir) return
    const isDriveRoot = /^[a-zA-Z]:[\\/]?$/.test(selectedWorkDir)
    if (isDriveRoot) return
    if (lastCwdRef.current === selectedWorkDir) return
    // Escape embedded quotes and issue a cd command. On Windows, `cd` does
    // NOT switch drive letters, so send the bare drive letter first — otherwise
    // the terminal label shows the new project while pwd stays on the old drive.
    const safeDir = selectedWorkDir.replace(/"/g, '\\"')
    const driveMatch = selectedWorkDir.match(/^([a-zA-Z]):[\\/]/)
    if (driveMatch) {
      electronTerminal.write(`${driveMatch[1]}:\r\n`)
    }
    electronTerminal.write(`cd "${safeDir}"\r\n`)
    lastCwdRef.current = selectedWorkDir
  }, [selectedWorkDir, isTerminalOpen])

  const handleCloseAndClear = useCallback(() => {
    try { termRef.current?.reset() } catch { /* ignore */ }
    bufferRef.current = ''
    setTerminalRawBuffer('')
    onClose()
  }, [onClose, setTerminalRawBuffer])

  return (
    <div className={`shrink-0 h-64 flex flex-col bg-transparent rounded-t-lg overflow-hidden border-t border-border/40 ${isTerminalOpen ? '' : 'hidden'}`}>
      {/* Tab bar — Windows Terminal style */}
      <div className="flex items-center h-8 bg-black/5 backdrop-blur-sm shrink-0 select-none">
        <div className="flex items-center h-full">
          <div className="flex items-center gap-2 h-full px-3 bg-white/60 border-t-2 border-primary text-foreground text-[12px]">
            <Terminal className="size-3.5" />
            <span className="max-w-[180px] truncate">
              {selectedWorkDir ? selectedWorkDir.split(/[\\/]/).pop() || 'PowerShell' : 'PowerShell'}
            </span>
          </div>
        </div>
        <div className="flex-1" />
        <button
          onClick={handleCloseAndClear}
          className="px-2.5 h-full flex items-center text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
          title="关闭并清空终端"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* xterm.js terminal */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-transparent backdrop-blur-sm px-1 py-1"
        onClick={() => termRef.current?.focus()}
      />

      {!electronReady && (
        <div className="px-3 py-2 text-[12px] text-[#999]">Terminal not available in browser mode</div>
      )}
    </div>
  )
}
