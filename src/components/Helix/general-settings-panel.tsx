'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { Toggle, SettingRow, SettingGroup, SectionHeading } from './settings-ui'

export function GeneralSettingsPanel() {
  const desktopNotifications = useHelixStore(s => s.desktopNotifications)
  const setDesktopNotifications = useHelixStore(s => s.setDesktopNotifications)
  const voiceWakeEnabled = useHelixStore(s => s.voiceWakeEnabled)
  const setVoiceWakeEnabled = useHelixStore(s => s.setVoiceWakeEnabled)
  const wakeWordPhrase = useHelixStore(s => s.wakeWordPhrase)
  const setWakeWordPhrase = useHelixStore(s => s.setWakeWordPhrase)
  const startupGreeting = useHelixStore(s => s.startupGreeting)
  const setStartupGreeting = useHelixStore(s => s.setStartupGreeting)
  const showToast = useHelixStore(s => s.showToast)

  const {
    apiConfig, apiProfiles, activeProfileId, providers, activeModel,
    activeProviderId, providerModels,
    fontFamily, fontSize, interfaceFont, transcriptFontSize,
    mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm,
    gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix,
    persistToStorage,
  } = useHelixStore()

  return (
    <div className="space-y-1">
      <SectionHeading>常规</SectionHeading>

      <SettingGroup title="通知">
        <SettingRow label="桌面通知">
          <Toggle enabled={desktopNotifications} onToggle={() => setDesktopNotifications(!desktopNotifications)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="语音">
        <SettingRow label="语音唤醒" hint={voiceWakeEnabled ? `说 "${wakeWordPhrase}" 唤醒` : '开启后说唤醒词可唤醒'}>
          <Toggle enabled={voiceWakeEnabled} onToggle={() => setVoiceWakeEnabled(!voiceWakeEnabled)} />
        </SettingRow>
        {voiceWakeEnabled && (
          <SettingRow label="唤醒词">
            <input
              value={wakeWordPhrase}
              onChange={(e) => setWakeWordPhrase(e.target.value)}
              onBlur={() => { if (!wakeWordPhrase.trim()) setWakeWordPhrase('hey hermes') }}
              placeholder="hey hermes"
              className="w-56 px-2.5 py-1.5 rounded-lg bg-muted/50 text-sm text-foreground border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup title="个性化">
        <SettingRow label="启动语">
          <input
            value={startupGreeting}
            onChange={(e) => setStartupGreeting(e.target.value)}
            onBlur={() => { if (!startupGreeting.trim()) setStartupGreeting('有什么可以帮你的？') }}
            placeholder="有什么可以帮你的？"
            className="w-56 px-2.5 py-1.5 rounded-lg bg-muted/50 text-sm text-foreground border border-border focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="数据管理">
        <div className="py-3 flex flex-wrap gap-2 justify-end">
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
      </SettingGroup>
    </div>
  )
}
