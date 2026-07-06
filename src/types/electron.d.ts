export interface ElectronAPI {
  fs: {
    read: (filePath: string) => Promise<string>
    write: (filePath: string, content: string) => Promise<{ success: boolean }>
    edit: (filePath: string, oldString: string, newString: string) => Promise<{ success: boolean }>
    readdir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
    stat: (filePath: string) => Promise<{
      isFile: boolean
      isDirectory: boolean
      size: number
      mtime: number
    }>
  }
  
  shell: {
    exec: (command: string) => Promise<{ stdout: string; stderr: string }>
    open: (target: string) => Promise<void>
  }
  
  dialog: {
    openDirectory: () => Promise<string | null>
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
    saveFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  }
  
  app: {
    getInfo: () => Promise<{ version: string; platform: string; workDir: string }>
    setWorkDir: (dir: string) => Promise<{ success: boolean }>
  }
  
  platform: string
  isElectron: boolean
}

declare global {
  interface Window {
    electron?: ElectronAPI
  }
}

export {}
