import { getServeHermesFacade } from '@/lib/serve-gateway'
import { installTauriBridge, isTauri } from '@/lib/tauri-bridge'
import type { ElectronAPI } from '@/types/electron'

/**
 * Check if running in Electron (or the Tauri build, which shims the same
 * `window.electron` surface).
 */
export function isElectron(): boolean {
  if (typeof window === 'undefined') return false
  if (!!window.electron?.isElectron) return true
  // Tauri: install the invoke-backed bridge lazily so any consumer (even one
  // that only checks `isElectron()` first) sees a consistent environment.
  if (isTauri()) {
    installTauriBridge()
    return true
  }
  return false
}

/**
 * True ONLY in a real Electron runtime (where the contextBridge exposed
 * `window.electron.isElectron === true`). Distinct from `isElectron()`:
 * in the Tauri build `isElectron()` is forced true (shim) but Tauri's WebView2
 * engine does NOT support the Electron `<webview>` *guest* tag, so any code that
 * needs a real Electron webview (the embedded browser in preview-rail) must use
 * this guard and fall back to `<iframe>` in Tauri.
 */
export function isRealElectron(): boolean {
  if (typeof window === 'undefined') return false
  // The Tauri bridge also sets window.electron.isElectron = true (shim), so the
  // flag alone can't distinguish runtimes — must exclude Tauri explicitly.
  if (isTauri()) return false
  return !!window.electron?.isElectron
}

// serve 模式下包裹 window.electron 的 Proxy 缓存：
// 拦截 `.hermes` 返回网关门面，其余属性透传原 contextBridge 对象。
// （contextBridge 暴露的 window.electron 不可重赋值，只能在读取层分流。）
//
// 关键坑：contextBridge 暴露的对象属性是 non-writable + non-configurable，
// JS Proxy 不变量要求 get 陷阱对这类属性必须原样返回 target 上的值——
// 直接以 window.electron 为 target 并对 `hermes` 返回门面会抛
// "property 'hermes' is a read-only and non-configurable data property..."。
// 解法：以空对象为 target（无自有属性 → 不受不变量约束），闭包转发到真实 api。
let serveProxyCache: ElectronAPI | null = null

function wrapWithServeProxy(api: ElectronAPI): ElectronAPI {
  if (serveProxyCache) return serveProxyCache
  serveProxyCache = new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, prop: string | symbol) {
      if (prop === 'hermes') {
        const facade = getServeHermesFacade()
        if (facade) return facade
      }
      return (api as any)[prop as any]
    },
    has(_target, prop: string | symbol) {
      return prop in (api as any)
    },
  }) as unknown as ElectronAPI
  return serveProxyCache
}

/**
 * Get Electron API
 * serve 网关激活时返回 Proxy（`.hermes` 分流到网关门面），否则原样返回。
 */
export function getElectronAPI(): ElectronAPI | null {
  if (isElectron()) {
    if (getServeHermesFacade()) return wrapWithServeProxy(window.electron!)
    return window.electron!
  }
  return null
}

/**
 * 获取 hermes API（模式感知）。
 * serve 模式 → 网关门面（WS/REST 直连）；acp 模式 → 原 IPC 桥。
 * 渲染层所有直摸 `window.electron.hermes` 的调用点应改用本函数。
 */
export function hermesApi(): ElectronAPI['hermes'] | null {
  const facade = getServeHermesFacade()
  if (facade) return facade
  return (typeof window !== 'undefined' ? window.electron?.hermes : null) ?? null
}

/**
 * File system operations that work in both browser and Electron
 * In browser: uses IndexedDB via existing persist.ts
 * In Electron: uses IPC to main process
 */
export const electronFS = {
  async readFile(filePath: string): Promise<string> {
    const api = getElectronAPI()
    if (api) {
      return api.fs.read(filePath)
    }
    throw new Error('File system not available in browser mode')
  },

  async writeFile(filePath: string, content: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.fs.write(filePath, content)
      return
    }
    throw new Error('File system not available in browser mode')
  },

  async editFile(filePath: string, oldString: string, newString: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.fs.edit(filePath, oldString, newString)
      return
    }
    throw new Error('File system not available in browser mode')
  },

  async readDir(dirPath: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const api = getElectronAPI()
    if (api) {
      return api.fs.readdir(dirPath)
    }
    throw new Error('File system not available in browser mode')
  },

  // Absolute Hermes memory directory, computed in the main process.
  // Use this instead of deriving the path from process.env in the renderer
  // (which is undefined in a Next.js client bundle).
  async memoryDir(): Promise<string | null> {
    const api = getElectronAPI()
    if (api && typeof api.fs.hermesMemoryDir === 'function') {
      return api.fs.hermesMemoryDir()
    }
    return null
  },

  async stat(filePath: string) {
    const api = getElectronAPI()
    if (api) {
      return api.fs.stat(filePath)
    }
    throw new Error('File system not available in browser mode')
  },

  async rename(oldPath: string, newPath: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.fs.rename(oldPath, newPath)
      return
    }
    throw new Error('File system not available in browser mode')
  },

  async deleteFile(filePath: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.fs.delete(filePath)
      return
    }
    throw new Error('File system not available in browser mode')
  },

  async scanTree(dirPath?: string): Promise<Array<{ id: string; name: string; type: string; children?: any[] }>> {
    const api = getElectronAPI()
    if (api && typeof api.fs.scanTree === 'function') {
      return api.fs.scanTree(dirPath)
    }
    // 旧 preload 可能未暴露 scanTree：返回空树，避免 setWorkDir 抛错。
    return []
  },
}

/**
 * Shell operations (Electron only)
 */
export const electronShell = {
  async open(target: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.shell.open(target)
      return
    }
    window.open(target, '_blank')
  },

  async showItemInFolder(relativePath: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.shell.showItemInFolder(relativePath)
      return
    }
    throw new Error('showItemInFolder not available in browser mode')
  },

  async openPath(dir: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.shell.openPath(dir)
      return
    }
    throw new Error('openPath not available in browser mode')
  },
}

/**
 * Interactive terminal (Electron only) — persistent PowerShell session.
 * Each call is scoped to a renderer-assigned tab id so multiple terminals can
 * run side-by-side (VS Code style).
 */
export const electronTerminal = {
  async start(id: number, cols?: number, rows?: number, cwd?: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.terminal) {
      return api.terminal.start(id, cols, rows, cwd)
    }
    return { ok: false, error: 'Terminal not available in browser mode' }
  },

  write(id: number, command: string): void {
    const api = getElectronAPI()
    if (api?.terminal) {
      api.terminal.write(id, command)
    }
  },

  resize(id: number, cols: number, rows: number): void {
    const api = getElectronAPI()
    if (api?.terminal) {
      api.terminal.resize(id, cols, rows)
    }
  },

  async kill(id: number): Promise<void> {
    const api = getElectronAPI()
    if (api?.terminal) {
      await api.terminal.kill(id)
    }
  },

  onData(callback: (payload: { id: number; data: string }) => void): () => void {
    const api = getElectronAPI()
    if (api?.terminal) {
      return api.terminal.onData(callback)
    }
    return () => {}
  },
}

/**
 * Dialog operations (Electron only)
 */
export const electronDialog = {
  async openDirectory(defaultPath?: string): Promise<string | null> {
    const api = getElectronAPI()
    if (api) {
      return api.dialog.openDirectory(defaultPath)
    }
    throw new Error('Dialog not available in browser mode')
  },

  async openFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
    const api = getElectronAPI()
    if (api) {
      return api.dialog.openFile(options)
    }
    throw new Error('Dialog not available in browser mode')
  },

  async saveFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
    const api = getElectronAPI()
    if (api) {
      return api.dialog.saveFile(options)
    }
    throw new Error('Dialog not available in browser mode')
  },
}

/**
 * App info (Electron only)
 */
export const electronApp = {
  async getInfo() {
    const api = getElectronAPI()
    if (api) {
      return api.app.getInfo()
    }
    return {
      version: '0.2.0',
      platform: 'browser',
      workDir: '',
    }
  },

  async setWorkDir(dir: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.app.setWorkDir(dir)
      return
    }
    throw new Error('App not available in browser mode')
  },

  async getDataRoot(): Promise<{ dataRoot: string; dataRootDefault: string; dataRootCustom: boolean }> {
    const api = getElectronAPI()
    if (api) {
      return api.app.getDataRoot()
    }
    return { dataRoot: '', dataRootDefault: '', dataRootCustom: false }
  },

  async setDataRoot(path: string): Promise<{ success: boolean; dataRoot: string; dataRootDefault: string; dataRootCustom: boolean; copied: boolean; bytes?: number }> {
    const api = getElectronAPI()
    if (api) {
      return api.app.setDataRoot(path)
    }
    throw new Error('App not available in browser mode')
  },

  async proxyGet(): Promise<{ url: string }> {
    const api = getElectronAPI()
    if (api) {
      return api.app.proxyGet()
    }
    return { url: '' }
  },

  async proxySet(url: string): Promise<{ success: boolean; url: string }> {
    const api = getElectronAPI()
    if (api) {
      return api.app.proxySet(url)
    }
    throw new Error('App not available in browser mode')
  },
}

/**
 * Hermes bridge (Electron only) — JSON-RPC send / notify.
 *
 * `notify` is a JSON-RPC notification (no response expected). It is only
 * available in preload builds that expose `hermes.notify`. If the running
 * app has an older preload (not yet restarted after a code change), calling
 * `notify` directly throws "is not a function" and white-screens the UI.
 * This wrapper degrades gracefully: it no-ops with a warning instead of
 * crashing, so the app keeps working until the user restarts Helix.
 */
export const electronHermes = {
  async send(method: string, params?: any): Promise<any> {
    const api = getElectronAPI()
    if (api?.hermes) {
      return api.hermes.send(method, params)
    }
    return null
  },

  notify(method: string, params?: any): void {
    const api = getElectronAPI()
    const h = api?.hermes as any
    if (h?.notify) {
      h.notify(method, params)
      return
    }
    console.warn(`[electron-bridge] hermes.notify unavailable; skipped "${method}". Restart Helix to enable.`)
  },

  async interrupt(sessionId: string): Promise<void> {
    const api = getElectronAPI()
    const h = api?.hermes as any
    if (h?.interrupt) {
      await h.interrupt(sessionId)
    }
  },

  async update(): Promise<{ ok: boolean; message: string }> {
    const api = getElectronAPI()
    const h = api?.hermes as any
    if (h?.update) {
      return h.update()
    }
    return { ok: false, message: '更新通道不可用' }
  },

  /** Live config push: set a single key/value pair without gateway restart */
  async setConfigKeyValue(key: string, value: any, sessionId?: string): Promise<void> {
    const api = getElectronAPI()
    const h = api?.hermes as any
    if (h?.setConfigKeyValue) {
      await h.setConfigKeyValue({ key, value, session_id: sessionId })
    }
  },

  /** Respond to an approval request from the backend */
  async approvalRespond(params: { session_id?: string; tool_call_id?: string; choice: string }): Promise<void> {
    const api = getElectronAPI()
    const h = api?.hermes as any
    if (h?.approvalRespond) {
      await h.approvalRespond(params)
    }
  },
}

/**
 * Git operations (Electron only)
 */
export const electronGit = {
  async status(cwd?: string | null): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.status(cwd)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async diff(filePath?: string, staged?: boolean): Promise<{ ok: boolean; diff?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.diff(filePath, staged)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async diffHead(filePath?: string): Promise<{ ok: boolean; diff?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.diffHead(filePath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async diffNumstat(cwd?: string | null): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.diffNumstat(cwd)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async revert(filePath?: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.revert(filePath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async stage(filePath?: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.stage(filePath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async unstage(filePath?: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.unstage(filePath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async commit(message?: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.commit(message)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async branchList(cwd?: string | null): Promise<{ ok: boolean; branches?: string[]; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.branchList(cwd)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async branchSwitch(branch: string, cwd?: string | null): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.branchSwitch(branch, cwd)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async branchCreate(branch: string, cwd?: string | null): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.branchCreate(branch, cwd)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async currentBranch(cwd?: string | null): Promise<{ ok: boolean; branch?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.currentBranch(cwd)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async log(count?: number): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.log(count)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  // Worktree operations
  async worktreeList(): Promise<{ ok: boolean; worktrees?: any[]; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.worktreeList()
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async worktreeAdd(opts: { path: string; branch?: string; newBranch?: string }): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.worktreeAdd(opts)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async worktreeRemove(wtPath: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.worktreeRemove(wtPath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async worktreeLock(wtPath: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.worktreeLock(wtPath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async worktreeUnlock(wtPath: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.worktreeUnlock(wtPath)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async worktreePrune(): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.worktreePrune()
    return { ok: false, error: 'Git not available in browser mode' }
  },

  // Remote operations
  async push(opts?: { remote?: string; branch?: string; force?: boolean }): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.push(opts)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async pull(opts?: { remote?: string; branch?: string }): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.pull(opts)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async fetch(opts?: { remote?: string }): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.fetch(opts)
    return { ok: false, error: 'Git not available in browser mode' }
  },
}

