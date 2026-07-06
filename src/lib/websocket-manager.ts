/**
 * WebSocket Manager with automatic reconnection
 */

export type WebSocketEvent = {
  type: string
  data?: any
}

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

export class WebSocketManager {
  private ws: WebSocket | null = null
  private url: string
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private handlers = new Map<string, Set<Function>>()
  private status: WebSocketStatus = 'disconnected'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string) {
    this.url = url
  }

  /**
   * Connect to WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.setStatus('connecting')
    
    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log('[WS] Connected')
        this.setStatus('connected')
        this.resetReconnectAttempts()
        this.emit('connected')
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          this.emit('message', data)
          if (data.type) {
            this.emit(data.type, data)
          }
        } catch (e) {
          console.error('[WS] Failed to parse message:', e)
        }
      }

      this.ws.onclose = (event) => {
        console.log('[WS] Disconnected:', event.code, event.reason)
        this.setStatus('disconnected')
        this.emit('disconnected', { code: event.code, reason: event.reason })
        
        // Auto reconnect unless explicitly closed
        if (event.code !== 1000) {
          this.reconnect()
        }
      }

      this.ws.onerror = (error) => {
        console.error('[WS] Error:', error)
        this.emit('error', error)
      }
    } catch (error) {
      console.error('[WS] Connection failed:', error)
      this.reconnect()
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    
    this.setStatus('disconnected')
    this.reconnectAttempts = 0
  }

  /**
   * Send data to WebSocket server
   */
  send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    } else {
      console.warn('[WS] Cannot send, not connected')
    }
  }

  /**
   * Subscribe to an event
   */
  on(event: string, handler: Function): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)
    
    // Return unsubscribe function
    return () => this.off(event, handler)
  }

  /**
   * Unsubscribe from an event
   */
  off(event: string, handler: Function): void {
    this.handlers.get(event)?.delete(handler)
  }

  /**
   * Get current connection status
   */
  getStatus(): WebSocketStatus {
    return this.status
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private emit(event: string, data?: any): void {
    this.handlers.get(event)?.forEach(handler => {
      try {
        handler(data)
      } catch (e) {
        console.error(`[WS] Error in handler for ${event}:`, e)
      }
    })
  }

  private setStatus(status: WebSocketStatus): void {
    this.status = status
    this.emit('statusChange', status)
  }

  private reconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WS] Max reconnect attempts reached')
      this.emit('reconnectFailed')
      return
    }

    this.setStatus('reconnecting')
    this.reconnectAttempts++
    
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
    
    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  private resetReconnectAttempts(): void {
    this.reconnectAttempts = 0
  }
}

// Singleton instance for the app
let wsInstance: WebSocketManager | null = null

export function getWebSocketManager(url?: string): WebSocketManager {
  if (!wsInstance && url) {
    wsInstance = new WebSocketManager(url)
  }
  return wsInstance!
}

export function resetWebSocketManager(): void {
  wsInstance?.disconnect()
  wsInstance = null
}