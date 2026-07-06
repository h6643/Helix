'use client'

import React, { useState } from 'react'
import { X, Trash2, FileText, Code2, GitBranch } from 'lucide-react'
import { useHelixStore, type Artifact } from '@/stores/helix-store'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ArtifactPanelProps {
  onClose: () => void
}

function ArtifactViewer({ artifact }: { artifact: Artifact }) {
  if (artifact.type === 'html') {
    return (
      <iframe
        srcDoc={artifact.content}
        className="w-full h-full border-0 bg-white"
        title={artifact.title}
        sandbox="allow-scripts"
      />
    )
  }
  if (artifact.type === 'mermaid') {
    return (
      <div className="w-full h-full flex items-center justify-center p-4 bg-white">
        <pre className="text-xs font-mono text-gray-800 whitespace-pre-wrap">{artifact.content}</pre>
      </div>
    )
  }
  return (
    <div className="w-full h-full p-4 overflow-auto prose prose-sm dark:prose-invert max-w-none">
      <pre className="whitespace-pre-wrap text-sm">{artifact.content}</pre>
    </div>
  )
}

export function ArtifactPanel({ onClose }: ArtifactPanelProps) {
  const { artifacts, removeArtifact } = useHelixStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = artifacts.find(a => a.id === selectedId) || artifacts[0] || null

  const typeIcon = (type: string) => {
    switch (type) {
      case 'html': return <Code2 className="size-3.5" />
      case 'mermaid': return <GitBranch className="size-3.5" />
      default: return <FileText className="size-3.5" />
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-4xl bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">制品 ({artifacts.length})</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors">
            <X className="size-4" />
          </button>
        </div>

        {artifacts.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-12">
            <div className="text-center">
              <FileText className="size-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">暂无制品</p>
              <p className="text-xs text-muted-foreground/60 mt-1">agent 可使用 create_artifact 工具创建 HTML/图表/报告</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex min-h-0">
            <div className="w-56 border-r border-border/40 shrink-0">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-0.5">
                  {artifacts.map(a => (
                    <button
                      key={a.id}
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs transition-colors ${
                        selectedId === a.id || (!selectedId && a === artifacts[0])
                          ? 'bg-accent/60 font-medium'
                          : 'hover:bg-accent/30'
                      }`}
                    >
                      {typeIcon(a.type)}
                      <span className="flex-1 truncate">{a.title}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeArtifact(a.id) }}
                        className="opacity-0 hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all shrink-0"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
            <div className="flex-1 min-w-0">
              {selected && (
                <div className="h-full flex flex-col">
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 shrink-0">
                    {typeIcon(selected.type)}
                    <span className="text-sm font-medium">{selected.title}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{selected.type}</span>
                  </div>
                  <div className="flex-1 min-h-0">
                    <ArtifactViewer artifact={selected} />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
