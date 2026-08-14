'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toggle, PopupSelect, NumberField } from './settings-ui'
import {
  getHermesConfig,
  patchHermesConfig,
  getMemoryProviderConfig,
  setMemoryProviderConfig,
  setupMemoryProvider,
  HermesRestUnavailable,
} from '@/lib/hermes-rest'
import type { MemoryProviderField } from '@/types/electron'
import { warn } from '@/lib/logger'

/**
 * Hermes 记忆 / 压缩配置面板。
 *
 * 直接读写后端 `~/.hermes/config.yaml`（经 serve 网关的 `GET|PUT /api/config`，
 * 见 lib/hermes-rest.ts），**不再只存前端 IndexedDB**。字段名与后端一一对应
 * （核查 agent/agent_init.py:1618 与 :1785）：
 *
 *   memory.memory_enabled        持久记忆总开关          默认 false
 *   memory.user_profile_enabled  用户画像（USER.md）      默认 false
 *   memory.provider            外置记忆 Provider（mem0/hindsight/…，单选，空=仅内置） 默认 ''
 *   memory.memory_char_limit     MEMORY.md 字符上限       默认 2200
 *   memory.user_char_limit       USER.md 字符上限         默认 1375
 *   compression.threshold        上下文占用触发压缩比例    默认 0.50
 *   compression.target_ratio     压缩后目标占用比例        默认 0.20
 *   compression.protect_last_n   压缩时保护的末尾消息条数  默认 20
 *
 * 两个必须知道的语义坑：
 * 1. 预算单位是**字符**不是 token（hermes 自己按 ~2.75 字符/token 估算），
 *    所以界面直接标「字符」，不做换算以免误导。
 * 2. threshold / target_ratio 在 YAML 里是 0–1 的小数，界面用百分比展示，
 *    读写两侧各做一次换算。
 *
 * 生效时机：这些值只在 **agent 构造时**读一次（agent_init 里没有 watcher，
 * 网关也没有 reload.config RPC），所以写盘后无需重启进程，但要新建会话才生效。
 */

type ProviderMeta = { id: string; label: string; type: string; best: string; env?: string; env2?: string; local?: boolean }
const PROVIDERS: ProviderMeta[] = [
  { id: '', label: '无', type: '仅内置记忆', best: '默认' },
  { id: 'mem0', label: 'Mem0', type: '记忆层（通用）', best: '个性化助手', env: 'MEM0_API_KEY' },
  { id: 'hindsight', label: 'Hindsight', type: '高级记忆系统', best: '企业知识 / Agent', env: 'HINDSIGHT_API_KEY', env2: 'HINDSIGHT_API_URL' },
  { id: 'holographic', label: 'Holographic', type: '本地记忆', best: '本地单机', local: true },
  { id: 'honcho', label: 'Honcho', type: '用户建模记忆', best: '个性建模', env: 'HONCHO_API_KEY', env2: 'HONCHO_BASE_URL' },
  { id: 'retaindb', label: 'RetainDB', type: '记忆数据库', best: '高精度偏好记忆', env: 'RETAINDB_API_KEY', env2: 'RETAINDB_BASE_URL' },
  { id: 'byterover', label: 'ByteRover', type: '检索层', best: '大规模系统', env: 'BRV_API_KEY' },
  { id: 'supermemory', label: 'Supermemory', type: '用户工具', best: '个人知识库', env: 'SUPERMEMORY_API_KEY' },
  { id: 'openviking', label: 'OpenViking', type: 'Agent 框架', best: 'Agent 系统', env: 'OPENVIKING_API_KEY', env2: 'OPENVIKING_ENDPOINT' },
]

interface MemoryCfg {
  memoryEnabled: boolean
  userProfileEnabled: boolean
  provider: string
  memoryCharLimit: number
  userCharLimit: number
  thresholdPct: number
  targetPct: number
  protectLastN: number
}

const DEFAULTS: MemoryCfg = {
  memoryEnabled: false,
  userProfileEnabled: false,
  provider: '',
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  thresholdPct: 50,
  targetPct: 20,
  protectLastN: 20,
}

function toBool(v: any, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.toLowerCase())
  if (typeof v === 'number') return v !== 0
  return fallback
}

function toNum(v: any, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** config.yaml → 面板状态 */
function fromConfig(cfg: Record<string, any>): MemoryCfg {
  const mem = (cfg?.memory && typeof cfg.memory === 'object') ? cfg.memory : {}
  const comp = (cfg?.compression && typeof cfg.compression === 'object') ? cfg.compression : {}
  return {
    memoryEnabled: toBool(mem.memory_enabled, DEFAULTS.memoryEnabled),
    userProfileEnabled: toBool(mem.user_profile_enabled, DEFAULTS.userProfileEnabled),
    provider: String(mem.provider ?? ''),
    memoryCharLimit: Math.round(toNum(mem.memory_char_limit, DEFAULTS.memoryCharLimit)),
    userCharLimit: Math.round(toNum(mem.user_char_limit, DEFAULTS.userCharLimit)),
    thresholdPct: Math.round(toNum(comp.threshold, 0.5) * 100),
    targetPct: Math.round(toNum(comp.target_ratio, 0.2) * 100),
    protectLastN: Math.round(toNum(comp.protect_last_n, DEFAULTS.protectLastN)),
  }
}

/** 面板状态 → config.yaml 子树（PUT 时服务端做深合并，只发这两段是安全的） */
function toConfigPatch(c: MemoryCfg): Record<string, any> {
  return {
    memory: {
      memory_enabled: c.memoryEnabled,
      user_profile_enabled: c.userProfileEnabled,
      provider: c.provider,
      memory_char_limit: c.memoryCharLimit,
      user_char_limit: c.userCharLimit,
    },
    compression: {
      threshold: Number((c.thresholdPct / 100).toFixed(4)),
      target_ratio: Number((c.targetPct / 100).toFixed(4)),
      protect_last_n: c.protectLastN,
    },
  }
}

function Row({
  label,
  hint,
  children,
  dim = false,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  dim?: boolean
}) {
  return (
    <div className={`flex items-start gap-3 py-3 px-4 hover:bg-muted/40 transition-colors ${dim ? 'opacity-45' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="ui-text text-foreground">{label}</div>
        {hint && <div className="ui-text text-muted-foreground/60 mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

// ── 外置记忆 Provider 配置面板 ────────────────────────────────────────────
// 由 serve 网关 /api/memory/providers/{name}/config 的 schema 驱动渲染：
// GET 返回字段定义 + 当前值，PUT 以 {values:{…}} 保存并激活。
// 后端没有该 provider 插件时字段为空 → 显示「未安装」状态与安装指引。

const FIELD_INPUT_CLS =
  'px-2.5 py-1.5 rounded-lg bg-muted/20 ui-text text-foreground text-center border border-border focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors'

function renderProviderField(field: MemoryProviderField, value: any, onChange: (v: any) => void) {
  switch (field.kind) {
    case 'select':
      return (
        <PopupSelect
          value={String(value ?? '')}
          onChange={onChange}
          placeholder="请选择"
          className="w-56 ui-text text-foreground border border-border bg-muted/20 rounded-md px-3 py-1.5 focus:outline-none focus:border-primary/40 transition-colors"
          options={(field.options || []).map((o) => ({
            label: o.label,
            value: o.value,
            ...(o.description ? { hint: o.description } : {}),
          }))}
        />
      )
    case 'bool':
      return <Toggle enabled={!!value} onToggle={() => onChange(!value)} />
    case 'number':
      return (
        <input
          type="number"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD_INPUT_CLS} w-32 font-mono`}
        />
      )
    case 'json':
      return (
        <textarea
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={`${FIELD_INPUT_CLS} w-72 font-mono`}
        />
      )
    default:
      return (
        <input
          type={field.kind === 'secret' ? 'password' : 'text'}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || (field.kind === 'secret' ? '留空保持原值' : '')}
          className={`${FIELD_INPUT_CLS} w-56 font-mono`}
        />
      )
  }
}

function ProviderConfigPanel({ provider }: { provider: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'not-installed' | 'error'>('loading')
  const [fields, setFields] = useState<MemoryProviderField[]>([])
  const [label, setLabel] = useState(provider)
  const [setup, setSetup] = useState<any>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [secretSet, setSecretSet] = useState<Record<string, boolean>>({})
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(0)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 未安装态：显示一行安装指令（插件安装）+ 可选 pip 依赖提示 + 一键安装。
  const pluginInstallCommand = useMemo(
    () => `hermes plugins install NousResearch/hermes-agent/plugins/memory/${provider}`,
    [provider]
  )
  const pipHint = useMemo(() => {
    const pipDeps: string[] = Array.isArray(setup?.pip_dependencies) ? setup.pip_dependencies : []
    return pipDeps.length > 0 ? `pip install ${pipDeps.join(' ')}` : ''
  }, [setup])
  const [installOutput, setInstallOutput] = useState<string | null>(null)
  const [installOk, setInstallOk] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [loadTick, setLoadTick] = useState(0)

  // 切换 Provider 时清空安装输出。
  useEffect(() => { setInstallOutput(null); setInstallOk(false) }, [provider])

  useEffect(() => {
    let cancelled = false
    setState('loading')
    setErr(null)
    ;(async () => {
      try {
        const cfg = await getMemoryProviderConfig(provider)
        if (cancelled) return
        setLabel(cfg?.label || provider)
        setSetup(cfg?.setup)
        const f: MemoryProviderField[] = Array.isArray(cfg?.fields) ? cfg.fields : []
        if (!f.length) {
          setState('not-installed')
          return
        }
        setFields(f)
        const v: Record<string, any> = {}
        const s: Record<string, boolean> = {}
        for (const field of f) {
          if (field.kind === 'secret') {
            s[field.key] = !!field.is_set
          } else {
            v[field.key] = field.value ?? (field.kind === 'bool' ? false : '')
          }
        }
        setValues(v)
        setSecretSet(s)
        setState('ready')
      } catch (e: any) {
        if (cancelled) return
        setErr(String(e?.message || e))
        setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [provider, loadTick])

  // 一键安装：1) 插件本体（hermes plugins install → GitHub 下载到
  // $HERMES_HOME/plugins/<name>） 2) 运行时依赖（POST /setup → pip install）。
  const runInstall = async () => {
    if (installing) return
    setInstalling(true)
    setInstallOutput(null)
    try {
      // 1) 插件文件（不内置，必须按需安装）
      const el = window.electron as any
      if (typeof el?.hermes?.installPlugin !== 'function') {
        setInstallOutput('当前运行时未提供自动安装通道，请在终端手动执行：' + pluginInstallCommand)
        setInstallOk(false)
        return
      }
      const pluginRes = await el.hermes.installPlugin(
        `NousResearch/hermes-agent/plugins/memory/${provider}`,
        false
      )
      if (!pluginRes?.ok) {
        setInstallOutput(String(pluginRes?.message || pluginRes?.error || '插件安装失败'))
        setInstallOk(false)
        return
      }
      // 2) 运行时依赖（pip / external）
      const res = await setupMemoryProvider(provider)
      const results = Array.isArray(res?.results) ? res.results : (res?.results ? [res.results] : [])
      const failed = results.find((r: any) => r?.status === 'failed')
      if (failed) {
        setInstallOutput(String(failed.error || failed.command || '依赖安装失败'))
        setInstallOk(false)
        return
      }
      setInstallOutput('安装完成，正在刷新配置…')
      setInstallOk(true)
      setLoadTick((n) => n + 1)
    } catch (e: any) {
      setInstallOutput(String(e?.message || e))
      setInstallOk(false)
    } finally {
      setInstalling(false)
    }
  }

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const save = async () => {
    setSaving(true)
    setErr(null)
    try {
      await setMemoryProviderConfig(provider, values)
      setSavedTick((n) => n + 1)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSavedTick(0), 2200)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="py-3 px-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 ui-text text-foreground">
          配置 <span className="font-mono">{label}</span>
          <span className="ml-1 ui-text text-muted-foreground/60">（写入后新建会话生效）</span>
        </div>
        {state === 'ready' && (
          <div className="flex items-center gap-2 shrink-0">
            {err
              ? <span className="ui-text text-red-400">{err}</span>
              : saving
                ? <span className="ui-text text-muted-foreground/60">保存中…</span>
                : savedTick > 0
                  ? <span className="ui-text text-muted-foreground/60">已保存</span>
                  : null}
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 disabled:opacity-50 transition-colors"
            >
              保存
            </button>
          </div>
        )}
      </div>

      {state === 'loading' && (
        <div className="ui-text text-muted-foreground/60">读取 Provider 配置…</div>
      )}

      {state === 'error' && (
        <div className="ui-text text-red-400">读取配置失败：{err}</div>
      )}

      {state === 'not-installed' && (
        <div className="ui-text text-muted-foreground/70 leading-relaxed">
          <span className="text-foreground">{label}</span> 未安装，暂无可配置项。安装后即可配置：
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-muted/50 font-mono text-[12px] text-foreground/80 border border-border overflow-x-auto whitespace-nowrap">
              {pluginInstallCommand}
            </code>
            <button
              type="button"
              onClick={runInstall}
              disabled={installing}
              className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 disabled:opacity-50 transition-colors"
            >
              {installing ? '安装中…' : '一键安装'}
            </button>
          </div>
          {pipHint && (
            <div className="mt-1 ui-text text-muted-foreground/50">
              安装后还需运行依赖：<code className="font-mono">{pipHint}</code>（一键安装会自动执行）
            </div>
          )}
          {installOutput && (
            <pre className={`mt-2 max-h-48 overflow-auto px-2.5 py-2 rounded-lg bg-muted/40 font-mono text-[11px] whitespace-pre-wrap break-all ${installOk ? 'text-emerald-500/90' : 'text-red-400'}`}>
              {installOutput}
            </pre>
          )}
        </div>
      )}

      {state === 'ready' && (
        <div className="space-y-3">
          {fields.map((field) => (
            <div key={field.key} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="ui-text text-foreground/90">
                  {field.label}
                  {field.required && <span className="ml-1 text-red-400">*</span>}
                  {field.kind === 'secret' && (
                    <span className={`ml-2 ui-text ${secretSet[field.key] ? 'text-emerald-500' : 'text-amber-500'}`}>
                      {secretSet[field.key] ? '已设置' : '未设置'}
                    </span>
                  )}
                </div>
                {field.description && (
                  <div className="ui-text text-muted-foreground/60 mt-0.5">{field.description}</div>
                )}
              </div>
              <div className="shrink-0 pt-0.5">
                {renderProviderField(field, values[field.key], (v) => setValues((prev) => ({ ...prev, [field.key]: v })))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MemorySettings() {
  const [cfg, setCfg] = useState<MemoryCfg>(DEFAULTS)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(0)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await getHermesConfig()
        if (cancelled) return
        setCfg(fromConfig(raw))
        setState('ready')
      } catch (e: any) {
        if (cancelled) return
        if (e instanceof HermesRestUnavailable) {
          setState('unavailable')
        } else {
          warn('[MemorySettings] 读取配置失败:', e)
          setErr(String(e?.message || e))
          setState('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const update = useCallback(async (patch: Partial<MemoryCfg>) => {
    const next = { ...cfg, ...patch }
    setCfg(next) // 乐观更新
    setSaving(true)
    setErr(null)
    try {
      await patchHermesConfig(toConfigPatch(next))
      setSavedTick((n) => n + 1)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSavedTick(0), 2200)
    } catch (e: any) {
      warn('[MemorySettings] 保存配置失败:', e)
      setErr(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }, [cfg])

  if (state === 'loading') {
    return <div className="max-w-3xl text-xs text-muted-foreground/60 py-2">读取 Hermes 配置…</div>
  }

  if (state === 'unavailable') {
    return (
      <div className="max-w-3xl text-xs text-muted-foreground/60 py-2">
        Hermes 网关未就绪，暂时无法读写记忆配置。
      </div>
    )
  }

  const memOff = !cfg.memoryEnabled && !cfg.userProfileEnabled

  const status = err
    ? <span className="text-[11px] text-red-400">{err}</span>
    : saving
      ? <span className="text-[11px] text-muted-foreground/60">保存中…</span>
      : savedTick > 0
        ? <span className="text-[11px] text-muted-foreground/60">已保存</span>
        : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="ui-title font-semibold text-foreground">记忆</h3>
        {status}
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden divide-y divide-border/30">
        <Row label="持久记忆" hint="把对话要点写入 MEMORY.md，跨会话保留">
          <Toggle enabled={cfg.memoryEnabled} onToggle={() => update({ memoryEnabled: !cfg.memoryEnabled })} />
        </Row>
        <Row label="用户画像" hint="自动维护 USER.md 中的长期偏好">
          <Toggle enabled={cfg.userProfileEnabled} onToggle={() => update({ userProfileEnabled: !cfg.userProfileEnabled })} />
        </Row>
        <Row label="记忆预算" hint="MEMORY.md 的字符上限，超出会触发裁剪" dim={memOff}>
          <NumberField value={cfg.memoryCharLimit} min={200} max={40000} suffix="字符" disabled={memOff} onCommit={(v) => update({ memoryCharLimit: v })} />
        </Row>
        <Row label="画像预算" hint="USER.md 的字符上限" dim={memOff}>
          <NumberField value={cfg.userCharLimit} min={200} max={40000} suffix="字符" disabled={memOff} onCommit={(v) => update({ userCharLimit: v })} />
        </Row>
        <Row
          label="外置记忆 Provider"
          hint={
            cfg.provider
              ? (() => {
                  const t = PROVIDERS.find((x) => x.id === cfg.provider)
                  if (!t) return '外部记忆服务已启用'
                  const envLine = t.local
                    ? '本地实现，无需 API Key'
                    : `需在 Hermes 启动环境设置 ${[t.env, t.env2].filter(Boolean).join(' / ')}`
                  return `${t.type} · 适合 ${t.best} · ${envLine}`
                })()
              : '可选一个，与内置记忆并存'
          }
        >
          <PopupSelect
            value={cfg.provider}
            onChange={(v) => update({ provider: v })}
            placeholder="无"
            className="w-40 ui-text-sm2 text-foreground border border-border bg-muted/20 rounded-md px-3 py-1.5 focus:outline-none focus:border-primary/40 transition-colors"
            options={PROVIDERS.map((t) => ({
              label: `${t.label}${t.local ? '（本地）' : ''}`,
              value: t.id,
            }))}
          />
        </Row>
        {cfg.provider && <ProviderConfigPanel provider={cfg.provider} />}
      </div>

      <h3 className="ui-title font-semibold text-foreground mb-4">上下文管理</h3>
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden divide-y divide-border/30">
        <Row label="压缩阈值" hint="上下文占用达到该比例时自动压缩">
          <NumberField value={cfg.thresholdPct} min={10} max={95} suffix="%" onCommit={(v) => update({ thresholdPct: v })} />
        </Row>
        <Row label="压缩目标" hint="压缩后希望回落到的占用比例">
          <NumberField value={cfg.targetPct} min={5} max={90} suffix="%" onCommit={(v) => update({ targetPct: v })} />
        </Row>
        <Row label="保留最近消息" hint="压缩时末尾这些消息原样保留，不被摘要">
          <NumberField value={cfg.protectLastN} min={0} max={200} suffix="条" onCommit={(v) => update({ protectLastN: v })} />
        </Row>
      </div>

    </div>
  )
}
