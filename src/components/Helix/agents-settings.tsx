'use client'

import React, { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { SettingRow, SettingGroup, SectionHeading } from './settings-ui'

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
        const d = r?.delegation ?? {}
        setCfg({
          provider: d.provider ?? '',
          model: d.model ?? '',
          base_url: d.base_url ?? '',
          max_iterations: d.max_iterations != null ? Number(d.max_iterations) : 50,
          reasoning_effort: d.reasoning_effort ?? '',
          subagent_auto_approve: d.subagent_auto_approve === true || d.subagent_auto_approve === 'true',
        })
      })
      .catch((e: any) => alive && setErr(String(e?.message || e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const setKey = (key: string, value: any) =>
    (window as any).electron?.hermes?.setYamlKey(`delegation.${key}`, value)

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
    <SettingRow label={label}>
      <input
        type={type}
        value={cfg[key] as any}
        placeholder={placeholder}
        onChange={(e) =>
          setCfg((c) => ({ ...c, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))
        }
        className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm font-mono text-foreground/70 placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 transition-colors"
      />
    </SettingRow>
  )

  return (
    <div className="max-w-xl space-y-1">
      <SectionHeading>Subagent</SectionHeading>

      {loading ? (
        <div className="text-xs text-muted-foreground/60 mt-2">读取配置中…</div>
      ) : (
        <>
          <SettingGroup title="委托配置">
            {field('子智能体 Provider', 'provider', '例如 openai / anthropic')}
            {field('子智能体 Model', 'model', '例如 gpt-4o')}
            {field('子智能体 Base URL', 'base_url', 'OpenAI 兼容端点（可选）')}
            {field('最大迭代次数', 'max_iterations', '50', 'number')}
            {field('推理强度', 'reasoning_effort', 'ultra / max / high（可选）')}
            <SettingRow label="子智能体危险命令自动通过（非交互式）">
              <input
                type="checkbox"
                checked={cfg.subagent_auto_approve}
                onChange={(e) => setCfg((c) => ({ ...c, subagent_auto_approve: e.target.checked }))}
                className="size-4 accent-primary"
              />
            </SettingRow>
          </SettingGroup>
          {err && <p className="text-xs text-red-400 pt-2">{err}</p>}
          <div className="flex items-center justify-end gap-3 pt-4">
            <Button size="sm" variant="ghost" onClick={() => setCfg(DEFAULTS)}>
              重置
            </Button>
            <Button size="sm" variant="default" onClick={save} disabled={loading || saving}>
              {saving ? '保存中…' : saved ? '已保存' : '保存'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
