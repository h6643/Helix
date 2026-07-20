'use client'

import React, { useState, useRef, useEffect } from 'react'
import {
  Settings, Sun, Moon, Archive, Globe, FileText, Plug, Activity,
  RefreshCw, Zap, AlertTriangle, Eye, Sparkles, Target, Wand2,
  AlignLeft, Minimize2, ChevronLeft, ChevronRight, ChevronDown, Folder, X, Search,
  GitBranch, Keyboard, Keyboard as KeyboardIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHelixStore } from '@/stores/helix-store'

// ─── settings search index ──────────────────────────────────────────────
const SEARCH_INDEX: { page: string; label: string; desc: string }[] = [
  { page: 'general', label: '输出风格', desc: '简洁 / 详细 / 标准' },
  { page: 'general', label: '自动压缩上下文', desc: '对话上下文管理' },
  { page: 'general', label: '桌面通知', desc: '完成任务时通知' },
  { page: 'general', label: '提示音', desc: '完成时播放提示音' },
  { page: 'general', label: '恢复上次会话', desc: '启动时恢复' },
  { page: 'general', label: '默认工作目录', desc: '默认工作路径' },
  { page: 'general', label: '危险操作确认', desc: '执行前确认' },
  { page: 'general', label: '自动批准读取', desc: '无需逐次确认' },
  { page: 'general', label: 'Agent 预设', desc: '行为模式' },
  { page: 'general', label: '自定义指令', desc: '系统提示词' },
  { page: 'general', label: '数据管理', desc: '导入/导出配置' },
  { page: 'appearance', label: '主题', desc: '深色 / 浅色' },
  { page: 'appearance', label: '编辑器设置', desc: '代码字体字号' },
  { page: 'appearance', label: '界面设置', desc: 'UI 字体字号' },
  { page: 'appearance', label: '界面字体', desc: '菜单字体' },
  { page: 'api', label: '模型配置', desc: 'API 端点' },
  { page: 'api', label: '添加模型', desc: '新端点' },
  { page: 'mcp', label: 'MCP', desc: '服务器连接' },
  { page: 'usage', label: 'Token 用量', desc: '统计' },
  { page: 'archive', label: '历史归档', desc: '会话管理' },
  { page: 'shortcuts', label: '快捷键', desc: '自定义' },
  { page: 'git', label: 'Git', desc: '自动提交推送' },
  { page: 'hook', label: 'Hooks', desc: '事件钩子' },
]

// ─── shared components ──────────────────────────────────────────────────
const Toggle2 = ({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) => (
  <button
    onClick={onToggle}
    className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
      enabled ? 'bg-primary' : 'bg-muted-foreground/20'
    }`}
  >
    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
      enabled ? 'translate-x-4' : ''
    }`} />
  </button>
)

const Row = ({ icon, label, description, children }: { icon: React.ReactNode; label: string; description: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between py-2.5 gap-4">
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground/50 mt-0.5">{description}</p>
      </div>
    </div>
    <div className="shrink-0">{children}</div>
  </div>
)

const Group = ({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) => (
  <div className="pt-5 first:pt-0">
    <div className="flex items-center gap-2 mb-1 px-0.5">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <h4 className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{title}</h4>
    </div>
    <div className="divide-y divide-border/10">{children}</div>
  </div>
)

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-semibold text-foreground tracking-tight mb-5">{children}</h3>
}

// ─── exported component ─────────────────────────────────────────────────
export function SettingsContentNew({
  page,
  theme,
  onToggleTheme,
  setPage,
  pushNavigation,
  sidebarCollapsed,
  setSidebarCollapsed,
  navWidth,
  showSidebar,
  setShowSidebar,
  toggleSettings,
}: {
  page: string
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  setPage: (p: string) => void
  pushNavigation: (entry: any) => void
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void
  navWidth: number
  showSidebar: boolean
  setShowSidebar: (v: boolean | ((prev: boolean) => boolean)) => void
  toggleSettings: () => void
}) {
  const s = useHelixStore.getState
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (sidebarCollapsed) return
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [sidebarCollapsed])

  const renderSidebar = () => {
    const groups: { title: string; items: { id: string; label: string; icon: any }[] }[] = [
      { title: '个人', items: [
        { id: 'general', label: '常规', icon: Settings },
        { id: 'appearance', label: '外观', icon: Sun },
        { id: 'archive', label: '归档', icon: Archive },
        { id: 'shortcuts', label: '快捷键', icon: KeyboardIcon },
      ]},
      { title: '配置', items: [
        { id: 'api', label: '模型', icon: Globe },
        { id: 'mcp', label: 'MCP', icon: Plug },
        { id: 'usage', label: '用量', icon: Activity },
      ]},
      { title: '集成', items: [
        { id: 'git', label: 'Git', icon: GitBranch },
        { id: 'hook', label: 'Hook', icon: Zap },
      ]},
    ]
    const q = search.trim().toLowerCase()
    if (q) {
      const r = SEARCH_INDEX.filter(x => x.label.includes(q) || x.desc.includes(q) || x.page.includes(q))
      if (!r.length) return <div className="px-5 py-8 text-center text-[13px] text-muted-foreground/40">未找到匹配项</div>
      const grouped: Record<string, typeof r> = {}
      for (const x of r) { if (!grouped[x.page]) grouped[x.page] = []; grouped[x.page].push(x) }
      const label = (id: string) => groups.flatMap(g => g.items).find(i => i.id === id)?.label || id
      return Object.entries(grouped).map(([pg, items]) => (
        <div key={pg} className="mb-1">
          <p className="px-5 pt-3 pb-1.5 text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-[0.12em]">{label(pg)}</p>
          {items.map((x, i) => (
            <button key={pg + i} onClick={() => { setPage(x.page); pushNavigation({ type: 'settings', page: x.page }); setSearch('') }}
              className="w-full text-left pl-[26px] pr-4 py-2 text-[13px] rounded-lg transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted/40">
              <span className="font-medium">{x.label}</span>
              <span className="text-[11px] text-muted-foreground/40 ml-1.5">{x.desc}</span>
            </button>
          ))}
        </div>
      ))
    }
    return groups.map(g => (
      <div key={g.title} className="mb-3">
        <p className="px-5 pt-4 pb-1.5 text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-[0.12em]">{g.title}</p>
        {g.items.map(item => (
          <button key={item.id} onClick={() => { setPage(item.id); pushNavigation({ type: 'settings', page: item.id }) }}
            className={`w-full flex items-center gap-2.5 pl-[26px] pr-4 py-2 text-[13px] rounded-lg transition-all duration-200 ${
              page === item.id ? 'bg-muted/60 text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
            }`}>
            <item.icon className="size-4" />{item.label}
          </button>
        ))}
      </div>
    ))
  }

  const renderContent = () => {
    // shared state reads — many selectors, but this component covers many pages
    const {
      outputStyle, setOutputStyle,
      autoCompactContext, setAutoCompactContext,
      desktopNotifications, setDesktopNotifications,
      soundEnabled, setSoundEnabled,
      restoreLastSession, setRestoreLastSession,
      defaultWorkDir, setDefaultWorkDir,
      confirmDangerousActions, setConfirmDangerousActions,
      autoApproveRead, setAutoApproveRead,
      fontFamily, setFontFamily, fontSize, setFontSize,
      interfaceFont, setInterfaceFont, transcriptFontSize, setTranscriptFontSize,
      customInstructions, setCustomInstructions,
      showToast, persistToStorage,
      apiConfig, apiProfiles, activeProfileId, providers, activeModel,
      mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix,
    } = useHelixStore()

    switch (page) {
      case 'general':
        return (
          <div className="max-w-xl space-y-1">
            <SectionTitle>常规</SectionTitle>
            <Group title="输出风格" icon={<AlignLeft className="size-3.5" />}>
              <div className="py-3 space-y-2">
                <p className="text-xs text-muted-foreground/50">控制 Agent 回复的详细程度和风格</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: 'default', label: '默认', desc: '平衡详细度和简洁性' },
                    { value: 'concise', label: '简洁', desc: '精简回复，直奔主题' },
                    { value: 'detailed', label: '详细', desc: '包含更多解释和背景' },
                    { value: 'technical', label: '技术性', desc: '侧重技术细节和实现' },
                  ].map(o => (
                    <button key={o.value} onClick={() => setOutputStyle(o.value as any)}
                      className={`px-3 py-2.5 rounded-lg border text-left transition-all duration-150 ${
                        outputStyle === o.value ? 'border-primary/40 bg-primary/5 text-foreground' : 'border-transparent bg-muted/20 hover:bg-muted/30 text-foreground/60'
                      }`}>
                      <p className="text-sm font-medium">{o.label}</p>
                      <p className="text-[11px] text-muted-foreground/50 mt-0.5">{o.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
            </Group>
            <Group title="上下文" icon={<Minimize2 className="size-3.5" />}>
              <Row icon={<Minimize2 className="size-4" />} label="自动压缩上下文" description="对话接近上下文限制时自动压缩历史消息">
                <Toggle2 enabled={autoCompactContext} onToggle={() => setAutoCompactContext(!autoCompactContext)} />
              </Row>
            </Group>
            <Group title="通知" icon={<Zap className="size-3.5" />}>
              <Row icon={<Zap className="size-4" />} label="桌面通知" description="Agent 完成任务时显示桌面通知">
                <Toggle2 enabled={desktopNotifications} onToggle={() => setDesktopNotifications(!desktopNotifications)} />
              </Row>
              <Row icon={<Zap className="size-4" />} label="提示音" description="Agent 完成任务时播放提示音">
                <Toggle2 enabled={soundEnabled} onToggle={() => setSoundEnabled(!soundEnabled)} />
              </Row>
            </Group>
            <Group title="启动" icon={<RefreshCw className="size-3.5" />}>
              <Row icon={<RefreshCw className="size-4" />} label="恢复上次会话" description="启动时自动恢复上次的对话">
                <Toggle2 enabled={restoreLastSession} onToggle={() => setRestoreLastSession(!restoreLastSession)} />
              </Row>
              <div className="flex items-center justify-between py-2.5 gap-4">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <span className="text-muted-foreground"><Folder className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">默认工作目录</p>
                    <input type="text" value={defaultWorkDir} onChange={e => setDefaultWorkDir(e.target.value)}
                      placeholder="留空使用上次的工作目录" className="mt-1 w-full px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm font-mono text-foreground/70 placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/30 transition-colors" />
                  </div>
                </div>
              </div>
            </Group>
            <Group title="安全" icon={<AlertTriangle className="size-3.5" />}>
              <Row icon={<AlertTriangle className="size-4" />} label="危险操作确认" description="执行删除、覆盖等危险操作前弹出确认对话框">
                <Toggle2 enabled={confirmDangerousActions} onToggle={() => setConfirmDangerousActions(!confirmDangerousActions)} />
              </Row>
              <Row icon={<Eye className="size-4" />} label="自动批准读取" description="自动批准文件读取操作，无需逐次确认">
                <Toggle2 enabled={autoApproveRead} onToggle={() => setAutoApproveRead(!autoApproveRead)} />
              </Row>
            </Group>
            <Group title="预设" icon={<Sparkles className="size-3.5" />}>
              <Row icon={<Target className="size-4" />} label="当前预设" description="选择不同的 Agent 行为模式">
                <select value={useHelixStore.getState().activePreset || ''}
                  onChange={e => useHelixStore.getState().setActivePreset(e.target.value || null)}
                  className="px-3 py-1.5 rounded-md border border-border/20 bg-muted/20 text-sm focus:outline-none focus:border-primary/30 cursor-pointer">
                  <option value="">默认</option><option value="coder">编程助手</option><option value="reviewer">代码审查员</option>
                  <option value="writer">文档撰写</option><option value="analyst">分析师</option>
                </select>
              </Row>
              <Row icon={<Wand2 className="size-4" />} label="自定义指令" description="附加到每个对话的系统提示词">
                <input type="text" value={useHelixStore.getState().customInstructions}
                  onChange={e => useHelixStore.getState().setCustomInstructions(e.target.value)}
                  placeholder="始终用中文回复，代码使用 TypeScript"
                  className="w-52 px-3 py-1.5 bg-muted/20 border border-border/20 rounded-md text-sm focus:outline-none focus:border-primary/30 transition-colors" />
              </Row>
            </Group>
            <Group title="数据" icon={<Archive className="size-3.5" />}>
              <div className="py-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={async () => { try { const d = { apiConfig, apiProfiles, activeProfileId, providers, activeModel, fontFamily, fontSize, interfaceFont, transcriptFontSize, customInstructions, mcpServers, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix }; const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `helix-config-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(u) } catch { showToast({ type: 'error', title: '导出失败' }) } }}>导出配置</Button>
                <Button size="sm" variant="outline" onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; try { const t = await f.text(); const d = JSON.parse(t); if (d.apiConfig) setOutputStyle; await persistToStorage() } catch { showToast({ type: 'error', title: '导入失败' }) } }; i.click() }}>导入配置</Button>
                <Button size="sm" variant="destructive" onClick={() => { if (confirm('重置所有设置？不可撤销')) { localStorage.clear(); location.reload() } }}>重置</Button>
              </div>
            </Group>
          </div>
        )
      case 'appearance':
        return (
          <div className="max-w-xl space-y-1">
            <SectionTitle>外观</SectionTitle>
            <Group title="主题" icon={theme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}>
              <Row icon={theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />} label="主题" description={theme === 'dark' ? '深色模式' : '浅色模式'}>
                <Toggle2 enabled={theme === 'dark'} onToggle={onToggleTheme} />
              </Row>
            </Group>
            <Group title="编辑器" icon={<FileText className="size-3.5" />}>
              <div className="py-2.5 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-foreground">代码字体</span>
                  <div className="flex gap-2">
                    <select value={fontFamily} onChange={e => setFontFamily(e.target.value)} className="w-40 px-2.5 py-1 rounded border border-border/20 bg-muted/20 text-xs focus:outline-none focus:border-primary/30 cursor-pointer">
                      {[{l:'默认',v:"'Geist Mono','Fira Code',Consolas,monospace"},{l:'Monaco',v:'Monaco,monospace'},{l:'JetBrains',v:'"JetBrains Mono",monospace'},{l:'Fira Code',v:'"Fira Code",monospace'},{l:'Consolas',v:'Consolas,monospace'},{l:'SF Mono',v:'"SF Mono",monospace'}].map(f=>(<option key={f.v} value={f.v}>{f.l}</option>))}
                    </select>
                    <input type="text" value={fontFamily} onChange={e => setFontFamily(e.target.value)} placeholder="自定义" className="w-24 px-2.5 py-1 bg-muted/20 border border-border/20 rounded text-xs font-mono focus:outline-none focus:border-primary/30" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-foreground">字号</span>
                  <div className="flex items-center gap-1.5"><button onClick={()=>setFontSize(Math.max(10,fontSize-1))} className="w-6 h-6 rounded border border-border/20 bg-muted/20 text-muted-foreground/50 hover:text-foreground text-xs flex items-center justify-center">−</button><span className="w-7 text-center text-xs font-mono">{fontSize}</span><button onClick={()=>setFontSize(Math.min(32,fontSize+1))} className="w-6 h-6 rounded border border-border/20 bg-muted/20 text-muted-foreground/50 hover:text-foreground text-xs flex items-center justify-center">+</button></div>
                </div>
              </div>
            </Group>
            <Group title="界面字体" icon={<Settings className="size-3.5" />}>
              <div className="py-2.5 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-foreground">UI 字体</span>
                  <div className="flex gap-2">
                    <select value={interfaceFont} onChange={e => setInterfaceFont(e.target.value)} className="w-40 px-2.5 py-1 rounded border border-border/20 bg-muted/20 text-xs focus:outline-none focus:border-primary/30 cursor-pointer">
                      {[{l:'默认',v:'var(--font-geist-sans)'},{l:'Inter',v:'"Inter",sans-serif'},{l:'SF Pro',v:'"-apple-system","SF Pro",sans-serif'},{l:'Segoe UI',v:'"Segoe UI",sans-serif'},{l:'JetBrains',v:'"JetBrains Mono",monospace'}].map(f=>(<option key={f.v} value={f.v}>{f.l}</option>))}
                    </select>
                    <input type="text" value={interfaceFont} onChange={e => setInterfaceFont(e.target.value)} placeholder="自定义" className="w-24 px-2.5 py-1 bg-muted/20 border border-border/20 rounded text-xs font-mono focus:outline-none focus:border-primary/30" />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm text-foreground">字号</span>
                  <div className="flex items-center gap-1.5"><button onClick={()=>setTranscriptFontSize(Math.max(10,transcriptFontSize-1))} className="w-6 h-6 rounded border border-border/20 bg-muted/20 text-muted-foreground/50 hover:text-foreground text-xs flex items-center justify-center">−</button><span className="w-7 text-center text-xs font-mono">{transcriptFontSize}</span><button onClick={()=>setTranscriptFontSize(Math.min(28,transcriptFontSize+1))} className="w-6 h-6 rounded border border-border/20 bg-muted/20 text-muted-foreground/50 hover:text-foreground text-xs flex items-center justify-center">+</button></div>
                </div>
              </div>
            </Group>
          </div>
        )
      case 'shortcuts':
        return <div className="max-w-xl"><SectionTitle>快捷键</SectionTitle><p className="text-sm text-muted-foreground/50">在右侧快捷键面板中查看和自定义快捷键</p></div>
      case 'archive':
        return <div className="max-w-xl"><SectionTitle>历史归档</SectionTitle><p className="text-sm text-muted-foreground/50">管理已归档的会话记录</p></div>
      case 'git':
        return (
          <div className="max-w-xl space-y-1">
            <SectionTitle>Git</SectionTitle>
            <Group title="自动提交" icon={<GitBranch className="size-3.5" />}>
              <Row icon={<GitBranch className="size-4" />} label="Agent 完成后自动 commit" description="自动将变更提交到当前分支">
                <Toggle2 enabled={useHelixStore.getState().gitAutoCommit} onToggle={() => useHelixStore.getState().setGitAutoCommit(!useHelixStore.getState().gitAutoCommit)} />
              </Row>
            </Group>
          </div>
        )
      case 'hook':
        return <div className="max-w-xl"><SectionTitle>Hooks</SectionTitle><p className="text-sm text-muted-foreground/50">配置事件钩子</p></div>
      default:
        return <div className="max-w-xl"><SectionTitle>{page}</SectionTitle></div>
    }
  }

  return (
    <div className="fixed top-10 left-0 right-0 bottom-0 z-50 flex bg-background">
      {showSidebar && (
        <div
          className={`relative bg-sidebar flex flex-col shrink-0 border-r border-border/40 h-full overflow-hidden transition-[width] duration-200 ease-out`}
          style={{ width: sidebarCollapsed ? 48 : navWidth }}
        >
          {sidebarCollapsed ? (
            <div className="flex-1 flex flex-col items-center pt-2 gap-1 overflow-y-auto">
              <button onClick={toggleSettings} title="返回" className="p-2.5 rounded-lg text-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors">
                <ChevronLeft className="size-[18px]" />
              </button>
              <button onClick={() => { setSidebarCollapsed(false); setTimeout(() => searchRef.current?.focus(), 150) }}
                title="搜索 (⌘K)" className="p-2 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors">
                <Search className="size-[18px]" />
              </button>
            </div>
          ) : (
            <>
              <div className="px-3 py-3 border-b border-border/20">
                <button onClick={toggleSettings} className="flex items-center gap-2.5 w-full px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-lg transition-all duration-200 mb-0.5">
                  <ChevronLeft className="size-4" />返回
                </button>
                <div className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg bg-transparent border border-transparent transition-all duration-200 focus-within:bg-muted/25 focus-within:border-primary/20 hover:bg-muted/15">
                  <Search className="size-3.5 text-muted-foreground/25 shrink-0" />
                  <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); (e.target as HTMLInputElement).blur() } }}
                    placeholder="搜索设置..." className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none min-w-0" />
                  {search && <button onClick={() => setSearch('')} className="text-muted-foreground/20 hover:text-foreground/60 shrink-0"><X className="size-3" /></button>}
                </div>
              </div>
              <nav className="flex-1 overflow-y-auto py-2">{renderSidebar()}</nav>
            </>
          )}
        </div>
      )}
      <div className="flex-1 bg-background overflow-y-auto scroll-smooth">
        <div className="px-10 pt-8 pb-16">{renderContent()}</div>
      </div>
    </div>
  )
}
