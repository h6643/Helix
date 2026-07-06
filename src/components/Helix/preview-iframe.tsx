'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  X,
  RefreshCw,
  ExternalLink,
  Loader2,
  Monitor,
  Smartphone,
  Tablet,
  RotateCcw,
  Maximize2,
  Minimize2,
} from 'lucide-react'

interface PreviewIframeProps {
  url?: string
  onClose: () => void
}

type ViewMode = 'desktop' | 'tablet' | 'mobile'

const VIEW_MODES: Record<ViewMode, { width: string; icon: typeof Monitor; label: string }> = {
  desktop: { width: '100%', icon: Monitor, label: '桌面' },
  tablet: { width: '768px', icon: Tablet, label: '平板' },
  mobile: { width: '375px', icon: Smartphone, label: '手机' },
}

export function PreviewIframe({ url = 'http://localhost:3000', onClose }: PreviewIframeProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('desktop')
  const [isLoading, setIsLoading] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleRefresh = useCallback(() => {
    setIsLoading(true)
    setLastRefresh(new Date())
    if (iframeRef.current) {
      iframeRef.current.src = url
    }
  }, [url])

  const handleOpenExternal = () => {
    window.open(url, '_blank')
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

  // Auto refresh on file changes (simulated)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+R or F5 to refresh
      if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') {
        e.preventDefault()
        handleRefresh()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleRefresh])

  return (
    <div 
      ref={containerRef}
      className={`fixed inset-0 z-50 flex flex-col bg-[#1C1A16] ${isFullscreen ? 'fullscreen' : ''}`}
    >
      {/* Header */}
      <div className="h-12 bg-[#2D2A24] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <h3 className="text-sm font-medium text-white">项目预览</h3>
          <div className="flex items-center gap-1 bg-[#1C1A16] rounded-lg p-1">
            {Object.entries(VIEW_MODES).map(([mode, config]) => {
              const Icon = config.icon
              return (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode as ViewMode)}
                  className={`p-1.5 rounded transition-colors ${
                    viewMode === mode
                      ? 'bg-[#3D3A34] text-white'
                      : 'text-white/50 hover:text-white/70'
                  }`}
                  title={config.label}
                >
                  <Icon className="size-4" />
                </button>
              )
            })}
          </div>
          <div className="text-[10px] text-white/30">
            上次刷新: {lastRefresh.toLocaleTimeString('zh-CN')}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="p-1.5 text-white/50 hover:text-white rounded transition-colors"
            title="刷新 (Ctrl+R)"
          >
            <RefreshCw className={`size-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-1.5 text-white/50 hover:text-white rounded transition-colors"
            title="全屏"
          >
            {isFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          <button
            onClick={handleOpenExternal}
            className="p-1.5 text-white/50 hover:text-white rounded transition-colors"
            title="在新窗口打开"
          >
            <ExternalLink className="size-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-white/50 hover:text-white rounded transition-colors"
            title="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* iframe container */}
      <div className="flex-1 flex items-start justify-center overflow-auto p-4">
        <div
          className="bg-white rounded-lg overflow-hidden shadow-2xl transition-all duration-300 relative"
          style={{ width: VIEW_MODES[viewMode].width, maxWidth: '100%' }}
        >
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <Loader2 className="size-6 text-green-500 animate-spin" />
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-[calc(100vh-8rem)] border-0"
            onLoad={() => setIsLoading(false)}
            title="Project Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>

      {/* Status bar */}
      <div className="h-8 bg-[#2D2A24] flex items-center justify-between px-4 text-[10px] text-white/40 shrink-0">
        <div className="flex items-center gap-4">
          <span>{url}</span>
          <span>{VIEW_MODES[viewMode].label}视图</span>
        </div>
        <div className="flex items-center gap-4">
          <span>Ctrl+R 刷新</span>
          <span>F11 全屏</span>
        </div>
      </div>
    </div>
  )
}