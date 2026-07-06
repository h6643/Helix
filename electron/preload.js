const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods via contextBridge
contextBridge.exposeInMainWorld('electron', {
  // File system
  fs: {
    read: (filePath) => ipcRenderer.invoke('fs:read', filePath),
    write: (filePath, content) => ipcRenderer.invoke('fs:write', filePath, content),
    edit: (filePath, oldString, newString) => ipcRenderer.invoke('fs:edit', filePath, oldString, newString),
    readdir: (dirPath) => ipcRenderer.invoke('fs:readdir', dirPath),
    stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
  },
  
  // Shell
  shell: {
    exec: (command) => ipcRenderer.invoke('shell:exec', command),
    open: (target) => ipcRenderer.invoke('shell:open', target),
  },
  
  // Dialogs
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  },
  
  // App info
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    setWorkDir: (dir) => ipcRenderer.invoke('app:setWorkDir', dir),
  },

  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (callback) => {
      ipcRenderer.on('window:maximized-changed', (_event, maximized) => callback(maximized))
    },
    toggleDevTools: () => ipcRenderer.invoke('window:toggleDevTools'),
  },

  // Platform info
  platform: process.platform,
  isElectron: true,
})
