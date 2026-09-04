'use client'

import { ChevronRight, X, Copy, CheckCheck, Image as ImageIcon } from 'lucide-react'
import React, { useState } from 'react'
import { formatDurationSeconds } from '@/lib/format'
import { normalizeAcpContent, stripEmoji } from '@/lib/text-utils'
import { getToolIcon, getToolDisplayLabel, extractCommandSnippet, extractToolPath } from '@/lib/tool-display-utils'
import type { ExecutionStep } from '@/stores/helix-store'
import { CodeCard } from '@/components/Helix/helix-markdown'

const TOOL_RESULT_CLAMP = 20_000

// ── ANSI escape code stripper ───────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Hermes 的 mktemp 包装（cache/terminal/hermes-snap-*.sh.tmp.XXXX）若
// cache/terminal 目录缺失就会刷一行 mktemp: failed to create...。这是环境噪音
// 不是工具执行失败，从渲染内容里整行剥掉。
function stripMktempNoise(s: string): string {
  return s
    .split('\n')
    .filter(line => !/^\s*mktemp:\s+failed to create file via template/i.test(line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
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

// ── Result renderers ────────────────────────────────────────────────────

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
  // 非命令工具（GUI/浏览器/MCP 等）的参数经常把正文/代码/错误说明塞在 text/input
  // 里，直接拿它当标题会显示 "Clear the draft's responseBlocks" 这类内容。非命令
  // 工具只显示工具名，不拿参数当标题。
  const isCommandTool = /bash|terminal|shell|run|execute|command/i.test(step.toolName || '')
  if (!isCommandTool) return ''

  const cmd = extractCommandSnippet(step.toolParams)
  if (cmd) {
    // 非命令工具（GUI/浏览器/MCP 等）的参数可能把错误文案放在 text/input 里，
    // 直接拿它当标题会变成 "指令完成 (gui.lock) prevented..."。明显是错误/拦截
    // 说明时不当作命令标题，回退到工具名。
    const looksLikeError = /^\(|prevented|failed|error|cannot|unable|permission|denied|timeout/i.test(cmd)
    if (looksLikeError) return ''
    // bash/terminal：标题返回命令完整首行（不手动截断 50）——命令卡已不可
    // 展开、标题是唯一查看入口，截断太短会看不到命令本体；视觉过长由外层
    // CSS truncate 省略，完整命令放 title 悬停可见。
    const firstLine = cmd.split('\n')[0]
    return firstLine
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
  const path = extractToolPath(step)
  const hasSubSteps = step.subSteps && step.subSteps.length > 0
  const isCommandTool = /bash|terminal|shell|run|execute|command/i.test(step.toolName || '')
  // 命令类 + 读文件类（read_file/list_directory…）点击不展开（标题/状态/错误外露即可）；
  // 文件修改等其余工具保留展开。
  const canExpand =
    !isCommandTool && !/read|view|list|directory/i.test(step.toolName || '')
  // 紧凑工具：命令/搜索/罗列类工具，具体动作（命令/查询/路径）已经在标题里展示，
  // 参数区和结果区再平铺一遍纯属冗余。约定是"只显示标题/动作就够了"。
  const isCompactTool = isCommandTool || /grep|search|glob|list/i.test(step.toolName || '')
  const visibleParamEntries = isCompactTool
    ? []
    : (step.toolParams ? Object.entries(step.toolParams) : [])
  const hasParams = !hasSubSteps && visibleParamEntries.length > 0
  const stepStatus = results.length > 0
    ? (step.status === 'failed' ? 'failed' : 'completed')
    : (step.status || (step.finishedAt ? 'completed' : step.startedAt ? 'running' : undefined))
  const running = stepStatus === 'running' && isRunning
  const failed = stepStatus === 'failed'
  const action = toolActionText(step)
  // 动词随状态变化:运行中"执行/搜索/读取",完成态加"已"前缀("已执行/已搜索/已读取")。
  const verb = toolVerb(step.toolName || '')
  const verbText = stepStatus === 'completed' && !failed ? `已${verb}` : verb
  // 完整标题（verb + action/label）：action 为空时回退到工具显示名。title 属性
  // 用于悬停查看全文——命令类标题可能被 CSS truncate 视觉截断。
  const titleLabel = action || getToolDisplayLabel(step.toolName || '', step.toolKind, path, step.toolParams)
  const fullTitle = `${verbText} ${titleLabel}`

  return (
    <div className="group">
      {/* Tool title row — click to expand/collapse.
          动作词(执行/搜索/读取) + 具体动作，完成态显示"已执行/已搜索/已读取"。 */}
      <button
        type="button"
        onClick={() => { if (canExpand) setOpen(prev => !prev) }}
        className={`w-full flex items-center gap-1.5 text-left text-[0.9em] text-foreground/80 ${canExpand ? '' : 'cursor-default'}`}
      >
        {failed ? (
          <X className="size-3.5 text-red-500 shrink-0" />
        ) : (
          getToolIcon(step.toolName || '')
        )}
        <span className={`font-medium truncate ${running ? 'flowing-text' : ''}`} title={fullTitle}>
          {verbText} {titleLabel}
        </span>
        {step.duration_s != null && step.duration_s > 0 && (
          <span className="text-[0.72em] text-muted-foreground shrink-0">{formatDurationSeconds(step.duration_s)}</span>
        )}
        {(() => {
          const count = step.content ? extractResultCount(step.content, step.toolName || '', step.toolParams) : ''
          return count ? <span className="text-[0.72em] text-muted-foreground/50 shrink-0">{count}</span> : null
        })()}
        {(() => {
          const diff = step.content ? extractDiffStats(step.content) : ''
          return diff ? <span className="text-[0.72em] text-emerald-500/60 shrink-0">{diff}</span> : null
        })()}
        {canExpand && <ChevronRight className={`size-3.5 shrink-0 text-foreground/30 transition-all ${open ? 'rotate-90' : ''}`} />}
      </button>

      {/* 命令类不可展开：运行中的实时输出与失败错误直接外露在标题下，不依赖展开。 */}
      {!canExpand && running && step.content && (
        <div className="ml-1 mt-1 text-[0.85em] text-foreground/40 font-mono max-h-16 overflow-hidden leading-relaxed whitespace-pre-wrap break-all">
          {stripAnsi(step.content.slice(-200))}
        </div>
      )}
      {!canExpand && results.some(r => r.type === 'error') && (
        <div className="ml-1 mt-1 flex items-start gap-1">
          <div className="flex-1 min-w-0 text-[0.8em] text-red-500/80 font-mono whitespace-pre-wrap break-all leading-relaxed">
            {results.filter(r => r.type === 'error')
              .map(r => stripMktempNoise(stripEmoji(normalizeAcpContent(r.content || ''))))
              .filter(Boolean).join('\n')}
          </div>
        </div>
      )}

      {canExpand && open && (
        <div className="pb-1 pt-1 pl-3 border-l-2 border-border/60 space-y-1.5">
          {/* Streaming output preview — shown while tool is running.
              tool.progress → tool_call_update(in_progress) → tool_output_delta 把
              实时输出追加到 step.content（agent-flow-panel），这里显示它的末尾。 */}
          {running && step.content && (
            <div className="text-[0.85em] text-foreground/40 font-mono max-h-16 overflow-hidden leading-relaxed whitespace-pre-wrap break-all">
              {stripAnsi(step.content.slice(-200))}
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
          {/* 内容单块 — 参数与结果合并展示，无单独标签分隔 */}
          {(hasParams || results.length > 0) && (
            <div className="rounded border border-border/20 divide-y divide-border/20">
              {hasParams && (
                <div className="p-1.5 space-y-1.5">
                  {visibleParamEntries.map(([k, v]) => (
                    <div key={k} className="flex flex-col">
                      <span className="text-[0.72em] text-foreground/40 font-medium uppercase tracking-wide">{k}</span>
                      <div className="helix-md">
                        <CodeCard
                          language="json"
                          code={typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                          showRunButton={false}
                          className="!leading-snug !my-0"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {results.map((r) => {
                if (r.type === 'error') {
                  const errFiltered = stripMktempNoise(stripEmoji(normalizeAcpContent(r.content || '')))
                  if (!errFiltered) return null
                  return (
                    <div key={r.id} className="flex items-start gap-1 p-1.5">
                      <div className="flex-1 min-w-0 text-[0.85em] text-red-500/80 font-mono whitespace-pre-wrap break-all leading-relaxed">
                        {errFiltered}
                      </div>
                      <CopyButton text={errFiltered} />
                    </div>
                  )
                }
                // 紧凑工具（命令/搜索/罗列）只显示标题，正常结果不展开。
                // Note: r.type is typed as ExecutionStep['type'] which doesn't include 'error',
                // but the runtime value might be 'error' from legacy code. Use type assertion.
                if ((r.type as string) !== 'error' && isCompactTool) return null
                const raw = stripMktempNoise(stripEmoji(normalizeAcpContent(r.content || '')))
                if (!raw) return null
                const fullText = raw
                const isImage = detectResultKind(r.toolName || '', raw) === 'image'

                // 图片结果不是代码块，保持原样渲染。
                if (isImage) {
                  return (
                    <div key={r.id} className="relative p-1.5">
                      <div className="absolute top-2 right-2 z-10">
                        <CopyButton text={fullText} />
                      </div>
                      <ImageRenderer content={raw} />
                    </div>
                  )
                }

                // 其余结果（diff / plain 文本）统一走 WorkBuddy 风格代码卡片：
                // 语言标签 + 行数 + 复制按钮 + 语法高亮 + 过长自动折叠/展开。
                // diff 由 CodeCard 内部的 DiffView 处理；plain 用 text 高亮。
                const resultLang = detectResultKind(r.toolName || '', raw) === 'diff' ? 'diff' : 'text'
                const clamped = raw.length > TOOL_RESULT_CLAMP ? raw.slice(0, TOOL_RESULT_CLAMP) + `\n\n… (${raw.length - TOOL_RESULT_CLAMP} 字符已截断)` : raw
                const isLong = clamped.length > 500 || clamped.split('\n').length > 10

                return (
                  <div key={r.id} className="p-1.5">
                    <div className="helix-md">
                      <CodeCard
                        language={resultLang}
                        code={clamped}
                        showRunButton={false}
                        className="!leading-snug !my-0"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
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
