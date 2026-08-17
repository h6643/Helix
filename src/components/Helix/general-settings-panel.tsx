'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { SettingRow, SettingGroup, SectionHeading, Toggle, PopupSelect } from './settings-ui'
import { electronApp, electronDialog } from '@/lib/electron-bridge'
import { CodingContextSetting } from './agents-settings'

/** 归档保留时长选项（小时）— 任务最后更新时间早于该时长才进入自动归档候选。 */
const RETENTION_OPTIONS = [
  { label: '3 天', value: '72', },
  { label: '7 天', value: '168', },
  { label: '14 天', value: '336',},
  { label: '30 天', value: '720',},
]

/** 集成终端 Shell 选项 — 仅新会话生效。 */
const TERMINAL_SHELL_OPTIONS = [
  { label: '自动（Git Bash）', value: 'auto'},
  { label: 'cmd.exe', value: 'cmd'},
]

export function GeneralSettingsPanel() {
  const showToast = useHelixStore(s => s.showToast)

  const {
    apiConfig, apiProfiles, activeProfileId, providers, activeModel,
    activeProviderId, providerModels,
    fontFamily, fontSize, interfaceFont, transcriptFontSize,
    mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm,
    gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix,
    persistToStorage,
    autoArchiveOldTasks, setAutoArchiveOldTasks,
    archiveRetentionHours, setArchiveRetentionHours,
    enhancedFindGrep, setEnhancedFindGrep,
    terminalShell, setTerminalShell,
  } = useHelixStore()

  const [dataRootInfo, setDataRootInfo] = useState<{
    dataRoot: string
    dataRootDefault: string
    dataRootCustom: boolean
  }>({ dataRoot: '', dataRootDefault: '', dataRootCustom: false })
  const [dataRootPath, setDataRootPath] = useState('')
  const [dataRootBusy, setDataRootBusy] = useState(false)

  // HTTP 代理（配置持久化在 Rust 侧 proxy.json，重启应用后生效）。
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyBusy, setProxyBusy] = useState(false)

  // 常规面板的开关/选项改动即生效（无保存按钮），防抖写入 IndexedDB，
  // 避免「增强 Find 和 Grep」「自动归档」「终端 Shell」等重启后丢失。
  const settingsPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (settingsPersistTimer.current) clearTimeout(settingsPersistTimer.current)
    settingsPersistTimer.current = setTimeout(() => {
      void persistToStorage().catch(() => {})
    }, 300)
    return () => {
      if (settingsPersistTimer.current) clearTimeout(settingsPersistTimer.current)
    }
  }, [autoArchiveOldTasks, archiveRetentionHours, enhancedFindGrep, terminalShell, persistToStorage])

  // 拉取当前生效的数据根目录（后端是权威来源）。
  useEffect(() => {
    let cancelled = false
    electronApp.getDataRoot()
      .then((r) => {
        if (!cancelled && r) {
          setDataRootInfo(r)
          setDataRootPath(r.dataRoot)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 拉取当前配置的 HTTP 代理。
  useEffect(() => {
    let cancelled = false
    electronApp.proxyGet()
      .then((r: { url?: string } | null) => {
        if (!cancelled && r) setProxyUrl(r.url ?? '')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const applyProxy = async () => {
    setProxyBusy(true)
    try {
      const r = await electronApp.proxySet(proxyUrl)
      if (r?.success) {
        showToast({ type: 'success', title: '代理已保存', description: '重启 Helix 后生效' })
      } else {
        showToast({ type: 'error', title: '保存失败' })
      }
    } catch (e) {
      showToast({ type: 'error', title: '保存失败', description: String(e) })
    } finally {
      setProxyBusy(false)
    }
  }

  const pickDataRoot = async () => {
    try {
      const dir = await electronDialog.openDirectory(dataRootInfo.dataRoot || undefined)
      if (dir) setDataRootPath(dir)
    } catch {
      /* 取消选择：忽略 */
    }
  }

  const applyDataRoot = async () => {
    const target = dataRootPath.trim()
    if (!target) {
      showToast({ type: 'warning', title: '请先输入或选择路径' })
      return
    }
    setDataRootBusy(true)
    try {
      const r = await electronApp.setDataRoot(target)
      if (r?.success) {
        setDataRootInfo({ dataRoot: r.dataRoot, dataRootDefault: r.dataRootDefault, dataRootCustom: r.dataRootCustom })
        setDataRootPath(r.dataRoot)
        showToast({ type: 'success', title: '数据已复制到新位置', description: '重启 Helix 后生效' })
      } else {
        showToast({ type: 'error', title: '设置失败' })
      }
    } catch (e) {
      showToast({ type: 'error', title: '设置失败', description: String(e) })
    } finally {
      setDataRootBusy(false)
    }
  }

  const resetDataRoot = async () => {
    setDataRootBusy(true)
    try {
      const r = await electronApp.setDataRoot('')
      if (r?.success) {
        setDataRootInfo({ dataRoot: r.dataRoot, dataRootDefault: r.dataRootDefault, dataRootCustom: r.dataRootCustom })
        setDataRootPath(r.dataRoot)
        showToast({ type: 'success', title: '已恢复默认路径', description: '重启 Helix 后生效' })
      } else {
        showToast({ type: 'error', title: '恢复失败' })
      }
    } catch (e) {
      showToast({ type: 'error', title: '恢复失败', description: String(e) })
    } finally {
      setDataRootBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeading>常规</SectionHeading>

      <CodingContextSetting />

      <SettingGroup>
        <SettingRow
          label="自动归档旧任务"
          hint="定时扫描最近打开过的工作区，将已完成、无未读、未置顶且超过保留期的任务自动归档。"
        >
          <Toggle
            enabled={!!autoArchiveOldTasks}
            onToggle={() => setAutoArchiveOldTasks(!autoArchiveOldTasks)}
          />
        </SettingRow>
        {autoArchiveOldTasks && (
          <SettingRow
            label="归档保留时长"
          >
            <PopupSelect
              value={String(archiveRetentionHours)}
              onChange={(v) => setArchiveRetentionHours(Number(v))}
              options={RETENTION_OPTIONS}
              className="w-36 rounded-md border border-border bg-background px-2 py-1 ui-text-sm2"
            />
          </SettingRow>
        )}
        <SettingRow
          label="增强 Find 和 Grep"
          hint="在新建会话或应用重启后恢复的会话中使用增强 Find 和 Grep（ripgrep）。当前会话保持现有设置；Windows 的 Find 保持不变。"
        >
          <Toggle
            enabled={!!enhancedFindGrep}
            onToggle={() => setEnhancedFindGrep(!enhancedFindGrep)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow
          label="集成终端 Shell"
          hint="仅新会话生效。Windows 下 Bash 工具用此 shell。"
        >
          <PopupSelect
            value={terminalShell}
            onChange={(v) => setTerminalShell(v === 'cmd' ? 'cmd' : 'auto')}
            options={TERMINAL_SHELL_OPTIONS}
            className="w-40 ui-text-sm2 text-foreground border border-border bg-muted/20 rounded-md px-3 py-1.5 focus:outline-none focus:border-primary/40 transition-colors"
            popupWidth={160}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow
          label="HTTP 代理"
          hint="模型、MCP、命令工具与应用渲染层的出口流量将经此代理；留空时直连，不读取系统环境变量。修改后需重启应用生效。"
        >
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <input
              type="text"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="例如 http://127.0.0.1:7890"
              className="w-64 ui-text-sm2 px-2 py-1 rounded-md border border-border bg-background text-foreground outline-none focus:border-primary"
            />
            <Button size="sm" variant="outline" onClick={applyProxy} disabled={proxyBusy}>
              {proxyBusy ? '保存中…' : '保存'}
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow
          label="数据存储路径"
          hint={`应用数据的根目录（默认为用户主目录）。修改后会把现有数据复制到新位置，重启 Helix 后生效。`}
        >
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <input
              type="text"
              value={dataRootPath}
              onChange={(e) => setDataRootPath(e.target.value)}
              placeholder={dataRootInfo.dataRootDefault || '未设置'}
              className="w-72 ui-text-sm2 px-2 py-1 rounded-md border border-border bg-background text-foreground outline-none focus:border-primary"
            />
            <Button size="sm" variant="outline" onClick={pickDataRoot}>选择文件夹</Button>
            <Button size="sm" variant="outline" onClick={applyDataRoot} disabled={dataRootBusy}>
              {dataRootBusy ? '复制中…' : '应用'}
            </Button>
            {dataRootInfo.dataRootCustom && (
              <Button size="sm" variant="ghost" onClick={resetDataRoot} disabled={dataRootBusy}>恢复默认</Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="配置管理" hint="导出当前配置为 JSON 文件备份，或从备份文件导入恢复；重置将清空全部设置。">
        <div className="flex flex-wrap gap-2 justify-end">
          <Button size="sm" variant="outline" onClick={async () => {
            try {
              const data = { apiConfig, apiProfiles, activeProfileId, providers, activeModel, activeProviderId, providerModels, fontFamily, fontSize, interfaceFont, transcriptFontSize, mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix }
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a'); a.href = url; a.download = `helix-config-${new Date().toISOString().slice(0, 10)}.json`; a.click()
              URL.revokeObjectURL(url)
              showToast({ type: 'success', title: '配置已导出' })
            } catch { showToast({ type: 'error', title: '导出失败' }) }
          }}>
            导出配置
          </Button>
          <Button size="sm" variant="outline" onClick={() => {
            const input = document.createElement('input')
            input.type = 'file'; input.accept = '.json'
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (!file) return
              try {
                const text = await file.text()
                const data = JSON.parse(text)
                if (!data || typeof data !== 'object') throw new Error('bad config file')
                const keys = [
                  'apiConfig', 'apiProfiles', 'activeProfileId', 'providers', 'activeModel',
                  'activeProviderId', 'providerModels',
                  'fontFamily', 'fontSize', 'interfaceFont', 'transcriptFontSize',
                  'mcpServers',
                  'gitAutoCommit', 'gitAutoPush', 'gitPushConfirm', 'gitAutoBranch',
                  'gitRemoteUrl', 'gitCommitTemplate', 'gitBranchPrefix',
                ]
                const patch: Record<string, unknown> = {}
                for (const k of keys) if (data[k] !== undefined) patch[k] = data[k]
                useHelixStore.setState(patch)
                await persistToStorage()
                showToast({ type: 'success', title: '配置已导入' })
              } catch { showToast({ type: 'error', title: '导入失败：文件格式无效' }) }
            }
            input.click()
          }}>
            导入配置
          </Button>
          <Button size="sm" variant="outline" onClick={() => {
            if (confirm('确定要重置所有设置吗？此操作不可撤销。')) {
              localStorage.clear(); window.location.reload()
            }
          }}>
            重置所有设置
          </Button>
          </div>
        </SettingRow>
      </SettingGroup>
    </div>
  )
}
