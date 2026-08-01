'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { Toggle, SettingRow, SettingGroup, SectionHeading } from './settings-ui'

export function GeneralSettingsPanel() {
  const desktopNotifications = useHelixStore(s => s.desktopNotifications)
  const setDesktopNotifications = useHelixStore(s => s.setDesktopNotifications)
  const soundEnabled = useHelixStore(s => s.soundEnabled)
  const setSoundEnabled = useHelixStore(s => s.setSoundEnabled)
  const restoreLastSession = useHelixStore(s => s.restoreLastSession)
  const setRestoreLastSession = useHelixStore(s => s.setRestoreLastSession)
  const defaultWorkDir = useHelixStore(s => s.defaultWorkDir)
  const setDefaultWorkDir = useHelixStore(s => s.setDefaultWorkDir)
  const confirmDangerousActions = useHelixStore(s => s.confirmDangerousActions)
  const setConfirmDangerousActions = useHelixStore(s => s.setConfirmDangerousActions)
  const autoApproveRead = useHelixStore(s => s.autoApproveRead)
  const setAutoApproveRead = useHelixStore(s => s.setAutoApproveRead)

  const {
    apiConfig, apiProfiles, activeProfileId, providers, activeModel,
    fontFamily, fontSize, interfaceFont, transcriptFontSize,
    mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm,
    gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix,
    persistToStorage, showToast,
  } = useHelixStore()

  return (
    <div className="max-w-xl space-y-1">
      <SectionHeading>常规</SectionHeading>

      <SettingGroup title="通知">
        <SettingRow label="桌面通知">
          <Toggle enabled={desktopNotifications} onToggle={() => setDesktopNotifications(!desktopNotifications)} />
        </SettingRow>
        <SettingRow label="提示音">
          <Toggle enabled={soundEnabled} onToggle={() => setSoundEnabled(!soundEnabled)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="启动">
        <SettingRow label="恢复上次会话">
          <Toggle enabled={restoreLastSession} onToggle={() => setRestoreLastSession(!restoreLastSession)} />
        </SettingRow>
        <SettingRow label="默认工作目录">
          <input
            type="text"
            value={defaultWorkDir}
            onChange={e => setDefaultWorkDir(e.target.value)}
            placeholder="留空使用上次的工作目录"
            className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm font-mono text-foreground/70 placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 transition-colors"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="安全">
        <SettingRow label="危险操作确认">
          <Toggle enabled={confirmDangerousActions} onToggle={() => setConfirmDangerousActions(!confirmDangerousActions)} />
        </SettingRow>
        <SettingRow label="自动批准读取">
          <Toggle enabled={autoApproveRead} onToggle={() => setAutoApproveRead(!autoApproveRead)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="数据管理">
        <div className="py-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={async () => {
            try {
              const data = { apiConfig, apiProfiles, activeProfileId, providers, activeModel, fontFamily, fontSize, interfaceFont, transcriptFontSize, mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix }
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
                // Mirror every key the export writes (api-settings 导出配置), so
                // import restores the whole configuration — not just apiConfig.
                const keys = [
                  'apiConfig', 'apiProfiles', 'activeProfileId', 'providers', 'activeModel',
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
          <Button size="sm" variant="destructive" onClick={() => {
            if (confirm('确定要重置所有设置吗？此操作不可撤销。')) {
              localStorage.clear(); window.location.reload()
            }
          }}>
            重置所有设置
          </Button>
        </div>
      </SettingGroup>
    </div>
  )
}
