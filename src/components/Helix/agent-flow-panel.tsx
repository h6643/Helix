'use client'

import {
  Circle,
  FileText,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  Search,
  Folder,
  ArrowDown,
  ArrowUp,
  X,
  Square,
  Plus,
  FolderPlus,
  Clock,
  Hand,
  AlertTriangle,
  GitBranch,
  Undo2,
  Archive,
  Link,
} from 'lucide-react'
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import type { ReasoningEffortLevel } from '@/hermes-ui/types'
import { useProviderStore } from '@/hermes-ui/provider-store'
import { pushModelConfig } from '@/lib/config-sync'
import { isElectron, electronDialog, electronHermes, electronGit, hermesApi } from '@/lib/electron-bridge'
import { generateId } from '@/lib/format'
import { processClipboardImage, canAddMoreImages, blobToDataUrl, compressImage } from '@/lib/image-utils'
import { buildAcpMcpServers } from '@/lib/mcp'
import { detectScheduledTasks, syncTaskToBackend, type DetectedTask } from '@/lib/schedule-utils'
import { isServeActive } from '@/lib/serve-gateway'
import { debug } from '@/lib/logger'
import { decodeBase64Utf8, extractThinkTags, normalizeAcpContent, normalizeAcpContentRaw, stripEmoji, extractKaomojiStatus } from '@/lib/text-utils'
import { ContextUsageIndicator } from './context-usage'

import { getToolDisplayLabel } from '@/lib/tool-display-utils'
import { InlineToolGroup } from './inline-tool-group'
import { HistoryStrip } from './history-strip'
import { FileChangeSummary } from './file-change-summary'
import { ApprovalDialog, ClarifyBar, PlanReviewBar, type ApprovalRequest, type PlanReviewRequest } from './approval-dialog'
import type { ApprovalLevel } from '@/hermes-ui/api-client'
import { ScheduledTaskConfirm } from './scheduled-task-confirm'
import { useHelixStore, type ImageAttachment, type FileAttachment, type LinkAttachment, type ExecutionStep, type StreamingResponseBlock } from '@/stores/helix-store'
import { useHermesStore } from '@/stores/hermes-store'
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
// SessionMapEntry / SESSION_MAP_KEY / loadSessionMap / resolveBackendSid 已迁移到
// @/lib/session-map 模块，供多个组件复用；这里仅导入所需引用。
import { SESSION_MAP_KEY, loadSessionMap, type SessionMapEntry } from '@/lib/session-map'

async function persistSessionMap(map: Map<string, SessionMapEntry>) {
  try {
    const { persistence } = await import('@/lib/persist')
    const obj: Record<string, SessionMapEntry> = {}
    map.forEach((v, k) => { obj[k] = v })
    await persistence.saveSetting(SESSION_MAP_KEY, obj)
  } catch { /* best-effort persistence — never block the UI on it */ }
}


// mergeAdjacentThinking merges runs of consecutive thinking blocks: a
// cumulative superset replaces the earlier one, disjoint segments are
// concatenated. Runs only become adjacent when there was no tool/text between
// them, so interleaved thinking/tool turns stay chronologically separated —
// each thinking segment keeps its own fold.
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

// reconcileBlocksWithContent repairs streaming-accumulated text blocks using
// the authoritative msg.content. The forwarding chain intermittently drops
// whitespace/newlines inside streamed chunks (e.g. "**加粗** 后" glued into
// "**加粗**后"), which breaks CommonMark strong rendering (a `**` closer must
// be followed by whitespace/punctuation). The done handler already repairs
// msg.content from the backend's final text; here we apply the same fix to the
// blocks path so rendering matches. Only fires when the joined text blocks are
// normalized-equivalent to msg.content AND content is not shorter (i.e. it is
// the same or a fuller version) — never guesses, never corrupts normal text.
function reconcileBlocksWithContent(
  blocks: NonNullable<ChatMessage['blocks']>,
  content?: string | null,
): NonNullable<ChatMessage['blocks']> {
  if (!content || blocks.length === 0) return blocks
  const textBlocks = blocks.filter((b) => b.type === 'text')
  if (textBlocks.length === 0) return blocks
  const joined = textBlocks.map((b) => String(b.content || '')).join('')
  if (!joined) return blocks
  const normJoined = normalizeForCompare(joined)
  const normContent = normalizeForCompare(content)
  if (!normJoined || !normContent) return blocks
  if (normJoined !== normContent && !normJoined.includes(normContent) && !normContent.includes(normJoined)) return blocks
  if (content.length < joined.length) return blocks
  // Same-or-fuller authoritative text: last text block carries the full
  // content, earlier text blocks are blanked (normalizeTextBlocks filters
  // empty ones). Non-text blocks (thinking/tool_group) keep their order.
  let textSeen = false
  return blocks.map((b) => {
    if (b.type !== 'text') return b
    if (!textSeen) {
      textSeen = true
      return { ...b, content }
    }
    return { ...b, content: '' }
  })
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
  mode: 'default' | 'accept_edits' | 'dont_ask' | 'plan',
): 'auto' | 'ask' {
  const patternKey = String(params?.pattern_key || '')
  const command = String(params?.command || '')
  const blob = `${toolName} ${patternKey} ${command} ${params?.description || ''} ${params?.reason || ''}`
  const workNorm = workDir ? normPathForCompare(workDir) : ''

  // 0) 计划模式：只读查询放行，其余全部弹。计划审批的意义就是让用户先看方案，
  //    因此文件写入/命令执行/外部访问（甚至项目内读写）都要求确认。
  if (mode === 'plan') {
    if (DANGEROUS_CMD_RE.test(command)) return 'ask'
    if (EXFIL_CMD_RE.test(command)) return 'ask'
    if (SENSITIVE_PATH_RE.test(blob)) return 'ask'
    if (FILE_WRITE_TOOL_RE.test(blob)) return 'ask'
    for (const p of extractAbsPaths(blob)) {
      if (/^~\//.test(p)) return 'ask'
      if (!workNorm) return 'ask'
      const pn = normPathForCompare(p)
      if (pn !== workNorm && !pn.startsWith(workNorm + '/')) return 'ask'
    }
    if (patternKey.includes('read_file:outside_project:')) return 'ask'
    return 'ask' // 计划模式下非只读查询一律弹，让用户批准后才真正执行
  }

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

  // 6) 项目内文件修改 → 视模式：accept_edits/dont_ask 自动批准（diff 记录走 tool.complete
  //    inline_diff，不受影响）；default 模式一律弹，让用户确认
  if (FILE_WRITE_TOOL_RE.test(blob)) {
    if (mode === 'accept_edits' || mode === 'dont_ask') return 'auto'
    return 'ask'
  }

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
    // 文本/其他文件也要填 base64，否则 prompt 构建时无法 inline 内容
    // （原先只对图片填 base64，导致文本文件内容永远发不出去）
    base64: isImage
      ? compressedDataUrl.split(',')[1] || ''
      : isTextualFile(file)
        ? (dataUrl.split(',')[1] || '')
        : '',
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
        className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/70 hover:text-foreground px-2 py-1.5 h-7 rounded-lg border border-border/60 bg-muted/40 hover:bg-muted/70 transition-colors min-w-11 text-center chat-toolbar-label"
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
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/60">推理强度</span>
            <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-primary">{current.label}</span>
          </div>
          <div className="flex items-center justify-between text-[calc(var(--helix-transcript-size)*0.7143)] text-foreground/40 leading-none">
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
  | { kind: 'status'; id: string; text: string }

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
      <summary className="flex items-center gap-1.5 px-1 py-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/40 cursor-pointer hover:text-foreground/60 select-none list-none transition-colors">
        <ChevronRight className="size-3 transition-transform group-open/details:rotate-90 shrink-0" />
        <span>已压缩 {count} 条较早消息{range}，点击展开预览</span>
      </summary>
      <div className="pl-4 pr-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/45  leading-relaxed mb-2">
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
  onWithdraw,
  onUndo,
}: {
  msg: ChatMessage
  fontSize: number
  searchOpen: boolean
  searchQuery: string
  isSearchMatch: boolean
  isSearchActive: boolean
  onFork: (id: string) => void
  onWithdraw: (id: string) => void
  onUndo?: () => void
}) {
  const content = useMemo(() => normalizeAcpContent(msg.content), [msg.content])
  const mdContent = useMemo(() => normalizeAcpContentRaw(msg.content), [msg.content])
  const reasoning = useMemo(() => normalizeAcpContentRaw(msg.reasoning || ''), [msg.reasoning])
  const messageDuration = msg.duration ?? msg.thinkingTime
  const isStreaming = msg.isStreaming === true

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
            {(msg.blocks && msg.blocks.length > 0) ? (() => {
              // 按时间序交替渲染 thinking / tool_group / text（不置顶工具、不合并
              // 所有思考）：被工具隔开的思考段各自独立折叠，工具卡按事件顺序出现，
              // 模型"思考→执行→再思考→再执行"的节奏原样呈现。仅合并相邻思考块。
              const normalizedBlocks = mergeAdjacentThinking(normalizeTextBlocks(reconcileBlocksWithContent(msg.blocks, msg.content)))
              const lastTextIndex = normalizedBlocks.reduce((acc, b, i) => b.type === 'text' ? i : acc, -1)
              const processBlocks = lastTextIndex >= 0 ? normalizedBlocks.slice(0, lastTextIndex) : normalizedBlocks
              const answerBlocks = lastTextIndex >= 0 ? normalizedBlocks.slice(lastTextIndex) : []
              const showInlineReasoning = !!(msg.reasoning && msg.reasoning.trim().length > 0 && !(msg.blocks && msg.blocks.some(b => b.type === 'thinking')))
              const hasProcess = processBlocks.length > 0 || showInlineReasoning
              return (
              <>
                {hasProcess && (
                  <details className="mb-2 mt-3 group/process">
                    <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize }}>
                      <span>已结束</span>
                      <svg className="size-3.5 transition-transform group-open/process:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                    </summary>
                    <div className="mt-1 pl-3 space-y-1">
                      {showInlineReasoning && (
                        <details className="mb-2 mt-3 group/details">
                          <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize }}>
                            <span>{extractKaomojiStatus(reasoning).status || '思考'}</span>
                            <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                          </summary>
                          <div className="mt-1 pl-3 border-l-2 border-border/60 text-foreground/50 break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize }}>
                            {searchOpen && searchQuery.trim() ? <HighlightText text={reasoning} query={searchQuery} active={isSearchActive} /> : <HelixMarkdown text={reasoning} />}
                          </div>
                        </details>
                      )}
                      {processBlocks.map((block, idx) =>
                        block.type === 'thinking' ? (
                          <details key={idx} className="mb-2 mt-3 group/details">
                            <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize }}>
                              <span>{extractKaomojiStatus(block.content).status || '思考'}</span>
                              <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                            </summary>
                            <div className="mt-1 pl-3 border-l-2 border-border/60 text-foreground/50 break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize }}>
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
                          <InlineToolGroup key={idx} steps={block.steps} isRunning={false} fontSize={fontSize} />
                        )
                      )}
                    </div>
                  </details>
                )}
                {answerBlocks.length > 0 && (
                  <div className="helix-md" style={{ fontSize }}>
                    {answerBlocks.map((block, idx) =>
                      block.type === 'text' ? (
                        <div key={idx} style={{ fontSize }}>
                          {searchOpen && searchQuery.trim() ? (
                            <div className="whitespace-pre-wrap break-words" style={{ fontSize }}>
                              <HighlightText text={normalizeAcpContentRaw(block.content)} query={searchQuery} active={isSearchActive} />
                            </div>
                          ) : (
                            <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                          )}
                        </div>
                      ) : null
                    )}
                  </div>
                )}
              </>
              )
            })() : (
              <div className="helix-md" style={{ fontSize }}>
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
              <div className="text-foreground/30 tabular-nums mt-1 px-1" style={{ fontSize }}>
                {formatDuration(messageDuration ?? 0)}
              </div>
            )}
            {/* Copy button */}
            <div className="flex opacity-0 group-hover:opacity-100 transition-opacity pt-1 px-1 gap-0.5">
              <CopyButton text={mdContent} />
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
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground max-w-[8ch] truncate">{f.name.length > 8 ? f.name.slice(0, 8) + '…' : f.name}</p>
                      <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/70">{formatBytes(f.size)}</p>
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
            <button
              onClick={() => onUndo?.()}
              className="p-1 rounded-lg text-muted-foreground/40 hover:text-amber-500 hover:bg-amber-500/10 transition-colors"
              data-tip="撤回本轮对话"
            >
              <Undo2 className="size-3" />
            </button>
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
const EMPTY_LINKS: LinkAttachment[] = []

export function AgentFlowPanel() {
  const [steps, setSteps] = useState<ExecutionStep[]>([])
  useEffect(() => { stepsRef.current = steps }, [steps])
  const [input, setInput] = useState('')
  // Per-session streaming drafts let the running thinking/steps survive
  // conversation switches. `isRunning` is derived from the current session's draft.
  const streamingDrafts = useHelixStore(s => s.streamingDrafts)
  const setStreamingDraft = useHelixStore(s => s.setStreamingDraft)
  const clearStreamingDraft = useHelixStore(s => s.clearStreamingDraft)
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([])
  // 模型反问多选（clarify）：一次只显示最旧一条，回应后出队
  const [clarifyQueue, setClarifyQueue] = useState<Array<{ id: string; question: string; choices: string[] | null; sessionId?: string }>>([])
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  // 计划审批（plan 模式）：模型产出方案后先弹浮条让用户决定“批准执行”或“继续调整”，
  // 用户批准后才以 accept_edits 模式真正跑 handleRun（done 时由它触发 + handleApprovePlan）。
  const [pendingPlanReview, setPendingPlanReview] = useState<PlanReviewRequest | null>(null)

  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [showFolderDropdown, setShowFolderDropdown] = useState(false)
  const [showApprovalModeDropdown, setShowApprovalModeDropdown] = useState(false)
  const approvalMode = useHelixStore(s => s.approvalMode)
  const setApprovalMode = useHelixStore(s => s.setApprovalMode)
  const [showNewProjectForm, setShowNewProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [fileSkills, setFileSkills] = useState<Array<{ name: string; description: string }>>([])
  const startupGreeting = useHelixStore(s => s.startupGreeting)
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
  // Inline notices for automatic context compression events (shown inside transcript).
  const [autoCompressNotices, setAutoCompressNotices] = useState<Array<{ id: string; ts: number; text: string }>>([])
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
      if (injectSignal.append) {
        // 追加模式（连续选取网页元素累积）：保留现有输入，换行拼接新内容
        const prev = inputValueRef.current
        setInputSynced(prev ? `${prev}\n${injectSignal.text}` : injectSignal.text)
      } else {
        setInputSynced(injectSignal.text)
      }
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
  // Link cards picked from the in-app browser ("选取网页元素加入聊天") live in the
  // store (not local state) so preview-rail can append them from another surface.
  const pendingLinks = useHelixStore((s) => {
    const key = currentSessionId ?? DRAFT_SESSION_KEY
    return s.tabAttachments[key]?.links ?? EMPTY_LINKS
  })
  const setSessionPendingApproval = useHelixStore(s => s.setSessionPendingApproval)
  // 仅显示/统计当前会话的待确认（审批/反问/定时任务），避免切会话时串台。
  // 统一用 currentSessionId ?? DRAFT_SESSION_KEY 作为查找键：新建对话（id 未分配）
  // 时 handleRun 的自动批准/审批回调拿到的也是这个 fallback 键，双方对齐才能命中。
  const approvalKey = currentSessionId ?? DRAFT_SESSION_KEY
  const approvalRequest = approvalQueue.find(r => r.sessionId === approvalKey) || null
  const pendingApprovalCount = approvalQueue.filter(r => r.sessionId === approvalKey).length
  const clarifyRequest = clarifyQueue.find(c => c.sessionId === approvalKey) || null
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
  // 切换会话时清空上一次的自动压缩内联提示，避免把旧提示带进新对话；
  // 同时清掉不属于当前会话的待审批计划（切走即作废，防止串到别的会话）。
  useEffect(() => {
    setAutoCompressNotices([])
    setPendingPlanReview(prev => (prev && prev.sessionId === (currentSessionId ?? DRAFT_SESSION_KEY) ? prev : null))
  }, [currentSessionId])
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
    // 自动压缩事件以居中状态行的形式插入对话流末尾
    for (const notice of autoCompressNotices) {
      items.push({ kind: 'status', id: notice.id, text: notice.text })
    }
    return items
  }, [sessionMessages, autoCompressNotices])

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
  // 覆盖面板（看板/定时任务/技能）打开时，把聊天输入区降一级（z-20），避免
  // 和面板（z-30）争焦点；历史条/上下文指示器也在面板打开时隐藏（遮挡感）。
  const showKanbanPanel = useHelixStore(s => s.showKanbanPanel)
  const showScheduledTasksPanel = useHelixStore(s => s.showScheduledTasksPanel)
  const showSkillPanel = useHelixStore(s => s.showSkillPanel)
  const overlayPanelOpen = showKanbanPanel || showScheduledTasksPanel || showSkillPanel
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
  const transcriptFontSize = useHelixStore(s => s.transcriptFontSize)
  const selectedWorkDir = useHelixStore(s => s.selectedWorkDir)
  const activeSessionWorkDir = useHelixStore(s => s.activeSessionWorkDir)
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

  // 撤回：移除该助手消息，并同时移除紧邻的上一条用户提问（这一轮对话），保持整洁；
  // 同时同步后端 message.delete，删除 state.db 里的历史，避免下次 prompt 复活。
  const handleWithdraw = useCallback((id: string) => {
    const state = useHelixStore.getState()
    const msgs = state.chatMessages
    const idx = msgs.findIndex((m) => m.id === id)
    if (idx === -1) return
    const assistantMsg = msgs[idx]
    state.deleteMessage(id)
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        useHelixStore.getState().deleteMessage(msgs[i].id)
        break
      }
    }
    state.showToast({ type: 'success', title: '已撤回', description: '已移除该回复及其提问' })
    const sessionId = useHermesStore.getState().hermesSessionId
    const rowId = assistantMsg?.rowId
    if (sessionId && rowId != null) {
      hermesApi()?.send('message.delete', { session_id: sessionId, row_id: rowId }).catch(() => {})
    }
  }, [])

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
    // live UI state 的所有者重置：切换会话后，responseBlocks/steps/streamThinking
    // 这些组件 state 已被清空，若 liveStateOwnerRef 仍指向旧会话，切回来时会命中
    // displayResponseBlocks 的 "owner === currentSessionId" 分支而返回空数组——
    // 后台 run 的真实内容在 draft 里，但读不到 → "切回来只剩工作中和时间，思考消失"。
    // 重置为 null 让恢复走 streamingDrafts 分支。
    liveStateOwnerRef.current = null
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
  // /btw 后台任务的完成通知需要一个 persistent listener（handleRun 里的 per-run
  // onEvent 在 finally 里退订，后台 run 与当前 run 生命周期不同步，事件会漏掉）。
  // background.complete 参数 = { session_id: 后台任务的 sid, task_id, text }。
  useEffect(() => {
    let unsubFn: (() => void) | undefined
    try {
      unsubFn = hermesApi()!.onEvent((method: string, params: any) => {
        if (method !== 'background.complete') return
        const parentSid = params?.session_id
        const text = typeof params?.text === 'string' ? params.text : ''
        const taskId = params?.task_id
        // 通过 session 映射反查它属于哪个对话（后台会话未注册时落到当前对话）。
        let bgCid: string | null = null
        if (parentSid) {
          for (const [c, entry] of sessionMapRef.current.entries()) {
            if (entry.sid === parentSid) { bgCid = c; break }
          }
        }
        const target = bgCid || useHelixStore.getState().currentSessionId || undefined
        if (text) {
          useHelixStore.getState().addChatMessage({ role: 'assistant', content: text, sessionId: target })
        }
        storeActions.showToast({
          type: 'success',
          title: '后台任务已完成',
          description: text.slice(0, 80) || (taskId ? `任务 ${taskId} 已完成` : undefined),
          duration: 8000,
        })
      })
    } catch (e) {
      console.warn('[Helix] background.complete listener setup failed:', e)
    }
    return () => { try { unsubFn?.() } catch {} }
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
  // Queries the selected project directory (passed as cwd) rather than relying
  // on the Electron main-process workDir. Loading a conversation keeps
  // selectedWorkDir in sync with that conversation's own project (see
  // handleLoadSession / navigateSession), so the branch follows whichever
  // project is currently active — conversation switch or plain browse.
  useEffect(() => {
    // 切换项目时立即隐藏分支按钮并清空旧分支，避免在探活间隙残留上一个仓库的
    // 分支名（比如切到非 git 目录仍短暂显示旧项目的 "tauri"）。gitAvailable 恢复
    // 为 null = 隐藏，探活确认是 git 仓库后才重新显示。
    setGitAvailable(null)
    setCurrentBranch('')
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
    // Sync the ACTIVE profile's model too. restoreFromStorage prefers the
    // activeProfileId's config.model over the persisted activeModel — if we
    // only updated activeModel here, the profile keeps its old model and a
    // restart reverts the input-bar choice to whatever the profile pinned.
    const pst = useHelixStore.getState()
    if (pst.activeProfileId) {
      const prof = pst.apiProfiles.find((p) => p.id === pst.activeProfileId)
      if (prof) {
        useHelixStore.getState().updateApiProfileConfig(pst.activeProfileId, { ...prof.config, model })
      }
    }
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
      // Persist the synced profile model so a cold restart restores the same
      // model (restoreFromStorage reads activeProfileId's config first).
      persistence.saveSetting('apiProfiles', st.apiProfiles)
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
      <div className="relative min-w-0" ref={modelDropdownRef}>
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
          className="flex items-center justify-between gap-2 min-w-0 max-w-[140px] px-2.5 py-1.5 h-7 bg-muted/30 border border-border/30 rounded-lg text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground hover:bg-muted/30 hover:border-border/30 transition-all duration-200 font-mono"
        >
          <span className="truncate min-w-0 flex-1 text-left chat-toolbar-label">{displayName}</span>
          <svg className={`size-3.5 text-muted-foreground transition-transform shrink-0 ${showModelDropdown ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        {showModelDropdown && (
          <div className="absolute bottom-full right-0 mb-2 min-w-[220px] max-w-[360px] max-h-56 overflow-y-auto bg-popover border border-border/40 rounded-xl shadow-xl z-50 p-1 animate-scale-in">
            {modelList.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => handleModelSelect(m)}
                className={`w-full text-left px-3 py-2 rounded-md text-[length:var(--helix-transcript-size)] font-mono transition-colors ${
                  m === selectedForHighlight
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-foreground/70 hover:bg-muted'
                }`}
              >
                <span className="truncate">{m}</span>
              </button>
            ))}
            {modelList.length === 0 && (
              <div className="px-3 py-2 text-[length:var(--helix-transcript-size)] text-foreground/40">
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
    { name: 'background', description: '后台运行一个任务，不打断当前对话', action: 'background' as const, aliases: ['bg', 'btw'] },
    { name: 'undo', description: '撤销上一条消息并同步截断后端历史', action: 'undo' as const },
    { name: 'save', description: '保存当前会话到磁盘（~/hermes/sessions/saved/*.json）', action: 'save' as const },
    { name: 'branch', description: '从当前对话分叉出一个新分支会话', action: 'branch' as const },
    { name: 'steer', description: '偏离当前思路，告诉模型换方向：/steer <text>', action: 'steer' as const },
    { name: 'redirect', description: '重定向话题到新方向：/redirect <text>', action: 'redirect' as const },
    { name: 'image', description: '生成一张图片：/image <prompt>', action: 'image' as const },
    { name: 'rollback', description: '打开回滚面板（文件版本回滚）', action: 'rollback' as const },
    { name: 'sessions', description: '打开后端会话管理面板', action: 'sessions' as const },
    { name: 'projects', description: '打开项目管理面板', action: 'projects' as const },
    { name: 'mcp', description: '管理 MCP 服务器', action: 'mcp' as const },
    { name: 'model', description: '切换到模型选择设置', action: 'model' as const },
    { name: 'skill', description: '打开技能管理面板', action: 'skill' as const },
  ], [])

  // Merge local skills with Hermes slash commands
  const allSlashItems = useMemo(() => {
    const builtinCmds = BUILTIN_COMMANDS.flatMap(c => {
      const names = [c.name, ...(c.aliases ?? [])]
      return names.map(name => ({
        name,
        description: c.description,
        id: 'builtin:' + c.name + ':' + name,
        icon: undefined as string | undefined,
        isBuiltinCommand: true,
        action: c.action,
      }))
    })
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

  // Undo last round (same semantics as the /undo builtin command, exposed as a
  // toolbar button): truncate backend history back to the last user prompt and
  // drop all local messages after it.
  const handleUndoChat = useCallback(async () => {
    try {
      const cid = currentSessionId
      const sid = (cid && sessionMapRef.current.get(cid)?.sid) || hermesSessionIdRef.current
      if (!sid) {
        storeActions.showToast({ type: 'warning', title: '无法撤回', description: '当前对话还没有后端会话，无法截断历史' })
        return
      }
      const r = await hermesApi()!.send('session.undo', { session_id: sid })
      const removed = (r as any)?.removed ?? 0
      const all = useHelixStore.getState().chatMessages
      const local = all.filter(m => !m.sessionId || m.sessionId === cid)
      const lastUserIdx = [...local].reverse().findIndex(m => m.role === 'user')
      const kept = lastUserIdx >= 0
        ? all.filter(m => !local.includes(m) || local.indexOf(m) < local.length - 1 - lastUserIdx)
        : all
      useHelixStore.setState({ chatMessages: kept })
      storeActions.showToast({ type: 'success', title: '已撤回', description: `已截断后端历史（移除 ${removed} 条记录）` })
    } catch (e) {
      storeActions.showToast({ type: 'error', title: '撤回失败', description: String(e) })
    }
  }, [currentSessionId, storeActions.showToast])

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
    const baseTrimmed = currentInput.trim()
    // Fold any web-link cards (picked from the in-app browser) into the text the
    // agent receives, so they ride along without cluttering the input as raw URLs.
    const linkCards = useHelixStore.getState().tabAttachments[currentSessionId ?? DRAFT_SESSION_KEY]?.links ?? []
    const linkSuffix = linkCards.length ? '\n' + linkCards.map((l) => `链接: ${l.title ? `${l.title} (${l.url})` : l.url}`).join('\n') : ''
    const trimmed = baseTrimmed + linkSuffix
    if (!baseTrimmed && pendingImages.length === 0 && pendingFiles.length === 0 && linkCards.length === 0) return

    // Lock isBusy to true BEFORE any async gap so the button NEVER flips
    // back to "send" while the agent is in-flight (even if streamingDrafts
    // temporarily loses its isAgentRunning flag due to session-id drift or
    // a draft clear). Without this, the user sees the send button reappear,
    // clicks it, and ACP receives a second prompt → "Queued (1 queued)" and
    // the model gets interrupted mid-thought.
    useHelixStore.setState({ isChatLoading: true })

    // Builtin-command helper: resolve (or create) the backend session for the
    // current conversation. Reuses the same params/epoch logic as the main flow.
    // Returns the backend sid, or null when no conversation / creation failed.
    const ensureBuiltinSid = async (): Promise<string | null> => {
      const cid = currentSessionId
      if (!cid) return null
      const liveEpoch = useHermesStore.getState().gatewayEpoch
      const cached = sessionMapRef.current.get(cid)
      if (cached && cached.epoch === liveEpoch && cached.sid) return cached.sid
      try {
        const st = useHelixStore.getState()
        const res = await hermesApi()!.send('session/new', {
          mcpServers: buildAcpMcpServers(st.mcpServers),
          cwd: st.activeSessionWorkDir ?? st.selectedWorkDir ?? undefined,
          search_engine: st.enhancedFindGrep ? 'rg' : '',
          terminal_shell: st.terminalShell,
        }) as any
        const sid = res?._meta?.hermes?.sessionProvenance?.acpSessionId
          || res?.session_id
          || res?.sessionID
          || (typeof res === 'string' ? res : null)
        if (!sid) return null
        sessionMapRef.current.set(cid, { sid, epoch: liveEpoch })
        persistSessionMap(sessionMapRef.current)
        return sid
      } catch (e) {
        console.warn('[Helix] ensureBuiltinSid failed:', e)
        return null
      }
    }

    // --- Built-in slash commands (handled client-side, never sent to Hermes) ---
    const builtinMatch = baseTrimmed.match(/^\/(\S+)/)
    if (builtinMatch) {
      const builtin = BUILTIN_COMMANDS.find(c =>
        c.name === builtinMatch[1].toLowerCase() || c.aliases?.includes(builtinMatch[1].toLowerCase()))
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
          case 'background': {
            // /background|/bg|/btw <prompt> — 启动一个后台任务，不打断当前对话：
            // 为它新建（或复用）一个独立会话，prompt.background 派发（ack-only，
            // 只回 { task_id }），完成后走 background.complete 事件通知前端渲染。
            const bgMatch = baseTrimmed.match(/^\/(?:background|bg|btw)\s+([\s\S]+)$/i)
            const bgText = bgMatch ? bgMatch[1].trim() : ''
            if (!bgText) {
              storeActions.showToast({ type: 'warning', title: '缺少参数', description: '/btw <你的提示> — 把任务放到后台运行，不打断当前对话' })
              break
            }
            try {
              // 当前对话没有 id（新建未进入 store）时，为后台任务临时分配一个，
              // 并同步 activeSessionWorkDir 到所选项目，避免 session/new 拿错 cwd。
              let bgCid = currentSessionId
              if (!bgCid) {
                bgCid = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
                const stNew = useHelixStore.getState()
                stNew.setCurrentSessionId(bgCid)
                useHelixStore.setState({ activeSessionWorkDir: stNew.selectedWorkDir })
                stNew.pushNavigation({ type: 'chat', sessionId: bgCid })
                stNew.persistToStorage()
              }
              const st0 = useHelixStore.getState()
              const bgLiveEpoch = useHermesStore.getState().gatewayEpoch
              let bgSid: string | null = sessionMapRef.current.get(bgCid)?.sid ?? null
              if (bgSid && sessionMapRef.current.get(bgCid)?.epoch !== bgLiveEpoch) bgSid = null
              if (!bgSid) {
                const res = await hermesApi()!.send('session/new', {
                  mcpServers: buildAcpMcpServers(st0.mcpServers),
                  cwd: st0.activeSessionWorkDir ?? st0.selectedWorkDir ?? undefined,
                  search_engine: st0.enhancedFindGrep ? 'rg' : '',
                  terminal_shell: st0.terminalShell,
                }) as any
                bgSid = res?._meta?.hermes?.sessionProvenance?.acpSessionId
                  || res?.session_id
                  || res?.sessionID
                  || (typeof res === 'string' ? res : null)
                if (!bgSid) throw new Error('后端未能创建会话')
                sessionMapRef.current.set(bgCid, { sid: bgSid, epoch: bgLiveEpoch })
                persistSessionMap(sessionMapRef.current)
              }
              // 后台任务的消息挂在 bgCid 下，切过去能看到（async 上下文里用 ref 兜底）。
              useHelixStore.getState().addChatMessage({ role: 'user', content: baseTrimmed, sessionId: bgCid })
              // 后台派发是 ack-only 的：只返回 { task_id }，没有流式事件。
              const r = await hermesApi()!.send('prompt.background', { session_id: bgSid, text: bgText })
              storeActions.showToast({ type: 'success', title: '已转后台执行', description: bgText.slice(0, 40), duration: 4000 })
              debug('[HelixTrace] /btw dispatched', { bgCid, bgSid, taskId: (r as any)?.task_id })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '后台任务启动失败', description: String(e) })
            }
            break
          }
          case 'undo': {
            // /undo — 撤销上一轮对话：后端 session.undo 截断历史 + 前端同步删除本地消息。
            try {
              const sid = await ensureBuiltinSid()
              if (!sid) { storeActions.showToast({ type: 'warning', title: '无法撤销', description: '当前对话还没有后端会话，无法截断历史' }); break }
              const r = await hermesApi()!.send('session.undo', { session_id: sid })
              const removed = (r as any)?.removed ?? 0
              const all = useHelixStore.getState().chatMessages
              const local = all.filter(m => !m.sessionId || m.sessionId === currentSessionId)
              // 后端 del history[last_user_idx:] — 前端删到上一条用户消息为止。
              const lastUserIdx = [...local].reverse().findIndex(m => m.role === 'user')
              const kept = lastUserIdx >= 0
                ? all.filter(m => !local.includes(m) || local.indexOf(m) < local.length - 1 - lastUserIdx)
                : all
              useHelixStore.setState({ chatMessages: kept })
              storeActions.showToast({ type: 'success', title: '已撤销', description: `已截断后端历史（移除 ${removed} 条记录）` })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '撤销失败', description: String(e) })
            }
            break
          }
          case 'save': {
            // /save — 把当前会话存档为 JSON（~/.hermes/sessions/saved/）。
            try {
              const sid = await ensureBuiltinSid()
              if (!sid) { storeActions.showToast({ type: 'warning', title: '无法保存', description: '当前对话还没有后端会话' }); break }
              const r = await hermesApi()!.send('session.save', { session_id: sid })
              const file = (r as any)?.file
              storeActions.showToast({ type: 'success', title: '会话已保存', description: file || undefined, duration: 6000 })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '保存失败', description: String(e) })
            }
            break
          }
          case 'branch': {
            // /branch — 从当前会话分叉出一个新分支（后端 session.branch 返回新 sid +
            // 完整消息列表），前端切到新会话并沿用同一个项目目录。
            try {
              const sid = await ensureBuiltinSid()
              if (!sid) { storeActions.showToast({ type: 'warning', title: '无法分叉', description: '当前对话还没有后端会话' }); break }
              const r = await hermesApi()!.send('session.branch', { session_id: sid }) as any
              const newSid = r?.session_id
              if (!newSid) throw new Error('branch 未返回 session_id')
              const title = r?.title || '分支会话'
              const newCid = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
              const msgs = (Array.isArray(r.messages) ? r.messages : []).map((m: any) => ({
                id: m.id || generateId(),
                role: (m.role === 'assistant' || m.role === 'user' ? m.role : m.role === 'tool' ? 'assistant' : 'user') as 'user' | 'assistant' | 'system',
                content: (typeof m.content === 'string' ? m.content : '') || '',
                timestamp: m.timestamp || Date.now(),
                reasoning: m.reasoning,
                sessionId: newCid,
              }))
              const stB = useHelixStore.getState()
              stB.setCurrentSessionId(newCid)
              useHelixStore.setState({ chatMessages: msgs })
              useHelixStore.setState({ activeSessionWorkDir: stB.activeSessionWorkDir ?? stB.selectedWorkDir })
              stB.pushNavigation({ type: 'chat', sessionId: newCid })
              await stB.persistToStorage()
              // 新分支的会话映射立即注册，防止后续 prompt 再用旧 sid 起新会话。
              sessionMapRef.current.set(newCid, { sid: newSid, epoch: useHermesStore.getState().gatewayEpoch })
              persistSessionMap(sessionMapRef.current)
              useHelixStore.getState().showToast({ type: 'success', title: `已创建分支「${title}」`, description: `${msgs.length} 条消息` })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '分叉失败', description: String(e) })
            }
            break
          }
          case 'steer': {
            // /steer <text> — 偏离当前思路：告诉模型换方向，agent 采纳后调整后续行为。
            const steerText = baseTrimmed.replace(/^\/(?:steer)\s+/i, '').trim()
            if (!steerText) { storeActions.showToast({ type: 'warning', title: '缺少参数', description: '/steer <你的新方向>' }); break }
            try {
              const sid = await ensureBuiltinSid()
              if (!sid) { storeActions.showToast({ type: 'warning', title: '无法转向', description: '当前对话还没有后端会话' }); break }
              const r = await hermesApi()!.send('session.steer', { session_id: sid, text: steerText }) as any
              storeActions.showToast({ type: r?.status === 'rejected' ? 'warning' : 'success', title: r?.status === 'rejected' ? '方向被拒绝' : '已转向', description: steerText.slice(0, 60) })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '转向失败', description: String(e) })
            }
            break
          }
          case 'redirect': {
            // /redirect <text> — 重定向话题到新方向（与 steer 类似但用于扭转整个对话走向）。
            const redirectText = baseTrimmed.replace(/^\/(?:redirect)\s+/i, '').trim()
            if (!redirectText) { storeActions.showToast({ type: 'warning', title: '缺少参数', description: '/redirect <新方向>' }); break }
            try {
              const sid = await ensureBuiltinSid()
              if (!sid) { storeActions.showToast({ type: 'warning', title: '无法重定向', description: '当前对话还没有后端会话' }); break }
              const r = await hermesApi()!.send('session.redirect', { session_id: sid, text: redirectText }) as any
              storeActions.showToast({ type: r?.status === 'rejected' ? 'warning' : 'success', title: r?.status === 'rejected' ? '重定向被拒绝' : '已重定向', description: redirectText.slice(0, 60) })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '重定向失败', description: String(e) })
            }
            break
          }
          case 'image': {
            // /image <prompt> — 调用 image.generate 生成一张图片，作为 assistant 消息
            // 带 images 挂到当前对话。
            const imagePrompt = baseTrimmed.replace(/^\/(?:image)\s+/i, '').trim()
            if (!imagePrompt) { storeActions.showToast({ type: 'warning', title: '缺少参数', description: '/image <你的提示>' }); break }
            try {
              const r = await hermesApi()!.send('image.generate', { prompt: imagePrompt, aspect_ratio: 'square' }) as any
              if (r?.available === false) {
                storeActions.showToast({ type: 'warning', title: '图片生成不可用', description: r?.error || '后端没有可用的图片生成能力' })
                break
              }
              if (r?.success !== true || !r?.image_data) {
                storeActions.showToast({ type: 'error', title: '图片生成失败', description: r?.error || '未返回图片数据' })
                break
              }
              const dataUrl: string = r.image_data
              const mediaType = (dataUrl.match(/^data:([^;]+)/) || [])[1] || 'image/png'
              useHelixStore.getState().addChatMessage({
                role: 'assistant',
                content: `已生成 ${imagePrompt}`,
                sessionId: currentSessionId || undefined,
                images: [{ id: generateId(), dataUrl, mediaType, name: imagePrompt.slice(0, 40) }],
              })
              storeActions.showToast({ type: 'success', title: '图片已生成', description: imagePrompt.slice(0, 40) })
            } catch (e) {
              storeActions.showToast({ type: 'error', title: '图片生成失败', description: String(e) })
            }
            break
          }
          case 'rollback':
            storeActions.toggleRollbackPanel()
            break
          case 'sessions':
            storeActions.toggleBackendSessionsPanel()
            break
          case 'projects':
            storeActions.toggleProjectsPanel()
            break
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
    const doneMsgIdRef = { current: null as string | null }
    const pendingAssistantRowIdRef = { current: null as number | null }
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
    // 语义化的 done 正文自愈：部分场景后端连发多条 done，前面已触发的 done 已把消息提交到
    // chatMessages，此时用本次 done 自带正文（message.complete / run.completed 的 text，与
    // state.db 持久化同源，字节完好）原地修正已提交消息，覆盖流式累积可能丢空白/换行的损坏。
    // 只替换为原文，不猜补空格；归一化比较下 complete 更短（截断/中断）时则保留流式累积。
    const patchDoneMessage = (finalText: string) => {
      const mid = doneMsgIdRef.current
      if (!mid || !finalText || !finalText.trim()) return
      const st = useHelixStore.getState()
      const existing = st.chatMessages.find((m: { id: string }) => m.id === mid)
      if (!existing) return
      const cur = existing.content || ''
      if (cur === finalText) return
      const normCur = normalizeForCompare(cur)
      const normFinal = normalizeForCompare(finalText)
      if (!cur.trim() ||
          (normFinal.length >= normCur.length &&
           (normFinal.includes(normCur) || normCur.includes(normFinal)))) {
        st.updateChatMessage(mid, finalText)
        debug('[HelixTrace] 权威全文自愈，已原地修正消息正文', { len: cur.length, to: finalText.length })
      }
    }
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
      // 新对话归属当前所选项目：activeSessionWorkDir 从此始终反映「当前对话所属项目」
      // （加载的项目外对话为 null），界面据此决定是否显示项目目录与分支。
      useHelixStore.setState({ activeSessionWorkDir: useHelixStore.getState().selectedWorkDir })
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
    // Clear the web-link cards that rode along on this send.
    if (linkCards.length > 0) {
      for (const l of linkCards) useHelixStore.getState().removeLinkAttachment(l.id)
    }

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
        const st0 = useHelixStore.getState()
        const res = await hermesApi()!.send('session/new', {
          mcpServers: buildAcpMcpServers(st0.mcpServers),
          // 会话必须绑定当前对话所属项目，否则 serve 后端用配置/TERMINAL_CWD/
          // 启动目录，模型读到的目录和界面显示的项目脱节（"在 agentchat 对话，
          // 但模型读到之前选过的目录"）。
          cwd: st0.activeSessionWorkDir ?? st0.selectedWorkDir ?? undefined,
          // 常规「增强 Find 和 Grep」：新建会话 / 应用重启后恢复的会话（走
          // session/new 重建后端会话）带上 search_engine=rg；当前会话保持创建
          // 时的设置，Windows 的 Find 后端不启用。
          search_engine: st0.enhancedFindGrep ? 'rg' : '',
          // 常规「集成终端 Shell」：仅新会话生效，Windows 下 Bash 工具用此 shell。
          terminal_shell: st0.terminalShell,
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
              // 工具完成/失败：serve 模式下 tool.complete 走这里（status='completed'/'failed'），
              // 没有独立的 tool_result 事件。必须转发为 tool_result，否则 tool_call
              // 一直保持 running，卡片永远显示"执行"而不是"已执行"。
              if (u.status === 'completed' || u.status === 'failed' || u.status === 'complete') {
                return {
                  type: 'tool_result',
                  toolName: u.toolName || u.title || '',
                  content: normalizeAcpContent(u.content || ''),
                  failed: u.status === 'failed',
                }
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
              // 自动压缩信号：压缩会轮换内部 Hermes session id，ACP server 随即
              // 发出 session_info_update 并携带 field_meta.hermes.sessionProvenance
              // （previous_hermes_session_id 非空即表示发生过轮转 = 压缩）。
              // 普通标题/元数据更新该字段为 null，不会误触发。
              {
                const _prov = u?.field_meta?.hermes?.sessionProvenance
                if (_prov && _prov.previous_hermes_session_id) {
                  return { type: 'auto_compressed' }
                }
              }
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

      // ── 子代理实时事件 → store.subAgents ──────────────────────────────
      // serve 模式下后端把子任务进度以 subagent.* 事件中继到父会话（见
      // tui_gateway/server.py _on_tool_progress 的 subagent.* 分支）。
      // 这些事件经 serve-gateway.ts 的 default 分支原样透传，这里消费并写入
      // store，让 DelegationsPanel 顶部的"实时"区能显示运行中的子任务。
      // 磁盘 live 日志（delegation_live_log.py）仍由后端独立维护，作为兜底。
      const handleSubagentEvent = (method: string, params: any): void => {
        if (typeof params !== 'object' || params === null) return
        const goal = typeof params.goal === 'string' ? params.goal : ''
        // 后端 subagent_id；缺失时退回 child_session_id 构造的稳定 id
        const subagentId =
          typeof params.subagent_id === 'string' && params.subagent_id
            ? params.subagent_id
            : typeof params.child_session_id === 'string' && params.child_session_id
              ? `sa-${params.child_session_id}`
              : null
        if (!subagentId) {
          debug('[SubAgent] 事件缺少 subagent_id/child_session_id，跳过', method)
          return
        }
        const model = typeof params.model === 'string' ? params.model : ''
        const text = typeof params.text === 'string' ? params.text : ''

        if (method === 'subagent.start') {
          const existing = useHelixStore.getState().subAgents.some(a => a.id === subagentId)
          if (existing) return // 已存在（thinking 提前建过）——只补描述
          useHelixStore.getState().spawnSubAgent(model || '子代理', goal || text || '执行子任务', undefined, subagentId)
          return
        }
        if (method === 'subagent.thinking') {
          const existing = useHelixStore.getState().subAgents.some(a => a.id === subagentId)
          if (!existing) {
            useHelixStore.getState().spawnSubAgent(model || '子代理', goal || text || '思考中…', undefined, subagentId)
          }
          return
        }
        if (method === 'subagent.tool') {
          const toolName = typeof params.tool_name === 'string' && params.tool_name ? params.tool_name : 'tool'
          // 后端 subagent.tool 只带 tool_preview（args 不进 payload）；优先用它
          const preview = typeof params.tool_preview === 'string' && params.tool_preview
            ? params.tool_preview
            : text
          useHelixStore.getState().addSubAgentToolCall(subagentId, {
            toolName,
            params: preview.slice(0, 500),
            status: 'running',
          })
          return
        }
        if (method === 'subagent.complete') {
          const status = typeof params.status === 'string' ? params.status : ''
          const summary = typeof params.summary === 'string' && params.summary ? params.summary : text
          const filesWritten = Array.isArray(params.files_written)
            ? params.files_written.map((f: unknown) => String(f)).slice(0, 20)
            : undefined
          if (status === 'failed' || status === 'error') {
            useHelixStore.getState().failSubAgent(subagentId, summary || '子代理执行失败')
          } else {
            useHelixStore.getState().completeSubAgent(subagentId, summary || undefined, filesWritten)
          }
          return
        }
        // subagent.progress / subagent.text / 其它 → 忽略
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
          // 带上会话级 sessionId：todo 面板按会话聚合，只显示当前 run 所属
          // 会话的 UI 更新，避免切会话/并发 run 时串台。
          useHelixStore.getState().setHermesTodos(list, sessionId ?? undefined)
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
      const IDLE_TIMEOUT_MS = 90_000
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
          // 抓取后端 message.complete 透传的 row_id，落库时盖到 ChatMessage 上，供撤回同步后端用。
          if (method === 'message.complete') {
            const rid = params?.row_id ?? params?.payload?.row_id
            if (rid != null) {
              const n = typeof rid === 'string' ? parseInt(rid, 10) : Number(rid)
              if (!Number.isNaN(n)) pendingAssistantRowIdRef.current = n
            }
          }
          if (parsed) {
            enqueue('data: ' + JSON.stringify(parsed))
          }
          // 子代理（delegate_task）事件：实时写入 store.subAgents，
          // 供 DelegationsPanel 顶部"实时"区渲染（磁盘 live 日志仍作兜底）。
          // 这些事件携带父会话 sid，已通过上面的 true-concurrency 过滤。
          if (method === 'subagent.start' || method === 'subagent.thinking' ||
              method === 'subagent.tool' || method === 'subagent.complete') {
            try {
              handleSubagentEvent(method, params)
            } catch (e) {
              console.error('[Helix] subagent event handling error', e)
            }
          }
          // 自动压缩实时提示：检测到压缩驱动的 session 轮转事件时，在对话流中插入一条居中状态行。
          if (parsed && parsed.type === 'auto_compressed') {
            setAutoCompressNotices(prev => {
              const text = '上下文已自动压缩'
              if (prev.some(n => n.text === text)) return prev
              return [...prev, { id: generateId(), ts: Date.now(), text }]
            })
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
          if (parsed && parsed.type === 'done' && doneProcessedRef.current) {
            // 后续重复的 done 事件带权威正文时，就地修正已提交消息，避免最终文本缺字。
            patchDoneMessage(typeof parsed.content === 'string' ? parsed.content : '')
          }
          if (parsed && (parsed.type === 'done' || parsed.type === 'error')) {
            queueDone = true
            if (idleTimerRef) { clearTimeout(idleTimerRef); idleTimerRef = null }
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
        // 只要有可解码的文本内容就 inline，不依赖 kind（覆盖扩展名未识别的文本文件）
        const hasText = f.base64
          ? (() => { try { decodeBase64Utf8(f.base64!); return true } catch { return false } })()
          : false
        if (hasText) {
          const maxInline = 200 * 1024
          try {
            const content = decodeBase64Utf8(f.base64!)
            if (f.size && f.size > maxInline) {
              const head = content.slice(0, maxInline)
              const tail = f.path ? ` 完整内容可用 Read 工具读取: ${f.path.replace(/\\/g, '/')}` : ''
              fileContext += `\n\n--- 文件 ${f.name} 的内容(前 ${formatBytes(maxInline)}) ---\n${head}\n...(内容较长已截断)${tail}`
            } else {
              fileContext += `\n\n--- 文件 ${f.name} 的内容 ---\n${content}`
            }
          } catch { /* not text */ }
        } else {
          // 二进制或无法解码：仅给路径提示，依赖 Electron/Tauri 提供真实路径让模型 Read
          fileContext += `\n\n[已附加文件: ${f.name} (${formatBytes(f.size)})]`
          if (f.path) {
            const normalizedPath = f.path.replace(/\\/g, '/')
            fileContext += ` 文件路径: ${normalizedPath}`
          }
        }
      }
const promptText = (trimmed + fileContext).trim() || trimmed
      // 计划模式（plan）：handleRun 被批准流程重新触发时（approvalMode 已是
      // accept_edits），这里取 live getState() 而非闭包——避免闭包里还是旧的
      // plan 模式，导致批准后仍带上只读前缀，模型继续只读规划不执行。
      // plan 模式前缀明确告诉模型：只做只读分析、给出方案，不要改文件/跑命令；
      // 用户批准后（accept_edits）前缀消失，模型才真正动手。
      const liveMode = useHelixStore.getState().approvalMode
      const finalPromptText = liveMode === 'plan'
        ? `[计划模式] 请只做只读分析并给出可执行的实施计划，不要修改任何文件、不要执行任何命令，也不要在没有明确请求时下载或访问外部资源。请以清晰的步骤列出你的方案，供用户审阅批准后再执行。\n\n${promptText}`
        : promptText
      promptItems.push({ type: 'text', text: finalPromptText })

      // Fire the prompt — events stream back via onEvent (don't await the promise itself).
      // ACP expects prompt as a list of content blocks, not a plain string
promptSentAtRef.current = Date.now()
      hermesApi()!.send('session/prompt', {
        session_id: sessionId,
        prompt: [{ type: 'text', text: finalPromptText }],
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
              // 同时把该块中 status==='running' 的 tool_call 标记 completed/failed——
              // 否则工具已完成但卡片仍显示"执行"（tool_group 块的状态只在
              // 这里维护，done 分支只更新独立的 steps 数组，不动 responseBlocks）。
              uiRB(prev => {
                const idx = prev.findIndex(b => {
                  if (b.type !== 'tool_group') return false
                  return !b.steps.some(s => s.type === 'tool_result' || s.type === 'error')
                })
                if (idx !== -1) {
                  const cur = prev[idx] as Extract<ResponseBlock, { type: 'tool_group' }>
                  const nb = prev.slice()
                  nb[idx] = {
                    type: 'tool_group',
                    steps: [
                      ...cur.steps.map(s =>
                        s.type === 'tool_call' && s.status === 'running'
                          ? { ...s, status: parsed.failed ? ('failed' as const) : ('completed' as const) }
                          : s
                      ),
                      step,
                    ],
                  }
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
                // New text is a superset of accumulated text (Hermes full resend).
                // Guard: a resend that LOST whitespace (fewer bytes, same normalized
                // content) must not clobber the accumulated copy — whitespace loss is
                // what breaks markdown tables/strong ("**加粗** 后" → "**加粗**后").
                newText = incRaw.length >= cur.length ? incRaw : cur
              } else if (incTrim && curTrim.startsWith(incTrim)) {
                // Incoming is a subset of accumulated (retry sent shorter text) — keep the
                // more complete accumulated buffer to avoid truncation.
                // `incTrim &&` guard: a whitespace-only chunk trims to "" and
                // curTrim.startsWith("") is ALWAYS true — that branch would silently
                // DROP the whitespace (the root cause of glued words / broken tables
                // in streamed markdown). Whitespace-only chunks must be appended.
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
                // 重复的 done 事件带权威正文时，就地修正已提交消息，避免最终文本缺字。
                patchDoneMessage(typeof parsed.content === 'string' ? parsed.content : '')
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
                // something useful instead of a blank reply. 例外：暂停/停止时
                //（无正文 + responseBlocks 里已有 thinking/tool 块）不把思考塞进
                // 正文——保留 blocks 让已完成消息按折叠的「思考过程」渲染，而不是
                // 所有思考过程平铺冒出来（且 discardBlocks 会把 thinking 块丢掉）。
                if (!content && reasoning && responseBlocksRef.current.length === 0) {
                  content = reasoning
                  reasoning = ''
                }
                // Detect scheduled-task declarations in AI output. Don't auto-create —
                // collect them and show a confirm dialog so the user approves first.
                const detected = detectScheduledTasks(content)
                content = detected.cleaned
                if (detected.tasks.length > 0) {
                  setPendingTaskCreations(prev => [...prev, ...detected.tasks.map(t => ({ ...t, sessionId: useHelixStore.getState().currentSessionId ?? DRAFT_SESSION_KEY }))])
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
                // 权威全文自愈（见 reconcileBlocksWithContent）：流式转发链会间歇丢
                // 空白/换行，done 时 content 已被 finalText 修复；把同样的权威文本写回
                // blocks 的 text 块，让 blocks 渲染路径与 msg.content 一致——否则
                // "**加粗** 后"黏成 "**加粗**后" 时 strong 闭合符后紧跟非空白字符，
                // CommonMark 不渲染加粗（用户可见症状：** 原样显示）。
                if (finalBlocks && content) {
                  finalBlocks = reconcileBlocksWithContent(finalBlocks, content)
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
                if (pendingAssistantRowIdRef.current != null) {
                  curState.setChatMessageRowId(msgId, pendingAssistantRowIdRef.current)
                  pendingAssistantRowIdRef.current = null
                }
                doneMsgIdRef.current = msgId
                thoughtTokensRef.current = 0
                outputTokensRef.current = 0
                thinkingStartTimeRef.current = 0
                thinkingDurationRef.current = 0
                curState.setChatMessageStreaming(msgId, false)
                // 两阶段计划模式：plan 模式下模型产出方案后不直接执行，而是先弹
                // 审批浮条让用户“批准执行”或“继续调整”。批准时才把模式切到
                // accept_edits 并重新跑 handleRun（此时 getState() 已是批准后的
                // 模式，handleRun 的只读前缀判定自然放行）。
                if (content && useHelixStore.getState().approvalMode === 'plan') {
                  setPendingPlanReview({
                    sessionId: useHelixStore.getState().currentSessionId ?? DRAFT_SESSION_KEY,
                    content,
                  })
                }
              } else {
                // 防御性兜底：run 结束但无任何可见内容（根因已修复，极少触发）。
                const st = useHelixStore.getState()
                const mid = st.addChatMessage({ role: 'assistant', content: '⚠️ 本轮运行已结束，但模型未返回任何可见内容。', sessionId: activeSessionId })
                doneMsgIdRef.current = mid
                if (pendingAssistantRowIdRef.current != null) {
                  st.setChatMessageRowId(mid, pendingAssistantRowIdRef.current)
                  pendingAssistantRowIdRef.current = null
                }
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
                useHelixStore.getState().activeSessionWorkDir ?? useHelixStore.getState().selectedWorkDir,
                useHelixStore.getState().approvalMode,
              )
              if (verdict === 'auto') {
                const sid = (myCid && sessionMapRef.current.get(myCid)?.sid)
                  || (currentSessionId && sessionMapRef.current.get(currentSessionId)?.sid)
                  || hermesSessionIdRef.current
                if (sid) {
                  // 自动批准也走新 RPC（2026-08-17 起后端弃用 session/approve）：
                  // approval.respond + choice，无需再配对 toolCallId。
                  hermesApi()!.send('approval.respond', {
                    session_id: sid,
                    choice: 'once',
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

  const handleApproval = useCallback(async (approvalId: string, choice: ApprovalLevel) => {
    // 先出队（fail-closed）：无论 RPC 是否成功，approval 弹条立即从 UI 移除，
    // 避免后端已 resolve 但响应延迟/超时时，用户看到一条永远转圈"提交中"的弹条
    //（RPC_TIMEOUT_MS=60s，agent 已继续但审批仍在占屏）。未送达时 agent 会再发
    // 新 approval.request 重新入队，UI 与后端状态自然对齐。
    setApprovalQueue(prev => prev.filter(r => r.id !== approvalId))
    try {
      // 用 getState() 拿当前会话，避免 useCallback([]) 闭包里的 currentSessionId
      // 因依赖变化而读到旧值（弹条常跨会话存活，出队必须删对的会话）。
      const cid = useHelixStore.getState().currentSessionId
      const sid = (cid && sessionMapRef.current.get(cid)?.sid) || hermesSessionIdRef.current
      if (sid) {
        // 旧 RPC 是 WS 里非对称的一对一 approve/deny（session/approve 需要 toolCallId）。
        // 新 RPC 用 approval.respond + choice: once/session/always/deny，把决定写回
        // 后端状态机后由 agent 侧 resolve，无需前端再配对 request_id（2026-08-17 验证）。
        await hermesApi()!.send('approval.respond', {
          session_id: sid,
          choice,
        })
      }
    } catch (err) {
      console.error('Approval error:', err)
      storeActions.showToast({ type: 'error', title: '审批提交失败', description: String(err) })
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

  // 批准计划：关掉审批浮条，把 approvalMode 切到 accept_edits（用 live store + 后端
  // set_mode 双保险，让后端/前端都进入"替我审批"模式），然后重跑 handleRun 让 agent
  // 真正动手执行刚才的方案。注意 handleRun 是幂等的：它按当前输入重新发 prompt，模型
  // 在 accept_edits 模式下会继续执行（而非再次只读规划）。
  const handleApprovePlan = useCallback(async () => {
    setPendingPlanReview(null)
    const cid = useHelixStore.getState().currentSessionId
    setApprovalMode('accept_edits')
    // 后端模式同步：让 yolo/只读模式下的 session 真正解锁到可写状态。
    const hermesSid = (cid && sessionMapRef.current.get(cid)?.sid) || hermesSessionIdRef.current
    if (hermesSid) {
      hermesApi()!.send('session/set_mode', {
        session_id: hermesSid,
        mode_id: 'accept_edits',
      }).catch((e: any) => {
        console.warn('[Helix] set_mode(accept_edits) failed:', e)
      })
    }
    // 把"批准"注入输入框再跑，模型以此确认用户已同意并开始动手；setInputSynced
    // 只写 ref（不触发 store 写入），setTimeout 确保新输入在 handleRun 读到的是
    // 批准后的状态。
    setInputSynced('[计划已获批准] 请按你刚才给出的计划开始执行。')
    setTimeout(() => handleRun(), 0)
  }, [setApprovalMode, setInputSynced, handleRun])

  // 调整计划：只关闭审批浮条（保持 plan 模式），用户自己修改输入后重新触发即可；
  // 后端 session 模式不变，仍是只读规划模式。
  const handleAdjustPlan = useCallback(() => {
    setPendingPlanReview(null)
  }, [])

  const handleApproveAll = useCallback(async () => {
    if (approvalQueue.length === 0) return
    // 先把队列清空（fail-closed），让弹条立即消失；RPC 逐个发，任一个失败不阻塞整体。
    setApprovalQueue([])
    try {
      const cid = useHelixStore.getState().currentSessionId
      const sid = (cid && sessionMapRef.current.get(cid)?.sid) || hermesSessionIdRef.current
      if (sid) {
        for (const req of approvalQueue) {
          // 新 RPC（2026-08-17 起后端弃用 session/approve）：approval.respond +
          // choice: once/session/always/deny，由 agent 侧状态机 resolve，不再配对
          // toolCallId。once = 仅放行当前这步。
          await hermesApi()!.send('approval.respond', {
            session_id: sid,
            choice: 'once',
          })
        }
      }
    } catch (err) {
      console.error('Approve all error:', err)
      storeActions.showToast({ type: 'error', title: '全部批准失败', description: String(err) })
    }
  }, [approvalQueue])

  const handleRejectAll = useCallback(async () => {
    if (approvalQueue.length === 0) return
    // 先清空队列（fail-closed），弹条立即消失；逐个发 deny 让 agent 侧拒绝。
    setApprovalQueue([])
    try {
      const cid = useHelixStore.getState().currentSessionId
      const sid = (cid && sessionMapRef.current.get(cid)?.sid) || hermesSessionIdRef.current
      if (sid) {
        for (const req of approvalQueue) {
          await hermesApi()!.send('approval.respond', {
            session_id: sid,
            choice: 'deny',
          })
        }
      }
    } catch (err) {
      console.error('Reject all error:', err)
      storeActions.showToast({ type: 'error', title: '全部拒绝失败', description: String(err) })
    }
  }, [approvalQueue])

  // Listen for keyboard shortcut approve/decline events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (approvalQueue.length === 0) return
      const first = approvalQueue[0]
      handleApproval(first.id, detail.approved ? 'once' : 'deny')
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
      // Preserve the previous session's link cards too (they live in the store,
      // not in local state) so switching away doesn't drop them.
      const prevLinks = store.tabAttachments[prev]?.links ?? []
      store.setTabAttachments(prev, pendingImages, pendingFiles, prevLinks)
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
      <div className="relative min-w-0" ref={approvalModeDropdownRef}>
        <button
          type="button"
          onClick={() => setShowApprovalModeDropdown(!showApprovalModeDropdown)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[calc(var(--helix-transcript-size)*0.8571)] transition-all duration-200 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60"
          data-tip="审批模式"
        >
          {approvalMode === 'default' && <Hand className="size-3.5" />}
          {approvalMode === 'accept_edits' && <Clock className="size-3.5" />}
          {approvalMode === 'dont_ask' && <AlertTriangle className="size-3.5" />}
          {approvalMode === 'plan' && <FileText className="size-3.5" />}
          <span className="truncate min-w-0 chat-toolbar-label">
            {approvalMode === 'default' && '请求批准'}
            {approvalMode === 'accept_edits' && '替我审批'}
            {approvalMode === 'dont_ask' && '完全访问权限'}
            {approvalMode === 'plan' && '制定计划'}
          </span>
          <ChevronDown className="size-3" />
        </button>
        {showApprovalModeDropdown && (
          <div className="absolute bottom-full left-0 mb-2 w-56 bg-popover rounded-xl border border-border/40 shadow-xl py-1 z-50 animate-scale-in">
            {[
              {
                id: 'default' as const,
                icon: Hand,
                title: '请求批准',
                desc: '全部需批准',
              },
              {
                id: 'accept_edits' as const,
                icon: Clock,
                title: '替我审批',
                desc: '风险才批准',
              },
              {
                id: 'dont_ask' as const,
                icon: AlertTriangle,
                title: '完全访问权限',
                desc: '完全放开',
              },
              {
                id: 'plan' as const,
                icon: FileText,
                title: '制定计划',
                desc: '先规划后做',
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
                  className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-muted transition-colors ${active ? 'bg-primary/5' : ''}`}
                >
                  <div className="mt-0.5 shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center">
                    <Icon className="size-3.5 text-foreground/70" />
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
      className={`helix-chat-input-card border transition-all duration-200 relative bg-card backdrop-blur-md border-border/40 rounded-2xl ${isDraggingFile ? 'border-primary/40' : 'hover:border-border/60 focus-within:border-primary/30'}`}
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
              <div className={`absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-primary/10 text-[length:var(--helix-transcript-size)] font-medium text-primary rounded-2xl`}>
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
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground max-w-[8ch] truncate">{f.name.length > 8 ? f.name.slice(0, 8) + '…' : f.name}</p>
                      <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60">{formatBytes(f.size)}</p>
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

            {/* Web link cards picked from the in-app browser (compact替代长 URL 纯文本) */}
            {pendingLinks.length > 0 && (
              <div className="border-t border-border/20 px-4 py-2">
                <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 mb-1.5">
                  {pendingLinks.length} 个网页链接
                </p>
                <div className="flex flex-wrap gap-2">
                {pendingLinks.map(l => {
                  const linkTitle = l.title || (() => { try { return new URL(l.url).hostname } catch { return '网页链接' } })()
                  return (
                  <div
                    key={l.id}
                    className="relative flex items-center gap-2 max-w-[280px] px-2.5 py-1.5 rounded-xl border border-border/30 bg-muted/20 hover:bg-muted/40 hover:border-border/30 transition-all duration-200 group cursor-pointer"
                    onClick={() => {
                      import('@/lib/electron-bridge').then(({ electronShell }) => electronShell.open(l.url))
                    }}
                    data-tip={linkTitle}
                  >
                    <Link className="size-4 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground truncate">{linkTitle}</p>
                      <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 truncate">{l.url}</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        useHelixStore.getState().removeLinkAttachment(l.id)
                      }}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                  )
                })}
                </div>
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
              placeholder={ "随心输入..."}
              rows={2}
              className="chat-input w-full resize-none bg-transparent caret-foreground text-left placeholder:text-left placeholder:text-muted-foreground/60 outline-none focus-visible:outline-none text-[length:var(--helix-transcript-size)] min-h-[52px] max-h-[300px] px-4 pt-3.5 pb-1 leading-relaxed  [overflow-wrap:anywhere] overflow-x-hidden overflow-y-auto text-foreground"
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

            {/* Unified slash command dropdown */}
            {showSlashMenu && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-background/95 backdrop-blur-sm rounded-2xl border border-border/30 shadow-xl shadow-black/10 z-50 max-h-[300px] overflow-y-auto mx-3">
                {/* Quick commands section */}
                {matchedQuickCmds.length > 0 && (
                  <>
                    <p className="px-3 pt-2 pb-1 text-[calc(var(--helix-transcript-size)*0.7143)] font-semibold text-muted-foreground/30 uppercase tracking-wider">快捷指令</p>
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
                        <code className="text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-primary/70 shrink-0 w-20">{qc.cmd}</code>
                        <div className="min-w-0 flex-1">
                          <span className="text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground block">{qc.label}</span>
                          <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground block truncate">{qc.prompt}</span>
                        </div>
                      </button>
                    ))}
                  </>
                )}

                {/* Skills/Commands section */}
                {filteredSkills.length > 0 && (
                  <>
                    {matchedQuickCmds.length > 0 && <div className="border-t border-border/20 mx-3" />}
                    <p className="px-3 pt-2 pb-1 text-[calc(var(--helix-transcript-size)*0.7143)] font-semibold text-muted-foreground/30 uppercase tracking-wider">命令</p>
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
                          <span className="text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground block truncate">{skill.name}</span>
                          {skill.description && (
                            <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground block truncate">{skill.description}</span>
                          )}
                        </div>
                        {(skill as any).isBuiltinCommand && (
                          <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-amber-500/70 shrink-0">CMD</span>
                        )}
                        {(skill as any).isHermesCommand && (
                          <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60 shrink-0">Hermes</span>
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
                      <span className="text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground block truncate">{file.name}</span>
                      <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground block truncate">{file.path}</span>
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
                  <div className="flex items-center gap-1.5 min-w-0 shrink">
                    <ContextUsageIndicator />
                    {hasApiKey || isServeActive() ? (
                      renderModelSelector()
                    ) : (
                      <button
                        type="button"
                        onClick={() => storeActions.toggleSettings('api')}
                        className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/50 hover:text-foreground hover:bg-muted/60 px-2.5 py-1.5 h-9 rounded-lg transition-colors"
                      >
                        设置模型
                      </button>
                    )}
                    <ReasoningEffortControl value={reasoningEffort} onChange={(v) => storeActions.setReasoningEffort(v)} />
                    <button
                      type="button"
                      onClick={isBusy ? () => handleStop() : handleRun}
                      disabled={!isBusy && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0 && pendingLinks.length === 0}
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
                  <div className="flex items-center gap-1.5 min-w-0 shrink">
                    <ContextUsageIndicator />
                    {(hasApiKey || isServeActive()) && renderModelSelector()}
                    <ReasoningEffortControl value={reasoningEffort} onChange={(v) => storeActions.setReasoningEffort(v)} />
                    <button
                      type="button"
                      onClick={isBusy ? () => handleStop() : handleRun}
                      disabled={!isBusy && !input.trim() && pendingImages.length === 0 && pendingFiles.length === 0 && pendingLinks.length === 0}
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
    // 项目外对话（已加载但 workDir 为空）不显示项目目录与分支。新对话（无会话，
    // currentSessionId 为 null）仍显示所选项目或「选择项目」提示。
    const showProjectContext = currentSessionId === null || !!activeSessionWorkDir
    if (!showProjectContext) return null
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
          className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
          data-tip={selectedWorkDir || '选择项目目录'}
        >
          <Folder className="size-3.5 text-amber-500" />
          <span className="max-w-[160px] truncate">{projectName.length > 12 ? projectName.slice(0, 12) + '…' : projectName}</span>
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
            className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/60 hover:text-foreground hover:bg-accent/50 px-2 py-1 rounded-lg transition-colors"
            data-tip={`当前分支：${currentBranch}`}
          >
            <GitBranch className="size-3.5 text-emerald-500" />
            <span>{currentBranch}</span>
          </button>
          {branchPopoverOpen && (
            <div className="absolute bottom-full left-0 mb-1.5 w-64 bg-background/95 backdrop-blur-sm rounded-xl border border-border/30 shadow-lg shadow-black/8 z-50 flex flex-col max-h-80">
              {/* Search */}
              <div className="px-3 pt-2.5 pb-1.5 border-b border-border/20">
                <div className="flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground">
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
                <div className="px-3 py-1 text-[calc(var(--helix-transcript-size)*0.7857)] font-medium text-muted-foreground">分支</div>
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
                    className={`w-full flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.9286)] px-3 py-1.5 transition-colors ${b === currentBranch ? 'bg-primary/8 text-primary' : 'text-foreground/80 hover:bg-muted/40'}`}
                  >
                    <GitBranch className="size-3.5 shrink-0 text-foreground/40" />
                    <span className="truncate flex-1 text-left">{b}</span>
                    {b === currentBranch && (
                      <div className="flex items-center gap-2 shrink-0">
                        {branchDirtyCount > 0 && (
                          <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground">未提交：{branchDirtyCount} 个文件</span>
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
                    className="w-full flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.8571)] px-3 py-2 text-foreground/50 hover:text-foreground hover:bg-muted/30 transition-colors"
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
                      className="w-full text-[calc(var(--helix-transcript-size)*0.8571)] px-2 py-1 rounded-md bg-muted/40 border border-border/30 outline-none focus:border-primary/50"
                      autoFocus
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleCreateBranch(branchNewName.trim())}
                        disabled={!branchNewName.trim()}
                        className="flex-1 text-[calc(var(--helix-transcript-size)*0.7857)] py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-30"
                      >创建</button>
                      <button
                        type="button"
                        onClick={() => setBranchCreating(false)}
                        className="flex-1 text-[calc(var(--helix-transcript-size)*0.7857)] py-1 rounded-md bg-muted/40 text-foreground/70 hover:bg-muted/60 transition-colors"
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
      {/* 历史对话竖条：消息区左侧边缘，点击弹出最近对话列表并跳转。
          覆盖面板（看板/定时任务/技能）打开时隐藏，避免竖条与面板抢焦点。 */}
      {!overlayPanelOpen && <HistoryStrip />}
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
            className="w-44 bg-transparent text-[length:var(--helix-transcript-size)] outline-none placeholder:text-muted-foreground"
          />
          <span className={`text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums shrink-0 ${searchMatches.length ? 'text-muted-foreground' : 'text-foreground/40'}`}>
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
      <div ref={scrollRef} className={`flex-1 min-h-0 overflow-y-auto msg-scroll-viewport ${sessionMessages.length === 0 && !hasSteps ? 'hide-scrollbar' : ''}`}>
        <div className="max-w-[700px] mx-auto px-5 py-4 pb-12 min-h-full">
          {sessionMessages.length === 0 && !hasSteps ? (
            <div className="flex flex-col items-center w-full pt-[22vh]">
              <div className="w-full max-w-[700px] mx-auto px-5">
                <img src="/kirin.png" alt="Helix" className="w-14 h-14 opacity-70 mx-auto mb-4" />
                <p className="text-[calc(var(--helix-transcript-size)*1.0714)] font-normal text-foreground/50 text-center mb-6 tracking-tight">{startupGreeting}</p>
                {renderEmptyBreadcrumb()}
                {renderChatInput({ isEmpty: true })}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Branch indicator */}
              {currentBranchInfo && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/5 border border-blue-500/15 text-[calc(var(--helix-transcript-size)*0.8571)]">
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
                ) : item.kind === 'status' ? (
                  <div
                    key={item.id}
                    className="flex w-full items-center justify-center gap-1.5 py-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground/60"
                  >
                    <Archive className="size-3 shrink-0" />
                    <span>{item.text}</span>
                  </div>
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
                    onWithdraw={handleWithdraw}
                    onUndo={handleUndoChat}
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
                    {/* Top status bar — 执行中显示「工作中」，完成后显示「已结束」 */}
                    {(streamingActive || displayResponseBlocks.length > 0) && (
                      <div className="flex items-center gap-1.5 my-1 text-foreground/50" style={{ fontSize: transcriptFontSize }}>
                        <span>{streamingActive ? '工作中' : '已结束'}</span>
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
                          <div className="mt-1 pl-3 border-l-2 border-border/60 text-foreground/60 break-all leading-relaxed thinking-cap-tall thinking-scroll" style={{ fontSize: transcriptFontSize }}>
                            {thinkingBody}
                          </div>
                        </details>
                      </div>
                    )}

                    {/* Inline thinking block (collapsible) — kept for completed messages */}

                    {/* Interleaved response blocks: thinking, text, and tool groups in chronological order */}
                    {displayResponseBlocks.length > 0 && (() => {
                      // 按时间序交替渲染思考/工具/正文，但把最终 text 之前的中间过程
                      // （thinking + tool_group + 中间文本）整体包进一个折叠块，减少
                      // 空间占用。流式中展开（实时可见过程），完成后自动收起——与
                      // 已完成消息的 group/process 折叠一致。
                      const normalizedBlocks = mergeAdjacentThinking(normalizeTextBlocks(displayResponseBlocks))
                      const lastTextIndex = normalizedBlocks.reduce((acc, b, i) => b.type === 'text' ? i : acc, -1)
                      const processBlocks = lastTextIndex >= 0 ? normalizedBlocks.slice(0, lastTextIndex) : normalizedBlocks
                      const answerBlocks = lastTextIndex >= 0 ? normalizedBlocks.slice(lastTextIndex) : []
                      return (
                      <>
                        {processBlocks.length > 0 && (
                          <details className="mb-2 mt-3 group/process" open={streamingActive}>
                            <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize: transcriptFontSize }}>
                              <span>{streamingActive ? '思考过程' : '已结束'}</span>
                              <svg className="size-3.5 transition-transform group-open/process:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                            </summary>
                            <div className="mt-1 pl-3 space-y-1">
                              {processBlocks.map((block, idx) =>
                                block.type === 'thinking' ? (
                                <details key={idx} className="mb-2 mt-3 group/details">
                                  <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize: transcriptFontSize }}>
                                    <span>{extractKaomojiStatus(block.content).status || '思考中'}</span>
                                    <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                                  </summary>
                                  <div className="mt-1 pl-3 border-l-2 border-border/60 text-foreground/50 break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize: transcriptFontSize }}>
                                    {conversationSearchOpen && conversationSearchQuery.trim() ? (
                                      <HighlightText text={normalizeAcpContentRaw(block.content)} query={conversationSearchQuery} active={false} />
                                    ) : (
                                      <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                                    )}
                                  </div>
                                </details>
                              ) : block.type === 'text' ? (
                                <div key={idx} style={{ fontSize: transcriptFontSize }}>
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
                                <InlineToolGroup key={idx} steps={block.steps} isRunning={isRunning} fontSize={transcriptFontSize} />
                              )
                              )}
                            </div>
                          </details>
                        )}
                        {answerBlocks.map((block, idx) =>
                          block.type === 'text' ? (
                            <div key={idx} style={{ fontSize: transcriptFontSize }}>
                              {conversationSearchOpen && conversationSearchQuery.trim() ? (
                                <div className="whitespace-pre-wrap break-words">
                                  <HighlightText text={normalizeAcpContentRaw(block.content)} query={conversationSearchQuery} active={false} />
                                </div>
                              ) : (
                                <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                              )}
                            </div>
                          ) : block.type === 'thinking' ? (
                            <details key={idx} className="mb-2 mt-3 group/details">
                              <summary className="text-foreground/35 cursor-pointer hover:text-foreground/55 select-none flex items-center gap-1 list-none transition-colors" style={{ fontSize: transcriptFontSize }}>
                                <span>{extractKaomojiStatus(block.content).status || '思考中'}</span>
                                <svg className="size-3.5 transition-transform group-open/details:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                              </summary>
                              <div className="mt-1 pl-3 border-l-2 border-border/60 text-foreground/50 break-all leading-relaxed thinking-cap thinking-scroll" style={{ fontSize: transcriptFontSize }}>
                                {conversationSearchOpen && conversationSearchQuery.trim() ? (
                                  <HighlightText text={normalizeAcpContentRaw(block.content)} query={conversationSearchQuery} active={false} />
                                ) : (
                                  <HelixMarkdown text={normalizeAcpContentRaw(block.content)} />
                                )}
                              </div>
                            </details>
                          ) : block.type === 'file_change' ? (
                            <FileChangeSummary key={idx} changes={block.changes} />
                          ) : (
                            <InlineToolGroup key={idx} steps={block.steps} isRunning={isRunning} fontSize={transcriptFontSize} />
                          )
                        )}
                      </>
                      )
                    })()}

                    {/* Live thinking duration — only while actually streaming (isRunning).
                        Must NOT hang on streamingActive/isChatLoading; those can stay true
                        after completion (e.g. session-id drift prevents the finally block
                        from clearing isChatLoading), causing the timer to tick forever. */}
                    {isRunning && (
                      <div className="text-foreground/30 tabular-nums mt-1 ml-3" style={{ fontSize: transcriptFontSize }}>
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
        <div className="mx-4 mb-2 px-3 py-2.5 rounded-xl text-[calc(var(--helix-transcript-size)*0.8571)] flex items-center gap-2 border cursor-pointer hover:opacity-80 transition-all duration-200 shadow-sm" style={{
          backgroundColor: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145 / 0.1)' : 'oklch(0.70 0.15 65 / 0.1)',
          borderColor: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145 / 0.25)' : 'oklch(0.70 0.15 65 / 0.25)',
          color: connectionNotice.phase === 'recovered' ? 'oklch(0.65 0.15 145)' : 'oklch(0.70 0.15 65)',
        }} onClick={() => useHelixStore.getState().setConnectionNotice(null)}>
          {connectionNotice.phase !== 'recovered' && (
            <div className="animate-spin size-3 border-2 border-current border-t-transparent rounded-full shrink-0" />
          )}
          <span className="flex-1">{connectionNotice.message}</span>
          <span className="text-[calc(var(--helix-transcript-size)*0.7143)] opacity-60">点击关闭</span>
        </div>
      )}

      {/* New project form */}
      {showNewProjectForm && (
        <div className="max-w-[700px] mx-auto mb-2 p-3 bg-card/30 rounded-xl border border-border/30 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <FolderPlus className="size-4 text-primary" />
            <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">新建项目</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject() }}
              placeholder="输入项目名称..."
              className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-[length:var(--helix-transcript-size)] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all duration-200"
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/80 hover:bg-muted border border-border/50 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground hover:text-foreground transition-all duration-200 shadow-sm backdrop-blur-sm"
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
          </div>
        </div>
      )}

      {/* Approval Dialog */}
      {approvalRequest && (
        <ApprovalDialog
          request={approvalRequest}
          pendingCount={pendingApprovalCount}
          onApprove={(id, level) => handleApproval(id, level)}
          onReject={(id) => handleApproval(id, 'deny')}
          onApproveAll={handleApproveAll}
        />
      )}

      {/* Scheduled task creation confirmation */}
      {pendingTaskCreations.some(t => t.sessionId === approvalKey) && (
        <ScheduledTaskConfirm
          tasks={pendingTaskCreations.filter(t => t.sessionId === approvalKey)}
          onConfirm={handleConfirmTasks}
          onDismiss={handleDismissTasks}
        />
      )}

      {/* Clarify 反问浮条（模型多选反问） */}
      {clarifyRequest && (
        <ClarifyBar
          // key 绑定到请求 id：同一会话连发多条 clarify 时，第二条进来会强制重建
          // 组件，清掉上一条的 submitting/freeText/selectedIdx 等内部状态，避免
          // 残留 UI 挡在第二条上面（ApprovalBar 的 pendingCount 同样依赖重建）。
          key={clarifyRequest.id}
          request={clarifyRequest}
          onRespond={handleClarifyRespond}
        />
      )}

      {/* 计划审批浮条（plan 模式）：模型产出方案（Claude 只读规划返回）后先弹给
          用户审阅，批准才切换 accept_edits 重新执行，调整则关闭浮条让用户改输入。 */}
      {pendingPlanReview && pendingPlanReview.sessionId === approvalKey && (
        <PlanReviewBar
          content={pendingPlanReview.content}
          onApprove={handleApprovePlan}
          onAdjust={handleAdjustPlan}
        />
      )}

    </div>
  )
}

