/**
 * Terminal IPC handlers — extracted from main.js.
 * Manages the interactive PowerShell PTY via node-pty.
 */
const { ipcMain } = require('electron')

module.exports = function registerTerminalHandlers(getMainWindow, getWorkDir) {
  // During dev reloads this module may be re-executed; remove any
  // stale handlers/listeners before registering new ones so Electron
  // does not throw "Attempted to register a second handler".
  ipcMain.removeHandler('terminal:start')
  ipcMain.removeHandler('terminal:kill')
  ipcMain.removeAllListeners('terminal:write')
  ipcMain.removeAllListeners('terminal:resize')

  let ptyProc = null
  let ptyCols = 80
  let ptyRows = 30
  let ptyCwdOverride = null

  function ptyCwd() {
    const fs = require('fs')
    let cwd = ptyCwdOverride || getWorkDir()
    try {
      if (!cwd || !fs.existsSync(cwd)) cwd = process.cwd()
    } catch { cwd = process.cwd() }
    return cwd
  }

  function startPty(cols, rows, cwd) {
    if (ptyProc) return ptyProc
    const fs = require('fs')
    if (cols && rows) { ptyCols = cols; ptyRows = rows }
    if (cwd) {
      try {
        if (fs.existsSync(cwd)) ptyCwdOverride = cwd
      } catch { /* ignore */ }
    }
    try {
      const pty = require('node-pty')
      ptyProc = pty.spawn('powershell.exe', ['-NoExit'], {
        name: 'xterm-color',
        cols: ptyCols,
        rows: ptyRows,
        cwd: ptyCwd(),
        env: process.env,
      })
      ptyProc.onData((data) => {
        if (data) getMainWindow()?.webContents.send('terminal:data', data)
      })
      ptyProc.onExit(({ exitCode, signal }) => {
        ptyProc = null
        getMainWindow()?.webContents.send('terminal:data', '\r\n\x1b[31m[PowerShell process exited code=' + exitCode + ' signal=' + signal + ']\x1b[0m\r\n')
      })
    } catch (err) {
      ptyProc = null
      getMainWindow()?.webContents.send('terminal:data', '\r\n\x1b[31m[PowerShell failed to start: ' + (err && err.message) + ']\x1b[0m\r\n')
    }
    return ptyProc
  }

  ipcMain.handle('terminal:start', async (event, cols, rows, cwd) => {
    try {
      startPty(cols, rows, cwd)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
  })

  ipcMain.on('terminal:write', (event, command) => {
    if (!ptyProc) startPty()
    if (ptyProc) ptyProc.write(command)
  })

  ipcMain.on('terminal:resize', (event, cols, rows) => {
    if (ptyProc && cols && rows) {
      try { ptyProc.resize(cols, rows) } catch { /* ignore */ }
    }
  })

  ipcMain.handle('terminal:kill', async () => {
    if (ptyProc) {
      ptyProc.kill()
      ptyProc = null
    }
    return { ok: true }
  })

  // Return cleanup function for before-quit
  return {
    kill: () => {
      if (ptyProc) {
        try { ptyProc.kill() } catch {}
        ptyProc = null
      }
    },
  }
}
