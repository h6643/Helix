'use client'

import React, { useState } from 'react'
import { Plug, Terminal, Link, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface McpFormData {
  name: string
  type: 'local' | 'remote'
  command: string
  url: string
  args: string
  env: Record<string, string>
  envPassthrough: boolean
  cwd: string
}

export function McpEditorForm({
  form, onChange, onSave, onCancel, fullScreen,
}: {
  form: McpFormData
  onChange: (patch: Partial<McpFormData>) => void
  onSave: () => void
  onCancel: () => void
  fullScreen?: boolean
}) {
  const envEntries = Object.entries(form.env)
  const [newEnvKey, setNewEnvKey] = useState('')
  const [newEnvValue, setNewEnvValue] = useState('')

  const addEnvVar = () => {
    if (!newEnvKey.trim()) return
    onChange({ env: { ...form.env, [newEnvKey.trim()]: newEnvValue } })
    setNewEnvKey(''); setNewEnvValue('')
  }
  const removeEnvVar = (key: string) => {
    const { [key]: _, ...rest } = form.env
    onChange({ env: rest })
  }

  return (
    <div className={`rounded-2xl border border-border/60 bg-card overflow-hidden flex flex-col ${fullScreen ? 'flex-1' : ''}`}>
      <div className={`p-4 space-y-4 ${fullScreen ? 'flex-1 overflow-y-auto' : ''}`}>
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">名称</label>
          <input type="text" value={form.name} onChange={e => onChange({ name: e.target.value })}
            placeholder="MCP server name"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
        </div>

        {/* Type */}
        <div>
          <div className="flex gap-2">
            {([['local', 'STDIO', Terminal], ['remote', '流式 HTTP', Link]] as const).map(([t, label, Icon]) => (
              <button key={t} onClick={() => onChange({ type: t, command: '', url: '' })}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors ${form.type === t ? 'border-primary bg-primary/10 text-primary' : 'border-border/50 text-muted-foreground hover:bg-accent/50'}`}>
                <Icon className="size-4" />{label}
              </button>
            ))}
          </div>
        </div>

        {/* Command / URL */}
        {form.type === 'local' ? (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">启动命令</label>
            <input type="text" value={form.command} onChange={e => onChange({ command: e.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ./data"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">URL</label>
            <input type="text" value={form.url} onChange={e => onChange({ url: e.target.value })}
              placeholder="http://localhost:3001/sse"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
        )}

        {/* Args */}
        {form.type === 'local' && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">参数</label>
            <input type="text" value={form.args} onChange={e => onChange({ args: e.target.value })}
              placeholder="--port 3000 --verbose"
              className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
          </div>
        )}

        {/* Environment variables */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">环境变量</label>
          {envEntries.length > 0 && (
            <div className="space-y-1 mb-2">
              {envEntries.map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-foreground/60 bg-muted px-2 py-1 rounded flex-shrink-0">{key}</span>
                  <span className="text-xs text-foreground/30">=</span>
                  <span className="text-xs font-mono text-foreground/40 truncate flex-1">{val}</span>
                  <button onClick={() => removeEnvVar(key)} className="text-xs text-red-500 hover:text-red-600 shrink-0">删除</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input type="text" value={newEnvKey} onChange={e => setNewEnvKey(e.target.value)} placeholder="键"
              className="flex-1 px-2 py-1.5 bg-muted/50 border border-border/50 rounded text-xs font-mono" />
            <input type="text" value={newEnvValue} onChange={e => setNewEnvValue(e.target.value)} placeholder="值"
              className="flex-1 px-2 py-1.5 bg-muted/50 border border-border/50 rounded text-xs font-mono" />
            <button onClick={addEnvVar} className="px-2 py-1.5 bg-muted/50 border border-border/50 rounded text-xs hover:bg-accent/50 transition-colors">添加</button>
          </div>
          <label className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={form.envPassthrough} onChange={e => onChange({ envPassthrough: e.target.checked })}
              className="rounded border-border/50" />
            环境变量传递
          </label>
        </div>

        {/* Working directory */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">工作目录</label>
          <input type="text" value={form.cwd} onChange={e => onChange({ cwd: e.target.value })}
            placeholder="~/Helix"
            className="w-full px-3 py-2 bg-muted/50 border border-border/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring font-mono" />
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border/50 bg-muted/10 flex justify-end gap-2 shrink-0">
        <Button onClick={onSave} size="sm" className="gap-1.5"><Save className="size-3.5" /> 保存</Button>
      </div>
    </div>
  )
}
