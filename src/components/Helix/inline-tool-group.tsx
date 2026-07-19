'use client'

import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ExecutionStep } from '@/stores/helix-store'
import { getToolLabel, getToolIcon, getToolDisplayLabel, extractToolPath } from '@/lib/tool-display-utils'
import { normalizeAcpContent, stripEmoji } from '@/lib/text-utils'

export function InlineToolGroup({ steps, isRunning }: { steps: ExecutionStep[]; isRunning: boolean }) {
  const [open, setOpen] = useState(false)
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())
  const calls = steps.filter(s => s.type === 'tool_call')
  const hasError = steps.some(s => s.type === 'error')

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
    title = calls[0].content || getToolLabel(calls[0].toolName || '')
  } else {
    const names = Array.from(new Set(calls.map(s => getToolLabel(s.toolName || ''))))
    if (names.length === 1) {
      title = `${names[0]} × ${calls.length}`
    } else {
      title = `执行了 ${calls.length} 个工具`
    }
  }

  const running = isRunning && !steps.some(s => s.type === 'tool_result' || s.type === 'error')

  return (
    <div className="my-2 overflow-hidden group">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-foreground/70 hover:bg-muted/50 transition-colors text-left"
      >
        <span className={`font-medium ${running ? 'animate-pulse text-foreground' : ''}`}>{title}</span>
        {hasError && <span className="text-red-500/80 text-[11px]">失败</span>}
        <ChevronRight className={`size-3.5 shrink-0 ml-auto text-foreground/30 transition-all ${open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-border/30 space-y-2">
          {steps.map((step) => {
            if (step.type === 'tool_call') {
              const path = extractToolPath(step)
              const hasSubSteps = step.subSteps && step.subSteps.length > 0
              return (
                <div key={step.id} className="text-[11px] text-foreground/60 font-mono">
                  <div className="flex items-center gap-1.5">
                    {getToolIcon(step.toolName || '')}
                    <span className={`font-medium ${hasSubSteps && step.status === 'running' ? 'animate-pulse text-foreground' : ''}`}>{getToolDisplayLabel(step.toolName || '', step.toolKind, path, step.toolParams)}</span>
                    {step.status === 'completed' && <span className="text-emerald-500/80 text-[10px]">✓</span>}
                    {step.status === 'failed' && <span className="text-red-500/80 text-[10px]">✗</span>}
                  </div>
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
                  {!hasSubSteps && step.toolParams && Object.keys(step.toolParams).length > 0 && (
                    <div className="mt-1.5 pl-5 space-y-1.5">
                      {Object.entries(step.toolParams).map(([k, v]) => (
                        <div key={k} className="flex flex-col">
                          <span className="text-[10px] text-foreground/40 font-medium uppercase tracking-wide">{k}</span>
                          <pre className="text-[11px] text-foreground/70 bg-card/50 rounded px-2 py-1.5 overflow-x-auto font-mono border border-border/50 whitespace-pre-wrap break-all">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            }
            if (step.type === 'tool_result') {
              const isExpanded = expandedResults.has(step.id)
              const content = stripEmoji(normalizeAcpContent(step.content || ''))
              const isLong = content.length > 500 || content.split('\n').length > 10
              return (
                <div key={step.id} className="pl-5 text-[11px] font-mono">
                  {isLong && !isExpanded ? (
                    <div>
                      <div className="text-foreground/50 whitespace-pre-wrap break-all leading-relaxed max-h-20 overflow-hidden relative">
                        {content}
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
                    <div>
                      <div className="text-foreground/50 whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
                        {content}
                      </div>
                      {isLong && (
                        <button
                          onClick={() => toggleResult(step.id)}
                          className="mt-1 text-foreground/40 hover:text-foreground/70 transition-colors"
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
        </div>
      )}
    </div>
  )
}
