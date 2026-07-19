/**
 * Window IPC handlers — extracted from main.js.
 * Window management: minimize, maximize, close, new window, drag.
 */
const { ipcMain, BrowserWindow, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

module.exports = function registerWindowHandlers(getMainWindow, PORT, appIcon) {
  // Idempotent registration — dev reloads may re-execute this module.
  const handles = ['window:minimize', 'window:maximize', 'window:unmaximize', 'window:close', 'window:isMaximized', 'window:toggleDevTools', 'window:newWindow']
  for (const channel of handles) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }
  ipcMain.removeAllListeners('window:startDrag')

  function openNewWindow() {
    const win = new BrowserWindow({
      width: 1400, height: 900, minWidth: 800, minHeight: 600,
      title: 'Helix', icon: appIcon, frame: false, show: false, roundedCorners: 'off',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
      backgroundColor: '#FCFBF9',
    })
    const url = `http://localhost:${PORT}`
    win.loadURL(url)
    win.setMenuBarVisibility(false)
    win.once('ready-to-show', () => {
      win.maximize()
      win.show()
      win.focus()
    })
    if (process.platform === 'win32') {
      try {
        const winIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'public', 'Helix.ico'))
        if (!winIcon.isEmpty()) win.setIcon(winIcon)
      } catch (e) { console.log('Failed to set window icon:', e) }
    }
    win.on('maximize', () => win.webContents.send('window:maximized-changed', true))
    win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false))
    return win
  }

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:maximize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.maximize()
  })

  ipcMain.handle('window:unmaximize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.unmaximize()
  })

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:isMaximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  ipcMain.handle('window:toggleDevTools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools()
    } else {
      win?.webContents.openDevTools()
    }
  })

  ipcMain.handle('window:newWindow', () => {
    openNewWindow()
  })

  ipcMain.on('window:startDrag', () => {
    // No-op: handled by CSS -webkit-app-region: drag
  })

  return { openNewWindow }
}
