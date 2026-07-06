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
}

/**
 * Shell operations (Electron only)
 */
export const electronShell = {
  async exec(command: string): Promise<{ stdout: string; stderr: string }> {
    const api = getElectronAPI()
    if (api) {
      return api.shell.exec(command)
    }
    throw new Error('Shell not available in browser mode')
  },

  async open(target: string): Promise<void> {
    const api = getElectronAPI()
    if (api) {
      await api.shell.open(target)
      return
    }
    window.open(target, '_blank')
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
