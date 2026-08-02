'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'
import { Toggle, SettingRow, SettingGroup, SectionHeading } from './settings-ui'

const textInput = (value: string, onChange: (v: string) => void, placeholder: string) => (
  <input
    type="text"
    value={value}
    onChange={e => onChange(e.target.value)}
    placeholder={placeholder}
    className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm font-mono text-foreground/70 placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 transition-colors"
  />
)

export function GitSettingsPanel() {
  const {
    gitAutoCommit, setGitAutoCommit,
    gitAutoPush, setGitAutoPush,
    gitPushConfirm, setGitPushConfirm,
    gitAutoBranch, setGitAutoBranch,
    gitRemoteUrl, setGitRemoteUrl,
    gitCommitTemplate, setGitCommitTemplate,
    gitBranchPrefix, setGitBranchPrefix,
    persistToStorage, showToast,
  } = useHelixStore()

  const [gitSaving, setGitSaving] = useState(false)

  const handleSaveGit = async () => {
    setGitSaving(true)
    try {
      await persistToStorage()
      showToast({ type: 'success', title: 'Git 设置已保存' })
    } finally {
      setGitSaving(false)
    }
  }

  return (
    <div className="max-w-xl space-y-1">
      <SectionHeading>Git</SectionHeading>

      <SettingGroup title="自动提交">
        <SettingRow label="Agent 完成后自动 commit">
          <Toggle enabled={gitAutoCommit} onToggle={() => setGitAutoCommit(!gitAutoCommit)} />
        </SettingRow>
        {gitAutoCommit && (
          <SettingRow label="提交信息模板">
            {textInput(gitCommitTemplate, setGitCommitTemplate, '如: chore: auto-commit changes')}
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup title="自动推送">
        <SettingRow label="Commit 后自动 push">
          <Toggle enabled={gitAutoPush} onToggle={() => setGitAutoPush(!gitAutoPush)} />
        </SettingRow>
        {gitAutoPush && (
          <>
            <SettingRow label="远程仓库 URL">
              {textInput(gitRemoteUrl, setGitRemoteUrl, 'https://github.com/user/repo.git')}
            </SettingRow>
            <SettingRow label="Push 前确认">
              <Toggle enabled={gitPushConfirm} onToggle={() => setGitPushConfirm(!gitPushConfirm)} />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      <SettingGroup title="分支管理">
        <SettingRow label="自动创建特性分支">
          <Toggle enabled={gitAutoBranch} onToggle={() => setGitAutoBranch(!gitAutoBranch)} />
        </SettingRow>
        {gitAutoBranch && (
          <SettingRow label="分支命名前缀">
            {textInput(gitBranchPrefix, setGitBranchPrefix, 'feature/')}
          </SettingRow>
        )}
      </SettingGroup>

      <div className="flex justify-end pt-4">
        <Button onClick={handleSaveGit} size="sm" variant="outline" className="gap-1.5" disabled={gitSaving}>
          {gitSaving ? '保存中…' : '保存设置'}
        </Button>
      </div>
    </div>
  )
}
