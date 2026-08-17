'use client'

import { Sparkles, Settings2, MessageSquare, Check, X } from 'lucide-react'
import React, { useState } from 'react'
import { useHelixStore } from '@/stores/helix-store'

const STEPS = [
  { icon: Settings2, title: '配置提供方与模型', desc: '在设置中选择你的 AI 提供方（OpenAI / Anthropic / 本地模型等）并填入 API Key。' },
  { icon: MessageSquare, title: '开始对话', desc: '回到主界面，直接输入任务，Hermes 会调用工具、读写文件、运行命令。' },
  { icon: Sparkles, title: '探索能力', desc: '试试计划任务、技能面板、终端、Git worktree 与文件预览。' },
]

export function Onboarding() {
  const hasOnboarded = useHelixStore((s) => s.hasOnboarded)
  const setHasOnboarded = useHelixStore((s) => s.setHasOnboarded)
  const [step, setStep] = useState(0)

  if (hasOnboarded) return null

  const finish = () => setHasOnboarded(true)

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6">
      <div className="relative w-full max-w-md bg-card border border-border/60 rounded-2xl shadow-2xl p-6">
        <button
          onClick={finish}
          className="absolute right-4 top-4 p-1.5 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-accent/60"
          data-tip="跳过"
        >
          <X className="size-4" />
        </button>

        <div className="flex items-center gap-2 mb-5">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <Sparkles className="size-5 text-primary" />
          </div>
          <h1 className="text-[calc(var(--helix-transcript-size)*1.2857)] font-semibold">欢迎使用 Helix</h1>
        </div>

        {/* progress */}
        <div className="flex items-center gap-1.5 mb-5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-primary' : 'bg-muted'
              }`}
            />
          ))}
        </div>

        <div className="min-h-[96px]">
          {STEPS.map((s, i) => {
            const Icon = s.icon
            return (
              <div key={i} className={i === step ? 'block' : 'hidden'}>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                    <Icon className="size-5 text-primary" />
                  </div>
                  <h2 className="text-[length:var(--helix-transcript-size)] font-semibold">{s.title}</h2>
                </div>
                <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground leading-relaxed">{s.desc}</p>
              </div>
            )
          })}
        </div>

        <div className="flex justify-between items-center mt-6">
          <button
            onClick={finish}
            className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground hover:text-foreground"
          >
            跳过引导
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="px-3 py-1.5 rounded-lg text-[calc(var(--helix-transcript-size)*0.8571)] border border-border/50 hover:bg-accent/50"
              >
                上一步
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                className="px-3 py-1.5 rounded-lg text-[calc(var(--helix-transcript-size)*0.8571)] bg-primary text-primary-foreground hover:bg-primary/90"
              >
                下一步
              </button>
            ) : (
              <button
                onClick={finish}
                className="px-3 py-1.5 rounded-lg text-[calc(var(--helix-transcript-size)*0.8571)] bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5"
              >
                <Check className="size-3.5" />
                开始使用
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
