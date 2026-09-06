'use client'

import React, { useState, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, PopupSelect } from './settings-ui'

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

interface SubagentDraft {
  id: string
  name: string
  system_prompt: string
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

const SubagentItem = ({ i, remove }: { i: SubagentDraft; remove: (id: string) => void }) => (
  <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2.5 flex items-center justify-between gap-3">
    <div className="min-w-0 space-y-0.5">
      <p className="ui-text font-semibold text-foreground truncate">{i.name.trim() || '未命名'}</p>
      <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate">
        {i.system_prompt.trim()
          ? truncate(i.system_prompt.trim(), 20)
          : '（未填写系统提示词）'}
      </p>
    </div>
    <Button
      size="icon"
      variant="ghost"
      className="size-8 shrink-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
      onClick={() => remove(i.id)}
      aria-label="删除 Subagent"
      data-tip="删除"
    >
      <Trash2 className="size-4" />
    </Button>
  </div>
)

export function AgentsSettings() {
  const [cfg, setCfg] = useState<DelegationConfig>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [identities, setIdentities] = useState<{ id: string; name: string; system_prompt: string }[]>([])
  const [adding, setAdding] = useState(false)

  const apiHistory = useHelixStore((s) => s.apiHistory)

  useEffect(() => {
    let alive = true
    const api = (window as any).electron?.helix
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
        // identities is persisted as a JSON-on-one-line YAML flow value, so
        // getConfig returns it as a string we JSON.parse here.
        const rawIds = d?.identities
        let parsedIds: any[] = []
        if (rawIds) { try { parsedIds = JSON.parse(rawIds) } catch {} }
        if (Array.isArray(parsedIds)) {
          setIdentities(
            parsedIds.map((x, i) => ({
              id: `id-${i}`,
              name: String(x?.name ?? ''),
              system_prompt: String(x?.system_prompt ?? ''),
            })),
          )
        }
      })
      .catch((e: any) => alive && setErr(String(e?.message || e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const setKey = (key: string, value: any) =>
    (window as any).electron?.helix?.setYamlKey(`delegation.${key}`, value)

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
      const payload = identities
        .filter((i) => i.name.trim())
        .map(({ name, system_prompt }) => ({ name: name.trim(), system_prompt }))
      await (window as any).electron?.helix?.setDelegationIdentities?.(payload)
      setSaved(true)
      setAdding(false)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  const applyHistory = (idx: string) => {
    const h = apiHistory[Number(idx)]
    if (!h) return
    setCfg((c) => ({ ...c, provider: h.provider, model: h.model, base_url: h.baseUrl }))
  }

  const matchedHistory = apiHistory.findIndex(
    (h) => h.model === cfg.model && h.baseUrl === cfg.base_url
  )

  const addIdentity = () =>
    setIdentities((prev) => [...prev, { id: `id-${Date.now()}`, name: '', system_prompt: '' }])

  const startAdd = () => {
    addIdentity()
    setAdding(true)
  }

  const updateIdentity = (id: string, patch: Partial<{ name: string; system_prompt: string }>) =>
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))

  const removeIdentity = (id: string) =>
    setIdentities((prev) => prev.filter((i) => i.id !== id))

  const field = (
    label: string,
    key: keyof DelegationConfig,
    placeholder: string,
    type: 'text' | 'number' = 'text',
    hint?: string
  ) => (
    <SettingRow label={label} hint={hint}>
      <input
        type={type}
        value={cfg[key] as any}
        placeholder={placeholder}
        onChange={(e) =>
          setCfg((c) => ({ ...c, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))
        }
        className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md ui-text font-mono text-foreground/70 text-center placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 transition-colors"
      />
    </SettingRow>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="ui-subtitle font-semibold text-foreground">Subagent</h3>
        <button
          onClick={startAdd}
          className="flex items-center gap-1.5 ui-text font-medium text-primary hover:text-primary/80 transition-colors"
        >
          添加 Subagent
        </button>
      </div>

      <div className="max-w-3xl space-y-4">
      {loading ? (
        <div className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60 mt-2">读取配置中…</div>
      ) : (
        <>
          {adding && (
            <>
              <SettingGroup>
                {apiHistory.length > 0 ? (
                  <SettingRow label="模型配置（从历史选择）">
                    <PopupSelect
                      value={matchedHistory >= 0 ? String(matchedHistory) : ''}
                      onChange={applyHistory}
                      placeholder={matchedHistory >= 0 ? '手动配置' : '选择历史模型配置…'}
                      className="w-56 ui-text text-foreground"
                      options={apiHistory.map((h, i) => ({
                        value: String(i),
                        label: h.model,
                      }))}
                    />
                  </SettingRow>
                ) : (
                  <SettingRow label="模型配置">
                    <span className="ui-text text-muted-foreground/60">
                      暂无历史配置，请先在「API 配置」中添加模型
                    </span>
                  </SettingRow>
                )}
                {field('最大迭代次数', 'max_iterations', '50', 'number', '子智能体单次任务最多执行的步骤数，超过即停止。')}
                {field('推理强度', 'reasoning_effort', 'ultra / max / high（可选）', 'text', '控制子智能体的思考深度与耗时，留空使用默认。')}
                {identities.length > 0 && (() => {
                  const draft = identities[identities.length - 1]
                  return (
                    <>
                      <SettingRow label="名称 Name">
                        <div className="flex items-center gap-2">
                          <input
                            value={draft.name}
                            onChange={(e) => updateIdentity(draft.id, { name: e.target.value })}
                            placeholder="如 researcher"
                            className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md ui-text font-semibold text-foreground text-center placeholder:text-muted-foreground/30 placeholder:font-normal focus:outline-none focus:border-primary/30 transition-colors"
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => removeIdentity(draft.id)}
                            aria-label="删除 Subagent"
                            data-tip="删除"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </SettingRow>
                      <SettingRow label="系统提示词" hint="子智能体的人格描述 / 角色设定">
                        <textarea
                          value={draft.system_prompt}
                          onChange={(e) => updateIdentity(draft.id, { system_prompt: e.target.value })}
                          placeholder="系统提示词 / 人格描述…"
                          className="w-72 min-h-[80px] px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md ui-text text-foreground text-left placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 resize-y transition-colors"
                        />
                      </SettingRow>
                    </>
                  )
                })()}
                <SettingRow label="子智能体危险命令自动通过（非交互式）" hint="开启后，子智能体执行危险命令前不再逐条请求确认。">
                  <input
                    type="checkbox"
                    checked={cfg.subagent_auto_approve}
                    onChange={(e) => setCfg((c) => ({ ...c, subagent_auto_approve: e.target.checked }))}
                    className="size-4 accent-primary"
                  />
                </SettingRow>
              </SettingGroup>

              {err && <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-red-400 pt-2">{err}</p>}
              <div className="flex items-center justify-end gap-3 pt-4">
                <Button size="sm" variant="ghost" onClick={() => setCfg(DEFAULTS)}>
                  重置
                </Button>
                <Button size="sm" variant="outline" onClick={save} disabled={loading || saving}>
                  {saving ? '保存中…' : saved ? '已保存' : '保存'}
                </Button>
              </div>
            </>
          )}

          {identities.slice(0, adding ? identities.length - 1 : undefined).map((i) => (
            <SubagentItem key={i.id} i={i} remove={removeIdentity} />
          ))}
        </>
      )}
      </div>
    </div>
  )
}

/**
 * 主 Agent 编码上下文开关（agent.coding_context）。
 * 放在「模型 → 主模型」设置页（api-settings），控制的是主 Agent 的编码姿态
 * （子 Agent 通过 delegation 自动继承，见 agent/coding_context.py）。
 * 切换即时写盘（setYamlKey），不依赖「保存」按钮。
 */
export function CodingContextSetting() {
  const [codingContext, setCodingContext] = useState<string>('auto')
  const [err, setErr] = useState<string | null>(null)
  const options = [
    { value: 'auto', label: 'auto' },
    { value: 'on', label: 'on' },
    { value: 'focus', label: 'focus' },
    { value: 'off', label: 'off' },
  ]

  useEffect(() => {
    let alive = true
    const api = (window as any).electron?.helix
    if (!api?.getConfig) return
    api
      .getConfig()
      .then((r: any) => {
        if (!alive) return
        const ac = r?.agent?.coding_context
        if (ac != null) setCodingContext(String(ac))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const apply = async (v: string) => {
    const prev = codingContext
    setCodingContext(v)
    setErr(null)
    try {
      await (window as any).electron?.helix?.setYamlKey('agent.coding_context', v)
    } catch (e: any) {
      setCodingContext(prev) // 失败回滚
      setErr(String(e?.message || e))
    }
  }

  return (
    <SettingGroup>
      <SettingRow
        label="上下文注入"
        hint="控制主 Agent 是否注入项目结构/工作区快照。"
      >
      <div className="flex justify-center w-full">
      <PopupSelect
        value={codingContext}
        onChange={(v) => apply(String(v))}
        options={options}
        placeholder="选择编码上下文模式"
        className="w-34 rounded-md border border-border bg-background px-2 py-1 ui-text text-foreground "
        popupWidth={200}
      />
      </div>
      </SettingRow>
      {err && (
        <p className="px-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-red-400">写入失败：{err}</p>
      )}
    </SettingGroup>
  )
}
