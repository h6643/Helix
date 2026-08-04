'use client'

import { ChevronRight, X, Copy, CheckCheck, Image as ImageIcon } from 'lucide-react'
import React, { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { formatDurationSeconds } from '@/lib/format'
import { normalizeAcpContent, stripEmoji, safeMarkdownSource } from '@/lib/text-utils'
import { getToolLabel, getToolIcon, getToolDisplayLabel, extractToolPath } from '@/lib/tool-display-utils'
import type { ExecutionStep } from '@/stores/helix-store'

const TOOL_RESULT_CLAMP = 20_000
const AUTO_SCROLL_THRESHOLD = 3

// ── ANSI escape code stripper ───────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// ── Result count extraction ──────────────────────────────────────────────

function extractResultCount(content: string, toolName: string, params?: Record<string, unknown>): string {
  const name = (toolName || '').toLowerCase()
  // Check params for explicit count fields
  if (params) {
    for (const key of ['count', 'result_count', 'match_count', 'file_count', 'total']) {
      const v = params[key]
      if (typeof v === 'number' && v > 0) return `${v}`
    }
  }
  // Scan content for "Found X results", "X matches", "X files", etc.
  const countMatch = content.match(/(?:Found|found|Total|total)\s+(\d+)\s+(results?|matches?|files?|entries?|items?|occurrences?)/i)
  if (countMatch) return countMatch[1]
  // Match array-like patterns
  const lines = content.trim().split('\n').filter(l => l.trim())
  if (lines.length > 3 && /^\d+\s*[│|]/.test(lines[1] || '')) return `${lines.length}`
  return ''
}

// ── Diff stats extraction ────────────────────────────────────────────────

function extractDiffStats(content: string): string {
  let added = 0, removed = 0
  for (const line of content.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  if (added === 0 && removed === 0) return ''
  const parts: string[] = []
  if (added) parts.push(`+${added}`)
  if (removed) parts.push(`−${removed}`)
  return parts.join(' ')
}

// ── Content type detection ──────────────────────────────────────────────

type ResultKind = 'diff' | 'image' | 'search' | 'markdown' | 'plain'

function detectResultKind(toolName: string, content: string): ResultKind {
  const name = (toolName || '').toLowerCase()

  // Diff detection
  if (name.includes('diff') || name.includes('patch') || name.includes('git_diff')) return 'diff'
  if (/^(---|\+\+\+|@@|diff --git)/.test(content.trim())) return 'diff'
  if (/^\x1b\[.*?(added|removed|modified)/.test(content)) return 'diff'

  // Image detection
  if (/^data:image\//.test(content.trim())) return 'image'
  if (/!\[.*?\]\(data:image\//.test(content)) return 'image'

  // Search results (grep/glob/read_directory output with file:line patterns)
  if (name.includes('grep') || name.includes('search') || name.includes('list_directory')) return 'search'
  if (/^\s*\d+\s*[│|]/.test(content) || /^[\w/.]+\.\w+:\d+/.test(content)) return 'search'

  // Markdown detection (has markdown syntax)
  if (/^#{1,6}\s|```|^\*|^-\s|\[.*?\]\(|^\|.*\|/m.test(content)) return 'markdown'

  return 'plain'
}

// ── Copy button ─────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* noop */ }
  }
  return (
    <button
      onClick={handleCopy}
      className="p-0.5 rounded text-foreground/30 hover:text-foreground/60 hover:bg-muted/50 transition-colors"
      title="复制"
    >
      {copied ? <CheckCheck className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
    </button>
  )
}

// ── Polymorphic result renderers ────────────────────────────────────────

function DiffRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className="text-[11px] font-mono leading-relaxed">
      {lines.map((line, i) => {
        let className = 'text-foreground/50'
        if (line.startsWith('+') && !line.startsWith('+++')) className = 'text-emerald-500/80 bg-emerald-500/5'
        else if (line.startsWith('-') && !line.startsWith('---')) className = 'text-red-500/80 bg-red-500/5'
        else if (line.startsWith('@@')) className = 'text-sky-500/80'
        else if (line.startsWith('diff ') || line.startsWith('index ')) className = 'text-muted-foreground font-semibold'
        else if (line.startsWith('---') || line.startsWith('+++')) className = 'text-amber-500/80'
        return (
          <div key={i} className={`${className} px-1 -mx-1`}>
            {line || '\u00A0'}
          </div>
        )
      })}
    </div>
  )
}

function SearchRenderer({ content, toolName }: { content: string; toolName: string }) {
  const name = (toolName || '').toLowerCase()
  const lines = content.split('\n').filter(l => l.trim())

  // Try to parse file:line format
  const hasFileLine = lines.some(l => /^[\w/.]+\.\w+:\d+/.test(l.trim()))
  if (hasFileLine || name.includes('grep') || name.includes('search')) {
    return (
      <div className="text-[11px] font-mono space-y-0.5">
        {lines.map((line, i) => {
          const match = line.match(/^([\w/.]+\.\w+):(\d+):?(.*)$/)
          if (match) {
            const [, file, ln, rest] = match
            return (
              <div key={i} className="flex gap-1">
                <span className="text-sky-500/80 shrink-0">{file}:{ln}</span>
                {rest && <span className="text-foreground/50 truncate">{rest}</span>}
              </div>
            )
          }
          return <div key={i} className="text-foreground/50">{line}</div>
        })}
      </div>
    )
  }

  // Fallback: numbered lines
  return (
    <div className="text-[11px] font-mono space-y-0.5">
      {lines.map((line, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-muted-foreground/60 shrink-0 w-5 text-right">{i + 1}</span>
          <span className="text-foreground/50">{stripAnsi(line)}</span>
        </div>
      ))}
    </div>
  )
}

function ImageRenderer({ content }: { content: string }) {
  const [error, setError] = useState(false)
  if (error) return <span className="text-[11px] text-muted-foreground">[图片加载失败]</span>
  return (
    <div className="relative group/img">
      <img
        src={content.startsWith('data:') ? content : `data:image/png;base64,${content}`}
        alt="工具输出图片"
        className="max-w-xs max-h-48 rounded-md border border-border/30"
        onError={() => setError(true)}
      />
    </div>
  )
}

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="text-[11px] prose prose-xs dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-pre:bg-transparent prose-pre:p-0">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
        {safeMarkdownSource(content)}
      </ReactMarkdown>
    </div>
  )
}

function PlainRenderer({ content }: { content: string }) {
  return (
    <div className="text-[11px] text-foreground/50 whitespace-pre-wrap break-all leading-relaxed font-mono">
      {stripAnsi(content)}
    </div>
  )
}

function ResultRenderer({ content, toolName }: { content: string; toolName: string }) {
  const kind = useMemo(() => detectResultKind(toolName, content), [toolName, content])
  switch (kind) {
    case 'diff': return <DiffRenderer content={content} />
    case 'image': return <ImageRenderer content={content} />
    case 'search': return <SearchRenderer content={content} toolName={toolName} />
    case 'markdown': return <MarkdownRenderer content={content} />
    default: return <PlainRenderer content={content} />
  }
}

// ── Main component ──────────────────────────────────────────────────────

export function InlineToolGroup({ steps, isRunning }: { steps: ExecutionStep[]; isRunning: boolean }) {
  const [open, setOpen] = useState(false)
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const visible = steps.filter(s => !dismissed.has(s.id))
  const calls = visible.filter(s => s.type === 'tool_call')
  const hasError = visible.some(s => s.type === 'error')

  const toggleResult = (id: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  let title = ''
  if (calls.length === 0) {
    title = '工具结果'
  } else if (calls.length === 1) {
    title = calls[0].content || getToolDisplayLabel(calls[0].toolName || '', calls[0].toolKind, undefined, calls[0].toolParams)
  } else {
    const names = Array.from(new Set(calls.map(s => getToolLabel(s.toolName || ''))))
    if (names.length === 1) {
      title = `${names[0]} × ${calls.length}`
    } else {
      title = `执行了 ${calls.length} 个工具`
    }
  }

  const running = isRunning && !visible.some(s => s.type === 'tool_result' || s.type === 'error')
  const useAutoScroll = steps.length >= AUTO_SCROLL_THRESHOLD

  useEffect(() => {
    if (open && useAutoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [open, useAutoScroll, steps.length])

  if (visible.length === 0) return null

  return (
    <div className="my-2 overflow-hidden group">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-foreground/70 hover:bg-muted/50 transition-colors text-left"
      >
        {hasError ? (
          <X className="size-3.5 text-red-500 shrink-0" />
        ) : null}
        <span className={`font-medium ${running ? 'flowing-text' : ''}`}>{title}</span>
        {hasError && <span className="text-red-500/80 text-[11px]">失败</span>}
        <ChevronRight className={`size-3.5 shrink-0 ml-auto text-foreground/30 transition-all ${open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
      </button>
      {open && (
        <div
          ref={scrollRef}
          className={`px-3 pb-3 pt-1 border-t border-border/30 space-y-2 ${useAutoScroll ? 'max-h-80 overflow-y-auto' : ''}`}
          style={useAutoScroll ? { maskImage: 'linear-gradient(to bottom, transparent 0%, black 4%, black 96%, transparent 100%)' } : undefined}
        >
          {useAutoScroll && <div className="sticky top-0 h-1 bg-gradient-to-b from-card/80 to-transparent pointer-events-none -mt-1" />}
          {steps.map((step) => {
            if (step.type === 'tool_call') {
              const path = extractToolPath(step)
              const hasSubSteps = step.subSteps && step.subSteps.length > 0
              const stepStatus = step.status || (step.finishedAt ? 'completed' : step.startedAt ? 'running' : undefined)
              return (
                <div key={step.id} className="group/step text-[11px] text-foreground/60 font-mono">
                  <div className="flex items-center gap-1.5">
                    {stepStatus === 'failed' ? (
                      <X className="size-3 text-red-500 shrink-0" />
                    ) : stepStatus === 'running' ? null : (
                      getToolIcon(step.toolName || '')
                    )}
                    <span className={`font-medium ${stepStatus === 'running' ? 'flowing-text' : ''}`}>{getToolDisplayLabel(step.toolName || '', step.toolKind, path, step.toolParams)}</span>
                    {stepStatus === 'failed' && <span className="text-red-500/80 text-[10px]">✗</span>}
                    {step.duration_s != null && step.duration_s > 0 && (
                      <span className="text-[10px] text-muted-foreground ml-1">{formatDurationSeconds(step.duration_s)}</span>
                    )}
                    {(() => {
                      const count = step.output ? extractResultCount(step.output, step.toolName || '', step.toolParams) : ''
                      return count ? <span className="text-[10px] text-muted-foreground/50 ml-1">{count}</span> : null
                    })()}
                    {(() => {
                      const diff = step.output ? extractDiffStats(step.output) : ''
                      return diff ? <span className="text-[10px] text-emerald-500/60 ml-1">{diff}</span> : null
                    })()}
                    {(stepStatus === 'completed' || stepStatus === 'failed') && (
                      <button
                        onClick={() => setDismissed(prev => new Set(prev).add(step.id))}
                        className="ml-auto opacity-0 group-hover/step:opacity-100 transition-opacity p-0.5 rounded text-foreground/20 hover:text-foreground/60"
                      >
                        <X className="size-2.5" />
                      </button>
                    )}
                  </div>
                  {/* Streaming output preview — shown while tool is running */}
                  {stepStatus === 'running' && step.output && (
                    <div className="mt-1 pl-5 text-[11px] text-foreground/40 font-mono max-h-16 overflow-hidden leading-relaxed">
                      {stripAnsi(step.output.slice(-200))}
                    </div>
                  )}
                  {hasSubSteps && (
                    <div className="mt-1.5 pl-4 border-l border-border/30 space-y-1.5">
                      {step.subSteps!.map((sub) => (
                        <div key={sub.id} className="flex items-center gap-1.5">
                          {getToolIcon(sub.toolName || '')}
                          <span className="text-foreground/50">{getToolDisplayLabel(sub.toolName || '', sub.toolKind, undefined, sub.toolParams)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Parameters — hidden by default */}
                  {!hasSubSteps && step.toolParams && Object.keys(step.toolParams).length > 0 && (
                    <details className="mt-1.5 pl-5 group/params">
                      <summary className="text-[10px] text-foreground/40 cursor-pointer hover:text-foreground/60 transition-colors">
                        参数 ({Object.keys(step.toolParams).length})
                      </summary>
                      <div className="mt-1 space-y-1.5">
                        {Object.entries(step.toolParams).map(([k, v]) => (
                          <div key={k} className="flex flex-col">
                            <span className="text-[10px] text-foreground/40 font-medium uppercase tracking-wide">{k}</span>
                            <pre className="text-[11px] text-foreground/70 bg-card/50 rounded px-2 py-1.5 overflow-x-auto font-mono border border-border/50 whitespace-pre-wrap break-all">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )
            }
            if (step.type === 'tool_result') {
              const isExpanded = expandedResults.has(step.id)
              const raw = stripEmoji(normalizeAcpContent(step.content || ''))
              const clamped = raw.length > TOOL_RESULT_CLAMP ? raw.slice(0, TOOL_RESULT_CLAMP) + `\n\n… (${raw.length - TOOL_RESULT_CLAMP} 字符已截断)` : raw
              const isLong = clamped.length > 500 || clamped.split('\n').length > 10
              const fullText = step.content || ''
              // Detect image for compact view
              const isImage = detectResultKind(step.toolName || '', raw) === 'image'

              return (
                <div key={step.id} className="pl-5 text-[11px] font-mono">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[10px] text-foreground/40">结果</span>
                    <CopyButton text={fullText} />
                  </div>
                  {isLong && !isExpanded && !isImage ? (
                    <div>
                      <div className="relative overflow-hidden max-h-20 rounded border border-border/20">
                        <ResultRenderer content={clamped} toolName={step.toolName || ''} />
                        <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent" />
                      </div>
                      <button
                        onClick={() => toggleResult(step.id)}
                        className="mt-1 text-foreground/40 hover:text-foreground/70 transition-colors"
                      >
                        展开 ▼
                      </button>
                    </div>
                  ) : (
                    <div className={`rounded border border-border/20 ${isLong ? 'max-h-40 overflow-y-auto' : ''}`}>
                      <div className="p-1.5">
                        <ResultRenderer content={isExpanded ? raw : clamped} toolName={step.toolName || ''} />
                      </div>
                      {isLong && (
                        <button
                          onClick={() => toggleResult(step.id)}
                          className="block w-full text-center py-0.5 text-foreground/40 hover:text-foreground/70 hover:bg-muted/30 transition-colors border-t border-border/20"
                        >
                          折叠 ▲
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            }
            if (step.type === 'error') {
              return (
                <div key={step.id} className="pl-5 text-[11px] text-red-500/80 font-mono whitespace-pre-wrap break-all leading-relaxed">
                  {stripEmoji(normalizeAcpContent(step.content || ''))}
                </div>
              )
            }
            return null
          })}
          {useAutoScroll && <div className="sticky bottom-0 h-1 bg-gradient-to-t from-card/80 to-transparent pointer-events-none" />}
        </div>
      )}
    </div>
  )
}
