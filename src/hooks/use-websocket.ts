'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { WebSocketManager, type WebSocketStatus } from '@/lib/websocket-manager'

interface UseWebSocketOptions {
  url?: string
  autoConnect?: boolean
  onMessage?: (data: any) => void
}

interface UseWebSocketReturn {
  status: WebSocketStatus
  connect: () => void
  disconnect: () => void
  send: (data: any) => void
  on: (event: string, handler: Function) => () => void
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { url, autoConnect = true, onMessage } = options
  const [status, setStatus] = useState<WebSocketStatus>('disconnected')
  const managerRef = useRef<WebSocketManager | null>(null)

  // Initialize manager
  useEffect(() => {
    if (url) {
      managerRef.current = new WebSocketManager(url)
    }
    
    return () => {
      managerRef.current?.disconnect()
    }
  }, [url])

  // Handle status changes
  useEffect(() => {
    const manager = managerRef.current
    if (!manager) return

    const unsubscribe = manager.on('statusChange', (newStatus: WebSocketStatus) => {
      setStatus(newStatus)
    })

    return unsubscribe
  }, [])

  // Handle messages
  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !onMessage) return

    const unsubscribe = manager.on('message', onMessage)
    return unsubscribe
  }, [onMessage])

  // Auto connect
  useEffect(() => {
    if (autoConnect && url) {
      managerRef.current?.connect()
    }
  }, [autoConnect, url])

  const connect = useCallback(() => {
    managerRef.current?.connect()
  }, [])

  const disconnect = useCallback(() => {
    managerRef.current?.disconnect()
  }, [])

  const send = useCallback((data: any) => {
    managerRef.current?.send(data)
  }, [])

  const on = useCallback((event: string, handler: Function) => {
    return managerRef.current?.on(event, handler) || (() => {})
  }, [])

  return {
    status,
    connect,
    disconnect,
    send,
    on,
  }
}