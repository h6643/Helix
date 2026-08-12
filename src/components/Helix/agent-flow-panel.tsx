'use client'

import {
  Send,
  Brain,
  Wrench,
  Circle,
  AlertCircle,
  Code2,
  FileCode,
  FileText,
  BarChart3,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  Search,
  Folder,
  FolderOpen,
  Eye,
  ArrowDown,
  ArrowUp,
  RotateCcw,
  X,
  Square,
  Plus,
  FolderPlus,
  Clock,
  Hand,
  AlertTriangle,
  GitBranch,
  Pause,
  Download,
  Trash,
  BookOpen,
  Volume2,
  Mic,
} from 'lucide-react'
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import type { ReasoningEffortLevel } from '@/hermes-ui/types'
import { useProviderStore } from '@/hermes-ui/provider-store'
import { pushModelConfig } from '@/lib/config-sync'
import { isElectron, electronDialog, electronHermes, electronGit, hermesApi } from '@/lib/electron-bridge'
import { generateId, timeAgo } from '@/lib/format'
import { processClipboardImage, canAddMoreImages, blobToDataUrl, compressImage } from '@/lib/image-utils'
import { buildAcpMcpServers } from '@/lib/mcp'
import { detectScheduledTasks, syncTaskToBackend, type DetectedTask } from '@/lib/schedule-utils'
import { isServeActive } from '@/lib/serve-gateway'
import { debug } from '@/lib/logger'
import { decodeBase64Utf8, extractThinkTags, normalizeAcpContent, normalizeAcpContentRaw, stripEmoji, stripSystemReminders, extractKaomojiStatus } from '@/lib/text-utils'
import { ContextUsageIndicator } from './context-usage'

import { getToolLabel, getToolIcon, getToolDisplayLabel, extractCommandSnippet, extractToolPath } from '@/lib/tool-display-utils'
import { InlineToolGroup } from './inline-tool-group'
import { FileChangeSummary } from './file-change-summary'
import { ApprovalDialog, ClarifyBar, type ApprovalRequest } from './approval-dialog'
import { ScheduledTaskConfirm } from './scheduled-task-confirm'
import { useHelixStore, type ImageAttachment, type FileAttachment, type ExecutionStep, type StreamingResponseBlock } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
import { startWakeWord, stopWakeWord, pauseWakeWord, resumeWakeWord } from '@/lib/wake-word-utils'
import { startStt, startNativeRecordStt, startMediaRecorderStt, isSpeechRecognitionSupported, isNativeRecordingSupported, isMediaRecorderSupported, type SttCallbacks, type SttHandle } from '@/lib/voice-input-utils'
import { playDingSound } from '@/lib/ding-sound'
import { speakText, splitSentences } from '@/lib/tts-utils'
import { speak, stopSpeaking } from '@/lib/voice-utils'
import type { ChatMessage, HermesTodo } from '@/stores/helix-types'
import { HelixMarkdown } from './helix-markdown'

// ── Persisted per-conversation Hermes session map ──────────────────────────
// `sessionMapRef` lives in component memory and is wiped on every app restart.
// We persist it so a conversation keeps remembering its backend Hermes session
// id across restarts. BUT backend Hermes sessions are ephemeral: the gateway
// respawns on app launch and kills them all. So a restored id is only valid if
// its recorded gateway `epoch` still matches the live epoch — otherwise it's a
// dead id and must be treated as missing (the run path recreates it on demand,
// and the context-usage indicator falls back to the per-conversation store).
type SessionMapEntry = { sid: string; epoch: number }
const SESSION_MAP_KEY = 'conversationSessions'

async function persistSessionMap(map: Map<string, SessionMapEntry>) {
  try {
    const { persistence } = await import('@/lib/persist')
    const obj: Record<string, SessionMapEntry> = {}
    map.forEach((v, k) => { obj[k] = v })
    await persistence.saveSetting(SESSION_MAP_KEY, obj)
  } catch { /* best-effort persistence — never block the UI on it */ }
}

async function loadSessionMap(): Promise<Map<string, SessionMapEntry>> {
  try {
    const { persistence } = await import('@/lib/persist')
    const raw = await persistence.loadSetting<Record<string, SessionMapEntry>>(SESSION_MAP_KEY)
    const map = new Map<string, SessionMapEntry>()
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.sid === 'string' && typeof v.epoch === 'number') map.set(k, v)
      }
    }
    return map
  } catch {
    return new Map()
  }
}


// Pin tool_group blocks to the top while preserving the relative order within
// each group. This makes an execute_code / shell-call header render ABOVE the
// model's prose (claude-code style) instead of being buried at the very end.
function pinToolGroupsToTop(blocks: StreamingResponseBlock[]): StreamingResponseBlock[] {
  if (!blocks || blocks.length <= 1) return blocks
  const tools = blocks.filter((b) => b.type === 'tool_group')
  if (tools.length === 0) return blocks
  const rest = blocks.filter((b) => b.type !== 'tool_group')
  return [...tools, ...rest]
}

// pinToolGroupsToTop hoists ALL tool_groups to the top, so thinking blocks
// that were chronologically interleaved with tool calls become ADJACENT at
// render time (e.g. [thinking, tool, thinking, tool] → [tool, tool, thinking,
// thinking]). Each thinking block also carries the full accumulated thought
// (isCumulative replace), so they'd render as several stacked "思考" collapsibles
// with overlapping content — the "连续出现多个 thinking" symptom. Merge runs of
// consecutive thinking blocks: a cumulative superset replaces the earlier one,
// disjoint segments are concatenated.
function mergeAdjacentThinking(blocks: StreamingResponseBlock[]): StreamingResponseBlock[] {
  const out: StreamingResponseBlock[] = []
  for (const block of blocks) {
    const prev = out[out.length - 1]
    if (block.type === 'thinking' && prev && prev.type === 'thinking') {
      const prevC = String(prev.content || '')
      const curC = String(block.content || '')
      const content = curC.includes(prevC) ? curC : prevC.includes(curC) ? prevC : `${prevC}\n\n${curC}`
      out[out.length - 1] = { ...prev, content }
    } else {
      out.push(block)
    }
  }
  return out
}

// Older streamed messages may store cumulative text per block. Convert those
// to incremental text blocks so completed messages never render duplicates.
function normalizeForCompare(s: string): string {
  // 归一化用于判重比较：去空白 + 去标点 + 小写。
  // Hermes 全文重发时经常带微小差异（"CLI和配置" vs "CLI 和配置"、
  // "File" vs "file"），不归一化直接比会判定为两段不同内容 → 拼接重复。
  return s.replace(/[\s\p{P}]/gu, '').toLowerCase()
}

function textSimilarityRatio(a: string, b: string): number {
  // 先归一化再算重叠度。快路径：公共前缀+后缀；慢路径：最长连续公共
  // 子串（滑动近似），覆盖差异散布在中段的改写。
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  if (na.length === 0 || nb.length === 0) return 0
  const short = na.length <= nb.length ? na : nb
  const long = na.length <= nb.length ? nb : na
  if (short.length < 8) return 0
  let pref = 0
  while (pref < short.length && short[pref] === long[pref]) pref++
  let suf = 0
  while (suf < short.length - pref && short[short.length - 1 - suf] === long[long.length - 1 - suf]) suf++
  const prefixSuffix = pref + suf
  if (prefixSuffix >= short.length * 0.6) return prefixSuffix / short.length
  // 慢路径：长度差过大或文本超长时不再深入（子集场景已被 includes 分支覆盖）
  if (long.length > 8000 || long.length > short.length * 2) return prefixSuffix / short.length
  let best = prefixSuffix
  for (let i = 0; i < short.length && best < short.length; i++) {
    let idx = long.indexOf(short[i], 0)
    while (idx !== -1 && best < short.length) {
      let k = 0
      const maxK = Math.min(short.length - i, long.length - idx)
      while (k < maxK && short[i + k] === long[idx + k]) k++
      if (k > best) {
        best = k
        if (best >= short.length * 0.6) return best / short.length
      }
      idx = long.indexOf(short[i], idx + 1)
    }
  }
  return best / short.length
}

function isNearDuplicate(aN: string, bN: string): boolean {
  // Both args must already be normalized. True when one is an equal/prefix/
  // substring/close-rewrite of the other — the signature of a resend.
  return aN === bN || aN.startsWith(bN) || bN.startsWith(aN) ||
    aN.includes(bN) || bN.includes(aN) || textSimilarityRatio(aN, bN) >= 0.6
}

function normalizeTextBlocks(blocks: NonNullable<ChatMessage['blocks']>): NonNullable<ChatMessage['blocks']> {
  // Hermes frequently RE-SENDS the full accumulated text as another
  // agent_message_chunk (update_agent_message_text). When such a resend lands
  // on its own text block (e.g. after a thinking/tool_group in between), naive
  // rendering shows the same paragraph twice — "完全重复紧挨着".
  //
  // Dedupe each text block against:
  //   - the whole accumulated text (prevConcat) — catches full-text resends
  //     even when they grow ("keep only the tail") or shrink ("drop the
  //     prefix/shortened version");
  //   - the last kept text block (lastKept, tracked across thinking/tool_group
  //     blocks) — catches near-duplicate rewrites whose bytes differ only in
  //     spacing/punctuation/case (normalized comparison, e.g. "CLI和配置" vs
  //     "CLI 和配置"). A rewrite at least as long as the older one supersedes
  //     it (blank the older block, final wording wins); a shorter
  //     near-duplicate is a spurious partial resend and is dropped.
  //   - otherwise -> distinct paragraph, keep as-is
  let prevConcat = ''
  let lastKept = ''
  const rendered: NonNullable<ChatMessage['blocks']> = []
  for (const block of blocks) {
    if (block.type !== 'text') {
      rendered.push(block)
      continue
    }
    const cur = typeof block.content === 'string' ? block.content : String(block.content || '')
    const curN = normalizeForCompare(cur)
    let out: string | null = null // null -> keep cur unchanged
    let matched = false
    if (prevConcat && prevConcat.length > 0) {
      if (cur.startsWith(prevConcat)) {
        // Full-text resend that grew: keep only the tail delta.
        out = cur.slice(prevConcat.length)
        matched = true
      } else if (prevConcat.startsWith(cur) && cur.length >= 4) {
        // Resend arrived as a shorter/prefix version of the accumulated text.
        out = ''
        matched = true
      } else if (lastKept && lastKept.length > 0) {
        const lastN = normalizeForCompare(lastKept)
        // Tail/head overlap: the new chunk begins with the same words the
        // previous chunk ended with (Hermes re-prefixes the sentence boundary
        // on the next delta). Rendering both yields "文字叠在一起" — strip the
        // duplicated head.
        if (cur.length >= 8 && lastKept.length >= 8) {
          let _hit = 0
          const _maxK = Math.min(Math.min(cur.length, lastKept.length), 20)
          for (let _k = _maxK; _k >= 4; _k--) {
            if (lastKept.slice(-_k) === cur.slice(0, _k)) { _hit = _k; break }
          }
          if (_hit >= 4 && cur.slice(_hit).trim()) {
            out = cur.slice(_hit)
            matched = true
          }
        }
        if (!matched && curN.length >= 8 && lastN.length >= 8 && isNearDuplicate(lastN, curN)) {
          if (curN.length >= lastN.length) {
            // Near-identical rewrite that kept or grew: the newer block
            // supersedes the older one — blank it, keep the new wording.
            for (let i = rendered.length - 1; i >= 0; i--) {
              const b = rendered[i]
              if (b.type === 'text' && b.content !== '') {
                rendered[i] = { ...b, content: '' }
                break
              }
            }
          } else {
            // Near-identical subset of the previous block (spurious partial
            // resend): nothing new to show.
            out = ''
          }
          matched = true
        }
      }
      if (!matched && curN.length >= 12) {
        // Not caught by the adjacent-pair rules: test against the FULL
        // accumulated text for a resend that landed after other blocks in
        // between (e.g. tool_group / thinking) and differs in bytes.
        const concatN = normalizeForCompare(prevConcat)
        if (concatN.length >= 12 &&
          (curN === concatN || concatN.includes(curN) || curN.includes(concatN) ||
            textSimilarityRatio(concatN, curN) >= 0.6)) {
          if (curN.length >= concatN.length) {
            // Newer block contains (a rewrite of) everything so far — it IS
            // the whole message now: blank all older text, reset accumulators.
            for (let i = 0; i < rendered.length; i++) {
              const b = rendered[i]
              if (b.type === 'text') rendered[i] = { ...b, content: '' }
            }
            prevConcat = ''
            lastKept = ''
          } else {
            out = ''
          }
          matched = true
        }
      }
    }
    const final = out ?? cur
    if (final) {
      rendered.push({ ...block, content: final })
      lastKept = final
      prevConcat = prevConcat + final
    }
  }
  return rendered.filter((b) => b.type !== 'text' || b.content.length > 0)
}

// ── Diff capture from Hermes inline_diff ──────────────────────────────────
// Hermes `tool.complete` ships a rendered unified diff (inline_diff) for
// write_file/patch. Parse enough structure out of it to feed DiffPreview:
// file path comes from the `a/<path> → b/<path>` label line produced by
// agent/display.py _render_inline_unified_diff.
function inferDiffPath(diff: string): string {
  if (!diff) return ''
  const lines = diff.split('\n')
  const label = lines.find((l) => l.includes('→'))
  if (label) {
    const m = label.match(/(?:^|\s)([^\s→]+)\s*→\s*([^\s→]+)/)
    if (m) return (m[1].replace(/^a\//, '') || m[2].replace(/^b\//, ''))
  }
  const hdr = lines.find((l) => /^(?:---|\+\+\+) /.test(l.trim()))
  if (hdr) {
    const p = hdr.trim().slice(4).replace(/^(a|b)\//, '').replace(/\s+\(timestamp.*\)$/, '')
    if (p && p !== '/dev/null') return p
  }
  return ''
}

function diffLanguageForPath(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || filePath
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
    css: 'css', html: 'html', sh: 'bash',
  }
  return map[ext] || 'plaintext'
}

// ── 审批分流：按操作类型决定弹窗 or 自动批准 ─────────────────────────────
// yolo 关（default 模式）时后端对每个需要授权的工具调用发 approval.request，
// 前端在这里分类：项目内文件修改 → auto（直接批准，不弹窗）；危险命令 /
// 项目外文件访问（读也弹）/ 敏感文件 / 上传外发 → ask（入队弹审批条）。
// approval.request 没有干净工具名，只有 pattern_key（plugin_rule:terminal:hash
// 等）+ command 文本 + description，分类靠三者综合判断。

/** 删除/格式化类危险命令（用户确认的范围：删除、格式化） */
const DANGEROUS_CMD_RE = /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?|\bdel\s+\/|\berase\s|\bformat\b|\bmkfs\b|\bdd\s+if=|Remove-Item\b.*-Recurse|\brd\s+\/s|\brmdir\s+\/s|diskpart/i
/** 上传/外发类命令 */
const EXFIL_CMD_RE = /\bcurl\b[^\n]*\s(-T|-F|--upload-file|--data-binary|--data @)|\bscp\b|\brsync\b|\bgit\s+push\b|\bnc\s+-|\bncat\b|\bftp\b.*\bput\b/i
/** 敏感文件路径片段 */
const SENSITIVE_PATH_RE = /(\.ssh[\/\\]|id_rsa|id_ed25519|\.pem\b|\.key\b|\.env\b|credentials|\.aws[\/\\]|\.gnupg[\/\\]|\.kube[\/\\]config|ntuser\.dat|sam$)/i
/** 项目内文件写工具名（这些命中且路径在项目内 → auto） */
const FILE_WRITE_TOOL_RE = /write_file|create_file|edit|patch|str_replace|apply_patch/i
/** 项目内文件读工具名（这些命中且路径在项目内 → auto） */
const FILE_READ_TOOL_RE = /read_file|cat|head|tail/i

/** 从命令/描述文本里提取形如绝对路径的片段（用于“项目外访问”判断） */
function extractAbsPaths(text: string): string[] {
  const out: string[] = []
  // Windows 绝对路径 C:\... 或 C:/...
  for (const m of text.matchAll(/[a-zA-Z]:[\\/][^\s"'|><;&]*/g)) out.push(m[0])
  // POSIX 绝对路径 /home/...、/etc/...、~/.ssh/...（~ 开头单独处理）
  for (const m of text.matchAll(/(?:^|[\s"'=])((?:\/(?:home|etc|var|usr|root|tmp|opt|Users)\/|~\/)[^\s"'|><;&]*)/g)) out.push(m[1])
  return out
}

/** 规范化路径做 startsWith 比较（分隔符统一、去尾斜杠、小写——Windows 不区分大小写） */
function normPathForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 审批分流。
 * @param toolName approval.request 的 toolName（pattern_key 或 command）
 * @param params   toolParams（command / description / pattern_key / reason）
 * @param workDir  当前项目根（selectedWorkDir）
 */
function classifyApproval(
  toolName: string,
  params: Record<string, any>,
  workDir: string | null,
  mode: 'default' | 'accept_edits' | 'dont_ask',
): 'auto' | 'ask' {
  const patternKey = String(params?.pattern_key || '')
  const command = String(params?.command || '')
  const blob = `${toolName} ${patternKey} ${command} ${params?.description || ''} ${params?.reason || ''}`
  const workNorm = workDir ? normPathForCompare(workDir) : ''

  // 1) 危险命令（删除/格式化）→ 弹
  if (DANGEROUS_CMD_RE.test(command)) return 'ask'
  // 2) 上传/外发 → 弹
  if (EXFIL_CMD_RE.test(command)) return 'ask'
  // 3) 敏感文件 → 弹
  if (SENSITIVE_PATH_RE.test(blob)) return 'ask'

  // 4) 项目外文件访问（读也弹）：blob 里出现的绝对路径不在项目根内 → 弹
  for (const p of extractAbsPaths(blob)) {
    if (/^~\//.test(p)) return 'ask' // ~ 开头一律视为项目外（home 下的东西）
    if (!workNorm) return 'ask' // 不知道项目根时，任何绝对路径访问都弹
    const pn = normPathForCompare(p)
    if (pn !== workNorm && !pn.startsWith(workNorm + '/')) return 'ask'
  }

  // 5) 项目外文件读取（后端检测到的）→ 弹
  if (patternKey.includes('read_file:outside_project:')) return 'ask'

  // 6) 项目内文件修改 → 自动批准（diff 记录走 tool.complete inline_diff，不受影响）
  if (FILE_WRITE_TOOL_RE.test(blob)) return 'auto'

  // 模式相关分流
  if (mode === 'dont_ask') return 'auto'        // 后端一般不发请求，前端兜底放行
  if (mode === 'accept_edits') return 'auto'   // 替我审批：已排除危险/项目外/敏感，安全操作自动批准

  // 默认：弹（审批的意义就是未知操作要人确认；明确安全的上面已 auto）
  return 'ask'
}

// ==== Types ============================================================================================



// ==== Interleaved response blocks (text -> tool groups) ====

type ResponseBlock = StreamingResponseBlock

// InlineToolGroup — extracted to ./inline-tool-group.tsx

// ==== Helpers ========================================================================================

function WaveLoader({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}>
      {[0, 1, 2, 3].map(i => (
        <span
          key={i}
          className="size-[4px] rounded-full bg-current"
          style={{ animation: `waveDot 0.9s ease-in-out ${i * 0.16}s infinite` }}
        />
      ))}
    </span>
  )
}

const TEXTUAL_MIME_RE = /^(text\/|application\/(json|xml|javascript|typescript|x-sh|csv|yaml|toml|x-www-form-urlencoded)|image\/(svg\+xml))/
const TEXTUAL_EXT = /\.(txt|md|markdown|mdx|json|yml|yaml|toml|csv|ts|tsx|js|jsx|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|bash|zsh|sql|html|htm|css|scss|less|xml|log|env|gitignore|dockerfile|makefile|rst|tex)$/i

function isTextualFile(file: File): boolean {
  if (TEXTUAL_MIME_RE.test(file.type)) return true
  return TEXTUAL_EXT.test(file.name)
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

// Convert a dropped/picked File into a FileAttachment (reads image preview + base64).
async function fileToAttachment(file: File): Promise<FileAttachment> {
  const isImage = file.type.startsWith('image/')
  const dataUrl = await blobToDataUrl(file)
  let compressedDataUrl = dataUrl
  if (isImage) {
    const compressed = await compressImage(dataUrl)
    if (compressed !== dataUrl) {
      compressedDataUrl = compressed
    }
  }
  return {
    id: generateId(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    kind: isImage ? 'image' : (isTextualFile(file) ? 'text' : 'file'),
    dataUrl: isImage ? compressedDataUrl : undefined,
    base64: isImage ? compressedDataUrl.split(',')[1] || '' : '',
    // Only available in Electron (File has a `path` prop injected by Chromium)
    path: (file as any).path,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// Isolated so the 200ms ticking only re-renders this tiny node, not the whole
// conversation panel — the old implementation called a parent-level setState
// every 200ms, forcing the entire agent-flow-panel to re-render 5×/sec.
function ThinkingTimer({ questionStartTs, isRunning }: { questionStartTs: number; isRunning: boolean }) {
  const [duration, setDuration] = useState(0)
  useEffect(() => {
    if (!isRunning || !questionStartTs) { setDuration(0); return }
    const tick = () => setDuration(Math.round((Date.now() - questionStartTs) / 1000))
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [isRunning, questionStartTs])
  return <>{formatDuration(duration)}</>
}

// Export conversation as Markdown
function exportConversation(messages: any[], sessionLabel: string): void {
  const lines: string[] = []
  lines.push('# ' + (sessionLabel || 'Helix 对话'))
  lines.push('')
  lines.push('> 导出时间: ' + new Date().toLocaleString('zh-CN'))
  lines.push('')
  lines.push('---')
  lines.push('')
  for (const msg of messages) {
    if (msg.role === 'system') continue
    lines.push('## ' + (msg.role === 'user' ? '🧑 用户' : '🤖 助手'))
    lines.push('')
    if (msg.blocks && msg.blocks.length > 0) {
      for (const block of msg.blocks) {
        if (block.type === 'thinking') {
          lines.push('<details><summary>💭 思考</summary>')
          lines.push('')
          lines.push(block.content)
          lines.push('')
          lines.push('</details>')
          lines.push('')
        } else if (block.type === 'text') {
          lines.push(block.content)
          lines.push('')
        }
      }
    } else {
      lines.push(msg.content || '')
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (sessionLabel || 'helix-conversation') + '-' + Date.now() + '.md'
  a.click()
  URL.revokeObjectURL(url)
}

// Export conversation as JSON
function exportConversationJSON(messages: any[], sessionLabel: string): void {
  const data = {
    label: sessionLabel || 'Helix 对话',
    exportedAt: new Date().toISOString(),
    messages: messages.filter(m => m.role !== 'system'),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (sessionLabel || 'helix-conversation') + '-' + Date.now() + '.json'
  a.click()
  URL.revokeObjectURL(url)
}

// Quick command templates
const QUICK_COMMANDS: { cmd: string; label: string; prompt: string }[] = [
  { cmd: '/review', label: '代码审查', prompt: '请审查当前代码变更，检查安全漏洞、性能问题、代码风格，并给出改进建议。' },
  { cmd: '/fix', label: '修复问题', prompt: '请分析并修复当前存在的问题。先定位根因，再给出最小改动方案。' },
  { cmd: '/test', label: '编写测试', prompt: '请为当前代码编写单元测试，覆盖主要功能路径和边界情况。' },
  { cmd: '/doc', label: '生成文档', prompt: '请为当前代码生成清晰的文档注释，包括函数说明、参数说明和示例。' },
  { cmd: '/refactor', label: '重构优化', prompt: '请重构当前代码，提高可读性、可维护性，消除重复代码，但不改变功能。' },
  { cmd: '/explain', label: '解释代码', prompt: '请详细解释当前代码的工作原理、设计思路和关键实现细节。' },
  { cmd: '/security', label: '安全审查', prompt: '请对当前代码进行安全审查，检查 OWASP Top 10 漏洞、输入验证、权限控制等。' },
  { cmd: '/optimize', label: '性能优化', prompt: '请分析当前代码的性能瓶颈，并给出具体的优化方案。' },
  { cmd: '/summary', label: '代码总结', prompt: '请总结当前代码的功能、架构和主要模块，给出一份简洁的概述。' },
]





const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

// Schedule parsing — extracted to lib/schedule-utils.ts

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      onClick={() => {
        // Strip markdown formatting for clean copy
        const cleanText = text
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/\*(.+?)\*/g, "$1")
          .replace(/`{3}[\s\S]*?\n/g, "")
          .replace(/`(.+?)`/g, "$1")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/^>\s+/gm, "")
          .replace(/^[-*+]\s+/gm, "\u2022 ")
          .replace(/^\d+\.\s+/gm, "")
          .replace(/\[(.+?)\]\(.+?\)/g, "$1")
          .replace(/^---+$/gm, "")
          .trim()
        navigator.clipboard.writeText(cleanText).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
      }}
      className={`p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors ${className}`}
      data-tip="复制"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

// Tool display utilities — extracted to lib/tool-display-utils.tsx

function SpeakButton({ text, className = '' }: { text: string; className?: string }) {
  const [speaking, setSpeaking] = React.useState(false)

  React.useEffect(() => {
    if (!speaking) return
    const t = setInterval(() => {
      if (typeof window === 'undefined' || !window.speechSynthesis?.speaking) setSpeaking(false)
    }, 400)
    return () => clearInterval(t)
  }, [speaking])

  return (
    <button
      onClick={() => {
        if (window.speechSynthesis?.speaking) {
          stopSpeaking()
          setSpeaking(false)
        } else {
          speak(text)
          setSpeaking(true)
        }
      }}
      className={`p-1.5 rounded-md transition-colors ${
        speaking
          ? 'text-primary bg-primary/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
      } ${className}`}
      data-tip={speaking ? '停止朗读' : '朗读'}
    >
      <Volume2 className={`size-3.5 ${speaking ? 'animate-pulse' : ''}`} />
    </button>
  )
}


// ==== Empty State ====================================================================================

function EmptyState() {
  return null
}

// ==== Reasoning Effort Select ==================================================================

const REASONING_OPTIONS: { value: ReasoningEffortLevel; label: string }[] = [
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' },
]

function ReasoningEffortControl({ value, onChange }: { value: ReasoningEffortLevel; onChange: (v: ReasoningEffortLevel) => void }) {
  const idx = REASONING_OPTIONS.findIndex(o => o.value === value)
  const safeIdx = idx < 0 ? 2 : idx
  const current = REASONING_OPTIONS[safeIdx]

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect()
      const panelWidth = 192 // w-48
      let left = r.left + r.width / 2 - panelWidth / 2
      left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8))
      setPanelStyle({
        position: 'fixed',
        left,
        bottom: window.innerHeight - r.top + 8,
        zIndex: 50,
      })
    }
    setOpen(v => !v)
  }

  const trackRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const handlePos = useCallback((clientX: number) => {
    if (!trackRef.current) return
    const r = trackRef.current.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - r.left, 0), r.width)
    const ratio = x / r.width
    const max = REASONING_OPTIONS.length - 1
    const nextIdx = Math.max(0, Math.min(max, Math.round(ratio * max)))
    const nextValue = REASONING_OPTIONS[nextIdx].value
    if (nextValue !== value) onChange(nextValue)
  }, [value, onChange])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
    handlePos(e.clientX)
  }, [handlePos])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return
    handlePos(e.clientX)
  }, [isDragging, handlePos])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="text-xs font-medium text-foreground/70 hover:text-foreground px-2 py-1.5 h-7 rounded-lg border border-border/60 bg-muted/40 hover:bg-muted/70 transition-colors min-w-11 text-center"
      >
        {current.label}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          style={panelStyle}
          className="p-2 bg-popover border border-border/40 rounded-xl shadow-2xl flex flex-col gap-1 w-48 select-none animate-scale-in"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground/60">推理强度</span>
            <span className="text-xs font-medium text-primary">{current.label}</span>
          </div>
          <div className="flex items-center justify-between text-[10px] text-foreground/40 leading-none">
            <span>更快</span>
            <span>更聪明</span>
          </div>
          <div
            ref={trackRef}
            className="relative h-2.5 rounded-full bg-muted/60 cursor-pointer touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            {REASONING_OPTIONS.map((o, i) => {
              const active = i === safeIdx
              return (
                <div
                  key={o.value}
                  className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-200 ${active ? 'size-2.5 bg-primary' : 'size-1.5 bg-foreground/20'}`}
                  style={{ left: `${(i / (REASONING_OPTIONS.length - 1)) * 100}%` }}
                />
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ==== Main Component ============================================================================

// ── 内存守卫：摘要化 + 截断 ──────────────────────────────────────────────
// 长期会话把完整历史（含工具输出/思考/steps）堆在渲染进程，normalized +
// markdown + DOM 多份副本最终会顶爆 V8 堆。策略与 Claude Code / 官方 Hermes
// 一致：旧消息折叠为摘要、超长单条截断、流式缓冲设上限，把内存压成
// 「近期限定」而不是「随时长无界增长」。持久化数据不受影响，搜索仍基于完整内容。
const DISPLAY_LIMIT = 80 // 最近 N 条消息完整渲染
const SUMMARY_CHUNK = 10 // 更早的消息每 N 条折叠为一个摘要块
const MAX_MESSAGE_CHARS = 200_000 // 单条正文上限（超出截断显示）
const MAX_REASONING_CHARS = 40_000
const MAX_STEP_CHARS = 60_000 // 单步工具输出上限
const MAX_STREAM_CHARS = 400_000 // 流式正文缓冲上限（防单次 run 失控）
const TRUNC_MARK = '…[内容过长已截断]'

type DisplayItem =
  | { kind: 'summary'; id: string; count: number; preview: string; startTs?: number; endTs?: number }
  | { kind: 'message'; msg: ChatMessage }

function truncateStr(s: string | undefined, max: number): string | undefined {
  if (!s || s.length <= max) return s
  return s.slice(0, max) + TRUNC_MARK
}

function truncateSteps(steps: ExecutionStep[] | undefined): ExecutionStep[] | undefined {
  if (!steps || steps.length === 0) return steps
  let changed = false
  const next = steps.map(st => {
    const content = truncateStr(st.content, MAX_STEP_CHARS)
    const output = truncateStr(st.output, MAX_STEP_CHARS)
    const logs = st.logs ? st.logs.map(l => truncateStr(l, MAX_STEP_CHARS) ?? l) : st.logs
    const subSteps = truncateSteps(st.subSteps)
    if (content === st.content && output === st.output && logs === st.logs && subSteps === st.subSteps) return st
    changed = true
    return { ...st, content: content ?? '', output, logs, subSteps }
  })
  return changed ? next : steps
}

function truncateBlocks(blocks: ChatMessage['blocks']): ChatMessage['blocks'] {
  if (!blocks || blocks.length === 0) return blocks
  let changed = false
  const next = blocks.map(b => {
    if (b.type === 'tool_group') {
      const steps = truncateSteps(b.steps) ?? b.steps
      if (steps !== b.steps) { changed = true; return { ...b, steps } }
      return b
    }
    if (b.type === 'file_change') return b
    const content = truncateStr(b.content, MAX_MESSAGE_CHARS)
    if (content === b.content) return b
    changed = true
    return { ...b, content: content ?? '' }
  })
  return changed ? next : blocks
}

function truncateMessage(m: ChatMessage): ChatMessage {
  const content = truncateStr(m.content, MAX_MESSAGE_CHARS)
  const reasoning = truncateStr(m.reasoning, MAX_REASONING_CHARS)
  const steps = truncateSteps(m.steps)
  const blocks = truncateBlocks(m.blocks)
  if (content === m.content && reasoning === m.reasoning && steps === m.steps && blocks === m.blocks) return m
  return { ...m, content: content ?? '', reasoning, steps, blocks }
}

function previewText(m: ChatMessage | undefined): string {
  if (!m) return ''
  const raw = stripEmoji(normalizeAcpContent(m.content || '')).replace(/\s+/g, ' ').trim()
  return raw ? raw.slice(0, 240) : (m.role === 'user' ? '(空消息)' : '(无正文输出)')
}

function summarizeChunk(messages: ChatMessage[]): string {
  const first = previewText(messages[0])
  const last = messages.length > 1 ? previewText(messages[messages.length - 1]) : null
  return (first + (last ? '\n\n…\n\n' + last : '')).slice(0, 800)
}

function SummarizedHistoryBlock({ count, preview, startTs, endTs }: { count: number; preview: string; startTs?: number; endTs?: number }) {
  const range = (startTs && endTs && startTs !== endTs)
    ? `（${new Date(startTs).toLocaleDateString()} ~ ${new Date(endTs).toLocaleDateString()}）`
    : ''
  return (
    <details className="group/details">
      <summary className="flex items-center gap-1.5 px-1 py-1 text-[11px] text-muted-foreground/40 cursor-pointer hover:text-foreground/60 select-none list-none transition-colors">
        <ChevronRight className="size-3 transition-transform group-open/details:rotate-90 shrink-0" />
        <span>已压缩 {count} 条较早消息{range}，点击展开预览</span>
      </summary>
      <div className="pl-4 pr-2 text-xs text-muted-foreground/45  leading-relaxed mb-2">
        {preview}
      </div>
    </details>
  )
}

function HighlightText({ text, query, active }: { text: string; query: string; active: boolean }) {
  const q = query.trim().toLowerCase()
  if (!q) return <>{text}</>
  const lower = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let key = 0
  while (true) {
    const idx = lower.indexOf(q, cursor)
    if (idx === -1) {
      if (cursor < text.length) parts.push(text.slice(cursor))
      break
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx))
    parts.push(
      <mark
        key={key++}
        className={`rounded-[3px] px-0.5 ${active ? 'bg-yellow-300/80 text-black' : 'bg-yellow-300/35 text-inherit'}`}
      >
        {text.slice(idx, idx + q.length)}
      </mark>
    )
    cursor = idx + q.length
  }
  return <>{parts}</>
}

function countOccurrences(text: string, query: string): number {
  if (!query) return 0
  let count = 0
  let idx = text.indexOf(query)
  while (idx !== -1) {
    count++
    idx = text.indexOf(query, idx + query.length)
  }
  return count
}

// Memoized single-message row. While a reply streams in, the live content lives
// in responseBlocks (local state) — committed messages keep stable references,
// so React.memo lets us skip re-rendering the whole transcript (markdown
// re-parse + text normalization) on every streamed chunk. This is the biggest
// lever for keeping long conversations smooth.
const TranscriptMessage = React.memo(function TranscriptMessage({
  msg,
  fontSize,
  searchOpen,
  searchQuery,
  isSearchMatch,
  isSearchActive,
  onFork,
}: {
  msg: ChatMessage
  fontSize: number
  searchOpen: boolean
  searchQuery: string
  isSearchMatch: boolean
  isSearchActive: boolean
  onFork: (id: string) => void
}) {
  const content = useMemo(() => normalizeAcpContent(msg.content), [msg.content])
  const mdContent = useMemo(() => normalizeAcpContentRaw(msg.content), [msg.content])
  const reasoning = useMemo(() => normalizeAcpContentRaw(msg.reasoning || ''), [msg.reasoning])
  const messageDuration = msg.duration ?? msg.thinkingTime

  return (
    <div
      data-message-id={msg.id}
      className={`flex w-full step-enter ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
    >
      {msg.role === 'assistant' ? (
        <div className={`group w-full rounded-xl transition-all duration-200 ${
          isSearchMatch
            ? isSearchActive
              ? 'ring-2 ring-yellow-400/40'
              : 'ring-1 ring-yellow-400/20'
            : ''
        }`}>
          <div className="flex-1 min-w-0">
            {/* Inline thinking block (collapsible) — skip if blocks already contain thinking (prevents duplicate) */}
            {msg.reasoning && msg.reasoning.trim().length > 0 && !(msg.blocks && msg.blocks.some(b => b.type === 'thinking')) && (
              <details className="mb-2 mt-3 group/details">
                <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize }}>
                  <span>{extractKaomojiStatus(reasoning).status || '思考'}</span>
                  <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                </summary>
                <div className="mt-1 pl-4 text-foreground/50  break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize }}>
                  {searchOpen && searchQuery.trim() ? <HighlightText text={reasoning} query={searchQuery} active={isSearchActive} /> : <HelixMarkdown text={reasoning} />}
                </div>
              </details>
            )}
            {/* Interleaved blocks: thinking, text, and tool groups in chronological order */}
            {(msg.blocks && msg.blocks.length > 0) ? (
              <div className="helix-md thinking-cap-body thinking-scroll" style={{ fontSize }}>
                {mergeAdjacentThinking(pinToolGroupsToTop(normalizeTextBlocks(msg.blocks))).map((block, idx) =>
                  block.type === 'thinking' ? (
                    <details key={idx} className="mb-2 mt-3 group/details">
                      <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize }}>
                        <span>{extractKaomojiStatus(block.content).status || '思考'}</span>
                        <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                      </summary>
                      <div className="mt-1 pl-4 text-foreground/50  break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize }}>
                        {searchOpen && searchQuery.trim() ? <HighlightText text={normalizeAcpContentRaw(block.content)} query={searchQuery} active={isSearchActive} /> : <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />}
                      </div>
                    </details>
                  ) : block.type === 'text' ? (
                    <div key={idx} style={{ fontSize }}>
                      {searchOpen && searchQuery.trim() ? (
                        <div className="whitespace-pre-wrap break-words" style={{ fontSize }}>
                          <HighlightText text={normalizeAcpContentRaw(block.content)} query={searchQuery} active={isSearchActive} />
                        </div>
                      ) : (
                        <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                      )}
                    </div>
                  ) : block.type === 'file_change' ? (
                    <FileChangeSummary key={idx} changes={block.changes} />
                  ) : (
                    <InlineToolGroup key={idx} steps={block.steps} isRunning={false} />
                  )
                )}
              </div>
            ) : (
              <div className="helix-md thinking-cap-body thinking-scroll" style={{ fontSize }}>
                {searchOpen && searchQuery.trim() ? (
                  <pre className="whitespace-pre-wrap break-words" style={{ fontSize }}>
                    <HighlightText text={mdContent} query={searchQuery} active={isSearchActive} />
                  </pre>
                ) : (
                  <HelixMarkdown text={mdContent} />
                )}
              </div>
            )}
            {(messageDuration ?? 0) > 0 && (
              <div className="text-[10px] text-foreground/30 tabular-nums mt-1 px-1">
                {formatDuration(messageDuration ?? 0)}
              </div>
            )}
            {/* Copy button */}
            <div className="flex opacity-0 group-hover:opacity-100 transition-opacity pt-1 px-1 gap-0.5">
              <CopyButton text={mdContent} />
              <SpeakButton text={mdContent} />
              <button
                onClick={() => onFork(msg.id)}
                className="p-1 rounded-lg text-muted-foreground/40 hover:text-blue-500 hover:bg-blue-500/10 transition-colors"
                data-tip="分叉对话"
              >
                <GitBranch className="size-3" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="group max-w-[80%]">
          <div className="px-4 py-2.5 rounded-2xl rounded-br-md bg-muted/30 text-foreground shadow-sm border border-border/20">
            {msg.images && msg.images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {msg.images.map(img => (
                  <img
                    key={img.id}
                    src={img.dataUrl}
                    alt={img.name || 'pasted image'}
                    className="rounded-lg max-h-[300px] max-w-full object-contain"
                  />
                ))}
              </div>
            )}
            {msg.files && msg.files.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {msg.files.map(f => (
                  <div
                    key={f.id}
                    className="flex items-center gap-2 max-w-[240px] px-2.5 py-1.5 rounded-lg border border-border/30 bg-muted/20 hover:bg-muted/40 hover:border-border/30 transition-all duration-200"
                  >
                    {f.kind === 'image' && f.dataUrl ? (
                      <img src={f.dataUrl} alt={f.name} className="size-8 rounded object-cover shrink-0" />
                    ) : (
                      <FileText className="size-4 text-foreground/50 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{f.name}</p>
                      <p className="text-[10px] text-muted-foreground/70">{formatBytes(f.size)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {content && (
              <div className="helix-md leading-normal" style={{ fontSize }}>
                {searchOpen && searchQuery.trim() ? (
                  <div className="whitespace-pre-wrap"><HighlightText text={content} query={searchQuery} active={isSearchActive} /></div>
                ) : (
                  <HelixMarkdown text={content} />
                )}
              </div>
            )}
          </div>
          {/* Action buttons below user message */}
          <div className="flex justify-end items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
            <CopyButton text={content} />
          </div>
        </div>
      )}
    </div>
  )
})

// Stable key for the "new conversation that hasn't sent a message yet" draft.
// When no real session exists yet (currentSessionId === null), attachments and
// typed text must still be preserved per-tab; using a fixed key lets the
// per-session persist/restore effects work for unsent drafts too.
const DRAFT_SESSION_KEY = '__draft__'

export function AgentFlowPanel() {
  const [steps, setSteps] = useState<ExecutionStep[]>([])
  useEffect(() => { stepsRef.current = steps }, [steps])
  const [input, setInput] = useState('')
  // Voice input (STT) session state — mic pill next to the send button.
  const [voiceInputActive, setVoiceInputActive] = useState(false)
  const [voiceInputInterim, setVoiceInputInterim] = useState('')
  const sttHandleRef = useRef<SttHandle | null>(null)
  // Per-session streaming drafts let the running thinking/steps survive
  // conversation switches. `isRunning` is derived from the current session's draft.
  const streamingDrafts = useHelixStore(s => s.streamingDrafts)
  const setStreamingDraft = useHelixStore(s => s.setStreamingDraft)
  const clearStreamingDraft = useHelixStore(s => s.clearStreamingDraft)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  // 模型反问多选（clarify）：一次只显示最旧一条，回应后出队
  const [clarifyQueue, setClarifyQueue] = useState<Array<{ id: string; question: string; choices: string[] | null; sessionId?: string }>>([])
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showFolderDropdown, setShowFolderDropdown] = useState(false)
  const [showApprovalModeDropdown, setShowApprovalModeDropdown] = useState(false)
  const approvalMode = useHelixStore(s => s.approvalMode)
  const setApprovalMode = useHelixStore(s => s.setApprovalMode)
  const [showNewProjectForm, setShowNewProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [fileSkills, setFileSkills] = useState<Array<{ name: string; description: string }>>([])
  const startupGreeting = useHelixStore(s => s.startupGreeting)
  // Wake-word detection
  const [wakeActive, setWakeActive] = useState(false)
  const wakeActiveRef = useRef(false)
  const [wakeListening, setWakeListening] = useState(false)
  const ttsBufferRef = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showAtRef, setShowAtRef] = useState(false)
  const [filteredAtFiles, setFilteredAtFiles] = useState<Array<{ name: string; path: string }>>([])
  const [selectedAtFileIndex, setSelectedAtFileIndex] = useState(0)
  // Git branch picker popover (empty-state breadcrumb).
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [branchList, setBranchList] = useState<string[]>([])
  const [branchSearch, setBranchSearch] = useState('')
  const [branchDirtyCount, setBranchDirtyCount] = useState(0)
  const [branchCreating, setBranchCreating] = useState(false)
  const [branchNewName, setBranchNewName] = useState('')
  const branchPopoverRef = useRef<HTMLDivElement>(null)
  const externalServices = useHelixStore((s) => s.externalServices)
  // Detected scheduled tasks awaiting user confirmation (AI asked to create them).
  const [pendingTaskCreations, setPendingTaskCreations] = useState<DetectedTask[]>([])
  const handleConfirmTasks = (tasks: DetectedTask[]) => {
    const st = useHelixStore.getState()
    for (const t of tasks) {
      st.addScheduledTask({
        label: t.label,
        prompt: t.prompt,
        scheduleText: t.scheduleText,
        cronExpression: undefined,
        enabled: true,
        lastRunAt: null,
        nextRunAt: t.nextRunAt,
      })
      syncTaskToBackend(t.label, t.prompt, t.scheduleText, t.nextRunAt)
    }
    setPendingTaskCreations([])
    st.showToast({ type: 'success', title: `已创建 ${tasks.length} 个定时任务` })
  }
  const handleDismissTasks = () => setPendingTaskCreations([])
  const workspaceFilesRef = useRef<Array<{ name: string; path: string }>>([])
  const workspaceFilesLoadedRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputValueRef = useRef(input)
  const chatInputWrapRef = useRef<HTMLDivElement>(null)
  const setInputSynced = useCallback((value: string) => {
    setInput(value)
    inputValueRef.current = value
    const sid = useHelixStore.getState().currentSessionId ?? DRAFT_SESSION_KEY
    useHelixStore.getState().setTabInput(sid, value)
  }, [])

  // ── Voice input (STT) ────────────────────────────────────────────────
  // Pick the best available backend: browser SpeechRecognition (zero-latency
  // interim results), then native arecord→Hermes STT (Linux WebKitGTK has no
  // getUserMedia audio), then MediaRecorder→Hermes STT.
  const handleVoiceInputToggle = useCallback(() => {
    // A click while a session exists (or marked listening) means STOP.
    // Flip the UI state synchronously so the red mic reverts at once,
    // regardless of how long the STT backend (e.g. Hermes) takes to tear down.
    if (voiceInputActive || sttHandleRef.current) {
      setVoiceInputActive(false)
      setVoiceInputInterim('')
      sttHandleRef.current?.stop()
      sttHandleRef.current = null
      inputRef.current?.focus()
      return
    }

    const appendFinal = (text: string) => {
      const clean = text.trim()
      if (!clean) return
      const existing = inputValueRef.current
      const next = existing.trim() ? `${existing}${existing.endsWith(' ') ? '' : ' '}${clean}` : clean
      setInputSynced(next)
    }
    const onError = (message: string) => {
      sttHandleRef.current = null
      setVoiceInputActive(false)
      setVoiceInputInterim('')
      useHelixStore.getState().showToast({ type: 'error', title: '语音输入', description: message })
    }
    const callbacks: SttCallbacks = {
      onFinal: appendFinal,
      onInterim: (text) => setVoiceInputInterim(text),
      onStatus: (status) => setVoiceInputActive(status === 'listening'),
      onError,
    }

    let session: SttHandle | null = null
    const lang = 'zh-CN'
    if (isSpeechRecognitionSupported()) {
      session = startStt(lang, callbacks)
    } else if (isNativeRecordingSupported()) {
      session = startNativeRecordStt(lang, callbacks)
    } else if (isMediaRecorderSupported()) {
      session = startMediaRecorderStt(lang, callbacks)
    }

    if (!session) {
      onError('当前平台不支持语音输入')
      return
    }
    sttHandleRef.current = session
    session.start()
  }, [voiceInputActive, setInputSynced])

  // Abort any in-flight STT session when the panel unmounts.
  React.useEffect(() => () => {
    sttHandleRef.current?.abort()
    sttHandleRef.current = null
  }, [])

  // Reset input height to default
  const resetInputHeight = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = '48px'
    }
  }, [])


  const abortRef = useRef<AbortController | null>(null)
  // Per-conversation AbortControllers so stopping one conversation's run never
  // aborts a parallel run in another conversation.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
  const doneProcessedRef = useRef(false)
  const synthDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const forceDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedSessionRef = useRef(false)
  const sharedTextBufferRef = useRef<string>('')
  const thoughtBufferRef = useRef<string>('')
  const thinkingStartTimeRef = useRef<number>(0)
  const thinkingDurationRef = useRef<number>(0)
  const promptSentAtRef = useRef<number>(0)
  const runStartedAtRef = useRef<number>(0)
  const firstContentAtRef = useRef<number>(0)
  const stepsRef = useRef<ExecutionStep[]>([])
  const hermesSessionIdRef = useRef<string | null>(null)
  // The gateway epoch (bumped on every restart) at the moment our current
  // hermesSessionIdRef was created. If the live epoch is higher, the gateway
  // restarted since → the cached session is dead and must be recreated even
  // though hermesConnected may already be true again.
  const sessionEpochRef = useRef<number>(0)
  // Per-conversation Hermes ACP session ids. Each entry stores the backend
  // session id AND the gateway epoch it was created under, so we can detect
  // dead sessions after a gateway restart (see loadSessionMap / persistSessionMap).
  const sessionMapRef = useRef<Map<string, SessionMapEntry>>(new Map())
  const runningSessionIdRef = useRef<string | null>(null)
  // Which session's data the shared live UI state (responseBlocks / steps /
  // streamThinking) currently belongs to. Lets the display layer keep
  // showing a promoted-but-not-yet-flushed run's own draft instead of another
  // run's stale live state right after switching conversations.
  const liveStateOwnerRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const skillUploadRef = useRef<HTMLInputElement>(null)
  const uploadFileInputRef = useRef<HTMLInputElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const folderDropdownRef = useRef<HTMLDivElement>(null)
  const approvalModeDropdownRef = useRef<HTMLDivElement>(null)

  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([])
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([])
  const [isDraggingFile, setIsDraggingFile] = useState(false)

  // External input injection (Command Center / Review panel push text here)
  const injectSignal = useHelixStore((s) => s.injectInputSignal)
  useEffect(() => {
    if (injectSignal) {
      setInputSynced(injectSignal.text)
      inputRef.current?.focus()
    }
  }, [injectSignal, setInputSynced])

  const [responseBlocks, setResponseBlocks] = useState<ResponseBlock[]>([])
  const responseBlocksRef = useRef<ResponseBlock[]>(responseBlocks)
  responseBlocksRef.current = responseBlocks
  const [streamThinking, setStreamThinking] = useState<string>('')
  const streamThinkingRef = useRef('')
  streamThinkingRef.current = streamThinking
  // Anchors the live timer to the moment the USER sends a question, so it keeps
  // ticking across any sub-runs (agent tool loops) instead of resetting per run.
  const [questionStartTs, setQuestionStartTs] = useState<number>(0)
  const [streamTotalTokens, setStreamTotalTokens] = useState<number>(0)

  const apiConfig = useHelixStore(s => s.apiConfig)
  const skills = useHelixStore(s => s.skills)
  const availableCommands = useHelixStore(s => s.availableCommands)
  const agentExecutionSteps = useHelixStore(s => s.agentExecutionSteps)
const tabInputs = useHelixStore(s => s.tabInputs)
const setTabInput = useHelixStore(s => s.setTabInput)
const clearTabInput = useHelixStore(s => s.clearTabInput)
  const chatMessages = useHelixStore(s => s.chatMessages)
  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const setSessionPendingApproval = useHelixStore(s => s.setSessionPendingApproval)
  // 仅显示/统计当前会话的待确认（审批/反问/定时任务），避免切会话时串台
  const approvalRequest = approvalQueue.find(r => r.sessionId === currentSessionId) || null
  const pendingApprovalCount = approvalQueue.filter(r => r.sessionId === currentSessionId).length
  const clarifyRequest = clarifyQueue.find(c => c.sessionId === currentSessionId) || null
  // 把每个会话的待确认状态同步到全局 store，供侧边栏标记
  useEffect(() => {
    const map: Record<string, boolean> = {}
    for (const r of approvalQueue) if (r.sessionId) map[r.sessionId] = true
    for (const c of clarifyQueue) if (c.sessionId) map[c.sessionId] = true
    for (const t of pendingTaskCreations) if (t.sessionId) map[t.sessionId] = true
    const prev = useHelixStore.getState().sessionPendingApproval
    const next: Record<string, boolean> = { ...prev }
    for (const k of Object.keys(next)) if (!(k in map)) next[k] = false
    for (const k of Object.keys(map)) next[k] = true
    setSessionPendingApproval(next)
  }, [approvalQueue, clarifyQueue, pendingTaskCreations, currentSessionId, setSessionPendingApproval])
  const sessionMessages = useMemo(() => {
    // 永远按会话过滤：currentSessionId 为 null（新对话）时只显示无 sessionId
    // 的历史消息，绝不能把其他会话（含仍在后台运行的旧 run）的消息漏进来。
    // 之前 `if (!currentSessionId) return chatMessages` 会让点击「新对话」后
    // 旧 run 结束时提交的 assistant 消息出现在全新对话里。
    return chatMessages.filter(m => !m.sessionId || m.sessionId === currentSessionId)
  }, [chatMessages, currentSessionId])

  // 渲染层摘要化：只完整渲染最近 DISPLAY_LIMIT 条，更早的折叠为摘要块；
  // 超长单条截断显示。数组在 sessionMessages 变化时才重建，截断后的副本引用
  // 保持稳定，TranscriptMessage 的 React.memo 不受影响。
  const displayMessages = useMemo<DisplayItem[]>(() => {
    const n = sessionMessages.length
    const items: DisplayItem[] = []
    if (n > DISPLAY_LIMIT) {
      const collapsed = n - DISPLAY_LIMIT
      const chunks = Math.ceil(collapsed / SUMMARY_CHUNK)
      for (let c = 0; c < chunks; c++) {
        const start = c * SUMMARY_CHUNK
        const end = Math.min(start + SUMMARY_CHUNK, collapsed)
        const chunk = sessionMessages.slice(start, end)
        items.push({
          kind: 'summary',
          id: 'summary-' + c,
          count: chunk.length,
          preview: summarizeChunk(chunk),
          startTs: chunk[0]?.timestamp,
          endTs: chunk[chunk.length - 1]?.timestamp,
        })
      }
    }
    const recentStart = Math.max(0, n - DISPLAY_LIMIT)
    for (let i = recentStart; i < n; i++) {
      items.push({ kind: 'message', msg: truncateMessage(sessionMessages[i]) })
    }
    return items
  }, [sessionMessages])

  // ── Conversation content search (Ctrl+F) ──────────────────────────────
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false)
  const [conversationSearchQuery, setConversationSearchQuery] = useState('')
  const [conversationSearchActive, setConversationSearchActive] = useState(0)
  const conversationSearchInputRef = useRef<HTMLInputElement>(null)

  const searchMatches = useMemo(() => {
    if (!conversationSearchOpen) return []
    const q = conversationSearchQuery.trim().toLowerCase()
    if (!q) return []
    const result: { messageId: string; count: number }[] = []
    for (const msg of sessionMessages) {
      const text = stripEmoji(normalizeAcpContent(msg.content)).toLowerCase()
      const count = countOccurrences(text, q)
      if (count > 0) result.push({ messageId: msg.id, count })
    }
    return result
  }, [sessionMessages, conversationSearchQuery, conversationSearchOpen])

  const searchMatchIds = useMemo(() => new Set(searchMatches.map(m => m.messageId)), [searchMatches])
  const conversationSearchActiveId = searchMatches[conversationSearchActive]?.messageId || null

  const openConversationSearch = useCallback(() => {
    setConversationSearchOpen(true)
    setConversationSearchActive(0)
    setTimeout(() => conversationSearchInputRef.current?.focus(), 50)
  }, [])

  const closeConversationSearch = useCallback(() => {
    setConversationSearchOpen(false)
    setConversationSearchQuery('')
    setConversationSearchActive(0)
    inputRef.current?.focus()
  }, [])

  const goToNextSearchMatch = useCallback(() => {
    if (!searchMatches.length) return
    setConversationSearchActive(i => (i + 1) % searchMatches.length)
  }, [searchMatches.length])

  const goToPrevSearchMatch = useCallback(() => {
    if (!searchMatches.length) return
    setConversationSearchActive(i => (i - 1 + searchMatches.length) % searchMatches.length)
  }, [searchMatches.length])

  const handleConversationSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      // Stop propagation so the global shortcut handler (Enter → approve,
      // Escape → decline) doesn't intercept the search input.
      e.stopPropagation()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) goToPrevSearchMatch()
      else goToNextSearchMatch()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeConversationSearch()
    }
  }, [goToNextSearchMatch, goToPrevSearchMatch, closeConversationSearch])

  useEffect(() => {
    const handler = () => openConversationSearch()
    window.addEventListener('helix:conversation-search', handler)
    return () => window.removeEventListener('helix:conversation-search', handler)
  }, [openConversationSearch])

  useEffect(() => {
    if (!conversationSearchOpen || !conversationSearchActiveId) return
    const el = scrollRef.current?.querySelector(`[data-message-id="${conversationSearchActiveId}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [conversationSearchActiveId, conversationSearchOpen])

  // ── Fork branch info for current session ──────────────────────────────
  const [currentBranchInfo, setCurrentBranchInfo] = useState<{ branchName?: string; parentLabel?: string } | null>(null)
  useEffect(() => {
    if (!currentSessionId) { setCurrentBranchInfo(null); return }
    let cancelled = false
    import('@/lib/persist').then(({ persistence }) => {
      persistence.loadSessions().then(all => {
        if (cancelled) return
        const session = all.find(s => s.id === currentSessionId)
        if (session?.branchName) {
          const parent = session.parentSessionId ? all.find(s => s.id === session.parentSessionId) : null
          setCurrentBranchInfo({ branchName: session.branchName, parentLabel: parent?.label })
        } else {
          setCurrentBranchInfo(null)
        }
      })
    })
    return () => { cancelled = true }
  }, [currentSessionId])
  // When the user focuses a conversation whose run is still active in the
  // background (e.g. via the sidebar), promote it to "front" so its live
  // streaming state drives the UI again — the run loop's isFrontRun() flips and
  // pushes its accumulated snapshot on the next event.
  useEffect(() => {
    const sid = currentSessionId
    if (!sid) return
    if (streamingDrafts[sid]?.isAgentRunning && runningSessionIdRef.current !== sid) {
      runningSessionIdRef.current = sid
    }
  }, [currentSessionId, streamingDrafts])
  // Per-session running: any conversation whose draft is running (whether it's
  // the front run or a background run you switched to) shows busy state.
  const isRunning = useMemo(() => {
    return !!streamingDrafts[currentSessionId || '']?.isAgentRunning
  }, [streamingDrafts, currentSessionId])
  const isChatLoading = useHelixStore(s => s.isChatLoading)
  // Per-session busy: only the conversation that is itself running shows a
  // stop button. A global isChatLoading (even if set by a future caller) must
  // never lock the input of a different/new conversation.
  const isBusy = isRunning || (isChatLoading && runningSessionIdRef.current === currentSessionId)
  const isRunningSession = currentSessionId === runningSessionIdRef.current
  // 流式区（状态栏/思考块/运行时长计时）与暂停按钮用同一个信号：
  // 只要当前会话正处于运行中（isChatLoading 覆盖整个 handleRun），就展示计时。
  // 修复「任务在跑、暂停按钮在，但 mm:ss 计时消失」——之前计时只挂 isRunning，
  // 而暂停按钮挂 isBusy，isAgentRunning 标志与 isChatLoading 状态漂移时二者分离。
  const streamingActive = isRunning || (isChatLoading && !!runningSessionIdRef.current && runningSessionIdRef.current === currentSessionId)
  // Defensive trace: log transitions so we can catch silent session drift.
  const prevIsRunningRef = useRef<boolean>(isRunning)
  useEffect(() => {
    const prev = prevIsRunningRef.current
    if (isRunning !== prev) {
      debug('[HelixTrace] isRunning changed:', prev, '->', isRunning, {
        currentSessionId,
        runningSessionId: runningSessionIdRef.current,
        isRunningSession,
      })
      prevIsRunningRef.current = isRunning
    }
  }, [isRunning, currentSessionId, isRunningSession])

  // Email notification: when an agent run for the active session finishes and
  // notifications are enabled + an account is configured, email a short summary.
  const prevRunningForNotifyRef = useRef(false)
  useEffect(() => {
    const wasRunning = prevRunningForNotifyRef.current
    prevRunningForNotifyRef.current = isRunning
    if (wasRunning && !isRunning && isRunningSession) {
      const st = useHelixStore.getState()
      if (st.emailNotifyEnabled && st.emailConfigured) {
        const lastText = (sharedTextBufferRef.current || '').slice(-800) || '(无文本输出)'
        window.electron.email
          .notify({
            subject: 'Helix：Agent 运行已完成',
            text: `本次对话已完成。\n\n最后输出摘要：\n${lastText}`,
          })
          .catch(() => {})
      }
    }
  }, [isRunning, isRunningSession])
  const displaySteps = useMemo(() => {
    // Only show live state if viewing the run that currently owns it; otherwise
    // fall back to that conversation's own draft so a promoted run that hasn't
    // flushed yet never shows another run's stale steps.
    if (isRunningSession && liveStateOwnerRef.current === currentSessionId) return steps
    return streamingDrafts[currentSessionId || '']?.steps || []
  }, [isRunningSession, steps, streamingDrafts, currentSessionId, liveStateOwnerRef])
  const displayResponseBlocks = useMemo(() => {
    if (isRunningSession && liveStateOwnerRef.current === currentSessionId) return responseBlocks
    return streamingDrafts[currentSessionId || '']?.responseBlocks || []
  }, [isRunningSession, responseBlocks, streamingDrafts, currentSessionId, liveStateOwnerRef])
  const displayStreamThinking = useMemo(() => {
    if (isRunningSession && liveStateOwnerRef.current === currentSessionId) return streamThinking
    return streamingDrafts[currentSessionId || '']?.streamThinking || ''
  }, [isRunningSession, streamThinking, streamingDrafts, currentSessionId, liveStateOwnerRef])

  // Extract kaomoji status line from thinking content
  const { status: thinkingStatus, body: thinkingBody } = useMemo(
    () => extractKaomojiStatus(displayStreamThinking),
    [displayStreamThinking]
  )
  // Detect whether this session already has a completed assistant message.
  // When true, suppress the bare "reasoning..." placeholder in the streaming area
  // — the user can already see finished content (with copy buttons) above, and
  // the ThinkingTimer below still conveys "still running".
  //
  // Why not just check m.reasoning?  Because the done-handler may *move* reasoning
  // into content ("if !content && reasoning → content=reasoning; reasoning=''"),
  // leaving the committed message with reasoning=undefined even though it was
  // originally a thinking-only reply.  Checking for *any* assistant message is
  // simpler and covers every variant (pure text, reasoning-as-content, tool output,
  // etc.).
  const hasCompletedAssistant = useMemo(() => {
    return sessionMessages.some(m => m.role === 'assistant')
  }, [sessionMessages])

  // Currently-running tool calls, shown in the top status bar as
  // "正在执行工具：read xxx / bash xxx" instead of a bare "正在思考".
  const runningToolLabels = useMemo(() => {
    if (!isRunning) return [] as string[]
    const labels: string[] = []
    for (const block of displayResponseBlocks) {
      if (block.type !== 'tool_group') continue
      const walk = (steps: ExecutionStep[]) => {
        for (const step of steps) {
          if (step.type === 'tool_call' && step.status === 'running') {
            labels.push(getToolDisplayLabel(step.toolName || '', step.toolKind, undefined, step.toolParams))
          }
          if (step.subSteps && step.subSteps.length > 0) walk(step.subSteps)
        }
      }
      walk(block.steps)
    }
    // De-duplicate while preserving order
    return labels.filter((l, i, a) => a.indexOf(l) === i)
  }, [isRunning, displayResponseBlocks])
  const transcriptFontSize = useHelixStore(s => s.transcriptFontSize)
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const activeProviderId = useHelixStore(s => s.activeProviderId)
  const activeModel = useHelixStore(s => s.activeModel)
  const reasoningEffort = useHelixStore(s => s.reasoningEffort)
  const personality = useHelixStore(s => s.personality)
  const providers = useHelixStore(s => s.providers)
  const availableModels = useHelixStore(s => s.availableModels)
  const providerModels = useHelixStore(s => s.providerModels)
  const [currentBranch, setCurrentBranch] = useState('main')
  // Whether the currently-selected project is a git repo. null = unknown (still probing).
  // When false, the branch picker button is hidden (no git → nothing to show).
  const [gitAvailable, setGitAvailable] = useState<boolean | null>(null)
  // Stable action references — these never change so getState() is safe
  const connectionNotice = useHelixStore(s => s.connectionNotice)
  const storeActions = useMemo(() => useHelixStore.getState(), [])

  const handleCreateBranch = async (name: string) => {
    if (!name || !isElectron()) return
    const res = await electronGit.branchCreate(name, selectedWorkDir)
    if (res.ok) {
      setCurrentBranch(name)
      setBranchCreating(false)
      setBranchNewName('')
      setBranchPopoverOpen(false)
      // Refresh list so the new branch shows up next time
      electronGit.branchList(selectedWorkDir)
        .then((r: { ok: boolean; branches?: string[] }) => { if (r.ok && r.branches) setBranchList(r.branches) })
        .catch(() => {})
      storeActions.showToast({ type: 'success', title: `已创建并切换到 ${name}` })
    } else {
      storeActions.showToast({ type: 'error', title: '创建分支失败', description: res.error })
    }
  }

  // Close the branch picker popover on outside click.
  useEffect(() => {
    if (!branchPopoverOpen) return
    const onDown = (e: MouseEvent) => {
      if (branchPopoverRef.current && !branchPopoverRef.current.contains(e.target as Node)) {
        setBranchPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [branchPopoverOpen])

  // Clear stale connection notices on mount
  useEffect(() => {
    const notice = useHelixStore.getState().connectionNotice
    if (notice && notice.ts && Date.now() - notice.ts > 60000) {
      useHelixStore.getState().setConnectionNotice(null)
    }
  }, [])
  // Drop the cached Hermes ACP session when the project directory changes so the
  // next prompt opens a fresh session rooted at the new cwd.
  // 例外：对话正在运行（有 streamingDraft）时绝不删——否则下次 session/prompt 会拿一个
  // 已从 sessionMapRef 移除的死会话去 prompt.submit → 后端 4001 "session not found" → 模型停止。
  useEffect(() => {
    if (!currentSessionId) return
    const running = useHelixStore.getState().isAgentRunning
      || !!useHelixStore.getState().streamingDrafts?.[currentSessionId]
    if (!running) {
      sessionMapRef.current.delete(currentSessionId)
      persistSessionMap(sessionMapRef.current)
    }
  }, [selectedWorkDir])


  // Switching conversations: clear the *front-end* streaming UI so the newly
  // focused conversation starts with a clean panel. We deliberately do NOT
  // touch sessionMapRef / hermesSessionIdRef or cancel anything — a run that is
  // still streaming in a *background* conversation must keep going (true
  // concurrency: the backend supports N parallel sessions). Its sid stays in
  // the map; when you switch back, the run resumes rendering into the UI.
  useEffect(() => {
    setResponseBlocks([])
    setSteps([])
    setStreamThinking('')
    setStreamTotalTokens(0)
    // Sync the GLOBAL hermesSessionId to this conversation's backend session so
    // that consumers outside handleRun (ContextUsageIndicator, compaction, etc.)
    // target the RIGHT session.  Without this they read a stale global that still
    // points at a different conversation's session → "session not found" RPC errors.
    // Only trust a cached session if its gateway epoch still matches the live
    // epoch — a mismatch means the gateway restarted and the backend session is
    // dead. A dead id must NOT be advertised globally (it would make the
    // context-usage indicator query the wrong/empty session and show the same
    // usage for every conversation). Instead fall back to the per-conversation
    // store (contextUsage[currentSessionId], already persisted & correct).
    const entry = currentSessionId ? sessionMapRef.current.get(currentSessionId) : null
    const liveEpoch = useHermesStore.getState().gatewayEpoch
    const hermesSid = entry && entry.epoch === liveEpoch ? entry.sid : null
    hermesSessionIdRef.current = hermesSid
    try { useHermesStore.getState().setHermesSessionId(hermesSid) } catch {}
  }, [currentSessionId])

  // Restore persisted per-conversation sessions on mount so the conversation→
  // backend-session mapping survives an app restart. Dead sessions (epoch
  // mismatch after a gateway restart) are silently dropped — the run path
  // recreates them and the context-usage indicator falls back to the store.
  useEffect(() => {
    let cancelled = false
    loadSessionMap().then((m) => {
      if (cancelled) return
      sessionMapRef.current = m
      const cid = useHelixStore.getState().currentSessionId
      const entry = cid ? m.get(cid) : null
      const liveEpoch = useHermesStore.getState().gatewayEpoch
      const sid = entry && entry.epoch === liveEpoch ? entry.sid : null
      hermesSessionIdRef.current = sid
      try { useHermesStore.getState().setHermesSessionId(sid) } catch {}
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // When the gateway restarts (e.g. provider switch), ALL Hermes ACP sessions
  // are destroyed server-side. Clear our cached session id DIRECTLY on the
  // event (not via a store-effect indirection) so the very next handleRun
  // unconditionally recreates a fresh session. The store-effect approach was
  // unreliable: handleRun only wrote hermesSessionIdRef (never the store), so
  // the store stayed null and the [hermesSessionId] effect never re-fired on a
  // second restart — leaving a stale id in the ref and causing prompts to hit a
  // dead session with no output.
  useEffect(() => {
    const unsub = window.electron?.hermes?.onEvent?.((event: string) => {
      if (event === 'gateway.sessionInvalidated') {
        // All backend sessions are destroyed on restart — drop every cached id.
        sessionMapRef.current.clear()
        persistSessionMap(sessionMapRef.current)
        // Force the next run to re-verify the gateway is fully up (it may still
        // be recycling) rather than trusting hermesConnected which is already
        // true after a prior restart.
        sessionEpochRef.current = -1
      }
    })
    return () => { try { unsub?.() } catch {} }
  }, [])
  // When an SSH connection is established, reload MCP tools for the active
  // session so `remote_exec` becomes available immediately (the bridge server
  // was just written into config.yaml). Fire-and-forget — a failure just means
  // the tool appears on the next conversation / manual /reload-mcp.
  useEffect(() => {
    if (!isElectron() || !window.electron?.external?.onSshConnected) return
    const unsubSsh = window.electron.external.onSshConnected(() => {
      const sid = (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid) || hermesSessionIdRef.current
      if (!sid) return
      hermesApi()!.send('reload.mcp', { session_id: sid, confirm: true }).catch((e: any) => {
        console.warn('[Helix] reload.mcp after SSH connect failed:', e)
      })
    })
    return () => { try { unsubSsh?.() } catch {} }
  }, [currentSessionId])
  // Resolve current git branch for the empty-state breadcrumb.
  // Queries the *currently-selected project directory* (passed as cwd) rather than
  // relying on the Electron main-process workDir, so the branch follows the active
  // project/conversation instead of the last manually-picked folder.
  useEffect(() => {
    if (!selectedWorkDir || !isElectron()) return
    let cancelled = false
    const refresh = () => {
      electronGit.currentBranch(selectedWorkDir).then((res: { ok: boolean; branch?: string; error?: string }) => {
        if (cancelled) return
        if (res.ok && res.branch) {
          setCurrentBranch(res.branch)
          setGitAvailable(true)
        } else {
          // Not a git repo (or git unavailable) → hide the branch button.
          setGitAvailable(false)
        }
      }).catch(() => setGitAvailable(false))
    }
    refresh()
    const timer = setInterval(refresh, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [selectedWorkDir])

  const hasApiKey = !!apiConfig.apiKey

  // Resolve the provider that owns the current backend endpoint.
  // Primary key: activeProviderId when it still matches the current baseUrl.
  // This prevents the input-bar model list from switching to a different
  // provider entry that happens to share the same base URL (e.g. a custom
  // DeepSeek profile vs. the built-in DeepSeek entry). If the id is stale or
  // points to a different endpoint, fall back to baseUrl matching.
  const activeProvider = useMemo(
    () => {
      if (activeProviderId) {
        const byId = providers.find((p) => p.id === activeProviderId)
        if (byId && (!apiConfig?.baseUrl || byId.baseUrl === apiConfig.baseUrl)) {
          return byId
        }
      }
      if (apiConfig?.baseUrl) {
        return providers.find((p) => p.baseUrl === apiConfig.baseUrl) || null
      }
      return null
    },
    [providers, activeProviderId, apiConfig?.baseUrl],
  )
  // Model list for the dropdown — scoped to the active endpoint. We merge ALL
  // providers (and their fetched lists) that share the current baseUrl. This
  // fixes the common case where a built-in provider and a custom profile point
  // to the same endpoint (e.g. DeepSeek): the model may have been fetched under
  // one provider id while `activeProvider` resolved to the other, causing the
  // dropdown to miss the selected model and auto-snap back to the default.
  const modelList = useMemo(() => {
    const baseUrl = activeProvider?.baseUrl || apiConfig?.baseUrl
    const candidates = baseUrl
      ? providers.filter((p) => p.baseUrl === baseUrl)
      : activeProvider
        ? [activeProvider]
        : []
    const set = new Set<string>()
    for (const p of candidates) {
      if (p.id && providerModels[p.id]?.length) {
        providerModels[p.id].forEach((m) => { if (m) set.add(m) })
      }
      if (p.models?.length) {
        p.models.forEach((m) => { if (m) set.add(m) })
      }
    }
    // Always surface the currently selected model so the button/dropdown never
    // shows a stale name and the selection survives transient list gaps.
    if (apiConfig.model) set.add(apiConfig.model)
    return Array.from(set)
  }, [activeProvider, providerModels, providers, apiConfig?.baseUrl, apiConfig.model])


  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false)
      }
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(event.target as Node)) {
        setShowFolderDropdown(false)
      }
      if (approvalModeDropdownRef.current && !approvalModeDropdownRef.current.contains(event.target as Node)) {
        setShowApprovalModeDropdown(false)
      }
    }
    if (showModelDropdown || showFolderDropdown || showApprovalModeDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelDropdown, showFolderDropdown, showApprovalModeDropdown])

  // The dropdown shows ONLY the active provider's models (modelList). If the
  // current model doesn't belong to that provider (e.g. after switching the
  // provider in Settings, or a stale persisted value), snap to the provider's
  // first model so the button never shows a different supplier's model name
  // than the list. A model genuinely owned by the active provider is already in
  // modelList, so we won't snap away from a valid selection.
  useEffect(() => {
    if (modelList.length === 0) return
    const store = useHelixStore.getState()
    const current = store.apiConfig.model
    if (current && modelList.includes(current)) return
    // If the active provider's fetched list hasn't loaded yet, the current model
    // may be valid but only present in the fetched list. Skip the snap to avoid
    // overwriting the user's explicit selection with a stale fallback.
    const pid = activeProvider?.id
    const hasFetched = pid && (store.providerModels?.[pid]?.length ?? 0) > 0
    if (!hasFetched) return
    const fixed = modelList[0]
    if (current !== fixed) store.setActiveModel(fixed)
    // Depend on a STABLE primitive signature of modelList, NOT the array itself
    // and never spread it. Spreading [...modelList] makes the deps array change
    // size whenever the fetched list grows (e.g. a 4th model loads), which
    // throws "changed size between renders". The join('|') string changes only
    // when the set of models actually changes, and always stays length 3.
  }, [activeProvider?.id, apiConfig.model, modelList.join('|')])
  // Shared tail for a model switch. Cancels the in-flight session, invalidates
  // the cached session id, then pushes the freshly-resolved config to the
  // backend. The ordering here is what prevents the swap-401: `cacheConfig`
  // must run BEFORE `setConfig`, because on restart Hermes reads the cache via
  // applyActiveProfileCache — so the cache must already hold the NEW key when
  // setConfig restarts the gateway.
  const syncConfigToBackend = useCallback(async () => {
    // 1) Cancel any in-flight session FIRST (while the id is still valid).
    // Use the per-conversation session from sessionMapRef — NOT the global
    // hermesSessionIdRef, which may have been overwritten by another run.
    const currentSid = (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid) || null
    if (isElectron() && currentSid) {
      try { electronHermes.notify('session/cancel', { session_id: currentSid }) } catch {}
    }
    // 2) Invalidate the session so the next prompt rebuilds it from config.yaml.
    useHermesStore.getState().setHermesSessionId(null)
    if (currentSessionId) {
      sessionMapRef.current.delete(currentSessionId)
      persistSessionMap(sessionMapRef.current)
    }
    // 3) Push the resolved config (provider+baseUrl+apiKey+model) to the backend.
    if (isElectron()) {
      const store = useHelixStore.getState()
      const cfg = store.apiConfig
      // Use the ACTIVE provider's stored key. We must NOT fall back to a stale
      // in-memory apiConfig.apiKey: after a reload it can be empty/stale, and
      // pushing it would send the PREVIOUS provider's key — the classic swap-401.
      // When the resolved key is genuinely empty, push '' and let the backend
      // (main.js) fall back to the target provider's own key stored in
      // config.yaml's custom_providers block (which is correct on disk).
      const provider = store.activeProviderId
        ? store.providers.find((p) => p.id === store.activeProviderId)
        : undefined
      const resolvedKey = provider?.apiKey || cfg.apiKey || ''
      const push = {
        model: cfg.model,
        provider: cfg.provider && cfg.provider !== '__custom__' ? cfg.provider : 'custom',
        baseUrl: cfg.baseUrl,
        apiKey: resolvedKey,
      }
      debug(`[config-switch] → provider=${push.provider} baseUrl=${push.baseUrl} model=${push.model} apiKey=${resolvedKey ? resolvedKey.substring(0, 6) + '…' : '(EMPTY → backend falls back to target provider stored key)'}`)
      // Flush IMMEDIATELY (bypass the 1.2s debounce). A model switch is an
      // explicit user action and must persist to active-profile.json + config.yaml
      // right away — otherwise closing/restarting within the debounce window leaves
      // the cache stale and the next launch reverts to the previous model.
      pushModelConfig(push)
    }
  }, [])

  // Handle model selection within the ACTIVE provider. The provider itself is
  // switched only on the settings page; the input bar lists just the active
  // provider's models, so this always resolves cleanly via setActiveModel
  // (which mirrors the resolved config into apiConfig). Shares the full
  // cancel + invalidate + push tail so a model switch also rebuilds the
  // session from config.yaml — never a stale key.
  const handleModelSelect = useCallback(async (model: string) => {
    useHelixStore.getState().setActiveModel(model)
    // Keep the hermes-ui provider store in sync too. It persists its own
    // activeModel separately, and helix-layout.tsx bridges THAT store into the
    // Helix store on launch — so if we don't update it here, a restart would
    // re-read the stale value (e.g. the previously-selected pro) and the bridge
    // would overwrite the Helix store back to it.
    useProviderStore.getState().setActiveModel(model)
    // setActiveModel already records the activation into apiHistory (settings
    // model list highlight) — no separate addApiHistory needed here.
    // Persist the API-related state only. The full persistToStorage() is too
    // heavy for a model switch: it re-serializes the ENTIRE chat session
    // (every message) plus all settings to IndexedDB on the main thread. The
    // bridge (onModelSwitched) already persisted these four keys when
    // useProviderStore.setActiveModel fired above; this covers the fallback
    // branch where the bridge found no owning provider and skipped persisting.
    import('@/lib/persist').then(({ persistence }) => {
      const st = useHelixStore.getState()
      persistence.saveSetting('apiHistory', st.apiHistory)
      persistence.saveSetting('apiConfig', st.apiConfig)
      persistence.saveSetting('activeModel', st.activeModel)
      persistence.saveSetting('activeProviderId', st.activeProviderId)
    })
    setShowModelDropdown(false)
    await syncConfigToBackend()
  }, [syncConfigToBackend])

  // Model selector for the active provider only. Rendered in BOTH input-bar
  // layouts (empty-state and active-conversation) via this helper so the
  // markup isn't duplicated.
  //
  // Display source of truth: `apiConfig.model`. This is what the Hermes backend
  // reads and what every mutation path (click handler / applyProfile /
  // handleSaveApi / handleModelSelect) writes. Using `activeModel` as the
  // display source caused persistent drift because auto-correct effects and
  // stale fallback chains could leave the button showing a PREVIOUS supplier's
  // model name while the backend was already on the new one.
  const renderModelSelector = () => {
    const displayName = apiConfig.model || activeModel || (modelList[0] || null) || '选择模型'
    // DROPDOWN HIGHLIGHT uses the SAME expression as the button display
    // (apiConfig.model first), so the highlighted item and the button text can
    // never disagree. Using activeModel-first here caused a visible mismatch:
    // when activeModel was stale (e.g. still "flash" after saving a different
    // model from Settings, which only writes apiConfig.model), the button showed
    // the new model while the dropdown kept highlighting the old one.
    const selectedForHighlight = apiConfig.model || activeModel
    return (
    <>
      {/* Model selector — wide button matching settings page style */}
      <div className="relative" ref={modelDropdownRef}>
        <button
          type="button"
          onClick={() => {
            const opening = !showModelDropdown
            setShowModelDropdown(!showModelDropdown)
            // 打开下拉且当前 provider 还没有抓取过的模型列表时，自动拉取，
            // 免去用户手动去设置页点"获取模型列表"。覆盖冷启动 / applyProfile
            // 等未经过 setActiveModel 的激活路径；成功后 providerModels 持久化，
            // 之后不再重复拉取。
            if (opening) {
              const st = useHelixStore.getState()
              // Always refresh the active provider's model list on open. The
              // dropdown is scoped to this provider, so a single endpoint probe
              // is enough. Forcing a re-fetch (rather than only when the cache is
              // empty) means newly-added models (e.g. a fresh ling-pro) show up
              // immediately, and we never rely on a possibly-stale persisted list.
              // Use the baseUrl-resolved activeProvider, NOT the raw
              // activeProviderId — the latter can be stale after saving a
              // different provider's config, which would probe the wrong endpoint
              // and leave the selector showing only the declared model.
              const pid = activeProvider?.id || st.activeProviderId
              if (pid) {
                st.fetchProviderModels(pid)
              }
            }
          }}
          className="flex items-center justify-between gap-2 min-w-[80px] max-w-[140px] px-2.5 py-1.5 h-7 bg-muted/30 border border-border/30 rounded-lg text-[13px] text-foreground hover:bg-muted/30 hover:border-border/30 transition-all duration-200 font-mono"
        >
          <span className="truncate">{displayName}</span>
          <svg className={`size-3.5 text-muted-foreground transition-transform shrink-0 ${showModelDropdown ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        {showModelDropdown && (
          <div className="absolute bottom-full right-0 mb-2 min-w-[220px] max-w-[360px] max-h-56 overflow-y-auto bg-popover border border-border/40 rounded-xl shadow-xl z-50 p-1 animate-scale-in">
            {modelList.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => handleModelSelect(m)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm font-mono transition-colors ${
                  m === selectedForHighlight
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-foreground/70 hover:bg-muted'
                }`}
              >
                <span className="truncate">{m}</span>
              </button>
            ))}
            {modelList.length === 0 && (
              <div className="px-3 py-2 text-sm text-foreground/40">
                暂无可用模型
              </div>
            )}
          </div>
        )}
      </div>
    </>
    )
  }

  // Handle skill selection
  const handleSkillSelect = useCallback((skill: { name: string; description?: string }) => {
    setInputSynced(`/${skill.name} `)
    inputRef.current?.focus()
  }, [setInputSynced])

  // Fetch file-based skills on mount (via Hermes skills bridge — no backend)
  useEffect(() => {
    if (fileSkills.length > 0) return
    if (typeof window === 'undefined' || !window.electron?.hermesSkills) return
    window.electron.hermesSkills.listSkills()
      .then((list: any) => {
        if (Array.isArray(list)) {
          setFileSkills(list.map((s: any) => ({ name: s.name, description: s.description || '' })))
        }
      })
      .catch(() => {})
  }, [fileSkills.length])

  // Reset when chat is cleared
  useEffect(() => {
    if (chatMessages.length === 0) {
      setResponseBlocks([])
      setSteps([])
      setInputSynced('')
      setApprovalQueue([])
    }
  }, [chatMessages.length, setInputSynced])

  // Filter skills based on input (exclude unwanted system/prompt skills)
  const SKILL_DENYLIST = useMemo(() => new Set(['项目里面有什么']), [])
  const allSkills = useMemo(() => [
    ...skills.map(s => ({ name: s.name, description: s.description, id: s.id, icon: s.icon })).filter(s => !SKILL_DENYLIST.has(s.name)),
    ...fileSkills.map(s => ({ name: s.name, description: s.description, id: s.name, icon: undefined })).filter(s => !SKILL_DENYLIST.has(s.name)),
  ], [skills, fileSkills, SKILL_DENYLIST])

  // Built-in slash commands handled on the client side (not sent to Hermes as
  // regular prompts).  These show up in the "/" autocomplete picker alongside
  // skills, Hermes commands, and shell commands.
  const BUILTIN_COMMANDS = useMemo(() => [
    { name: 'compact', description: '压缩上下文', action: 'compact' as const },
    { name: 'clear', description: '清空当前对话', action: 'clear' as const },
    { name: 'reset', description: '重置会话（清空对话+上下文）', action: 'reset' as const },
    { name: 'mcp', description: '管理 MCP 服务器', action: 'mcp' as const },
    { name: 'model', description: '切换到模型选择设置', action: 'model' as const },
    { name: 'skill', description: '打开技能管理面板', action: 'skill' as const },
  ], [])

  // Merge local skills with Hermes slash commands
  const allSlashItems = useMemo(() => {
    const builtinCmds = BUILTIN_COMMANDS.map(c => ({
      name: c.name,
      description: c.description,
      id: 'builtin:' + c.name,
      icon: undefined as string | undefined,
      isBuiltinCommand: true,
      action: c.action,
    }))
    const hermesCmds = (availableCommands || []).map(cmd => ({
      name: cmd.name,
      description: cmd.description || '',
      id: '/' + cmd.name,
      icon: undefined as string | undefined,
      isHermesCommand: true,
    }))
    return [...builtinCmds, ...allSkills, ...hermesCmds]
  }, [allSkills, availableCommands, BUILTIN_COMMANDS])

  const filteredSkills = useMemo(() => {
    if (input.startsWith('/')) {
      const query = input.slice(1).toLowerCase()
      return allSlashItems.filter(s => s.name.toLowerCase().includes(query))
    }
    return allSlashItems
  }, [allSlashItems, input])
  const slashCmd = input.startsWith('/') ? input.slice(1).split(' ')[0].toLowerCase() : ''
  const matchedQuickCmds = input.startsWith('/') ? QUICK_COMMANDS.filter(c => !slashCmd || c.cmd.slice(1).startsWith(slashCmd)) : []
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0)
  const [slashMenuOpen, setSlashMenuOpen] = useState(true)
  const showSlashMenu = input.startsWith('/') && slashMenuOpen && (filteredSkills.length > 0 || matchedQuickCmds.length > 0) && !input.includes(' ')

  // Handle input change for skill detection
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInputSynced(value)
    setSelectedSkillIndex(0) // Reset selection when input changes
    setSlashMenuOpen(true) // typing re-opens the slash menu
    // Detect @ file reference trigger
    const atIdx = value.lastIndexOf('@')
    if (atIdx >= 0 && (atIdx === 0 || /[\s\n]/.test(value[atIdx - 1]))) {
      const query = value.slice(atIdx + 1).toLowerCase()
      const files = workspaceFilesRef.current
      const filtered = files.filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
      setFilteredAtFiles(filtered.slice(0, 12))
      setShowAtRef(filtered.length > 0)
      setSelectedAtFileIndex(0)
    } else {
      setShowAtRef(false)
    }
  }, [setInputSynced])

  // Close the slash-command menu when clicking outside the chat input.
  useEffect(() => {
    if (!slashMenuOpen) return
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (chatInputWrapRef.current && !chatInputWrapRef.current.contains(target)) {
        setSlashMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [slashMenuOpen])

  // Auto-scroll to bottom (stop when user scrolls up)
  const userScrolledUpRef = useRef(false)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current || userScrolledUpRef.current) return
    const viewport = scrollRef.current
    if (viewport) {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight
      })
    }
  }, [])
  const jumpToBottom = useCallback(() => {
    userScrolledUpRef.current = false
    setUserScrolledUp(false)
    if (!scrollRef.current) return
    const viewport = scrollRef.current
    if (viewport) {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight
      })
    }
  }, [])

  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const handleScroll = () => {
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100
      userScrolledUpRef.current = !atBottom
      setUserScrolledUp(!atBottom)
    }
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (!userScrolledUpRef.current) scrollToBottom()
  }, [steps, scrollToBottom])

  // When switching to / loading a conversation, jump straight to the latest
  // message (bottom) instead of showing it from the top.
  useEffect(() => {
    userScrolledUpRef.current = false
    setUserScrolledUp(false)
    const viewport = scrollRef.current
    if (!viewport) return
    // Two rAFs to ensure the newly loaded messages are laid out first.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight
      })
    })
     
  }, [currentSessionId])

  useEffect(() => {
    if (isRunning) {
      const interval = setInterval(scrollToBottom, 200)
      return () => clearInterval(interval)
    }
  }, [isRunning, scrollToBottom])

  // Sync local steps when store execution flow is cleared externally (e.g. New task)
  useEffect(() => {
    if (agentExecutionSteps.length === 0 && steps.length > 0) {
      setSteps([])
      savedSessionRef.current = false
    }
  }, [agentExecutionSteps.length, steps.length])

  // Reset save ref when chat is cleared
  const prevMsgLen = useRef(chatMessages.length)
  useEffect(() => {
    // Detect clear: messages went from many to few (welcome message)
    if (prevMsgLen.current > 2 && chatMessages.length <= 1) {
      savedSessionRef.current = false
    }
    prevMsgLen.current = chatMessages.length
  }, [chatMessages.length])

  // Scan workspace files for @ file references
  useEffect(() => {
    if (!window.electron?.isElectron) return
    if (workspaceFilesLoadedRef.current) return
    workspaceFilesLoadedRef.current = true
    ;(async () => {
      try {
        // First try getting git status for most recent files
        const gitResult = await window.electron.git.status()
        if (gitResult?.ok) {
          const files: Array<{ name: string; path: string }> = []
          for (const line of gitResult.output!.split('\n')) {
            const m = line.match(/\s+(\S+)$/)
            if (m && !files.some(f => f.path === m[1])) {
              const parts = m[1].split(/[/\\]/)
              files.push({ name: parts[parts.length - 1], path: m[1] })
            }
          }
          if (files.length > 0) { workspaceFilesRef.current = files; return }
        }
      } catch {}
      try {
        // Fallback: scan workspace tree
        const tree = await window.electron.fs.scanTree('.')
        if (Array.isArray(tree)) {
          const files: Array<{ name: string; path: string }> = []
          function walk(nodes: any[], prefix: string) {
            for (const n of nodes) {
              if (n.type === 'file') {
                files.push({ name: n.name, path: prefix ? prefix + '/' + n.name : n.name })
              } else if (n.type === 'folder' && n.children) {
                walk(n.children, prefix ? prefix + '/' + n.name : n.name)
              }
            }
          }
          walk(tree, '')
          workspaceFilesRef.current = files
        }
      } catch {}
    })()
  }, [])


  // Clear flow

  // Tab management
  const handleNewTab = useCallback(() => {
    const state = useHelixStore.getState()
    // Save current input before switching
    if (state.currentSessionId) {
      state.setTabInput(state.currentSessionId, inputValueRef.current)
    }
    state.clearChat()
    state.setCurrentSessionId(null)
  }, [])

  const handleCloseTab = useCallback((sessionId: string) => {
    const state = useHelixStore.getState()
    const history = state.sessionHistory
    if (history.length <= 1 && sessionId === state.currentSessionId) return // Don't close last tab
    state.clearTabInput(sessionId)
    state.clearStreamingDraft?.(sessionId)
    // Remove from history
    const newHistory = history.filter(id => id !== sessionId)
    // If closing active tab, switch to another one
    if (sessionId === state.currentSessionId) {
      const next = newHistory[newHistory.length - 1] || null
      state.setCurrentSessionId(next)
    }
    useHelixStore.setState({ sessionHistory: newHistory })
  }, [])

  const handleSwitchTab = useCallback((sessionId: string) => {
    const state = useHelixStore.getState()
    // Save current input
    if (state.currentSessionId) {
      state.setTabInput(state.currentSessionId, inputValueRef.current)
    }
    // Restore input for target session
    const savedInput = state.tabInputs[sessionId] || ''
    setInputSynced(savedInput)
    debug('[HelixTrace] switchTab', { from: useHelixStore.getState().currentSessionId, to: sessionId })
    state.setCurrentSessionId(sessionId)
  }, [setInputSynced])

  const handleClear = useCallback(() => {
    setSteps([])
    storeActions.clearSelectedFiles()
    storeActions.setSelectedWorkDir(null)
    storeActions.clearExecutionFlow()
  }, [storeActions.clearExecutionFlow, storeActions.clearSelectedFiles])

  // Select project directory. Must go through setWorkDir (not just
  // setSelectedWorkDir) so the Electron main process workDir is synced AND
  // workDirEpoch bumps — otherwise useHermes keeps reusing the stale Hermes
  // session rooted at the old cwd, so the UI shows the new dir while Hermes
  // actually operates in the old one.
  const selectWorkDir = useCallback(async (dir: string | null) => {
    if (!dir) {
      storeActions.setSelectedWorkDir(null)
      return
    }
    useHelixStore.getState().setCurrentSessionId(null)
    await storeActions.setWorkDir(dir)
  }, [storeActions.setWorkDir, storeActions.setSelectedWorkDir])

  // Stop running agent (accepts optional sessionId to target specific session)
  const handleStop = useCallback((targetSessionId?: string) => {
    // `cid` 必须是「前端对话 id」——abortControllersRef 和 streamingDrafts 都
    // 以它为 key（handleRun 里 set(activeSessionId, controller)）。旧代码用
    // sessionMapRef.get(currentSessionId)?.sid（后端 sid）作 lookup key，
    // 两个 map 都 miss → 落到 abortRef.current（最近启动的 run）→ 并发时停错
    // 对话；且 setStreamingDraft(后端sid) 写进幻影 key，当前对话的 running 态
    // 永远不清除 → 「点暂停没用，只能回车」。
    const cid = targetSessionId || currentSessionId || runningSessionIdRef.current
    debug('[HelixTrace] handleStop start', { cid })
    if (synthDoneTimerRef.current) {
      clearTimeout(synthDoneTimerRef.current)
      synthDoneTimerRef.current = null
    }
    // Abort the targeted conversation's run only. Parallel runs in other
    // conversations keep streaming — abortRef points at the most recent run,
    // so prefer the per-session controller when a specific session is targeted.
    const ctl = (cid && abortControllersRef.current.get(cid)) || abortRef.current
    if (ctl) {
      ctl.abort()
      if (abortRef.current === ctl) abortRef.current = null
      if (cid) abortControllersRef.current.delete(cid)
    }
    if (cid) {
      setStreamingDraft(cid, { isAgentRunning: false })
    }
    useHelixStore.setState({ isChatLoading: false })
    try {
      // 后端 session id = sessionMapRef[cid].sid（新建对话可能为 null，跳过取消）。
      const sessionId = (cid && sessionMapRef.current.get(cid)?.sid) || null
      if (sessionId && isElectron()) {
        debug('[HelixTrace] handleStop cancel', { cid, sessionId })
        // session/cancel via the serve-aware bridge. The run's own AbortController
        // listener (registered at the run site) also fires this on abort; keep an
        // explicit send here as a safety net. (interrupt === notify('session/cancel')
        // in main.js, so one call suffices.)
        electronHermes.notify('session/cancel', { session_id: sessionId })
      }
    } catch (e) {
      console.error('[handleStop] Failed to interrupt Hermes:', e)
    }
  }, [setStreamingDraft, currentSessionId, isBusy, isRunning])

  // File picker handler
  const addSelectedFile = useHelixStore(s => s.addSelectedFile)
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    // Upload selected files as pending attachments
    const attachments = await Promise.all(
      Array.from(files).map(f => fileToAttachment(f).catch(() => null))
    )
    const valid = attachments.filter((a): a is FileAttachment => a !== null)
    if (valid.length > 0) setPendingFiles(prev => [...prev, ...valid])

    // Reset input so selecting the same file again triggers onChange
    e.target.value = ''
  }, [])

  // Handle skill file upload
  const handleSkillUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/skills', { method: 'POST', body: form })
      if (!res.ok) throw new Error('上传失败')
    } catch (err) {
      storeActions.showToast({ type: 'error', title: '技能上传失败', description: String(err) })
    }
    e.target.value = ''
  }, [storeActions.showToast])

  // Handle new project creation
  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) {
      return
    }

    if (isElectron()) {
      // Use Electron to create directory
      const dir = await electronDialog.openDirectory()
      if (dir) {
        const projectPath = `${dir}/${newProjectName.trim()}`
        try {
        await (window as any).electron?.fs?.write(`${projectPath}/.gitkeep`, '')
        selectWorkDir(projectPath)
          setShowNewProjectForm(false)
          setNewProjectName('')
          storeActions.showToast({ type: 'success', title: '项目已创建', description: projectPath })
        } catch (err) {
          storeActions.showToast({ type: 'error', title: '创建失败', description: String(err) })
        }
      }
    } else {
      // Browser mode: just set the project name as work dir hint
      selectWorkDir(newProjectName.trim())
      setShowNewProjectForm(false)
      setNewProjectName('')
      storeActions.showToast({ type: 'success', title: '项目已设置', description: newProjectName.trim() })
    }
  }, [newProjectName, storeActions.showToast])

  // Resolve /command -> skill name + user query
  const resolveCommand = useCallback((text: string): { skillName: string; name: string; query: string } | null => {
    const match = text.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (!match) return null
    const cmd = match[1].toLowerCase()
    const rest = match[2].trim()
    const skill = skills.find(s => s.id === cmd || s.name.toLowerCase() === cmd)
    if (skill) return { skillName: skill.id, name: skill.name, query: rest || text }
    const fileSkill = fileSkills.find(s => s.name.toLowerCase() === cmd)
    if (fileSkill) return { skillName: fileSkill.name, name: fileSkill.name, query: rest || text }
    return null
  }, [skills, fileSkills])

  // Run agent task
  const handleRun = useCallback(async () => {
    // Alias of the component-level shared textBufferRef — the run shadows that
    // name with its own local buffer below, but the finally block still needs to
    // refresh the shared one for the email-notify effect.
    const outerTextBufferRef = sharedTextBufferRef
    const currentInput = inputValueRef.current
    const cmd = resolveCommand(currentInput.trim())
    const trimmed = currentInput.trim()
    if (!trimmed && pendingImages.length === 0 && pendingFiles.length === 0) return

    // Lock isBusy to true BEFORE any async gap so the button NEVER flips
    // back to "send" while the agent is in-flight (even if streamingDrafts
    // temporarily loses its isAgentRunning flag due to session-id drift or
    // a draft clear). Without this, the user sees the send button reappear,
    // clicks it, and ACP receives a second prompt → "Queued (1 queued)" and
    // the model gets interrupted mid-thought.
    useHelixStore.setState({ isChatLoading: true })

    // --- Built-in slash commands (handled client-side, never sent to Hermes) ---
    const builtinMatch = trimmed.match(/^\/(\S+)/)
    if (builtinMatch) {
      const builtin = BUILTIN_COMMANDS.find(c => c.name === builtinMatch[1].toLowerCase())
      if (builtin) {
        setInputSynced('')
        resetInputHeight()
        switch (builtin.action) {
          case 'compact': {
            // Compact: call backend session.compress RPC and update frontend messages
            try {
              const result = await hermesApi()?.send('session.compress', { session_id: currentSessionId })
              if (result && typeof result === 'object') {
                const r = result as any
                if (r.status === 'compressed' && Array.isArray(r.messages)) {
                  // Update frontend messages with compressed messages from backend
                  const msgs = r.messages.map((m: any) => ({
                    id: m.id || generateId(),
                    role: m.role as 'user' | 'assistant' | 'system',
                    content: m.content || '',
                    images: m.images,
                    timestamp: m.timestamp || Date.now(),
                    reasoning: m.reasoning,
                    steps: m.steps,
                    sessionId: currentSessionId,
                  }))
                  useHelixStore.setState({ chatMessages: msgs })
                  storeActions.showToast({ type: 'success', title: '上下文已压缩' })
                } else if (r.status === 'aborted') {
                  storeActions.showToast({ type: 'warning', title: '压缩已中止' })
                } else {
                  storeActions.showToast({ type: 'success', title: '上下文已压缩' })
                }
              }
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '压缩失败', description: String(e) })
            }
            break
          }
          case 'reset': {
            // Reset: clear messages + reset backend session (model forgets history)
            if (currentSessionId) {
              sessionMapRef.current.delete(currentSessionId)
              persistSessionMap(sessionMapRef.current)
            }
            await storeActions.clearChatInPlace()
            storeActions.showToast({ type: 'success', title: '会话已重置' })
            break
          }
          case 'clear': {
            // Clear: only clear frontend messages (keep backend session alive)
            await storeActions.clearChatInPlace()
            break
          }
          case 'mcp':
            storeActions.toggleSettings('mcp')
            break
          case 'model':
            storeActions.toggleSettings('api')
            break
          case 'skill':
            storeActions.toggleSettings('skills')
            break
        }
        // Builtin commands are instant client-side operations — never leave the
        // isChatLoading flag stuck true (it was set before this branch).
        useHelixStore.setState({ isChatLoading: false })
        return
      }
    }

    // Track skill invocation count
    if (cmd) {
      window.electron?.hermesSkills?.trackSkillCall(cmd.name).catch?.(() => {})
    }

    // If the CURRENT session is running AND receiving a new send, stop it first
    // (toggle send/stop is per-session — other sessions keep running). A brand
    // new conversation (currentSessionId === null) has no draft of its own, so
    // it must NEVER stop another session's run; it always starts a fresh
    // concurrent run instead.
    const activeDraft = currentSessionId ? streamingDrafts[currentSessionId] : undefined
    if (activeDraft?.isAgentRunning) {
      handleStop(currentSessionId ?? undefined)
      return
    }

    // Check API key — serve 模式下密钥由 Hermes 托管，Helix 侧 apiConfig.apiKey
    // 为空，跳过该门否则发送会被永久拦截（"发送按钮无效"）。
    if (!hasApiKey && !isServeActive()) {
      storeActions.toggleSettings('api')
      return
    }

    setInputSynced('')
    resetInputHeight()
    // questionStartTs (the live timer anchor) is set per-run right after the
    // per-run shadows are declared, only when THIS run is front — so a parallel
    // run starting in another conversation never resets the focused timer.
    runStartedAtRef.current = Date.now()
    debug('[HelixTrace] handleRun start', {
      input: typeof trimmed === 'string' ? trimmed.slice(0, 80) : trimmed,
      currentSessionId,
      pendingImages: pendingImages.length,
      pendingFiles: pendingFiles.length,
    })
    let activeSessionId = currentSessionId
    // ── Front-run guard for true concurrency ───────────────────────────────────
    // Each concurrent run has its own Hermes session + queue, but the panel shares
    // one set of UI states (responseBlocks/steps/streamThinking). Only the run
    // whose conversation is currently focused may write them; background runs
    // keep streaming to the backend without touching the shared UI. Declared here
    // (before try) so both the pre-try resets and the finally block can use it.
    const isFrontRun = () => useHelixStore.getState().currentSessionId === activeSessionId
    // ── Per-run streaming state (true concurrency) ───────────────────────────
    // The component-level refs (textBufferRef, stepsRef, …) are shared across
    // every handleRun invocation. With parallel runs that was fatal: a run
    // started in another conversation wiped the focused run's buffers, the
    // first `done` set the shared doneProcessedRef so later runs never
    // committed, and the shared finally cleared the wrong draft — the "switched
    // away and the old chat stopped" bug. Each run now shadows those refs with
    // its OWN buffers; only the focused run pushes them into the UI via the
    // isFrontRun()-guarded setters below, and each run persists its accumulated
    // state to its own per-session draft (syncDraft) for switch-back.
    const textBufferRef = { current: '' }
    const thoughtBufferRef = { current: '' }
    const lastStreamedTextRef = { current: '' }
    const stepsRef = { current: [] as ExecutionStep[] }
    const responseBlocksRef = { current: [] as ResponseBlock[] }
    const streamThinkingRef = { current: '' }
    const doneProcessedRef = { current: false }
    const usageReceivedRef = { current: false }
    const streamCappedRef = { current: false }
    const thinkingCappedRef = { current: false }
    const pendingTextRef = { current: null as string | null }
    const pendingThinkingRef = { current: null as string | null }
    const pendingBlocksRef = { current: [] as Array<{ type: 'thinking' | 'text'; content: string }> }
    const rafPendingRef = { current: false }
    const promptSentAtRef = { current: 0 }
    const firstContentAtRef = { current: 0 }
    const thinkingStartTimeRef = { current: 0 }
    const thinkingDurationRef = { current: 0 }
    const thoughtTokensRef = { current: 0 }
    const outputTokensRef = { current: 0 }
    const totalTokensRef = { current: 0 }
    const synthDoneTimerRef = { current: null as ReturnType<typeof setTimeout> | null }
    const forceDoneTimerRef = { current: null as ReturnType<typeof setTimeout> | null }
    const startedAtRef = { current: 0 }
    // Tracks whether THIS run is the one currently driving the shared UI state.
    // On a background→front transition the accumulated snapshot is pushed first
    // so the live state never mixes two runs' data.
    let wasFront = isFrontRun()
    const uiRB = (u: any) => {
      responseBlocksRef.current = typeof u === 'function' ? u(responseBlocksRef.current) : u
      if (!isFrontRun()) { wasFront = false; return }
      if (!wasFront) { wasFront = true; setResponseBlocks(responseBlocksRef.current) }
      setResponseBlocks(u)
      liveStateOwnerRef.current = activeSessionId
    }
    const uiSteps = (u: any) => {
      stepsRef.current = typeof u === 'function' ? u(stepsRef.current) : u
      if (!isFrontRun()) { wasFront = false; return }
      if (!wasFront) { wasFront = true; setSteps(stepsRef.current) }
      setSteps(u)
      liveStateOwnerRef.current = activeSessionId
    }
    const uiST = (u: any) => {
      streamThinkingRef.current = u
      if (!isFrontRun()) { wasFront = false; return }
      if (!wasFront) { wasFront = true; setStreamThinking(streamThinkingRef.current) }
      setStreamThinking(u)
      liveStateOwnerRef.current = activeSessionId
    }
    const uiTotalTokens = (u: any) => {
      totalTokensRef.current = u
      if (!isFrontRun()) { wasFront = false; return }
      if (!wasFront) { wasFront = true; setStreamTotalTokens(totalTokensRef.current) }
      setStreamTotalTokens(u)
      liveStateOwnerRef.current = activeSessionId
    }
    // Push this run's accumulated state into its own per-session draft so the
    // streaming content survives switching away and back. Throttled to one
    // store write per animation frame (same cost model as the old shared sync).
    let draftSyncPending = false
    let runCompleted = false  // Guard: once finally sets this, stop writing isAgentRunning=true
    const syncDraft = () => {
      if (draftSyncPending) return
      draftSyncPending = true
      requestAnimationFrame(() => {
        draftSyncPending = false
        // The run is over: the completed message is already committed to
        // chatMessages, and finally already cleared the draft's responseBlocks.
        // A straggler rAF must NOT re-populate the draft (that would re-render
        // the blocks in the streaming area on top of the committed message →
        // duplicate output). Skip the write entirely once runCompleted.
        if (runCompleted) return
        setStreamingDraft(activeSessionId ?? '', {
          isAgentRunning: true,
          responseBlocks: responseBlocksRef.current,
          steps: stepsRef.current,
          streamThinking: streamThinkingRef.current,
          textBuffer: textBufferRef.current,
          thoughtBuffer: thoughtBufferRef.current,
          startedAt: startedAtRef.current,
          totalTokens: totalTokensRef.current,
        })
      })
    }
    // Per-run stream flush — merges this run's pending text/thinking blocks into
    // its own responseBlocksRef and (when front) the live UI state.
    const flushStreamRender = () => {
      rafPendingRef.current = false
      debug('[HelixTrace] flush rAF', { pending: pendingBlocksRef.current.length, textLen: (textBufferRef.current || '').length })
      const blocks = pendingBlocksRef.current.splice(0)
      if (!blocks.length) return
      const lastThinking = [...blocks].reverse().find(b => b.type === 'thinking')
      uiRB(prev => {
        let next = prev
        for (const b of blocks) {
          const last = next[next.length - 1]
          if (b.type === 'thinking') {
            next = last?.type === 'thinking'
              ? [...next.slice(0, -1), { type: 'thinking', content: b.content }]
              : [...next, { type: 'thinking', content: b.content }]
          } else {
            next = last?.type === 'text'
              ? [...next.slice(0, -1), { type: 'text', content: last.content + b.content }]
              : [...next, { type: 'text', content: b.content }]
          }
        }
        return next
      })
      if (lastThinking) uiST(lastThinking.content)
      syncDraft()
    }
    const scheduleStreamRender = () => {
      if (rafPendingRef.current) return
      rafPendingRef.current = true
      requestAnimationFrame(flushStreamRender)
    }
    // ──────────────────────────────────────────────────────────────────────────
    doneProcessedRef.current = false
    if (!activeSessionId) {
      activeSessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      useHelixStore.getState().setCurrentSessionId(activeSessionId)
      useHelixStore.getState().pushNavigation({ type: 'chat', sessionId: activeSessionId })
      useHelixStore.getState().persistToStorage()
    }
    runningSessionIdRef.current = activeSessionId
    startedAtRef.current = Date.now()
    if (isFrontRun()) setQuestionStartTs(startedAtRef.current)
    setStreamingDraft(activeSessionId!, {
      isAgentRunning: true,
      responseBlocks: [],
      steps: [],
      streamThinking: '',
      textBuffer: '',
      thoughtBuffer: '',
      startedAt: startedAtRef.current,
      totalTokens: 0,
    })
    uiRB([])
    uiSteps([])
    stepsRef.current = []
    uiST('')
    textBufferRef.current = ''
    thoughtBufferRef.current = ''
    lastStreamedTextRef.current = ''
    streamCappedRef.current = false
    thinkingCappedRef.current = false
    thinkingStartTimeRef.current = 0
    thinkingDurationRef.current = 0
    promptSentAtRef.current = 0
    uiTotalTokens(0)
    firstContentAtRef.current = 0
    usageReceivedRef.current = false
    // A fresh question starts a new todo scope — drop any stale list from the
    // previous run so the header button hides until Hermes streams a new one.
    useHelixStore.getState().clearHermesTodos()
    // Add user message to store with images
    const imagesSnapshot = pendingImages.length > 0 ? [...pendingImages] : undefined
    const filesSnapshot = pendingFiles.length > 0 ? [...pendingFiles] : undefined

    const storeState = useHelixStore.getState()
    storeState.addChatMessage({
      role: 'user',
      content: trimmed,
      images: imagesSnapshot,
      files: filesSnapshot,
      sessionId: activeSessionId,
    })
    setPendingImages([])
    setPendingFiles([])

    const controller = new AbortController()
    abortRef.current = controller
    abortControllersRef.current.set(activeSessionId, controller)

    let unsubscribe: (() => void) | null = null
    const queueDone = false
    // ä
    let idleTimerRef: ReturnType<typeof setTimeout> | null = null

    try {
      const state = useHelixStore.getState()
      const isElectron = typeof window !== 'undefined' && !!window.electron?.isElectron

      if (!isElectron) {
        throw new Error('当前环境无法连接 Hermes，与 Electron 界面端通信失败')
      }

      // Config is synced by handleModelSelect (setConfig) and by handleProfileSelect
      // (profile:cacheConfig) — both already restart Hermes if needed.  Calling
      // setModel AGAIN here would race with those restarts and corrupt .env.
      // session/new will pick up whatever config.yaml has on disk, so skip it.

      // Wait for the gateway to be ready only if it's actually disconnected.
      // Do NOT wait for a fresh `gateway.ready` just because the epoch changed;
      // that produced a 10s blind hang on every new conversation after a config
      // change. Instead, invalidate stale sessions immediately and let
      // session/new attempt directly. If the backend is still recycling,
      // Hermes will return an error we can catch and retry.
      const hermesStore = useHermesStore.getState()
      const liveEpoch = hermesStore.gatewayEpoch
      const epochStale = liveEpoch > sessionEpochRef.current
      if (!hermesStore.hermesConnected) {
        if (epochStale) {
          sessionMapRef.current.delete(useHelixStore.getState().currentSessionId || '')
          persistSessionMap(sessionMapRef.current)
        }
        await new Promise<boolean>((resolve) => {
          const startEpoch = useHermesStore.getState().gatewayEpoch
          const check = () => {
            if (useHermesStore.getState().hermesConnected && useHermesStore.getState().gatewayEpoch > startEpoch) {
              cleanup()
              resolve(true)
            }
          }
          const unsub = hermesApi()!.onEvent((event: string) => {
            if (event === 'gateway.ready') {
              cleanup()
              resolve(true)
            }
          })
          const cleanup = () => {
            try { unsub?.() } catch {}
          }
          check()
          if (!(useHermesStore.getState().hermesConnected && useHermesStore.getState().gatewayEpoch > startEpoch)) {
            setTimeout(() => { cleanup(); resolve(useHermesStore.getState().hermesConnected) }, 3000)
          }
        })
      } else if (epochStale) {
        sessionMapRef.current.delete(useHelixStore.getState().currentSessionId || '')
        persistSessionMap(sessionMapRef.current)
      }

      // Create a Hermes ACP session if we don't already have one for THIS
      // conversation. Sessions are keyed by conversationId so multiple
      // conversations can run in parallel (each keeps its own backend session).
      const myCid = activeSessionId
      const existing = sessionMapRef.current.get(myCid)
      // A cached session is only valid if it was created under the CURRENT gateway
      // epoch — a gateway restart wipes backend sessions, so a stale id would hit
      // "session not found". Treat stale/epoch-mismatched ids as missing and
      // recreate below.
      let sessionId = existing && existing.epoch === liveEpoch ? existing.sid : null
      let wasCreated = false
      if (!sessionId && existing) {
        sessionMapRef.current.delete(myCid)
        persistSessionMap(sessionMapRef.current)
      }
      if (!sessionId) {
        wasCreated = true
        const res = await hermesApi()!.send('session/new', {
          mcpServers: buildAcpMcpServers(useHelixStore.getState().mcpServers),
        }) as any
        sessionId = res?._meta?.hermes?.sessionProvenance?.acpSessionId
          || res?.session_id
          || res?.sessionID
          || (typeof res === 'string' ? res : null)
        if (!sessionId) {
          throw new Error('无法创建 Hermes 会话：session/new 缺少 session_id')
        }
        sessionMapRef.current.set(myCid, { sid: sessionId, epoch: liveEpoch })
        persistSessionMap(sessionMapRef.current)
        sessionEpochRef.current = liveEpoch
        // 不要在这里无条件写全局 hermesSessionId：后台 run 建会话时会把全局
        // 改成后台会话的 sid，让 ContextUsageIndicator（读全局）查错会话 → 空
        // 分类。全局只由「前台 run」（下方 isFrontRun 分支）和「切换对话时的
        // sync effect」写入。
        // Auto-approve edits for this session (no manual approval UI): switch
        // Hermes into "don't ask" mode. Hermes has no `session/approve` RPC — it
        // waits for an approval response to a permission_request, so the only
        // way to skip manual approval is to set the session mode here.
        try {
          await hermesApi()!.send('session/set_mode', {
            session_id: sessionId,
            mode_id: approvalMode,
          })
        } catch (e) {
          console.warn('[Helix] set_mode(' + approvalMode + ') failed:', e)
        }
      }
      // Only update the global ref / store if THIS run is the focused conversation.
      // A background run must NOT overwrite the global — that would make Stop /
      // model-switch target the wrong session.
      if (isFrontRun()) {
        hermesSessionIdRef.current = sessionId
        try { useHermesStore.getState().setHermesSessionId(sessionId) } catch {}
      }

      // Stop button -> ask Hermes to cancel the current run.
      // session/cancel is a Hermes *notification* (no response), so send it
      // via notify (not send, which issues a request and gets "Method not found").
      controller.signal.addEventListener('abort', () => {
        if (sessionId) {
          electronHermes.notify('session/cancel', { session_id: sessionId })
        }
        // 暂停/停止时绝不能让已流式输出的内容丢失。abort 不会让 ack-only 的
        // session/prompt 拒绝，下面的 AbortError catch 永远不会触发，循环只是
        // 在 queueDone=true 后正常 break，textBufferRef 未提交、草稿被 finally
        // 清空 → 已生成的内容全部消失。这里把部分缓冲区作为合成 done 入队，
        // 走正常 done 提交路径持久化为一条 assistant 消息（与 scheduleSynthDone
        // 的兜底方式一致）。
        const hasPartial = (textBufferRef.current || '').trim()
          || (thoughtBufferRef.current || '').trim()
          || stepsRef.current.length > 0
        if (!queueDone && hasPartial) {
          enqueue('data: ' + JSON.stringify({ type: 'done', content: textBufferRef.current || '' }))
        }
        queueDone = true
        if (queueWaiter) { const w = queueWaiter; queueWaiter = null; w() }
      })

      // Tracks whether this run has already streamed real text/thinking, so a
      // trailing session_info_update can be dropped quietly instead of as text.
      let streamedContent = false
      // Translate Hermes ACP notifications into the UI event shape the parser expects.
      const mapHermesEvent = (method: string, params: any): any => {
        if (method === 'usage:prompt-complete') {
          return { type: 'usage_prompt_complete', usage: params?.usage || null }
        }
        if (method === 'session/update') {
          const u = params?.update || params
          const su = u?.sessionUpdate
          switch (su) {
            case 'agent_message_chunk':
              return { type: 'text', content: normalizeAcpContent(u.content) }
            case 'agent_thought_chunk':
              return { type: 'thinking', content: normalizeAcpContent(u.content) }
            case 'tool_call': {
              const title= typeof u.title=== 'string' ? u.title : ''
              const kind = typeof u.kind === 'string' ? u.kind : ''
              const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : ''
              let args = u.rawInput
              if (typeof args === 'string') {
                try { args = JSON.parse(args) } catch { /* keep raw */ }
              }
              return {
                type: 'tool_call',
                toolName: title || 'tool',
                toolKind: kind,
                toolCallId,
                toolParams: (args && typeof args === 'object') ? args : { raw: args },
              }
            }
            case 'tool_call_chunk':
              return { type: 'tool_result', toolName: '', content: normalizeAcpContent(u.content) }
            case 'tool_call_update': {
              const tcId = typeof u.toolCallId === 'string' ? u.toolCallId : ''
              // Sub-agent root completion: update the parent delegate_task step status
              if (tcId.startsWith('sa-') && tcId.endsWith('-root')) {
                const status = u.status === 'failed' ? 'failed' : 'completed'
                const content = normalizeAcpContent(u.content)
                uiSteps(prev => {
                  const next = [...prev]
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].type === 'tool_call' && next[i].toolName?.startsWith('SubAgent')) {
                      next[i] = { ...next[i], status, content: content || next[i].content }
                      break
                    }
                  }
                  return next
                })
                return null
              }
              // Streaming output delta: forward content to the latest tool_call step
              if (u.status === 'in_progress' && u.content) {
                return { type: 'tool_output_delta', toolCallId: tcId, content: normalizeAcpContent(u.content) }
              }
              return null
            }
            case 'permission_request':
              // Forward as approval_request so the ApprovalDialog shows up
              return {
                type: 'approval_request',
                approvalId: (typeof u.toolCallId === 'string' ? u.toolCallId : '') || `approval-${Date.now()}`,
                toolName: u.toolName || u.title || 'unknown',
                toolParams: u.toolParams || u.params || {},
              }
            case 'clarify_request':
              // 模型反问多选（clarify 工具）：弹底部浮条让用户挑选/输入，
              // 回应 clarify/respond 后后端继续。之前没有此分支 → 模型一反问就挂起。
              return {
                type: 'clarify_request',
                requestId: u.requestId || u.request_id || `clarify-${Date.now()}`,
                question: u.question || '',
                choices: Array.isArray(u.choices) ? u.choices : null,
              }
            case 'run_complete':
              // 后端 run.completed / message.complete 携带完整正文(payload.text / output)。
              // 优先采用它兜底——否则若 serve 后端只在完成时给正文(不发 message.delta 流),
              // 仅用流式缓冲 textBufferRef.current 会拿到空值 → “只思考不输出”。
              return { type: 'done', content: u.content || textBufferRef.current }
            case 'usage_update':
              return { type: 'usage_update', size: Number(u.size) || 0, used: Number(u.used) || 0 }
            case 'available_commands_update':
              return { type: 'available_commands', commands: u.commands || u.availableCommands || u.available_commands || [] }
            case 'session_info_update': {
              // Backends sometimes carry errors, notices, or even the final
              // reply inside session_info_update. We used to silently drop it
              // (default: return null), which produced a blank UI with no clue.
              // Now we ALWAYS dump the raw payload (no DEV gate — production
              // builds strip import.meta.env, which is exactly why we went
              // blind before) and surface any error/text we can find.
              const rawSiup = (() => { try { return JSON.stringify(u) } catch { return String(u) } })()
              const err = u.error || u.errorMessage || u.err
              if (err) {
                return { type: 'error', content: typeof err === 'string' ? err : JSON.stringify(err) }
              }
              if (u.status === 'error' || u.status === 'failed') {
                const m = u.message || u.reason || u.detail || (typeof u.content === 'string' ? u.content : '')
                return { type: 'error', content: m || '会话返回错误状态' }
              }
              const msg = (typeof u.content === 'string' && u.content.trim()) ? u.content
                : (typeof u.message === 'string' && u.message.trim()) ? u.message
                : (typeof u.text === 'string' && u.text.trim()) ? u.text
                : null
              if (msg) return { type: 'text', content: msg }
              // Couldn't classify this as error/text. If the run already
              // streamed real content, a stray session_info_update is just
              // trailing metadata — drop it quietly (raw already logged).
              // If it's the ONLY thing we got, surface the raw payload so the
              // UI is never left blank and we can see what the backend said.
              if (!streamedContent) {
                return { type: 'text', content: '⚠️ 该模型未返回文本流，网关仅回传了 session_info_update。原始内容：\n' + rawSiup.slice(0, 2000) }
              }
              return null
            }
            default:
              return null
          }
        }
        if (method === 'session/complete' || method === 'session/end') {
          return { type: 'done', content: textBufferRef.current }
        }
        if (method === 'error') {
          return { type: 'error', content: params?.message || 'Hermes 错误' }
        }
        return null
      }

      // ── Hermes todo-list extraction ──────────────────────────────────────
      // Hermes carries an in-session todo list and streams it via session/update
      // events whose sessionUpdate name includes "todo"/"task"/"plan" (per the
      // user: "独立 session/update 事件"). It may also surface the full list
      // inside a `todo_write` tool result. We try both, tolerate unknown field
      // shapes, and normalize every item to { id, content, status, activeForm }.
      // The captured list is pushed to the store so the header button can show
      // it; an empty/garbage payload is ignored (button stays hidden).
      const STATUS_MAP: Record<string, 'pending' | 'in_progress' | 'completed' | 'cancelled'> = {
        pending: 'pending',
        todo: 'pending',
        not_started: 'pending',
        queued: 'pending',
        in_progress: 'in_progress',
        inprogress: 'in_progress',
        doing: 'in_progress',
        running: 'in_progress',
        active: 'in_progress',
        completed: 'completed',
        done: 'completed',
        finished: 'completed',
        cancelled: 'cancelled',
        canceled: 'cancelled',
        abandoned: 'cancelled',
      }
      const parseTodoItem = (raw: any): HermesTodo | null => {
        if (!raw || typeof raw !== 'object') return null
        const content =
          raw.content ?? raw.title ?? raw.text ?? raw.label ?? raw.name ?? raw.task ?? ''
        const statusRaw = String(raw.status ?? raw.state ?? 'pending').toLowerCase()
        const status = STATUS_MAP[statusRaw] || 'pending'
        if (typeof content !== 'string' || !content.trim()) return null
        return {
          id: typeof raw.id === 'string' && raw.id ? raw.id : 'todo-' + Math.abs(hashString(content + status)).toString(36),
          content: content.trim(),
          status,
          activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : undefined,
        }
      }
      const extractTodoList = (payload: any): HermesTodo[] | null => {
        if (!payload || typeof payload !== 'object') return null
        // session/update wraps the list in `.update` (or `.params.update`)
        const u = payload.update ?? payload.params?.update ?? payload
        // Direct array on the event? ACP's native plan update uses `entries`
        // (PlanEntry[] with content/priority/status) — see acp.schema.AgentPlanUpdate.
        // Also accept the legacy todos/items/taskList/list field names.
        const arr =
          u?.entries ?? u?.todos ?? u?.items ?? u?.taskList ?? u?.list ??
          u?.update?.entries ?? u?.update?.todos ?? u?.update?.items ??
          payload?.entries ?? payload?.todos ?? payload?.items
        if (Array.isArray(arr)) {
          const items = arr.map(parseTodoItem).filter(Boolean) as HermesTodo[]
          return items.length ? items : null
        }
        // tool_call with name todo_write/TodoWrite may carry `todos` in rawInput
        const toolName = String(u?.title ?? u?.toolName ?? payload?.title ?? '').toLowerCase()
        if (/todo_write|todowrite|todo_update|task_create|task_update/.test(toolName)) {
          const ri = u?.rawInput
          let parsedInput = ri
          if (typeof ri === 'string') { try { parsedInput = JSON.parse(ri) } catch { parsedInput = null } }
          const inner = Array.isArray(parsedInput?.todos) ? parsedInput.todos
            : Array.isArray(parsedInput?.items) ? parsedInput.items
            : Array.isArray(parsedInput?.taskList) ? parsedInput.taskList
            : Array.isArray(parsedInput?.list) ? parsedInput.list
            : null
          if (Array.isArray(inner)) {
            const items = inner.map(parseTodoItem).filter(Boolean) as HermesTodo[]
            return items.length ? items : null
          }
        }
        return null
      }
      const pushTodos = (list: HermesTodo[] | null) => {
        if (list && list.length) {
          useHelixStore.getState().setHermesTodos(list)
        }
      }

      // Simple stable string hash (for deriving todo ids when the backend
      // doesn't supply one). Defined before the todo parser uses it.
      function hashString(s: string): number {
        let h = 0
        for (let i = 0; i < s.length; i++) {
          h = (h << 5) - h + s.charCodeAt(i)
          h |= 0
        }
        return h
      }

      // Event-driven async queue — no polling. Producers push items and
      // wake the consumer immediately via a resolver.
      const queue: string[] = []
      let queueDone = false
      let queueWaiter: (() => void) | null = null
      function enqueue(item: string) {
        queue.push(item)
        if (queueWaiter) { const w = queueWaiter; queueWaiter = null; w() }
      }

      // Disconnect recovery — aligned with official Hermes: on a WS drop the
      // run is NOT killed. The backend detaches the session (drop sentinel) and
      // keeps executing (running sessions are never reaped — server.py
      // _ws_session_is_orphaned returns False for running=True). serve-gateway
      // reconnects and calls session.resume to re-bind the transport; the event
      // stream resumes and run.completed lands normally. So a disconnect only
      // shows a notice here — the run is ended only by the real completion, or
      // by serve-gateway rejecting the prompt when resume fails for good.
      function dequeue(): string | null {
        return queue.length > 0 ? queue.shift()! : null
      }
      async function waitForItem(): Promise<boolean> {
        if (queue.length > 0 || queueDone) return true
        return new Promise<boolean>(resolve => {
          queueWaiter = () => resolve(true)
        })
      }

      // 兜底 done 定时器。官方语义：run 的结束由后端权威事件驱动——
      // message.complete / run.completed / run.cancelled / run.failed 在
      // 每个 turn 结束时必然发射（server.py _emit("message.complete")，含
      // error/interrupted 状态）。因此绝不设短空闲窗口：8s 兜底会在模型
      // 停顿思考/provider 慢时误砍输出（此前的"自动中断"根因）。这里只留
      // 一个超长保险，防止终结帧意外丢失导致 UI 永久卡在"正在思考"。
      //
      // 空闲检测定时器（idle detector）：当已收到内容但事件流长时间静默
      // （15 秒无新事件）时，认为后端已结束但丢失了 session/complete 帧，
      // 合成 done 让循环退出、按钮恢复为发送。仅在已收到内容后才激活
      // （避免模型纯思考阶段误判）；有运行中工具时不触发（工具执行可能
      // 静默数分钟）。这是比 5 分钟 synthDone 敏感得多的早期检测。
      const scheduleSynthDone = (delay: number) => {
        if (synthDoneTimerRef.current) {
          clearTimeout(synthDoneTimerRef.current)
          synthDoneTimerRef.current = null
        }
        // 有运行中的工具调用时（bash/长工具可能静默数分钟），再放宽到 30 分钟
        // 极长兜底，避免工具执行间隙被误判结束。
        const hasPendingTools = stepsRef.current.some(
          s => s.type === 'tool_call' && s.status === 'running'
        )
        const window = hasPendingTools ? 1800000 : delay
        debug('[HelixTrace] scheduleSynthDone', { window, delay, queueDone, textLen: textBufferRef.current?.length ?? 0 })
        synthDoneTimerRef.current = setTimeout(() => {
          synthDoneTimerRef.current = null
          debug('[HelixTrace] synthDone fired', {
            queueDone,
            textLen: textBufferRef.current?.length ?? 0,
            stepsLen: stepsRef.current.length,
          })
          if (queueDone) return
          enqueue('data: ' + JSON.stringify({ type: 'done', content: textBufferRef.current }))
          queueDone = true
        }, window)
      }

      // ── 空闲检测定时器（idle detector）────────────────────────────────
      // 当已收到内容但事件流静默超过 15 秒时，合成 done 让循环退出。
      // 仅在 streamedContent=true 后激活；有运行中工具时不触发。
      const IDLE_TIMEOUT_MS = 15_000
      const resetIdleTimer = () => {
        if (idleTimerRef) { clearTimeout(idleTimerRef); idleTimerRef = null }
        if (!streamedContent || queueDone) return
        const hasRunningTools = stepsRef.current.some(s => s.type === 'tool_call' && s.status === 'running')
        if (hasRunningTools) return
        idleTimerRef = setTimeout(() => {
          idleTimerRef = null
          if (queueDone) return
          debug('[HelixTrace] idleDetector fired — no events for', IDLE_TIMEOUT_MS, 'ms, synthesizing done', {
            textLen: textBufferRef.current?.length ?? 0,
            reasoningLen: thoughtBufferRef.current?.length ?? 0,
            stepsLen: stepsRef.current.length,
            responseBlocksLen: responseBlocks.length,
          })
          enqueue('data: ' + JSON.stringify({ type: 'done', content: textBufferRef.current }))
          queueDone = true
          if (queueWaiter) { const w = queueWaiter; queueWaiter = null; w() }
        }, IDLE_TIMEOUT_MS)
      }

      // IMPORTANT: subscribe through hermesApi() (the mode-aware facade), NOT
      // window.electron.hermes. In serve mode agent stream events (session/update,
      // tool.*, message.*) arrive over the WS client inside serve-gateway.ts and
      // never hit the IPC bridge — subscribing to the raw IPC onEvent left the
      // run with "正在思考" forever (no tool cards, no text).
      unsubscribe = hermesApi()!.onEvent(async (method: string, params: any) => {
        const mySid = sessionId
        // True-concurrency guard: this onEvent instance belongs to the run for
        // `mySid`. Ignore events from any OTHER session so parallel runs don't
        // cross-contaminate each other's queues. Global gateway-level events
        // (gateway.*) carry no session_id and are intentionally NOT filtered.
        if (params?.session_id && params.session_id !== mySid) return
        const now = Date.now()
        // Track time to first token on first meaningful event
        if (method === 'session/update' && (
          params?.update?.sessionUpdate === 'agent_message_chunk' ||
          params?.update?.sessionUpdate === 'agent_thought_chunk'
        )) {
          if (promptSentAtRef.current && !firstContentAtRef.current) {
            firstContentAtRef.current = now
          }
        }
        try {
          // WS 断连：对齐官方——run 不结束。Hermes 把运行中的会话 detach 继续
          // 执行（running 会话不会被 reap），serve-gateway 会重连并 session.resume
          // 恢复事件流。这里只显示提示并重新武装超长兜底（断连/重连期间模型
          // 可能仍在思考、无 delta；兜底已是 5 分钟级，不会像旧 8s 那样把恢复
          // 中的 run 砍掉）。run 的收尾交给真实完成事件或 resume 失败的 reject。
          if (method === 'gateway.disconnected') {
            scheduleSynthDone(300000)
            useHelixStore.getState().setConnectionNotice({ phase: 'error', message: '与 Hermes 网关连接已断开，正在尝试恢复…', ts: Date.now() })
            return
          }
          // Reconnect completed (serve-gateway already re-ran session.resume).
          // The event stream is about to resume — clear the notice.
          if (method === 'gateway.reconnected') {
            useHelixStore.getState().setConnectionNotice({ phase: 'recovered', message: '连接已恢复', ts: Date.now() })
            setTimeout(() => useHelixStore.getState().setConnectionNotice(null), 2000)
            return
          }
          // serve-gateway 已不再主动驱逐并行会话；保留此分支仅作防御：
          // 若未来后端在个别配置下真的回收/挤掉本 run 的会话，立即收尾，
          // 避免静默挂到 5 分钟兜底。用户重发该消息即可在新会话上重新执行。
          if (method === 'session.evicted') {
            debug('[HelixTrace] session.evicted →', params)
            enqueue('data: ' + JSON.stringify({
              type: 'error',
              content: '后台会话被新的对话挤占，此任务已中断，请重发该消息以重新执行。',
            }))
            queueDone = true
            return
          }
          // 主进程/serve-gateway 自动恢复了本 run 的会话（"session not found" →
          // 重建并重放 prompt）。把 conversation→session 映射改绑到新 id，后续
          // 消息与 RPC 使用新会话；事件流已按 WS 同序保证在新 id 下继续到达。
          if (method === 'gateway.sessionReplaced' && params?.newId) {
            if (params?.oldId === sessionId) {
              debug('[HelixTrace] 本 run 会话被替换 →', params.oldId, '→', params.newId)
              sessionId = params.newId
              sessionMapRef.current.set(myCid, { sid: params.newId, epoch: useHermesStore.getState().gatewayEpoch })
              persistSessionMap(sessionMapRef.current)
            }
          }
          // When Hermes starts retrying after an UPSTREAM API connection error,
          // the ACP path clears the accumulated text/thinking buffers so the
          // retry response replaces (not appends to) the partial content from
          // the failed attempt. In serve mode this event originates from the
          // hermes process's stderr (main.js), NOT a WS drop — the session is
          // never rebuilt, so clearing buffers would discard already-streamed
          // thinking/text. Only update the notice there.
          if (method === 'gateway.retry') {
            const phase = params?.phase as string | undefined
            if (isServeActive()) {
              if (phase === 'recovered') {
                useHelixStore.getState().setConnectionNotice({ phase: 'recovered', message: '连接已恢复', ts: Date.now() })
                setTimeout(() => useHelixStore.getState().setConnectionNotice(null), 2000)
              } else {
                const attempt = params?.attempt ?? 1
                const total = params?.total ?? 3
                useHelixStore.getState().setConnectionNotice({ phase: 'retrying', attempt, total, message: '上游连接不稳定，正在重连（第 ' + attempt + '/' + total + ' 次）…', ts: Date.now() })
                setTimeout(() => {
                  const cur = useHelixStore.getState().connectionNotice
                  if (cur?.phase === 'retrying') {
                    useHelixStore.getState().setConnectionNotice(null)
                  }
                }, 30000)
              }
              return
            }
            if (phase === 'error') {
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              lastStreamedTextRef.current = ''
              streamCappedRef.current = false
              thinkingCappedRef.current = false
              pendingTextRef.current = ''
              pendingThinkingRef.current = ''
              pendingBlocksRef.current = []
              // Strip trailing thinking/text blocks so re-streamed content
              // replaces (not appends to) the in-progress response blocks, preventing
              // duplicate thinking/text output after reconnect.
              uiRB(prev => {
                const nb = prev.slice()
                while (nb.length > 0) {
                  const last = nb[nb.length - 1]
                  if (last.type === 'thinking' || last.type === 'text') nb.pop()
                  else break
                }
                return nb
              })
              uiST('')
              useHelixStore.getState().setConnectionNotice({ phase: 'error', message: '连接中断', ts: Date.now() })
            } else if (phase === 'retrying') {
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              lastStreamedTextRef.current = ''
              streamCappedRef.current = false
              thinkingCappedRef.current = false
              pendingTextRef.current = ''
              pendingThinkingRef.current = ''
              pendingBlocksRef.current = []
              uiST('')
              // Strip trailing thinking/text blocks so re-streamed content
              // replaces (not appends to) the in-progress response blocks, preventing
              // duplicate thinking/text output after reconnect.
              uiRB(prev => {
                const nb = prev.slice()
                while (nb.length > 0) {
                  const last = nb[nb.length - 1]
                  if (last.type === 'thinking' || last.type === 'text') nb.pop()
                  else break
                }
                return nb
              })
              const attempt = params?.attempt ?? 1
              const total = params?.total ?? 3
              useHelixStore.getState().setConnectionNotice({ phase: 'retrying', attempt, total, message: '连接中断，正在重连... (' + attempt + '/' + total + ')', ts: Date.now() })
            } else if (phase === 'recovered') {
              useHelixStore.getState().setConnectionNotice({ phase: 'recovered', message: '连接已恢复', ts: Date.now() })
              setTimeout(() => useHelixStore.getState().setConnectionNotice(null), 2000)
            }
            // Safety: clear stale retrying notices after 30 seconds
            if (phase === 'retrying') {
              setTimeout(() => {
                const cur = useHelixStore.getState().connectionNotice
                if (cur?.phase === 'retrying') {
                  useHelixStore.getState().setConnectionNotice(null)
                }
              }, 30000)
            }
          }
          const parsed = mapHermesEvent(method, params)
          if (parsed) {
            enqueue('data: ' + JSON.stringify(parsed))
            // ── TTS streaming ────────────────────────────────────────────
            if (parsed.type === 'text' && parsed.content) {
              ttsBufferRef.current += parsed.content as string
              const split = splitSentences(ttsBufferRef.current)
              ttsBufferRef.current = split.remainder
              for (const s of split.complete) {
                speakText(s)
              }
            }
          }
          // Capture Hermes's in-session todo list from dedicated todo/plan
          // session/update events (or todo_write tool results) so the header
          // button can surface it. Silently ignored when no list is present.
          if (method === 'session/update') {
            const su = params?.update?.sessionUpdate || params?.update?.type || ''
            if (/todo|task|plan/i.test(String(su))) {
              pushTodos(extractTodoList(params))
            }
            // Diff capture: Hermes tool.complete carries a rendered unified diff
            // (inline_diff) for write_file/patch. Turn it into a pending change
            // so the diff button lights up, AND surface it inline in the
            // conversation as a file_change block (per-file +green / -red stats).
            if (su === 'tool_call_update') {
              const raw = params?.update?.inlineDiff
              if (typeof raw === 'string' && raw.trim()) {
                const diff = raw.replace(/\u001b\[[0-9;]*m/g, '')
                const filePath = inferDiffPath(diff)
                if (filePath) {
                  const fileName = filePath.split(/[/\\]/).pop() || filePath
                  storeActions.addPendingChange({
                    fileId: filePath,
                    fileName,
                    filePath,
                    oldContent: '',
                    newContent: '',
                    language: diffLanguageForPath(filePath),
                    unifiedDiff: diff,
                  })
                  uiRB(prev => [...prev, {
                    type: 'file_change',
                    changes: [{
                      fileId: filePath,
                      fileName,
                      filePath,
                      oldContent: '',
                      newContent: '',
                      language: diffLanguageForPath(filePath),
                      unifiedDiff: diff,
                    }],
                  }])
                  syncDraft()
                }
              }
            }
          }
          if (parsed && (parsed.type === 'done' || parsed.type === 'error')) {
            queueDone = true
            if (idleTimerRef) { clearTimeout(idleTimerRef); idleTimerRef = null }
            // Flush remaining TTS text
            if (ttsBufferRef.current.trim()) {
              speakText(ttsBufferRef.current.trim())
              ttsBufferRef.current = ''
            }
          }
          if (parsed && (parsed.type === 'text' || parsed.type === 'thinking' || parsed.type === 'tool_call' || parsed.type === 'tool_result')) {
            streamedContent = true
            if (!firstContentAtRef.current) firstContentAtRef.current = Date.now()
            scheduleSynthDone(300000)
            resetIdleTimer()  // 重置空闲检测：有新内容 → 模型还在说，不判定结束
          }
          // A real text chunk (or tool result) means the gateway is delivering again →
          // clear any transient "reconnecting" notice so it doesn't linger.
          if (parsed && (parsed.type === 'text' || parsed.type === 'tool_result')) {
            const cur = useHelixStore.getState().connectionNotice
            if (cur && cur.phase !== 'recovered') {
              useHelixStore.getState().setConnectionNotice(null)
            }
          }
        } catch (e) {
          console.error('[Helix] event handling error', e)
        }
      })

      // Build a multimodal prompt: inline text files + image attachments,
      // then the user's text. Lets the Agent actually process dropped files.
      const promptItems: Array<Record<string, any>> = []
      const allImages = [
        ...(imagesSnapshot || []).map(i => i.dataUrl).filter(Boolean),
        ...(filesSnapshot || [])
          .filter(f => f.kind === 'image' && f.dataUrl)
          .map(f => f.dataUrl as string),
      ]
      for (const url of allImages) {
        promptItems.push({ type: 'image_url', image_url: { url } })
      }
      let fileContext = ''
      for (const f of filesSnapshot || []) {
        if (f.kind === 'text' && f.base64) {
          // Inline small text files only; large ones get a path hint instead.
          const maxInline = 50 * 1024
          if (f.size && f.size > maxInline) {
            if (f.path) fileContext += `\n\n[已附加大文件: ${f.name} (${formatBytes(f.size)})]\n 文件路径: ${f.path.replace(/\\/g, '/')}`
            else fileContext += `\n\n[已附加大文件: ${f.name} (${formatBytes(f.size)})]`
          } else {
            try {
              const content = decodeBase64Utf8(f.base64)
              fileContext += `\n\n--- 文件 ${f.name} 的内容 ---\n${content}`
            } catch { /* skip undecodable */ }
          }
        } else if (f.kind === 'file') {
          fileContext += `\n\n[已附加文件: ${f.name} (${formatBytes(f.size)})]`
          // Inject the absolute path so the model can read it using Read tool
          if (f.path) {
            const normalizedPath = f.path.replace(/\\/g, '/')
            fileContext += ` 文件路径: ${normalizedPath}`
          }
        }
      }
      const promptText = (trimmed + fileContext).trim() || trimmed
      promptItems.push({ type: 'text', text: promptText })

      // Fire the prompt — events stream back via onEvent (don't await the promise itself).
      // ACP expects prompt as a list of content blocks, not a plain string
      promptSentAtRef.current = Date.now()
      // ── 并发串台诊断日志（临时）：记录本 run 的对话 id → 后端 sid 映射 ──
      console.log('[HelixSend]', JSON.stringify({
        conversation: activeSessionId,
        sid: sessionId,
        sidSource: wasCreated ? 'new' : 'map',
        frontRun: isFrontRun(),
        globalSid: useHermesStore.getState().hermesSessionId,
        map: Object.fromEntries(sessionMapRef.current),
        text: promptText.slice(0, 50),
      }))
      hermesApi()!.send('session/prompt', {
        session_id: sessionId,
        prompt: [{ type: 'text', text: promptText }],
      }).then((result: any) => {
        // session/prompt is now ack-only (official model): result == {status:'streaming'}.
        // Completion + usage are driven by events — run_complete → done (mapHermesEvent
        // :1848), usage:prompt-complete → addSessionUsageStats (run loop :2791). Nothing
        // to do on the ack itself except log it; do NOT synthesize `done` here.
        debug('[HelixTrace] session/prompt ack', {
          sessionId,
          runningSessionId: runningSessionIdRef.current,
          currentSessionId,
          result,
        })
        // serve-gateway 在 "session not found" 时已自动重建会话并重放 prompt，
        // 返回新 session_id。改绑 conversation→session 映射，后续消息用新会话。
        if (result?.session_id && result.session_id !== sessionId) {
          debug('[HelixTrace] session/prompt 会话被替换 →', sessionId, '→', result.session_id)
          sessionId = result.session_id
          sessionMapRef.current.set(myCid, { sid: result.session_id, epoch: useHermesStore.getState().gatewayEpoch })
          persistSessionMap(sessionMapRef.current)
        }
      }).catch((err: any) => {
        console.error('[Helix] session/prompt error', err)
        enqueue('data: ' + JSON.stringify({ type: 'error', content: err?.message || '请求失败' }))
        queueDone = true
      })

      // 提交后立即武装超长兜底：即使后端迟迟不流式（agent 构建/纯思考），
      // 也有保险；正常内容事件会不断重置它，真实终结事件到达则作废。
      scheduleSynthDone(300000)

      // Process the event queue using the existing UI parser (unchanged below).
      while (true) {
        const line = dequeue()
        if (!line) {
          if (queueDone) break
          await waitForItem()
          continue
        }
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)

            if (parsed.type === 'tool_call') {
              const toolCallId = parsed.toolCallId || ''
              const isSubAgentTool = typeof toolCallId === 'string' && toolCallId.startsWith('sa-')

              // Sub-agent tool calls: append as sub-step to the last delegate_task step
              if (isSubAgentTool) {
                const subStep: ExecutionStep = {
                  id: generateId(), type: 'tool_call',
                  content: getToolDisplayLabel(parsed.toolName, parsed.toolKind, undefined, parsed.toolParams),
                  toolName: parsed.toolName,
                  toolKind: parsed.toolKind,
                  toolParams: parsed.toolParams,
                  timestamp: Date.now(),
                }
                uiSteps(prev => {
                  const next = [...prev]
                  // Find the last delegate_task step (running)
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].type === 'tool_call' && next[i].toolName?.startsWith('SubAgent')) {
                      next[i] = { ...next[i], subSteps: [...(next[i].subSteps || []), subStep] }
                      break
                    }
                  }
                  return next
                })
                return
              }

              // Extract file paths from tool params to track directories
              const params = parsed.toolParams || {}
              const pathKeys = ['path', 'file_path', 'filepath', 'filePath', 'file', 'filename']
              let filePath = ''
              for (const k of pathKeys) {
                if (params[k] && typeof params[k] === 'string') {
                  filePath = String(params[k])
                  break
                }
              }
              if (!filePath && params.raw && typeof params.raw === 'string') {
                try {
                  const raw = JSON.parse(params.raw)
                  for (const k of pathKeys) {
                    if (raw[k] && typeof raw[k] === 'string') {
                      filePath = String(raw[k])
                      break
                    }
                  }
                } catch {}
              }
              if (filePath) {
                const dir = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/'
                storeActions.addAccessedDirectory(dir)
              } else if (params.command && typeof params.command === 'string') {
                // Track bash commands that reference paths
                const match = params.command.match(/[`'"]?([\w/.-]+(?:\.\w+)+)[`'"]?/g)
                if (match) {
                  match.forEach(p => {
                    const dir = p.replace(/[`'"]/g, '').split('/').slice(0, -1).join('/')
                    if (dir) storeActions.addAccessedDirectory(dir)
                  })
                }
              }
              const id = generateId()
              const isDelegateTask = parsed.toolName?.startsWith('Delegating')
              // All tool_calls start as 'running' so the top status bar can surface
              // "正在执行工具：read xxx / bash xxx". They'll be marked
              // completed/failed when a matching tool_result or error arrives.
              const step: ExecutionStep = {
                id, type: 'tool_call',
                content: getToolDisplayLabel(parsed.toolName, parsed.toolKind, filePath, params),
                toolName: parsed.toolName,
                toolKind: parsed.toolKind,
                toolParams: params,
                timestamp: Date.now(),
                status: 'running',
                subSteps: isDelegateTask ? [] : undefined,
              }
              uiSteps(prev => [...prev, step])
              storeActions.addExecutionStep({ type: 'tool_call', toolName: parsed.toolName, toolKind: parsed.toolKind, path: filePath || undefined, toolParams: params })

              // 修改文件时（write_file / patch）把改动写入 pendingChanges，
              // 触发 DiffPreview 弹窗显示 diff（实现「修改文件时显示 diff」）。
              // 注意：Hermes 的 tool_call 事件里 toolName 是人类可读标题（如 "write: …"），
              // 不是工具原始名，所以不能用 === 'write_file' 判断。Hermes 把这两个文件工具
              // 的 kind 都映射成 'edit'（见 acp_adapter/tools.py 的 TOOL_KIND_MAP），
              // 因此用 toolKind==='edit' + 文件路径 + 内容参数来判定文件修改。
              // 主路径是 tool.complete 的 inline_diff（见 onEvent 的 tool_call_update 分支）；
              // 这里作为兜底：仅当参数里真的有编辑内容时使用。
              if (filePath && parsed.toolKind === 'edit') {
                const p = params as Record<string, any>
                let oldContent = ''
                let newContent = ''
                const os = p.old_string ?? p.old_text
                const ns = p.new_string ?? p.new_text
                if (os !== undefined || ns !== undefined) {
                  oldContent = String(os ?? '')
                  newContent = String(ns ?? '')
                } else if (p.content !== undefined) {
                  newContent = String(p.content)
                } else if (p.patch !== undefined) {
                  newContent = String(p.patch)
                }
                if (oldContent || newContent) {
                  const fileName = filePath.split(/[/\\]/).pop() || filePath
                  storeActions.addPendingChange({
                    fileId: filePath,
                    fileName,
                    filePath,
                    oldContent,
                    newContent,
                    language: diffLanguageForPath(filePath),
                  })
                  uiRB(prev => [...prev, {
                    type: 'file_change',
                    changes: [{
                      fileId: filePath,
                      fileName,
                      filePath,
                      oldContent,
                      newContent,
                      language: diffLanguageForPath(filePath),
                    }],
                  }])
                }
              }

              // 每个工具调用独立成块，不再与上一个 tool_group 合并，
              // 这样连续多个工具调用也会各自独立、可与文本交叉显示。
              uiRB(prev => [...prev, { type: 'tool_group', steps: [step] }])
            } else if (parsed.type === 'thinking') {
              if (!thinkingStartTimeRef.current) thinkingStartTimeRef.current = Date.now()
              const inc = normalizeAcpContent(parsed.content)
              const cur = thoughtBufferRef.current
              if (cur.length >= MAX_STREAM_CHARS) {
                if (!thinkingCappedRef.current) {
                  thinkingCappedRef.current = true
                  thoughtBufferRef.current = cur + '\n\n[思考过长，已截断]'
                }
                pendingThinkingRef.current = thoughtBufferRef.current
                pendingBlocksRef.current.push({ type: 'thinking', content: thoughtBufferRef.current })
                scheduleStreamRender()
                return
              }
              const curTrim = cur.trim()
              const incTrim = inc.trim()
              const isCumulative = curTrim && incTrim.startsWith(curTrim)
              
              if (isCumulative) {
                // Hermes sent cumulative content - replace, don't append
                thoughtBufferRef.current = inc
              } else {
                // Hermes sent incremental content - append
                thoughtBufferRef.current = cur + inc
              }
              pendingThinkingRef.current = thoughtBufferRef.current
              pendingBlocksRef.current.push({ type: 'thinking', content: thoughtBufferRef.current })
              scheduleStreamRender()
            } else if (parsed.type === 'reasoning') {
              const id = generateId()
              uiSteps(prev => [...prev, { id, type: 'reasoning', content: normalizeAcpContent(parsed.content), timestamp: Date.now() }])
            } else if (parsed.type === 'file_change') {
              const id = generateId()
              uiSteps(prev => [...prev, { id, type: 'file_change', content: parsed.content, fileChanges: parsed.fileChanges, timestamp: Date.now() }])
            } else if (parsed.type === 'tool_result') {
              const id = generateId()
              const step: ExecutionStep = { id, type: 'tool_result', content: parsed.content, toolName: parsed.toolName, timestamp: Date.now() }
              uiSteps(prev => [...prev, step])
              storeActions.addExecutionStep({ type: 'tool_result', toolName: parsed.toolName })
              // Mark the matching tool_call step as completed so the top status
              // bar stops showing it in "正在执行工具". We match by the last
              // unfinished tool_call (serial execution) or any running one.
              uiSteps(prev => {
                const next = [...prev]
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].type === 'tool_call' && next[i].status === 'running') {
                    next[i] = { ...next[i], status: 'completed' as const }
                    break
                  }
                }
                return next
              })
              // tool_result 归到第一个尚未收到结果的 tool_group 块
              // （串行时即当前块；并行时按调用顺序依次填充，避免全堆到最后一块）。
              uiRB(prev => {
                const idx = prev.findIndex(b => {
                  if (b.type !== 'tool_group') return false
                  return !b.steps.some(s => s.type === 'tool_result' || s.type === 'error')
                })
                if (idx !== -1) {
                  const cur = prev[idx] as Extract<ResponseBlock, { type: 'tool_group' }>
                  const nb = prev.slice()
                  nb[idx] = { type: 'tool_group', steps: [...cur.steps, step] }
                  return nb
                }
                return [...prev, { type: 'tool_group', steps: [step] }]
              })
            } else if (parsed.type === 'tool_output_delta') {
              // Streaming output chunk from a running tool — append to the
              // latest tool_call step's content so the user sees output in real time.
              const delta = normalizeAcpContent(parsed.content)
              if (!delta) return
              uiSteps(prev => {
                const next = [...prev]
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].type === 'tool_call' && next[i].status !== 'completed' && next[i].status !== 'failed') {
                    next[i] = { ...next[i], content: (next[i].content || '') + delta }
                    break
                  }
                }
                return next
              })
              // Also append to the corresponding tool_group in responseBlocks
              uiRB(prev => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  const block = prev[i]
                  if (block.type !== 'tool_group') continue
                  const lastToolCall = [...block.steps].reverse().find(s => s.type === 'tool_call' && s.status !== 'completed' && s.status !== 'failed')
                  if (lastToolCall) {
                    const nb = prev.slice()
                    nb[i] = { ...block, steps: block.steps.map(s => s.id === lastToolCall.id ? { ...s, content: (s.content || '') + delta } : s) }
                    return nb
                  }
                }
                return prev
              })
            } else if (parsed.type === 'text') {
              // Hermes streams the reply as word/token chunks and ALSO re-sends
              // the full final_response as another agent_message_chunk at the
              // end (acp.update_agent_message_text). If the incoming chunk is the
              // complete text, replace instead of appending — kills duplication.
              // Also detect retry-duplicated content: when Hermes retries after an
              // MCP failure, the model regenerates similar text which should
              // replace (not append to) the existing buffer.
              const incRaw = normalizeAcpContent(parsed.content)
              const cur = textBufferRef.current
              const curTrim = cur.trim()
              const incTrim = incRaw.trim()
              if (cur.length >= MAX_STREAM_CHARS) {
                if (!streamCappedRef.current) {
                  streamCappedRef.current = true
                  const capped = cur + '\n\n[输出过长，已截断，剩余内容不再显示]'
                  textBufferRef.current = capped
                  pendingTextRef.current = capped
                  const delta = capped.startsWith(lastStreamedTextRef.current)
                    ? capped.slice(lastStreamedTextRef.current.length)
                    : capped
                  lastStreamedTextRef.current = capped
                  pendingBlocksRef.current.push({ type: 'text', content: delta })
                }
                scheduleStreamRender()
                return
              }
              let newText: string
              if (!curTrim) {
                newText = incRaw
              } else if (incTrim.startsWith(curTrim)) {
                // New text is a superset of accumulated text (Hermes full resend)
                newText = incRaw
              } else if (curTrim.startsWith(incTrim)) {
                // Incoming is a subset of accumulated (retry sent shorter text) — keep the
                // more complete accumulated buffer to avoid truncation.
                newText = cur
              } else if (textSimilarityRatio(curTrim, incTrim) >= 0.6) {
                // 归一化后高度相似：Hermes 全文重发微差版 / 模型重试改写。
                // 直接拼接会把同一内容写两遍（"输出重复两次"的根因）。
                // 仅当传入文本达到"全文重发"尺度（≥累积文本一半）才替换——
                // 否则它只是与某段相关的独立新段落，替换会把已累积内容截断。
                if (incRaw.length >= cur.length * 0.5) {
                  newText = incRaw.length >= cur.length ? incRaw : cur
                } else {
                  newText = cur + incRaw
                }
              } else {
                // Simple append — no overlap scan (avoid false-positive duplication
                // on full resends when the 500-char cap misses the real overlap).
                newText = cur + incRaw
              }
              textBufferRef.current = newText
              pendingTextRef.current = newText

              // If the model embeds its reasoning inside <think:ID>...</think:ID> tags
              // instead of emitting a separate thinking stream, surface it as the thinking block.
              let renderText = newText
              if (!thoughtBufferRef.current) {
                const { content: cleaned, reasoning } = extractThinkTags(newText)
                if (reasoning) {
                  thoughtBufferRef.current = reasoning
                  pendingThinkingRef.current = reasoning
                  uiST(reasoning)
                  // If all text was inside <think:ID> tags (e.g. DeepSeek-style
                  // output), fall back to showing reasoning as visible content
                  // rather than leaving the message empty.
                  textBufferRef.current = cleaned || reasoning
                  renderText = cleaned || reasoning
                }
              }
              pendingTextRef.current = renderText
              let delta: string
              if (renderText.startsWith(lastStreamedTextRef.current)) {
                delta = renderText.slice(lastStreamedTextRef.current.length)
              } else if (lastStreamedTextRef.current) {
                // Byte-different (rewritten) full-text resend: the model rebuilt
                // the whole accumulated text with minor edits (spacing/case/
                // punctuation) instead of appending. The older text is already
                // on screen via the incremental blocks, so pushing the rewritten
                // full text again would render the same paragraph twice
                // ("正文重复" root cause). If the new text is close to the last
                // streamed text and at full-message scale, only emit the tail
                // delta that actually differs; if it's merely equal-or-a-subset,
                // suppress it entirely.
                const lastN = normalizeForCompare(lastStreamedTextRef.current)
                const newN = normalizeForCompare(renderText)
                if (lastN.length >= 8 && newN.length >= 8 &&
                    (newN === lastN || lastN.includes(newN) || newN.includes(lastN) ||
                     (textSimilarityRatio(lastN, newN) >= 0.6 && newN.length >= lastN.length * 0.5))) {
                  if (newN === lastN || lastN.includes(newN) || newN.includes(lastN)) {
                    delta = ''
                  } else {
                    // Near-duplicate rewrite at full-message scale: the delta is
                    // whatever this sentence introduced beyond the tail overlap;
                    // fall back to a single trailing chunk of the new text that
                    // isn't already shown (render-time normalize also collapses it).
                    delta = renderText.slice(0, 0) // empty — the rewrite is visually identical enough that re-rendering the text would just duplicate it
                  }
                } else {
                  delta = renderText
                }
              } else {
                delta = renderText
              }
              lastStreamedTextRef.current = renderText
              pendingBlocksRef.current.push({ type: 'text', content: delta })

              scheduleStreamRender()
            } else if (parsed.type === 'done') {
              if (doneProcessedRef.current) {
                queueDone = true
                return
              }
              // Wait for usage data if not received yet (max 500ms)
              if (!usageReceivedRef.current) {
                await new Promise(r => setTimeout(r, 500))
              }
              doneProcessedRef.current = true
              // 关键修复:done 事件可能自带正文(parsed.content,来自后端 message.complete /
              // run.completed 的 text)。当模型不流式发 message.delta 时 textBuffer 为空,
              // 必须回退用事件自带正文,否则表现为"只思考不输出"。流式场景 textBuffer 已填满,
              // 优先用它(避免 run_complete 自带内容截断已流出的全文)。
              //
              // 权威全文自愈:message.complete 的 text 来自后端 final_response,与 state.db
              // 持久化同源(字节完好),而流式累积 textBuffer 可能因转发链间歇丢空白/换行而损坏
              // (症状:"##当前实时验证\n\n" 黏成 "##当前实时验证")。若 complete 全文在归一化
              // 比较下覆盖流式累积(相同、包含或更长),用权威全文替换——只替换为原文,不猜补
              // 空格,所以绝不会改坏正常文本。仅当 complete 更短(可能为截断/中断)时保留流式累积。
              let content = textBufferRef.current
              const finalText = typeof parsed.content === 'string' ? parsed.content : ''
              if (!content.trim()) {
                content = finalText
              } else if (finalText && finalText.trim()) {
                const normBuf = normalizeForCompare(content)
                const normFinal = normalizeForCompare(finalText)
                if (
                  normBuf && normFinal && normFinal.length >= normBuf.length &&
                  (normFinal === normBuf || normFinal.includes(normBuf) || normBuf.includes(normFinal))
                ) {
                  content = finalText
                }
              }
              let reasoning = thoughtBufferRef.current
              const completedSteps = stepsRef.current
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              streamCappedRef.current = false
              thinkingCappedRef.current = false
              pendingTextRef.current = null
              pendingThinkingRef.current = null
              pendingBlocksRef.current = []
              rafPendingRef.current = false
              uiST('')
              if (content || reasoning || completedSteps.length > 0 || responseBlocksRef.current.length > 0) {
                // Some models place reasoning inside <think:ID>...</think:ID> tags as part of the final text.
                if (!reasoning) {
                  const extracted = extractThinkTags(content)
                  if (extracted.reasoning) {
                    reasoning = extracted.reasoning
                    content = extracted.content || extracted.reasoning
                  }
                }
                // If the model only emitted thinking tokens and no visible text,
                // surface the reasoning as the message content so the user sees
                // something useful instead of a blank reply.
                if (!content && reasoning) {
                  content = reasoning
                  reasoning = ''
                }
                // Detect scheduled-task declarations in AI output. Don't auto-create —
                // collect them and show a confirm dialog so the user approves first.
                const detected = detectScheduledTasks(content)
                content = detected.cleaned
                if (detected.tasks.length > 0) {
                  setPendingTaskCreations(prev => [...prev, ...detected.tasks.map(t => ({ ...t, sessionId: currentSessionId ?? undefined }))])
                }
                const curState = useHelixStore.getState()
                const endTs = Date.now()
                const totalSecs = Math.max(0, Math.round((endTs - startedAtRef.current) / 1000))
                let thinkingSecs = thinkingStartTimeRef.current
                  ? Math.round((endTs - thinkingStartTimeRef.current) / 1000)
                  : (firstContentAtRef.current && promptSentAtRef.current
                      ? Math.round((firstContentAtRef.current - promptSentAtRef.current) / 1000)
                      : 0)
                // 极短思考（<0.5s 取整为 0）但有思考迹象时，至少记为 1s，避免"有思考却不显示"
                if (thinkingSecs === 0 && (thinkingStartTimeRef.current || firstContentAtRef.current)) thinkingSecs = 1
                thinkingDurationRef.current = thinkingSecs
                // If responseBlocks has no text block but content is non-empty,
                // discard blocks so the renderer falls back to rendering msg.content
                // — prevents "only tool_groups/thinking, no readable result".
                // Also discard reasoning in this case: the thinking was intermediate
                // context that produced the final answer; showing it as a separate
                // collapsible below the completed text is redundant and confusing.
                let finalBlocks = responseBlocksRef.current.length ? responseBlocksRef.current : undefined
                const discardBlocks = !!(finalBlocks && content && !finalBlocks.some(b => b.type === 'text'))
                if (discardBlocks) {
                  finalBlocks = undefined
                }
                // CRITICAL: clear streaming blocks BEFORE adding the completed
                // message to chatMessages.  Zustand store writes can trigger a
                // synchronous (or microtask) React re-render *before* our subsequent
                // useState calls (setResponseBlocks etc.) are flushed.  If responseBlocks
                // still holds tool_groups at that point, BOTH rendering paths show
                // them simultaneously — TranscriptMessage (from sessionMessages) AND
                // the streaming area (via displayResponseBlocks) — producing exact
                // duplicates of every tool_group block.
                uiRB([])
                const msgId = curState.addChatMessage({ role: 'assistant', content, reasoning: discardBlocks ? undefined : (reasoning || undefined), steps: completedSteps.length ? completedSteps : undefined, blocks: finalBlocks, sessionId: activeSessionId, duration: totalSecs > 0 ? totalSecs : undefined, thoughtTokens: thoughtTokensRef.current || undefined, outputTokens: outputTokensRef.current || undefined, totalTokens: totalTokensRef.current || undefined, thinkingTime: thinkingDurationRef.current || undefined })
                thoughtTokensRef.current = 0
                outputTokensRef.current = 0
                thinkingStartTimeRef.current = 0
                thinkingDurationRef.current = 0
                curState.setChatMessageStreaming(msgId, false)
              } else {
                // 防御性兜底：run 结束但无任何可见内容（根因已修复，极少触发）。
                const st = useHelixStore.getState()
                const mid = st.addChatMessage({ role: 'assistant', content: '⚠️ 本轮运行已结束，但模型未返回任何可见内容。', sessionId: activeSessionId })
                st.setChatMessageStreaming(mid, false)
              }
              // Hermes' ACP adapter only emits a `tool_call` (tool.started) event
              // and NOT a matching completion/failure event (see backend
              // _tool_progress: `if event_type != "tool.started": return`). So a
              // tool_call step we created as `running` would otherwise stay stuck
              // in "正在执行工具" forever. On done, flush any lingering running
              // tool calls to completed so the status bar clears and the tool
              // card shows a finished state.
              uiSteps(prev => {
                const next = prev.map(s =>
                  s.type === 'tool_call' && s.status === 'running'
                    ? { ...s, status: 'completed' as const }
                    : s
                )
                return [...next, { id: generateId(), type: 'done', content: parsed.content, finishReason: parsed.finishReason, timestamp: Date.now() }]
              })
            } else if (parsed.type === 'error') {
              const content = textBufferRef.current
              const reasoning = thoughtBufferRef.current
              const errorSteps = stepsRef.current
              textBufferRef.current = ''
              thoughtBufferRef.current = ''
              streamCappedRef.current = false
              thinkingCappedRef.current = false
              pendingTextRef.current = null
              pendingThinkingRef.current = null
              pendingBlocksRef.current = []
              rafPendingRef.current = false
              uiST('')
              // Clear streaming blocks BEFORE adding to chatMessages — same race
              // condition as the done path above (Zustand store write can trigger
              // a re-render before React useState batches flush).
              uiRB([])
              if (content || reasoning || errorSteps.length > 0 || responseBlocks.length > 0) {
                const curState = useHelixStore.getState()
                const msgId = curState.addChatMessage({ role: 'assistant', content, reasoning: reasoning || undefined, steps: errorSteps.length ? errorSteps : undefined, blocks: responseBlocksRef.current.length ? responseBlocksRef.current : undefined, sessionId: activeSessionId })
                curState.setChatMessageStreaming(msgId, false)
              } else if (parsed.content) {
                // Pure error with no streamed content — surface it as an assistant message
                const curState = useHelixStore.getState()
                const msgId = curState.addChatMessage({ role: 'assistant', content: '⚠️ ' + parsed.content, sessionId: activeSessionId })
                curState.setChatMessageStreaming(msgId, false)
              }
              // Mark all running tool_calls as failed so they disappear from the
              // "正在执行工具" status bar.
              const errId = generateId()
              uiSteps(prev => {
                const next = prev.map(s =>
                  s.type === 'tool_call' && s.status === 'running'
                    ? { ...s, status: 'failed' as const }
                    : s
                )
                return [...next, { id: errId, type: 'error', content: parsed.content, timestamp: Date.now() }]
              })
              storeActions.addExecutionStep({ type: 'error' })
            } else if (parsed.type === 'plan') {
              const id = generateId()
              uiSteps(prev => [...prev, { id, type: 'plan', content: '模型已规划以下步骤', planText: parsed.planText || parsed.content, timestamp: Date.now() }])
              storeActions.addExecutionStep({ type: 'plan' })
            } else if (parsed.type === 'task') {
              const id = generateId()
              uiSteps(prev => [...prev, { id, type: 'task', content: parsed.content, taskLabel: parsed.taskLabel, taskId: parsed.taskId, timestamp: Date.now() }])
              storeActions.addExecutionStep({ type: 'task' })
            } else if (parsed.type === 'compact') {
              const id = generateId()
              uiSteps(prev => [...prev, { id, type: 'compact', content: parsed.content, timestamp: Date.now() }])
            } else if (parsed.type === 'usage_update') {
              if (activeSessionId) useHelixStore.getState().setContextUsage(activeSessionId, parsed.size, parsed.used)
            } else if (parsed.type === 'usage_prompt_complete') {
              const u = parsed.usage
              if (u && typeof u === 'object' && !usageReceivedRef.current) {
                const model = useHelixStore.getState().apiConfig.model || 'unknown'
                useHelixStore.getState().addSessionUsageStats(model, {
                  totalTokens: Number(u.totalTokens) || undefined,
                  inputTokens: Number(u.inputTokens) || undefined,
                  outputTokens: Number(u.outputTokens) || undefined,
                  thoughtTokens: Number(u.thoughtTokens) || undefined,
                  cachedReadTokens: Number(u.cachedReadTokens) || undefined,
                  cachedWriteTokens: Number(u.cachedWriteTokens) || undefined,
                })
                usageReceivedRef.current = true
                thoughtTokensRef.current = Number(u.thoughtTokens) || 0
                outputTokensRef.current = Number(u.outputTokens) || 0
                totalTokensRef.current = Number(u.totalTokens) || 0
                uiTotalTokens(totalTokensRef.current)
                // 只用后端 message.complete 携带的真实 context_used/context_max，
                // 不再用客户端估算。无后端数据时上下文环显示空态。
                const ctxMax = Number(u.context_max) || 0
                const ctxUsed = Number(u.context_used) || 0
                if (ctxMax && ctxUsed && activeSessionId) {
                  useHelixStore.getState().setContextUsage(activeSessionId, ctxMax, ctxUsed)
                }
              }
            } else if (parsed.type === 'available_commands') {
              useHelixStore.getState().setAvailableCommands(parsed.commands)
            } else if (parsed.type === 'approval_request') {
              // 审批分流：项目内文件修改 → 直接回 approve（不弹窗，diff 记录走
              // tool.complete inline_diff 独立路径不受影响）；危险命令/项目外文件/
              // 敏感文件/上传外发 → 入队弹审批条。完全访问权限档（yolo 开）时后端
              // 不发本事件，前端无物可分。
              const verdict = classifyApproval(
                String(parsed.toolName || ''),
                parsed.toolParams || {},
                useHelixStore.getState().selectedWorkDir,
                useHelixStore.getState().approvalMode,
              )
              if (verdict === 'auto') {
                const sid = (myCid && sessionMapRef.current.get(myCid)?.sid)
                  || (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid)
                  || hermesSessionIdRef.current
                if (sid) {
                  hermesApi()!.send('session/approve', {
                    session_id: sid,
                    toolCallId: parsed.approvalId,
                    approve: true,
                  }).catch((e: any) => console.warn('[Helix] auto-approve failed:', e))
                }
              } else {
                setApprovalQueue(prev => [...prev, {
                  id: parsed.approvalId,
                  sessionId: currentSessionId ?? undefined,
                  toolName: parsed.toolName,
                  params: parsed.toolParams || {},
                  timestamp: Date.now(),
                }])
              }
            } else if (parsed.type === 'clarify_request') {
              setClarifyQueue(prev => [...prev, {
                id: parsed.requestId,
                sessionId: currentSessionId ?? undefined,
                question: parsed.question || '',
                choices: parsed.choices || null,
              }])
            }
          } catch {
            // skip non-JSON lines
          }
        }
      }
    } catch (error) {
      debug('[HelixTrace] handleRun catch', {
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        currentSessionId,
        runningSessionId: runningSessionIdRef.current,
        textLen: textBufferRef.current?.length ?? 0,
        reasoningLen: thoughtBufferRef.current?.length ?? 0,
        stepsLen: stepsRef.current.length,
        responseBlocksLen: responseBlocks.length,
      })
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Save partial response before showing error
        if (textBufferRef.current) {
          const partialContent = textBufferRef.current
          const partialReasoning = thoughtBufferRef.current || undefined
          const msgId = useHelixStore.getState().addChatMessage({
            role: 'assistant',
            content: partialContent + '\n\n*[执行已中断]*',
            reasoning: partialReasoning,
            sessionId: activeSessionId,
          })
          useHelixStore.getState().setChatMessageStreaming(msgId, false)
        }
        pendingTextRef.current = null
        pendingThinkingRef.current = null
        pendingBlocksRef.current = []
        rafPendingRef.current = false
        uiSteps(prev => [...prev, {
          id: generateId(),
          type: 'error',
          content: '用户取消了执行',
          timestamp: Date.now(),
        }])
      } else {
        const message = error instanceof Error ? error.message : '连接失败，请检查网络和 API 设置'
        uiSteps(prev => [...prev, {
          id: generateId(),
          type: 'error',
          content: message,
          timestamp: Date.now(),
        }])
      }
    } finally {
      debug('[HelixTrace] handleRun finally ENTRY', {
        reason: queueDone ? 'queueDone' : 'abort/error',
        currentSessionId,
        runningSessionId: runningSessionIdRef.current,
        textLen: textBufferRef.current?.length ?? 0,
        reasoningLen: thoughtBufferRef.current?.length ?? 0,
        stepsLen: stepsRef.current.length,
        responseBlocksLen: responseBlocks.length,
      })
      const reason = queueDone ? 'queueDone' : 'abort/error'
      debug('[HelixTrace] handleRun finally', {
        reason,
        currentSessionId,
        runningSessionId: runningSessionIdRef.current,
        isRunningSession: currentSessionId === runningSessionIdRef.current,
        textLen: textBufferRef.current?.length ?? 0,
        reasoningLen: thoughtBufferRef.current?.length ?? 0,
        stepsLen: stepsRef.current.length,
        responseBlocksLen: responseBlocks.length,
      })
      // Always unsubscribe to prevent duplicate event handlers
      try { if (unsubscribe) unsubscribe() } catch {}

      // Cancel any pending synthetic-done timer so it can't fire after the run
      // ended (e.g. on abort / unmount) and call setState on a dead context.
      if (synthDoneTimerRef.current) {
        clearTimeout(synthDoneTimerRef.current)
        synthDoneTimerRef.current = null
      }
      if (forceDoneTimerRef.current) {
        clearTimeout(forceDoneTimerRef.current)
        forceDoneTimerRef.current = null
      }
      if (idleTimerRef) { clearTimeout(idleTimerRef); idleTimerRef = null }  // 清理空闲检测定时器
      // Seal the run: prevent any straggler rAF syncDraft callback from
      // re-setting isAgentRunning=true after we mark it false below.
      runCompleted = true
      const sid = activeSessionId
      if (sid) {
        // Clear the draft's responseBlocks at the same time we drop isAgentRunning:
        // the completed message was already committed to chatMessages (it renders
        // via TranscriptMessage), so any blocks still sitting in the draft would
        // make the streaming area render them a SECOND time — "输出重复两遍".
        // The completed message carries its own finalBlocks, so the draft copy is
        // redundant from this point on. Clearing here (instead of waiting for the
        // setTimeout clearStreamingDraft) closes the window where both containers
        // render the same blocks.
        setStreamingDraft(sid, { isAgentRunning: false, responseBlocks: [] })
        debug('[HelixTrace] handleRun finally setStreamingDraft false', { sid })
        // Once the reply is persisted, the draft is no longer needed; clear it
        // on the next tick so any render this cycle still sees the final steps.
        setTimeout(() => {
          debug('[HelixTrace] handleRun finally clearStreamingDraft', { sid })
          clearStreamingDraft(sid)
        }, 0)
      }
      // Keep the shared textBufferRef populated for the focused run so the
      // email-notify effect can still summarize the finished reply.
      outerTextBufferRef.current = textBufferRef.current
      // This run is done. Only touch the shared "current run" bookkeeping when
      // THIS run is the one the UI considers current — a parallel run in another
      // conversation may still be streaming.
      if (runningSessionIdRef.current === activeSessionId) {
        runningSessionIdRef.current = null
        debug('[HelixTrace] handleRun finally BEFORE isChatLoading false', {
          isChatLoading: useHelixStore.getState().isChatLoading,
          currentSessionId,
        })
        useHelixStore.setState({ isChatLoading: false })
        debug('[HelixTrace] handleRun finally AFTER isChatLoading false', {
          isChatLoading: useHelixStore.getState().isChatLoading,
          currentSessionId,
        })
      }
      if (abortRef.current === controller) abortRef.current = null
      abortControllersRef.current.delete(activeSessionId)

      // ── Post-run memory cleanup ─────────────────────────────────────────
      // Release large buffers and state that were built up during the run.
      // The final message was already persisted into chatMessages — the
      // streaming buffers, steps, and response blocks are no longer needed.
      // Without this, long conversations accumulate multi-MB of stale refs
      // across turns, eventually blowing the V8 heap past 3 GB.
      setTimeout(() => {
        // Large text / reasoning buffers (can be multi-MB with tool output).
        if (textBufferRef.current) textBufferRef.current = ''
        thoughtBufferRef.current = ''
        // Trim response blocks + execution steps back to empty (the store
        // holds a separate truncated copy via addExecutionStep — this
        // component-level state is a duplicate). Only clear the shared live
        // state if THIS run still owns it — a parallel run may have taken over
        // the front and its blocks must not be wiped.
        if (liveStateOwnerRef.current === activeSessionId) {
          setResponseBlocks([])
          setSteps([])
          setStreamThinking('')
        }
      }, 500) // after final render + persist are committed

      // Diagnostic: if the button still shows busy after the run ended, the store
      // is either set back to true later in this frame or something else is
      // keeping `isRunning` true. Capture the next paint-time state too.
      setTimeout(() => {
        debug('[HelixTrace] postRun nextTick snapshot', {
          currentSessionId,
          runningSessionId: runningSessionIdRef.current,
          isRunning,
          isChatLoading: useHelixStore.getState().isChatLoading,
          isBusy: isRunning || useHelixStore.getState().isChatLoading,
        })
      }, 0)

      // Git auto-commit/push after agent completes
      if (isElectron() && sid) {
        const { gitAutoCommit, gitAutoPush, gitCommitTemplate } = useHelixStore.getState()
        if (gitAutoCommit) {
          try {
            const stageResult = await window.electron.git.stage()
            if (stageResult?.ok) {
              const msg = gitCommitTemplate || 'chore: auto-commit changes'
              await window.electron.git.commit(msg)
              if (gitAutoPush) {
                await window.electron.git.push()
              }
            }
          } catch (e) {
            console.error('[GitAutoCommit] Failed:', e)
          }
        }
      }

      // Debounced full-session persist handles saving; mark as saved
      if (!savedSessionRef.current) {
        savedSessionRef.current = true
        storeActions.notifySessionSaved()
      }
    }
  }, [input, hasApiKey, currentSessionId, setStreamingDraft, clearStreamingDraft, storeActions, resolveCommand, BUILTIN_COMMANDS, setInputSynced, handleStop])

  // ── Voice Conversation Mode (like Siri) ──────────────────────────────────

  // ── Wake-word detection ────────────────────────────────────────────────

  // Called when the wake word is detected — plays a ding to confirm.
  const handleWakeDetected = useCallback(() => {
    if (!wakeActiveRef.current) return
    pauseWakeWord()
    setWakeListening(false)
    playDingSound()
    useHelixStore.getState().setShowWakeAnimation(true)
  }, [])

  // After a voice turn ends, auto-resume wake word detection.
  const resumeWakeAfterTurn = useCallback(() => {
    if (!wakeActiveRef.current) return
    pauseWakeWord().then(() => {
      setTimeout(() => {
        if (wakeActiveRef.current) {
          resumeWakeWord()
          setWakeListening(true)
        }
      }, 1000)
    }).catch(() => {})
  }, [])

  // Wake-word event listener
  useEffect(() => {
    if (!isElectron()) return
    const api = hermesApi()
    if (!api) return
    const unsub = api.onEvent((method: string, params: any) => {
      if (method === 'wake_word_wake_word') {
        handleWakeDetected()
      }
      if (method === 'wake_word_started') {
        setWakeListening(true)
      }
      if (method === 'wake_word_paused' || method === 'wake_word_stopped') {
        setWakeListening(false)
      }
      if (method === 'wake_word_in_use') {
        useHelixStore.getState().showToast({
          type: 'warning',
          title: '唤醒词麦克风被占用',
          description: '请关闭其他正在使用唤醒词的程序（如 CLI /wake on）',
        })
        setWakeActive(false)
        wakeActiveRef.current = false
      }
      if (method === 'wake_word_error') {
        const msg = typeof params?.message === 'string' ? params.message : '唤醒词引擎错误'
        useHelixStore.getState().showToast({ type: 'error', title: '唤醒词错误', description: msg })
      }
    })
    return () => { unsub() }
  }, [handleWakeDetected])

  // Auto-start wake word when enabled in settings
  const voiceWakeEnabled = useHelixStore(s => s.voiceWakeEnabled)
  useEffect(() => {
    if (!isElectron() || !voiceWakeEnabled) return
    const init = async () => {
      const ok = await startWakeWord()
      if (ok) {
        setWakeActive(true)
        wakeActiveRef.current = true
      }
    }
    void init()
    return () => {
      if (wakeActiveRef.current) {
        void stopWakeWord()
      }
    }
  }, [voiceWakeEnabled])

  // Stop wake word when setting is toggled off at runtime
  useEffect(() => {
    if (!voiceWakeEnabled && wakeActiveRef.current) {
      void stopWakeWord()
      setWakeActive(false)
      wakeActiveRef.current = false
      setWakeListening(false)
    }
  }, [voiceWakeEnabled])

  // External "send" trigger (Command Center / Review panel call injectAndSend,
  // which bumps requestSendSignal). Fires handleRun with the injected text.
  const requestSendSignal = useHelixStore((s) => s.requestSendSignal)
  useEffect(() => {
    if (requestSendSignal > 0) {
      const text = inputValueRef.current
      if (text.trim()) handleRun()
    }
  }, [requestSendSignal, handleRun])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showAtRef && filteredAtFiles.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedAtFileIndex(prev => Math.min(prev + 1, filteredAtFiles.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedAtFileIndex(prev => Math.max(prev - 1, 0))
          return
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault()
          const idx = Math.min(selectedAtFileIndex, filteredAtFiles.length - 1)
          const selected = filteredAtFiles[idx]
          if (!selected) return
          // Replace @query with the selected file path
          const atIdx = inputValueRef.current.lastIndexOf('@')
          if (atIdx >= 0) {
            const prefix = inputValueRef.current.slice(0, atIdx)
            const ref = `[${selected.name}](file:///${selected.path.replace(/\\/g, '/')})`
            const suffix = inputValueRef.current.slice(atIdx + 1).replace(/^\S+/, '')
            setInputSynced(prefix + ref + suffix)
          }
          setShowAtRef(false)
          setFilteredAtFiles([])
          return
        }
        if (e.key === 'Escape') {
          setShowAtRef(false)
          setFilteredAtFiles([])
          return
        }
      }
      if (showSlashMenu && filteredSkills.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedSkillIndex(prev => Math.min(prev + 1, filteredSkills.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedSkillIndex(prev => Math.max(prev - 1, 0))
          return
        }
        const hasSlashQuery = inputValueRef.current.slice(1).trim().length > 0
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          // With a bare "/", Enter inserts the highlighted item into the input
          // box (so the user can keep composing) instead of auto-running it or
          // sending a bare "/" to the agent. Once a query is typed, Enter runs
          // the highlighted item directly.
          e.preventDefault()
          const idx = Math.min(selectedSkillIndex, filteredSkills.length - 1)
          const selected = filteredSkills[idx] as any
          if (!selected) return
          if (!hasSlashQuery) {
            handleSkillSelect(selected)
            return
          }
            // Built-in commands are instant client-side operations — never gate
            // them on the run state (otherwise /compact & co. silently no-op
            // while a task is running). Hermes commands still stop first.
            if (selected.isBuiltinCommand) {
              setInputSynced(`/${selected.name}`)
              setTimeout(() => handleRun(), 0)
            } else if (selected.isHermesCommand) {
              setInputSynced(`/${selected.name}`)
              setTimeout(() => {
                if (isBusy) {
                  handleStop()
                } else {
                  handleRun()
                }
              }, 0)
            } else {
              handleSkillSelect(selected)
            }
            return
        }
        if (e.key === 'Escape') {
          setInputSynced('')
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        // Toggle send/stop for the CURRENT session only (other tabs keep running).
        // 新建对话（currentSessionId === null）没有自己的 draft——绝不 fallback
        // 到 runningSessionIdRef 去停别的对话的 run；它总是走 handleRun 开新 run。
        const cid = currentSessionId
        const draft = cid ? streamingDrafts[cid] : undefined
        if (draft?.isAgentRunning) {
          handleStop(cid ?? undefined)
        } else {
          handleRun()
        }
      }
    },
    [handleRun, handleStop, showSlashMenu, filteredSkills, handleSkillSelect, selectedSkillIndex, setInputSynced]
  )

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const imageItems = items.filter(item => item.type.startsWith('image/'))

    if (imageItems.length === 0) return // Let normal text paste happen

    e.preventDefault()

    if (!canAddMoreImages(pendingImages.length, imageItems.length)) {
      storeActions.showToast({ type: 'warning', title: `最多粘贴 5 张图片` })
      return
    }

    const newImages: ImageAttachment[] = []
    for (const item of imageItems) {
      const blob = item.getAsFile()
      if (!blob) continue

      const attachment = await processClipboardImage(blob)
      if (attachment) newImages.push(attachment)
    }

    if (newImages.length > 0) {
      setPendingImages(prev => [...prev, ...newImages])
    }
  }, [pendingImages.length, storeActions.showToast])

  const removePendingImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id))
  }, [])

  // Turn a FileList (dropped or picked) into pending file attachments.
  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0) return
    const attachments = await Promise.all(files.map(f => fileToAttachment(f).catch(() => null)))
    const valid = attachments.filter((a): a is FileAttachment => a !== null)
    if (valid.length > 0) setPendingFiles(prev => {
      // Deduplicate by name + size to prevent duplicates
      const existing = new Set(prev.map(f => `${f.name}:${f.size}`))
      const newOnes = valid.filter(f => !existing.has(`${f.name}:${f.size}`))
      if (newOnes.length === 0) return prev
      return [...prev, ...newOnes]
    })
  }, [])

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id))
  }, [])

  const handleApproval = useCallback(async (approvalId: string, approved: boolean, cacheDecision?: boolean) => {
    try {
      const sid = (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid) || hermesSessionIdRef.current
      if (sid) {
        await hermesApi()!.send('session/approve', {
          session_id: sid,
          toolCallId: approvalId,
          approve: approved,
        })
      }
      setApprovalQueue(prev => prev.filter(r => r.id !== approvalId))
    } catch (err) {
      console.error('Approval error:', err)
    }
  }, [])

  // 回应模型的 clarify 反问：把选中项/输入文本发回 clarify/respond 解锁后端，然后出队。
  const handleClarifyRespond = useCallback(async (requestId: string, answer: string) => {
    try {
      const sid = (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid) || hermesSessionIdRef.current
      if (sid) {
        await hermesApi()!.send('clarify/respond', {
          session_id: sid,
          request_id: requestId,
          answer,
        })
      }
    } catch (err) {
      console.error('Clarify respond error:', err)
    } finally {
      setClarifyQueue(prev => prev.filter(r => r.id !== requestId))
    }
  }, [currentSessionId])

  const handleApproveAll = useCallback(async () => {
    if (approvalQueue.length === 0) return
    try {
      const sid = (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid) || hermesSessionIdRef.current
      if (sid) {
        for (const req of approvalQueue) {
          await hermesApi()!.send('session/approve', {
            session_id: sid,
            toolCallId: req.id,
            approve: true,
          })
        }
      }
      setApprovalQueue([])
    } catch (err) {
      console.error('Approve all error:', err)
    }
  }, [approvalQueue])

  // Listen for keyboard shortcut approve/decline events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (approvalQueue.length === 0) return
      const first = approvalQueue[0]
      handleApproval(first.id, detail.approved)
    }
    window.addEventListener('helix:approve-request', handler)
    return () => window.removeEventListener('helix:approve-request', handler)
  }, [approvalQueue, handleApproval])

  // Allow other UI surfaces (sidebar session switch, etc.) to request an
  // immediate stop of the in-flight run without tight coupling.
  useEffect(() => {
    const handler = () => {
      handleStop()
    }
    window.addEventListener('helix:interrupt-request', handler)
    return () => window.removeEventListener('helix:interrupt-request', handler)
  }, [handleStop])

  // Restore per-tab input when switching sessions
  useEffect(() => {
    const sid = useHelixStore.getState().currentSessionId ?? DRAFT_SESSION_KEY
    const saved = useHelixStore.getState().tabInputs[sid]
    if (saved !== undefined && saved !== inputValueRef.current) {
      setInputSynced(saved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId])

  // Attachments are composing state: persist per-session (like tabInputs) so
  // files uploaded in conversation A never show up in B's input, and come back
  // when you return to A. Without this, pendingImages/pendingFiles live in a
  // single component-level useState that survives session switches untouched.
  // Uses DRAFT_SESSION_KEY when no real session exists yet, so unsent drafts
  // (new conversation, nothing sent) also round-trip correctly.
  const lastSessionForAttachmentsRef = useRef<string | null>(null)
  useEffect(() => {
    const store = useHelixStore.getState()
    const effectiveKey = currentSessionId ?? DRAFT_SESSION_KEY
    const prev = lastSessionForAttachmentsRef.current
    if (prev && prev !== effectiveKey) {
      store.setTabAttachments(prev, pendingImages, pendingFiles)
    }
    lastSessionForAttachmentsRef.current = effectiveKey
    const saved = useHelixStore.getState().tabAttachments[effectiveKey]
    setPendingImages(saved?.images ?? [])
    setPendingFiles(saved?.files ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId])


  // Stats
  // Per-session: `steps` is component-level state that is NOT cleared when you
  // switch to a brand-new conversation while a run is still active. Basing the
  // empty-state hero on the raw `steps` would suppress it — a new conversation
  // renders as a blank white area until the background run's finally clears
  // steps. `displaySteps` is already session-filtered, so use that.
  const hasSteps = displaySteps.length > 0

  const renderChatInput = ({ isEmpty }: { isEmpty?: boolean } = {}) => {
    const projectName = selectedWorkDir ? (selectedWorkDir.split(/[/\\]/).pop() || selectedWorkDir) : '选择项目'
    const approvalModeButton = (
      <div className="relative" ref={approvalModeDropdownRef}>
        <button
          type="button"
          onClick={() => setShowApprovalModeDropdown(!showApprovalModeDropdown)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all duration-200 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60"
          data-tip="审批模式"
        >
          {approvalMode === 'default' && <Hand className="size-3.5" />}
          {approvalMode === 'accept_edits' && <Clock className="size-3.5" />}
          {approvalMode === 'dont_ask' && <AlertTriangle className="size-3.5" />}
          <span>
            {approvalMode === 'default' && '请求批准'}
            {approvalMode === 'accept_edits' && '替我审批'}
            {approvalMode === 'dont_ask' && '完全访问权限'}
          </span>
          <ChevronDown className="size-3" />
        </button>
        {showApprovalModeDropdown && (
          <div className="absolute bottom-full left-0 mb-2 w-72 bg-popover rounded-xl border border-border/40 shadow-xl py-1 z-50 animate-scale-in">
            {[
              {
                id: 'default' as const,
                icon: Hand,
                title: '请求批准',
                desc: '所有操作均请求批准（含文件写入与命令执行）',
              },
              {
                id: 'accept_edits' as const,
                icon: Clock,
                title: '替我审批',
                desc: '仅对检测到的风险操作请求批准',
              },
              {
                id: 'dont_ask' as const,
                icon: AlertTriangle,
                title: '完全访问权限',
                desc: '可不受限制地访问互联网和您电脑上的任何文件',
              },
            ].map((mode) => {
              const Icon = mode.icon
              const active = approvalMode === mode.id
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    setApprovalMode(mode.id)
                    setShowApprovalModeDropdown(false)
                    // Immediately apply to current session if one exists
                    const hermesSid = (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid) || hermesSessionIdRef.current
                    if (hermesSid) {
                      hermesApi()!.send('session/set_mode', {
                        session_id: hermesSid,
                        mode_id: mode.id,
                      }).catch((e: any) => {
                        console.warn('[Helix] set_mode(' + mode.id + ') failed:', e)
                      })
                    }
                  }}
                  className={`w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-muted transition-colors ${active ? 'bg-primary/5' : ''}`}
                >
                  <div className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
                    <Icon className="size-4 text-foreground/70" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">{mode.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">{mode.desc}</div>
                  </div>
                  {active && (
                    <div className="mt-1 shrink-0">
                      <Check className="size-4 text-primary" />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
    return (
    <div
      ref={chatInputWrapRef}
      className={`border transition-all duration-200 relative bg-background/90 backdrop-blur-md border-border/40 rounded-2xl shadow-lg shadow-black/5 ${isDraggingFile ? 'border-primary/40' : 'hover:border-border/60 focus-within:border-primary/30'}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!isDraggingFile) setIsDraggingFile(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDraggingFile(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDraggingFile(false)
        if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
      }}
    >
            {/* Drag-over hint */}
            {isDraggingFile && (
              <div className={`absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-primary/10 text-sm font-medium text-primary rounded-2xl`}>
                松开以添加附件
              </div>
            )}
            {pendingFiles.length > 0 && (
              <div className={`flex flex-wrap gap-2 border-t border-border/20 px-4 py-2`}>
                {pendingFiles.map(f => (
                  <div
                    key={f.id}
                    className="relative flex items-center gap-2 max-w-[220px] px-2.5 py-1.5 rounded-xl border border-border/30 bg-muted/20 hover:bg-muted/40 hover:border-border/30 transition-all duration-200 group"
                  >
                    {f.kind === 'image' && f.dataUrl ? (
                      <img src={f.dataUrl} alt={f.name} className="size-7 rounded-lg object-cover shrink-0" />
                    ) : (
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{f.name}</p>
                      <p className="text-[10px] text-muted-foreground/60">{formatBytes(f.size)}</p>
                    </div>
                    <button
                      onClick={() => removePendingFile(f.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Image preview area */}
            {pendingImages.length > 0 && (
              <div className={`flex gap-2 overflow-x-auto border-t border-border/30 px-4 py-2`}>
                {pendingImages.map(img => (
                  <div key={img.id} className="relative shrink-0 group">
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="w-20 h-20 rounded-lg object-cover border border-border/30"
                    />
                    <button
                      onClick={() => removePendingImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Single textarea — no highlight overlay (WebKitGTK renders textarea text
                via native Pango, not WebKit's CSS engine, so a separate highlight div
                can never align glyphs pixel-perfectly on Linux). */}
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isEmpty ? "随心输入..." : "要求后续变更..."}
              rows={2}
              className="chat-input w-full resize-none bg-transparent caret-foreground text-left placeholder:text-left placeholder:text-muted-foreground/60 outline-none focus-visible:outline-none text-sm min-h-[52px] max-h-[300px] px-4 pt-3.5 pb-1 leading-relaxed  [overflow-wrap:anywhere] overflow-x-hidden overflow-y-auto text-foreground"
              style={{
                overflowX: 'hidden',
                overflowY: 'auto',
                height: '52px',
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                const prevHeight = parseInt(target.style.height || '52', 10)
                target.style.height = '52px'
                const ch = target.scrollHeight
                const min = 52
                const nextHeight = ch > min ? Math.min(ch, 300) : min
                target.style.height = nextHeight + 'px'
                // 输入框长高时自动把视口滚到底，防止输入框跑到可见区域下方
                if (nextHeight > prevHeight && scrollRef.current) {
                  const vp = scrollRef.current
                  if (vp) {
                    requestAnimationFrame(() => { vp.scrollTop = vp.scrollHeight })
                  }
                }
              }}
            />

            {/* Live voice transcription preview */}
            {voiceInputActive && (
              <div className="voice-interim">
                {voiceInputInterim ? (
                  <>{voiceInputInterim}<span className="caret" /></>
                ) : (
                  <span className="listening">正在聆听…</span>
                )}
              </div>
            )}

            {/* Unified slash command dropdown */}
            {showSlashMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-background/95 backdrop-blur-sm rounded-2xl border border-border/30 shadow-xl shadow-black/10 z-50 max-h-[300px] overflow-y-auto mx-3">
                {/* Quick commands section */}
                {matchedQuickCmds.length > 0 && (
                  <>
                    <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-wider">快捷指令</p>
                    {matchedQuickCmds.map((qc) => (
                      <button
                        key={qc.cmd}
                        type="button"
                        onClick={() => {
                          setInputSynced(qc.prompt)
                          inputRef.current?.focus()
                        }}
                        className="w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5 hover:bg-muted/30"
                      >
                        <code className="text-[12px] font-mono text-primary/70 shrink-0 w-20">{qc.cmd}</code>
                        <div className="min-w-0 flex-1">
                          <span className="text-[13px] text-foreground block">{qc.label}</span>
                          <span className="text-[11px] text-muted-foreground block truncate">{qc.prompt}</span>
                        </div>
                      </button>
                    ))}
                  </>
                )}

                {/* Skills/Commands section */}
                {filteredSkills.length > 0 && (
                  <>
                    {matchedQuickCmds.length > 0 && <div className="border-t border-border/20 mx-3" />}
                    <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-wider">命令</p>
                    {filteredSkills.map((skill, index) => (
                      <button
                        key={skill.id}
                        type="button"
                        ref={index === selectedSkillIndex ? (el) => { if (el) el.scrollIntoView({ block: 'nearest' }) } : undefined}
                        onClick={() => {
                          if ((skill as any).isBuiltinCommand) {
                            setInputSynced(`/${skill.name}`)
                            setTimeout(() => handleRun(), 0)
                          } else if ((skill as any).isHermesCommand) {
                            setInputSynced(`/${skill.name}`)
                            if (!isBusy) {
                              setTimeout(() => handleRun(), 0)
                            }
                          } else {
                            handleSkillSelect(skill)
                          }
                        }}
                        className={`w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5 ${
                          index === selectedSkillIndex
                            ? 'bg-primary/10 text-primary'
                            : 'hover:bg-muted/30'
                        }`}
                      >
                        {(skill as any).isBuiltinCommand
                          ? <Circle className="size-3.5 text-amber-500/70 shrink-0" fill="currentColor" />
                          : <FileText className="size-4 text-foreground/40 shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <span className="text-[13px] text-foreground block truncate">{skill.name}</span>
                          {skill.description && (
                            <span className="text-[11px] text-muted-foreground block truncate">{skill.description}</span>
                          )}
                        </div>
                        {(skill as any).isBuiltinCommand && (
                          <span className="text-[10px] text-amber-500/70 shrink-0">CMD</span>
                        )}
                        {(skill as any).isHermesCommand && (
                          <span className="text-[10px] text-muted-foreground/60 shrink-0">Hermes</span>
                        )}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* @-triggered file reference dropdown */}
            {showAtRef && filteredAtFiles.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-background/95 backdrop-blur-sm rounded-2xl border border-border/30 shadow-xl shadow-black/10 z-50 max-h-[200px] overflow-y-auto mx-3">
                {filteredAtFiles.map((file, index) => (
                  <button
                    key={file.path}
                    type="button"
                    ref={index === selectedAtFileIndex ? (el) => { if (el) el.scrollIntoView({ block: 'nearest' }) } : undefined}
                    onClick={() => {
                      const atIdx = inputValueRef.current.lastIndexOf('@')
                      if (atIdx >= 0) {
                        const prefix = inputValueRef.current.slice(0, atIdx)
                        const ref = `[${file.name}](file:///${file.path.replace(/\\/g, '/')})`
                        const suffix = inputValueRef.current.slice(atIdx + 1).replace(/^\S+/, '')
                        setInputSynced(prefix + ref + suffix)
                      }
                      setShowAtRef(false)
                      setFilteredAtFiles([])
                    }}
                    className={`w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5 first:rounded-t-2xl last:rounded-b-2xl ${
                      index === selectedAtFileIndex
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted/30'
                    }`}
                  >
                    <FileText className="size-4 text-foreground/40 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] text-foreground block truncate">{file.name}</span>
                      <span className="text-[11px] text-muted-foreground block truncate">{file.path}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Input toolbar */}
            <div className={`flex items-center justify-between px-3 pb-2.5 pt-0.5`}>
              {isEmpty ? (
                <>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => uploadFileInputRef.current?.click()}
                      className="p-2 rounded-xl text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-all duration-200"
                      data-tip="上传附件"
                    >
                      <Plus className="size-4" />
                    </button>
                    {approvalModeButton}
                    <input
                      ref={uploadFileInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      onChange={handleFileSelect}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ContextUsageIndicator />
                    {hasApiKey || isServeActive() ? (
                      renderModelSelector()
                    ) : (
                      <button
                        type="button"
                        onClick={() => storeActions.toggleSettings('api')}
                        className="text-xs text-foreground/50 hover:text-foreground hover:bg-muted/60 px-2.5 py-1.5 h-9 rounded-lg transition-colors"
                      >
                        设置模型
                      </button>
                    )}
                    <ReasoningEffortControl value={reasoningEffort} onChange={(v) => storeActions.setReasoningEffort(v)} />
                    <button
                      type="button"
                      onClick={handleVoiceInputToggle}
                      className={`h-9 w-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center ${
                        voiceInputActive
                          ? 'text-white bg-destructive/85 hover:bg-destructive shadow-sm'
                          : 'text-muted-foreground hover:text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40'
                      }`}
                      data-tip={voiceInputActive ? '停止语音输入' : '语音输入'}
                    >
                      <Mic className={`size-4 ${voiceInputActive ? 'animate-pulse' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={isBusy ? () => handleStop() : handleRun}
                      disabled={!isBusy && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                      className={`h-9 w-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center ${
                        isBusy
                          ? 'text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40'
                          : 'text-muted-foreground hover:text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40'
                      }`}
                      data-tip={isBusy ? '停止' : '发送'}
                    >
                      {isBusy ? <Square className="size-3 text-foreground fill-foreground" /> : <ArrowUp className="size-4" />}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => uploadFileInputRef.current?.click()}
                      className="p-2 rounded-xl text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-all"
                      data-tip="上传文件"
                    >
                      <Plus className="size-4" />
                    </button>
                    {approvalModeButton}
                    <input
                      ref={uploadFileInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      onChange={handleFileSelect}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ContextUsageIndicator />
                    {(hasApiKey || isServeActive()) && renderModelSelector()}
                    <ReasoningEffortControl value={reasoningEffort} onChange={(v) => storeActions.setReasoningEffort(v)} />
                    <button
                      type="button"
                      onClick={handleVoiceInputToggle}
                      className={`h-9 w-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center ${
                        voiceInputActive
                          ? 'text-white bg-destructive/85 hover:bg-destructive shadow-sm'
                          : 'text-muted-foreground hover:text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40'
                      }`}
                      data-tip={voiceInputActive ? '停止语音输入' : '语音输入'}
                    >
                      <Mic className={`size-4 ${voiceInputActive ? 'animate-pulse' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={isBusy ? () => handleStop() : handleRun}
                      disabled={!isBusy && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
                      className={`h-9 w-9 shrink-0 rounded-xl transition-all duration-200 flex items-center justify-center ${
                        isBusy
                          ? 'text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40'
                          : 'text-muted-foreground hover:text-foreground bg-muted/30 border border-border/30 hover:bg-muted/40'
                      }`}
                      data-tip={isBusy ? '停止' : '发送'}
                    >
                      {isBusy ? <Square className="size-3 text-foreground fill-foreground" /> : <ArrowUp className="size-4" />}
                    </button>
                  </div>
                </>
              )}
            </div>
      </div>
  )}

  const renderEmptyBreadcrumb = () => {
    const projectName = selectedWorkDir ? (selectedWorkDir.split(/[\/\\]/).pop() || selectedWorkDir) : '选择项目'
    return (
      <div className="flex items-center justify-start gap-1 mb-3">
        <button
          type="button"
          onClick={async () => {
            if (!isElectron()) {
              return
            }
            try {
              const dir = await electronDialog.openDirectory()
              if (dir) selectWorkDir(dir)
            } catch (e) {
              console.error('[selectWorkDir] openDirectory failed:', e)
            }
          }}
          className="flex items-center gap-1.5 text-[12px] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
          data-tip={selectedWorkDir || '选择项目目录'}
        >
          <Folder className="size-3.5 text-amber-500" />
          <span className="max-w-[160px] truncate">{projectName}</span>
        </button>

        {/* External services (server / VM) — breadcrumb entry, placed right of project name */}
        {/* Git branch picker — only shown when the selected project is a git repo */}
        {gitAvailable === true && (
          <div className="relative" ref={branchPopoverRef}>
          <button
            type="button"
            onClick={() => {
              const willOpen = !branchPopoverOpen
              setBranchPopoverOpen(willOpen)
              setBranchSearch('')
              setBranchCreating(false)
              setBranchNewName('')
              if (willOpen && isElectron()) {
                electronGit.branchList(selectedWorkDir)
                  .then((res: { ok: boolean; branches?: string[]; error?: string }) => {
                    if (res.ok && res.branches) setBranchList(res.branches)
                  })
                  .catch(() => {})
                electronGit.status(selectedWorkDir)
                  .then((res: { ok: boolean; output?: string }) => {
                    if (res.ok && res.output) {
                      // porcelain=v2: count lines starting with '1' or '2' (file entries)
                      const lines = res.output.split('\n')
                      const count = lines.filter(l => /^[12]/.test(l)).length
                      setBranchDirtyCount(count)
                    } else {
                      setBranchDirtyCount(0)
                    }
                  })
                  .catch(() => setBranchDirtyCount(0))
              }
            }}
            className="flex items-center gap-1.5 text-[12px] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
            data-tip={`当前分支：${currentBranch}（点击查看全部分支）`}
          >
            <GitBranch className="size-3.5 text-emerald-500" />
            <span>{currentBranch}</span>
          </button>
          {branchPopoverOpen && (
            <div className="absolute bottom-full left-0 mb-1.5 w-64 bg-background/95 backdrop-blur-sm rounded-xl border border-border/30 shadow-lg shadow-black/8 z-50 flex flex-col max-h-80">
              {/* Search */}
              <div className="px-3 pt-2.5 pb-1.5 border-b border-border/20">
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Search className="size-3.5 shrink-0" />
                  <input
                    value={branchSearch}
                    onChange={(e) => setBranchSearch(e.target.value)}
                    placeholder="搜索分支"
                    className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
                    autoFocus
                  />
                </div>
              </div>

              {/* Branch list */}
              <div className="flex-1 overflow-y-auto py-1 min-h-0">
                <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">分支</div>
                {branchList.filter(b => !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase())).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={async () => {
                      if (!isElectron()) return
                      const res = await electronGit.branchSwitch(b, selectedWorkDir)
                      if (res.ok) {
                        setCurrentBranch(b)
                        setBranchPopoverOpen(false)
                        storeActions.showToast({ type: 'success', title: `已切换到 ${b}` })
                      } else {
                        storeActions.showToast({ type: 'error', title: '切换分支失败', description: res.error })
                      }
                    }}
                    className={`w-full flex items-center gap-2 text-[13px] px-3 py-1.5 transition-colors ${b === currentBranch ? 'bg-primary/8 text-primary' : 'text-foreground/80 hover:bg-muted/40'}`}
                  >
                    <GitBranch className="size-3.5 shrink-0 text-foreground/40" />
                    <span className="truncate flex-1 text-left">{b}</span>
                    {b === currentBranch && (
                      <div className="flex items-center gap-2 shrink-0">
                        {branchDirtyCount > 0 && (
                          <span className="text-[11px] text-muted-foreground">未提交：{branchDirtyCount} 个文件</span>
                        )}
                        <Check className="size-4 text-primary" strokeWidth={2.5} />
                      </div>
                    )}
                  </button>
                ))}
              </div>

              {/* Create branch */}
              <div className="border-t border-border/20">
                {!branchCreating ? (
                  <button
                    type="button"
                    onClick={() => { setBranchCreating(true); setBranchNewName('') }}
                    className="w-full flex items-center gap-2 text-[12px] px-3 py-2 text-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors"
                  >
                    <Plus className="size-3" />
                    创建并检出新分支...
                  </button>
                ) : (
                  <div className="px-3 py-2 space-y-1.5">
                    <input
                      value={branchNewName}
                      onChange={(e) => setBranchNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && branchNewName.trim()) handleCreateBranch(branchNewName.trim())
                        if (e.key === 'Escape') setBranchCreating(false)
                      }}
                      placeholder="新分支名称"
                      className="w-full text-[12px] px-2 py-1 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
                      autoFocus
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleCreateBranch(branchNewName.trim())}
                        disabled={!branchNewName.trim()}
                        className="flex-1 text-[11px] py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-30"
                      >创建</button>
                      <button
                        type="button"
                        onClick={() => setBranchCreating(false)}
                        className="flex-1 text-[11px] py-1 rounded-md bg-muted/40 text-foreground/70 hover:bg-muted/60 transition-colors"
                      >取消</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-transparent text-foreground relative">
      {/* Header bar - removed */}

      {/* Conversation search bar (Ctrl+F) */}
      {conversationSearchOpen && (
        <div className="absolute top-2.5 right-3 z-40 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-popover text-popover-foreground border border-border/70 shadow-lg">
          <Search className="size-3.5 text-muted-foreground shrink-0" />
          <input
            ref={conversationSearchInputRef}
            value={conversationSearchQuery}
            onChange={(e) => { setConversationSearchQuery(e.target.value); setConversationSearchActive(0) }}
            onKeyDown={handleConversationSearchKeyDown}
            placeholder="搜索对话内容..."
            className="w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className={`text-[11px] tabular-nums shrink-0 ${searchMatches.length ? 'text-muted-foreground' : 'text-foreground/40'}`}>
            {conversationSearchQuery.trim() ? (searchMatches.length ? `${conversationSearchActive + 1}/${searchMatches.length}` : '无结果') : ''}
          </span>
          <button
            onClick={goToPrevSearchMatch}
            disabled={!searchMatches.length}
            className="p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            data-tip="上一个匹配 (Shift+Enter)"
          >
            <ArrowUp className="size-3.5" />
          </button>
          <button
            onClick={goToNextSearchMatch}
            disabled={!searchMatches.length}
            className="p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            data-tip="下一个匹配 (Enter)"
          >
            <ArrowDown className="size-3.5" />
          </button>
          <button
            onClick={closeConversationSearch}
            className="p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors"
            data-tip="关闭 (Esc)"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Flow area */}
      {/* 模型在执行危险操作、弹出确认弹窗时，不显示聊天对话框（对话区+输入框）。
          只保留确认弹窗，让用户专注审批；审批结束后聊天恢复显示。 */}
      <div ref={scrollRef} className={`flex-1 min-h-0 overflow-y-auto msg-scroll-viewport ${approvalRequest ? 'hidden' : ''} ${sessionMessages.length === 0 && !hasSteps ? 'hide-scrollbar' : ''}`}>
        <div className="max-w-[700px] mx-auto px-5 py-4 pb-12 min-h-full">
          {sessionMessages.length === 0 && !hasSteps ? (
            <div className="flex flex-col items-center w-full pt-[22vh]">
              <div className="w-full max-w-[700px] mx-auto px-5">
                <img src="/kirin.png" alt="Helix" className="w-14 h-14 opacity-70 mx-auto mb-4" />
                <p className="text-[15px] font-normal text-foreground/50 text-center mb-6 tracking-tight">{startupGreeting}</p>
                {renderEmptyBreadcrumb()}
                {renderChatInput({ isEmpty: true })}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Branch indicator */}
              {currentBranchInfo && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/5 border border-blue-500/15 text-[12px]">
                  <GitBranch className="size-3.5 text-blue-500 shrink-0" />
                  <span className="text-blue-600 dark:text-blue-400 font-medium">{currentBranchInfo.branchName}</span>
                  {currentBranchInfo.parentLabel && (
                    <span className="text-muted-foreground/50 truncate">← {currentBranchInfo.parentLabel}</span>
                  )}
                </div>
              )}
              {/* Chat messages (input/output)  — completed messages only.
                  Each row is memoized (TranscriptMessage) so streamed chunks
                  don't re-render the whole transcript. */}
              {displayMessages.map(item =>
                item.kind === 'summary' ? (
                  <SummarizedHistoryBlock
                    key={item.id}
                    count={item.count}
                    preview={item.preview}
                    startTs={item.startTs}
                    endTs={item.endTs}
                  />
                ) : (
                  <TranscriptMessage
                    key={item.msg.id}
                    msg={item.msg}
                    fontSize={transcriptFontSize}
                    searchOpen={conversationSearchOpen}
                    searchQuery={conversationSearchQuery}
                    isSearchMatch={searchMatchIds.has(item.msg.id)}
                    isSearchActive={item.msg.id === conversationSearchActiveId}
                    onFork={storeActions.forkConversation}
                  />
                )
              )}

              {/* Streaming assistant message — placed AFTER all completed messages */}
              {(streamingActive || displayResponseBlocks.length > 0) && (
                <div className="flex w-full justify-start transition-all duration-300 opacity-100">
                  <div className="w-full px-1 py-1 text-foreground transition-all duration-300">
                    {/* Loading placeholder — plain terminal-style reasoning line.
                        Only shown while streaming AND no content/blocks/thinking yet AND
                        no completed assistant message exists yet in this session.
                        Prevents duplicate "reasoning..." when a prior assistant message
                        was already committed (e.g. think→done→think again within one run). */}
                    {streamingActive && displayResponseBlocks.length === 0 && !displayStreamThinking && !hasCompletedAssistant && (
                      <div className="flex items-center my-1 text-sm text-foreground/50">
                        <span>推理中...</span>
                      </div>
                    )}

                    {/* Top status bar — shows kaomoji status from thinking or executing info */}
                    {streamingActive && (displayResponseBlocks.length > 0 || displayStreamThinking) && (
                      <div className="flex items-center gap-1.5 my-1 text-sm text-foreground/50">
                        <span>
                          {thinkingStatus
                            ? thinkingStatus
                            : runningToolLabels.length > 0
                              ? `执行中：${runningToolLabels.join(' / ')}`
                              : displayStreamThinking ? '思考中...' : '执行中...'}
                        </span>
                      </div>
                    )}

                    {/* Show thinking content if available (kaomoji status line stripped).
                        Only render while streaming AND no completed thinking blocks exist yet;
                        once thinking is flushed into displayResponseBlocks it renders there to avoid dup. */}
                    {streamingActive && thinkingBody && !displayResponseBlocks.some(b => b.type === 'thinking') && (
                      <div className="my-2">
                        <details className="group/details">
                          <summary className="text-muted-foreground cursor-pointer hover:text-foreground/60 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize: transcriptFontSize }}>
                            <span>{thinkingStatus || '思考中...'}</span>
                            <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                          </summary>
                          <div className="mt-1 pl-3 text-foreground/60  break-all leading-relaxed thinking-cap-tall thinking-scroll" style={{ fontSize: transcriptFontSize }}>
                            {thinkingBody}
                          </div>
                        </details>
                      </div>
                    )}

                    {/* Inline thinking block (collapsible) — kept for completed messages */}

                    {/* Interleaved response blocks: thinking, text, and tool groups in chronological order */}
                    {displayResponseBlocks.length > 0 && (() => {
                      const normalizedBlocks = normalizeTextBlocks(displayResponseBlocks)
                      const filtered = mergeAdjacentThinking(pinToolGroupsToTop(normalizedBlocks))
                      return (
                        <div className="helix-md thinking-cap-body thinking-scroll" style={{ fontSize: transcriptFontSize }}>
                          {filtered.map((block, idx) =>
                            block.type === 'thinking' ? (
                              <details key={idx} className="mb-2 mt-3 group/details">
                                <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize: transcriptFontSize }}>
                                  <span>{extractKaomojiStatus(block.content).status || '思考中'}</span>
                                  <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                </summary>
                                <div className="mt-1 pl-3 text-foreground/50  break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize: transcriptFontSize }}>
                                  {conversationSearchOpen && conversationSearchQuery.trim() ? (
                                    <HighlightText text={normalizeAcpContentRaw(block.content)} query={conversationSearchQuery} active={false} />
                                  ) : (
                                    <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                                  )}
                                </div>
                              </details>
                            ) : block.type === 'text' ? (
                            <div key={idx}>
                              {conversationSearchOpen && conversationSearchQuery.trim() ? (
                                <div className="whitespace-pre-wrap break-words">
                                  <HighlightText text={normalizeAcpContentRaw(block.content)} query={conversationSearchQuery} active={false} />
                                </div>
                              ) : (
                                <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                              )}
                            </div>
                          ) : block.type === 'file_change' ? (
                            <FileChangeSummary key={idx} changes={block.changes} />
                          ) : (
                            <InlineToolGroup key={idx} steps={block.steps} isRunning={isRunning} />
                          )
                          )}
                      </div>
                      )
                    })()}

                    {/* Live thinking duration — only while actually streaming (isRunning).
                        Must NOT hang on streamingActive/isChatLoading; those can stay true
                        after completion (e.g. session-id drift prevents the finally block
                        from clearing isChatLoading), causing the timer to tick forever. */}
                    {isRunning && (
                      <div className="text-xs text-foreground/30 tabular-nums mt-1 ml-3">
                        <ThinkingTimer questionStartTs={streamingDrafts[currentSessionId || '']?.startedAt ?? questionStartTs} isRunning={isRunning} />
                      </div>
                    )}

                  </div>
                </div>
              )}




              {/* End of flow area — no summary */}

              {/* End of flow area — no summary */}
            </div>
          )}
        </div>
      </div>

      {/* API key warning */}

      {/* Connection notice */}
      {connectionNotice && (
        <div className="mx-4 mb-2 px-3 py-2.5 rounded-xl text-xs flex items-center gap-2 border cursor-pointer hover:opacity-80 transition-all duration-200 shadow-sm" style={{
          backgroundColor: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145 / 0.1)' : 'oklch(0.70 0.15 65 / 0.1)',
          borderColor: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145 / 0.25)' : 'oklch(0.70 0.15 65 / 0.25)',
          color: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145)' : 'oklch(0.70 0.15 65)',
        }} onClick={() => useHelixStore.getState().setConnectionNotice(null)}>
          {connectionNotice.phase !== 'recovered' && (
            <div className="animate-spin size-3 border-2 border-current border-t-transparent rounded-full shrink-0" />
          )}
          <span className="flex-1">{connectionNotice.message}</span>
          <span className="text-[10px] opacity-60">点击关闭</span>
        </div>
      )}

      {/* New project form */}
      {showNewProjectForm && (
        <div className="max-w-[700px] mx-auto mb-2 p-3 bg-card/30 rounded-xl border border-border/30 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <FolderPlus className="size-4 text-primary" />
            <span className="text-sm font-medium text-foreground">新建项目</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject() }}
              placeholder="输入项目名称..."
              className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all duration-200"
              autoFocus
            />
            <Button size="sm" onClick={handleCreateProject} className="px-3">
              创建
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowNewProjectForm(false); setNewProjectName('') }}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* Scroll to bottom button */}
      {userScrolledUp && sessionMessages.length > 0 && !approvalRequest && (
        <div className="flex justify-center shrink-0 -my-1 relative z-10">
          <button
            onClick={jumpToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/80 hover:bg-muted border border-border/50 text-xs text-muted-foreground hover:text-foreground transition-all duration-200 shadow-sm backdrop-blur-sm"
          >
            <ArrowDown className="size-3.5" />
          </button>
        </div>
      )}

      {/* Bottom input */}
      {sessionMessages.length > 0 && !approvalRequest && !clarifyRequest && pendingTaskCreations.length === 0 && (
        <div className="bg-transparent shrink-0 mb-2 mt-2 w-full px-5">
          <div className="w-full max-w-[700px] mx-auto">
            {renderChatInput()}
            <p className="text-xs text-foreground/50 text-center mt-3 mb-1.5 select-none">AI不是万能的，需要有自己的判断</p>
          </div>
        </div>
      )}

      {/* Approval Dialog */}
      {approvalRequest && (
        <ApprovalDialog
          request={approvalRequest}
          pendingCount={pendingApprovalCount}
          onApprove={(id, cache) => handleApproval(id, true, cache)}
          onReject={(id, cache) => handleApproval(id, false, cache)}
          onApproveAll={handleApproveAll}
        />
      )}

      {/* Scheduled task creation confirmation */}
      {pendingTaskCreations.some(t => t.sessionId === currentSessionId) && (
        <ScheduledTaskConfirm
          tasks={pendingTaskCreations.filter(t => t.sessionId === currentSessionId)}
          onConfirm={handleConfirmTasks}
          onDismiss={handleDismissTasks}
        />
      )}

      {/* Clarify 反问浮条（模型多选反问） */}
      {clarifyRequest && (
        <ClarifyBar
          request={clarifyRequest}
          onRespond={handleClarifyRespond}
        />
      )}

    </div>
  )
}

// ── 诊断期：Ctrl+Shift+D 导出 HelixTrace 日志（诊断完可删） ──
;(function () {
  if (typeof window === 'undefined') return
  try {
    ;(window as any).__helixExportTrace = () => (localStorage.getItem('helix_trace') || '')
    window.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        var t = localStorage.getItem('helix_trace') || '(无日志)'
        window.prompt('Helix 诊断日志（Ctrl+C 复制后发给我）', t.slice(-20000))
      }
    })
  } catch (err) {}
})()
