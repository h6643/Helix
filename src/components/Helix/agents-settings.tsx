'use client'

import React, { useState, useEffect } from 'react'
import { Bot, Save, Loader2, RotateCcw } from 'lucide-react'

interface DelegationConfig {
  provider: string
  model: string
  base_url: string
  max_iterations: number
  reasoning_effort: string
  subagent_auto_approve: boolean
}

const DEFAULTS: DelegationConfig = {
  provider: '',
  model: '',
  base_url: '',
  max_iterations: 50,
  reasoning_effort: '',
  subagent_auto_approve: false,
}

// Helix's gateway exposes subagent routing via config.yaml `model.delegation.*`.
// This section reads/writes those keys through the existing hermes bridge.
export function AgentsSettings() {
  const [cfg, setCfg] = useState<DelegationConfig>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const api = (window as any).electron?.hermes
    if (!api?.getConfig) {
      setErr('网关未连接，无法读取配置')
      setLoading(false)
      return
    }
    api
      .getConfig()
      .then((r: any) => {
        if (!alive) return
        const d = r?.model?.delegation ?? {}
        setCfg({
          provider: d.provider ?? '',
          model: d.model ?? '',
          base_url: d.base_url ?? '',
          max_iterations: d.max_iterations ?? 50,
          reasoning_effort: d.reasoning_effort ?? '',
          subagent_auto_approve: !!d.subagent_auto_approve,
        })
      })
      .catch((e: any) => alive && setErr(String(e?.message || e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const setKey = (key: string, value: any) =>
    (window as any).electron?.hermes?.setYamlKey(`model.delegation.${key}`, value)

  const save = async () => {
    setSaving(true)
    setSaved(false)
    setErr(null)
    try {
      await Promise.all([
        setKey('provider', cfg.provider),
        setKey('model', cfg.model),
        setKey('base_url', cfg.base_url),
        setKey('max_iterations', cfg.max_iterations),
        setKey('reasoning_effort', cfg.reasoning_effort),
        setKey('subagent_auto_approve', cfg.subagent_auto_approve),
      ])
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  const field = (
    label: string,
    key: keyof DelegationConfig,
    placeholder: string,
    type: 'text' | 'number' = 'text'
  ) => (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type={type}
        value={cfg[key] as any}
        placeholder={placeholder}
        onChange={(e) =>
          setCfg((c) => ({ ...c, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))
        }
        className="mt-1 w-full px-3 py-1.5 text-sm rounded-lg bg-muted/50 border border-border/50 outline-none focus:border-primary/50"
      />
    </label>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Bot className="size-4 text-primary" />
        <h3 className="text-lg font-bold text-foreground">Agents / 子智能体</h3>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mt-2">
          <Loader2 className="size-3.5 animate-spin" /> 读取配置中…
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[11px] text-muted-foreground/70">
            子智能体（delegate_task）使用的 provider / model 与行为。留空则继承主模型。修改后需重启网关生效。
          </p>
          <div className="space-y-3 max-w-md">
            {field('子智能体 Provider', 'provider', '例如 openai / anthropic')}
            {field('子智能体 Model', 'model', '例如 gpt-4o')}
            {field('子智能体 Base URL', 'base_url', 'OpenAI 兼容端点（可选）')}
            {field('最大迭代次数', 'max_iterations', '50', 'number')}
            {field('推理强度', 'reasoning_effort', 'ultra / max / high（可选）')}
            <label className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={cfg.subagent_auto_approve}
                onChange={(e) => setCfg((c) => ({ ...c, subagent_auto_approve: e.target.checked }))}
                className="accent-primary"
              />
              <span className="text-xs text-foreground/80">子智能体危险命令自动通过（非交互式）</span>
            </label>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => setCfg(DEFAULTS)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="size-3.5" /> 重置
            </button>
            <button
              onClick={save}
              disabled={loading || saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {saved ? '已保存' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
