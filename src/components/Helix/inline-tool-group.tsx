'use client'

import { ChevronRight, X, Copy, CheckCheck, Image as ImageIcon } from 'lucide-react'
import React, { useState, useMemo } from 'react'
import { formatDurationSeconds } from '@/lib/format'
import { normalizeAcpContent, stripEmoji } from '@/lib/text-utils'
import { getToolIcon, getToolDisplayLabel, extractCommandSnippet, extractToolPath } from '@/lib/tool-display-utils'
import type { ExecutionStep } from '@/stores/helix-store'

const TOOL_RESULT_CLAMP = 20_000

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

type ResultKind = 'diff' | 'image' | 'search' | 'plain'

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

  // 工具输出一律按纯文本处理 —— 不解析 markdown（标题/表格/代码块原样显示）
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
      data-tip="复制"
    >
      {copied ? <CheckCheck className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
    </button>
  )
}

// ── Polymorphic result renderers ────────────────────────────────────────

function DiffRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className="text-[0.85em] font-mono leading-relaxed">
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
      <div className="text-[0.85em] font-mono space-y-0.5">
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
    <div className="text-[0.85em] font-mono space-y-0.5">
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
  if (error) return <span className="text-[0.85em] text-muted-foreground">[图片加载失败]</span>
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

function PlainRenderer({ content }: { content: string }) {
  return (
    <div className="text-[0.85em] text-foreground/50 whitespace-pre-wrap break-all leading-relaxed font-mono">
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
    default: return <PlainRenderer content={content} />
  }
}

// ── Main component ──────────────────────────────────────────────────────
//
// ZCode-style flat layout: each tool call is its own card (icon + status +
// duration + action), expanded on click to reveal params / sub-steps / result.
// No whole-group collapse wrapper — a multi-tool turn reads as a flat stack.

// The tool's concrete action: the command/script for bash, the path for
// file tools, etc. — shown WITHOUT the Chinese action prefix.
function toolActionText(step: ExecutionStep): string {
  const path = extractToolPath(step)
  if (path) return path
  const cmd = extractCommandSnippet(step.toolParams)
  if (cmd) {
    // For bash commands, show only the first line.
    const firstLine = cmd.split('\n')[0]
    return firstLine.length > 50 ? firstLine.slice(0, 50) + '…' : firstLine
  }
  return ''
}

// Action verb shown before the concrete action, derived from the tool type:
// a command shows "执行", a search shows "搜索", a read shows "读取" — NOT a
// generic "执行中" that doesn't describe what the tool does.
function toolVerb(toolName: string): string {
  const name = (toolName || '').toLowerCase()
  if (name.includes('grep') || name.includes('search') || name.includes('glob') || name.includes('find')) return '搜索'
  if (name.includes('read') || name.includes('view') || name.includes('list') || name.includes('directory')) return '读取'
  if (name.includes('write') || name.includes('create') || name.includes('edit') || name.includes('patch')) return '写入'
  if (name.includes('fetch') || name.includes('web')) return '获取网页'
  if (name.includes('memory')) return '读取记忆'
  if (name.includes('git')) return '查看'
  // bash / terminal / run / execute / default
  return '执行'
}

// Pair tool_result / error steps with their preceding tool_call so the result
// renders inside that tool's card. An orphan result (no preceding call) becomes
// a standalone card.
function groupSteps(steps: ExecutionStep[]): Array<{ call: ExecutionStep; results: ExecutionStep[] }> {
  const rows: Array<{ call: ExecutionStep; results: ExecutionStep[] }> = []
  for (const s of steps) {
    if (s.type === 'tool_call') {
      rows.push({ call: s, results: [] })
    } else if (rows.length > 0) {
      rows[rows.length - 1].results.push(s)
    } else {
      rows.push({ call: s, results: [] })
    }
  }
  return rows
}

function ToolCard({
  step,
  results,
  isRunning,
}: {
  step: ExecutionStep
  results: ExecutionStep[]
  isRunning: boolean
}) {
  const [open, setOpen] = useState(false)
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())
  const path = extractToolPath(step)
  const hasSubSteps = step.subSteps && step.subSteps.length > 0
  const stepStatus = step.status || (step.finishedAt ? 'completed' : step.startedAt ? 'running' : undefined)
  const running = stepStatus === 'running' && isRunning
  const failed = stepStatus === 'failed'
  const action = toolActionText(step)
  // 动词随状态变化:运行中"执行/搜索/读取",完成态加"已"前缀("已执行/已搜索/已读取")。
  const verb = toolVerb(step.toolName || '')
  const verbText = stepStatus === 'completed' && !failed ? `已${verb}` : verb

  const toggleResult = (id: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="group">
      {/* Tool title row — click to expand/collapse.
          动作词(执行/搜索/读取) + 具体动作，完成态显示"已执行/已搜索/已读取"。 */}
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center gap-1.5 text-left text-[0.9em] text-foreground/80"
      >
        {failed ? (
          <X className="size-3.5 text-red-500 shrink-0" />
        ) : (
          getToolIcon(step.toolName || '')
        )}
        {stepStatus === 'completed' && !failed && (
          <CheckCheck className="size-3.5 text-emerald-500/80 shrink-0" />
        )}
        <span className={`font-medium truncate ${running ? 'flowing-text' : ''}`}>
          {verbText} {action || getToolDisplayLabel(step.toolName || '', step.toolKind, path, step.toolParams)}
        </span>
        {step.duration_s != null && step.duration_s > 0 && (
          <span className="text-[0.72em] text-muted-foreground shrink-0">{formatDurationSeconds(step.duration_s)}</span>
        )}
        {(() => {
          const count = step.output ? extractResultCount(step.output, step.toolName || '', step.toolParams) : ''
          return count ? <span className="text-[0.72em] text-muted-foreground/50 shrink-0">{count}</span> : null
        })()}
        {(() => {
          const diff = step.output ? extractDiffStats(step.output) : ''
          return diff ? <span className="text-[0.72em] text-emerald-500/60 shrink-0">{diff}</span> : null
        })()}
        <ChevronRight className={`size-3.5 shrink-0 text-foreground/30 transition-all ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="pb-1 pt-1 pl-3 border-l-2 border-border/60 space-y-1.5">
          {/* Streaming output preview — shown while tool is running */}
          {running && step.output && (
            <div className="text-[0.85em] text-foreground/40 font-mono max-h-16 overflow-hidden leading-relaxed whitespace-pre-wrap break-all">
              {stripAnsi(step.output.slice(-200))}
            </div>
          )}
          {/* Sub-agent sub-steps */}
          {hasSubSteps && (
            <div className="space-y-1.5 pl-3">
              {step.subSteps!.map((sub) => {
                const subRunning = sub.status === 'running'
                const subFailed = sub.status === 'failed'
                return (
                  <div key={sub.id} className="flex items-center gap-1.5">
                    {subFailed ? (
                      <X className="size-3 text-red-500 shrink-0" />
                    ) : (
                      getToolIcon(sub.toolName || '')
                    )}
                    <span className="text-[0.85em] text-foreground/50">{getToolDisplayLabel(sub.toolName || '', sub.toolKind, undefined, sub.toolParams)}</span>
                    {subRunning ? (
                      <span className="text-[0.72em] text-primary/70 shrink-0 flowing-text">执行中</span>
                    ) : sub.status === 'completed' ? (
                      <span className="text-[0.72em] text-muted-foreground/50 shrink-0">已执行</span>
                    ) : subFailed ? (
                      <span className="text-[0.72em] text-red-500/80 shrink-0">失败</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
          {/* Parameters — hidden by default */}
          {!hasSubSteps && step.toolParams && Object.keys(step.toolParams).length > 0 && (
            <details className="pl-1 group/params">
              <summary className="text-[0.72em] text-foreground/40 cursor-pointer hover:text-foreground/60 transition-colors">
                参数 ({Object.keys(step.toolParams).length})
              </summary>
              <div className="mt-1.5 space-y-1.5">
                {Object.entries(step.toolParams).map(([k, v]) => (
                  <div key={k} className="flex flex-col">
                    <span className="text-[0.72em] text-foreground/40 font-medium uppercase tracking-wide">{k}</span>
                    <pre className="text-[0.85em] text-foreground/70 bg-muted/20 rounded px-2 py-1.5 overflow-x-auto font-mono whitespace-pre-wrap break-all">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
                  </div>
                ))}
              </div>
            </details>
          )}
          {/* Result(s) — multi-typed render inside this tool's card */}
          {results.map((r) => {
            if (r.type === 'error') {
              return (
                <div key={r.id} className="pl-1 text-[0.85em] text-red-500/80 font-mono whitespace-pre-wrap break-all leading-relaxed">
                  {stripEmoji(normalizeAcpContent(r.content || ''))}
                </div>
              )
            }
            const isExpanded = expandedResults.has(r.id)
            const raw = stripEmoji(normalizeAcpContent(r.content || ''))
            const clamped = raw.length > TOOL_RESULT_CLAMP ? raw.slice(0, TOOL_RESULT_CLAMP) + `\n\n… (${raw.length - TOOL_RESULT_CLAMP} 字符已截断)` : raw
            const isLong = clamped.length > 500 || clamped.split('\n').length > 10
            const fullText = r.content || ''
            const isImage = detectResultKind(r.toolName || '', raw) === 'image'

            return (
              <div key={r.id} className="pl-1">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[0.72em] text-foreground/40">结果</span>
                  <CopyButton text={fullText} />
                </div>
                {isLong && !isExpanded && !isImage ? (
                  <div>
                    <div className="relative overflow-hidden max-h-20 rounded border border-border/20">
                      <ResultRenderer content={clamped} toolName={r.toolName || ''} />
                      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent" />
                    </div>
                    <button
                      onClick={() => toggleResult(r.id)}
                      className="mt-1 text-foreground/40 hover:text-foreground/70 transition-colors text-[0.85em]"
                    >
                      展开 ▼
                    </button>
                  </div>
                ) : (
                  <div className={`rounded border border-border/20 ${isLong ? 'max-h-40 overflow-y-auto' : ''}`}>
                    <div className="p-1.5">
                      <ResultRenderer content={isExpanded ? raw : clamped} toolName={r.toolName || ''} />
                    </div>
                    {isLong && (
                      <button
                        onClick={() => toggleResult(r.id)}
                        className="block w-full text-center py-0.5 text-foreground/40 hover:text-foreground/70 hover:bg-muted/30 transition-colors border-t border-border/20 text-[0.85em]"
                      >
                        折叠 ▲
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function InlineToolGroup({ steps, isRunning, fontSize = 14 }: { steps: ExecutionStep[]; isRunning: boolean; fontSize?: number }) {
  const visible = steps
  if (visible.length === 0) return null

  const rows = groupSteps(visible)

  return (
    <div className="my-2 space-y-1.5" style={{ fontSize }}>
      {rows.map(({ call, results }) => (
        <ToolCard
          key={call.id}
          step={call}
          results={results}
          isRunning={isRunning}
        />
      ))}
    </div>
  )
}
