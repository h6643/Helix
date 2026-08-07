'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { Toggle, SettingRow, SettingGroup, SectionHeading } from './settings-ui'
import { ExternalServiceManager } from './external-services-manager'
import { WebSearchSettings } from './web-search-settings'

export function GeneralSettingsPanel() {
  const desktopNotifications = useHelixStore(s => s.desktopNotifications)
  const setDesktopNotifications = useHelixStore(s => s.setDesktopNotifications)
  const soundEnabled = useHelixStore(s => s.soundEnabled)
  const setSoundEnabled = useHelixStore(s => s.setSoundEnabled)

  const {
    apiConfig, apiProfiles, activeProfileId, providers, activeModel,
    fontFamily, fontSize, interfaceFont, transcriptFontSize,
    mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm,
    gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix,
    persistToStorage, showToast,
  } = useHelixStore()

  return (
    <div className="space-y-1">
      <SectionHeading>常规</SectionHeading>

      <SettingGroup title="通知">
        <SettingRow label="桌面通知">
          <Toggle enabled={desktopNotifications} onToggle={() => setDesktopNotifications(!desktopNotifications)} />
        </SettingRow>
        <SettingRow label="提示音">
          <Toggle enabled={soundEnabled} onToggle={() => setSoundEnabled(!soundEnabled)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="外部服务（服务器 / 虚拟机）">
        <div className="pb-1">
          <ExternalServiceManager />
        </div>
      </SettingGroup>

      <WebSearchSettings />

      <SettingGroup title="数据管理">
        <div className="py-3 flex flex-wrap gap-2 justify-end">
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
          <Button size="sm" variant="outline" onClick={() => {
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
