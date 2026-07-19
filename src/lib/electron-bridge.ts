import type { ElectronAPI } from '@/types/electron'

/**
 * Check if running in Electron
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electron?.isElectron
}

/**
 * Get Electron API
 */
export function getElectronAPI(): ElectronAPI | null {
  if (isElectron()) {
    return window.electron!
  }
  return null
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
 */
export const electronTerminal = {
  async start(cols?: number, rows?: number, cwd?: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.terminal) {
      return api.terminal.start(cols, rows, cwd)
    }
    return { ok: false, error: 'Terminal not available in browser mode' }
  },

  write(command: string): void {
    const api = getElectronAPI()
    if (api?.terminal) {
      api.terminal.write(command)
    }
  },

  resize(cols: number, rows: number): void {
    const api = getElectronAPI()
    if (api?.terminal) {
      api.terminal.resize(cols, rows)
    }
  },

  async kill(): Promise<void> {
    const api = getElectronAPI()
    if (api?.terminal) {
      await api.terminal.kill()
    }
  },

  onData(callback: (data: string) => void): () => void {
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
  async openDirectory(): Promise<string | null> {
    const api = getElectronAPI()
    if (api) {
      return api.dialog.openDirectory()
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
    // Pre-restart safety: notify channel unavailable in this preload build.
    // A full app restart enables it. Don't crash the UI.
    console.warn(`[electron-bridge] hermes.notify unavailable; skipped "${method}". Restart Helix to enable.`)
  },

  async interrupt(sessionId: string): Promise<void> {
    const api = getElectronAPI()
    const h = api?.hermes as any
    if (h?.interrupt) {
      await h.interrupt(sessionId)
    }
  },
}

/**
 * Git operations (Electron only)
 */
export const electronGit = {
  async status(): Promise<{ ok: boolean; output?: string; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.status()
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

  async branchList(): Promise<{ ok: boolean; branches?: string[]; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.branchList()
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async branchSwitch(branch: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.branchSwitch(branch)
    return { ok: false, error: 'Git not available in browser mode' }
  },

  async branchCreate(branch: string): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.git) return api.git.branchCreate(branch)
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

/**
 * Scheduled tasks sync (Hermes backend) — Electron only
 */
export const electronScheduledTasks = {
  async list(): Promise<{ ok: boolean; tasks?: any[]; error?: string }> {
    const api = getElectronAPI()
    if (api?.scheduledTasks) {
      return api.scheduledTasks.list()
    }
    return { ok: false, tasks: [], error: 'Scheduled tasks not available in browser mode' }
  },

  async create(params: { name?: string; prompt?: string; scheduleText?: string; cronExpression?: string; nextRunAt?: number }): Promise<{ ok: boolean; id?: string; nextRunAt?: number | null; error?: string }> {
    const api = getElectronAPI()
    if (api?.scheduledTasks) {
      return api.scheduledTasks.create(params)
    }
    return { ok: false, error: 'Scheduled tasks not available in browser mode' }
  },

  async update(params: { id: string; enabled: boolean }): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.scheduledTasks) {
      return api.scheduledTasks.update(params)
    }
    return { ok: false, error: 'Scheduled tasks not available in browser mode' }
  },

  async remove(params: { id: string }): Promise<{ ok: boolean; error?: string }> {
    const api = getElectronAPI()
    if (api?.scheduledTasks) {
      return api.scheduledTasks.remove(params)
    }
    return { ok: false, error: 'Scheduled tasks not available in browser mode' }
  },
}

