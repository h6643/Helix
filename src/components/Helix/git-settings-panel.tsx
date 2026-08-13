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
    className="w-56 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md ui-text font-mono text-foreground/70 text-center placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 transition-colors"
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
    <div className="space-y-4">
      <SectionHeading>Git</SectionHeading>

      <SettingGroup>
        <div className="py-3">
          <SettingRow label="Agent 完成后自动 commit" hint="Agent 完成一轮操作后自动把变更提交到当前分支。">
            <Toggle enabled={gitAutoCommit} onToggle={() => setGitAutoCommit(!gitAutoCommit)} />
          </SettingRow>
          {gitAutoCommit && (
            <SettingRow label="提交信息模板" hint="自动提交时使用的提交信息模板，可包含 AI 生成的摘要。">
              {textInput(gitCommitTemplate, setGitCommitTemplate, '如: chore: auto-commit changes')}
            </SettingRow>
          )}
        </div>

        <div className="py-3">
          <SettingRow label="Commit 后自动 push" hint="提交完成后自动推送到远程仓库。">
            <Toggle enabled={gitAutoPush} onToggle={() => setGitAutoPush(!gitAutoPush)} />
          </SettingRow>
          {gitAutoPush && (
            <>
              <SettingRow label="远程仓库 URL" hint="推送目标仓库地址；留空使用当前分支配置的 remote。">
                {textInput(gitRemoteUrl, setGitRemoteUrl, 'https://github.com/user/repo.git')}
              </SettingRow>
              <SettingRow label="Push 前确认" hint="推送前先征求你的确认，避免误推。">
                <Toggle enabled={gitPushConfirm} onToggle={() => setGitPushConfirm(!gitPushConfirm)} />
              </SettingRow>
            </>
          )}
        </div>

        <div className="py-3">
          <SettingRow label="自动创建特性分支" hint="在 feature 分支上工作时，自动为每次改动创建新分支。">
            <Toggle enabled={gitAutoBranch} onToggle={() => setGitAutoBranch(!gitAutoBranch)} />
          </SettingRow>
          {gitAutoBranch && (
            <SettingRow label="分支命名前缀" hint="新建分支的前缀，如 feature/ 或 fix/。">
              {textInput(gitBranchPrefix, setGitBranchPrefix, 'feature/')}
            </SettingRow>
          )}
        </div>
      </SettingGroup>

      <div className="flex justify-end pt-4">
        <Button onClick={handleSaveGit} size="sm" variant="outline" className="gap-1.5" disabled={gitSaving}>
          {gitSaving ? '保存中…' : '保存设置'}
        </Button>
      </div>
    </div>
  )
}
