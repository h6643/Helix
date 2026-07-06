const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron')
const path = require('path')
const fsPromises = require('fs').promises
const fs = require('fs')
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

// Load app icon from Helix.ico
const iconPath = path.join(__dirname, '..', 'public', 'Helix.ico')
let appIcon = null
if (fs.existsSync(iconPath)) {
  appIcon = nativeImage.createFromPath(iconPath)
  console.log('Icon loaded from:', iconPath, 'size:', appIcon.getSize())
} else {
  console.log('Icon not found at:', iconPath)
}

let mainWindow = null
let nextServer = null
const PORT = process.env.PORT || 3000

// Security: restrict file access to working directory
let workDir = process.cwd()

function safePath(filePath) {
  const resolved = path.resolve(workDir, filePath)
  if (!resolved.startsWith(workDir)) return null
  // Check for symlink escapes
  try {
    const realResolved = fs.realpathSync(resolved)
    const realWorkDir = fs.realpathSync(workDir)
    return realResolved.startsWith(realWorkDir) ? realResolved : null
  } catch {
    return resolved
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Helix',
    icon: appIcon,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#FCFBF9',
  })

  // Load the Next.js app
  const url = `http://localhost:${PORT}`
  
  // Wait for Next.js to be ready
  const maxRetries = 30
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) break
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  
  mainWindow.loadURL(url)
  mainWindow.setMenuBarVisibility(false)

  // Force set window icon after creation
  if (process.platform === 'win32') {
    try {
      const winIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'Helix.ico'))
      if (!winIcon.isEmpty()) {
        mainWindow.setIcon(winIcon)
      }
    } catch (e) {
      console.log('Failed to set window icon:', e)
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Notify renderer when maximize state changes
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })
}

async function startNextServer() {
  let nextPath = path.join(__dirname, '..', 'node_modules', '.bin', 'next')
  // On Windows, the executable may be a .cmd file
  if (process.platform === 'win32') {
    const cmdPath = nextPath + '.cmd'
    try { await fsPromises.access(cmdPath); nextPath = cmdPath } catch {}
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: PORT.toString() }
    const cmd = process.platform === 'win32' ? `"${nextPath}"` : nextPath
    let resolved = false

    nextServer = exec(`${cmd} dev -p ${PORT}`, { env, cwd: path.join(__dirname, '..') })

    const onData = (data) => {
      console.log(`[Next.js] ${data}`)
      if (!resolved && (data.includes('Ready') || data.includes('ready'))) {
        resolved = true
        resolve()
      }
    }

    nextServer.stdout?.on('data', onData)
    nextServer.stderr?.on('data', onData)
    nextServer.on('error', (err) => { if (!resolved) { resolved = true; reject(err) } })

    // Timeout safety: fail after 60s instead of silently succeeding
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('Next.js failed to start within 60s')) } }, 60000)
  })
}

// IPC Handlers

// File system operations
ipcMain.handle('fs:read', async (event, filePath) => {
  const resolved = safePath(filePath)
  if (!resolved) throw new Error('Path is outside working directory')
  return await fsPromises.readFile(resolved, 'utf-8')
})

ipcMain.handle('fs:write', async (event, filePath, content) => {
  const resolved = safePath(filePath)
  if (!resolved) throw new Error('Path is outside working directory')
  await fsPromises.mkdir(path.dirname(resolved), { recursive: true })
  await fsPromises.writeFile(resolved, content, 'utf-8')
  return { success: true }
})

ipcMain.handle('fs:edit', async (event, filePath, oldString, newString, replaceAll = false) => {
  const resolved = safePath(filePath)
  if (!resolved) throw new Error('Path is outside working directory')
  let content = await fsPromises.readFile(resolved, 'utf-8')
  if (!content.includes(oldString)) {
    throw new Error(`old_string not found in ${filePath}`)
  }
  content = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
  await fsPromises.writeFile(resolved, content, 'utf-8')
  return { success: true }
})

ipcMain.handle('fs:readdir', async (event, dirPath) => {
  const resolved = safePath(dirPath || '.')
  if (!resolved) throw new Error('Path is outside working directory')
  const entries = await fsPromises.readdir(resolved, { withFileTypes: true })
  return entries.map(e => ({
    name: e.name,
    isDirectory: e.isDirectory(),
  }))
})

ipcMain.handle('fs:stat', async (event, filePath) => {
  const resolved = safePath(filePath)
  if (!resolved) throw new Error('Path is outside working directory')
  const stat = await fsPromises.stat(resolved)
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtime: stat.mtimeMs,
  }
})

// Shell operations
ipcMain.handle('shell:exec', async (event, command) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workDir,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
    return { stdout: stdout || '', stderr: stderr || '' }
  } catch (err) {
    throw new Error(err.message)
  }
})

ipcMain.handle('shell:open', async (event, target) => {
  await shell.openExternal(target)
})

// Dialog operations
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  if (result.canceled) return null
  workDir = result.filePaths[0]
  return workDir
})

ipcMain.handle('dialog:openFile', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || [],
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:saveFile', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: options?.filters || [],
  })
  if (result.canceled) return null
  return result.filePath
})

// App info
ipcMain.handle('app:getInfo', () => {
  return {
    version: app.getVersion(),
    platform: process.platform,
    workDir,
  }
})

ipcMain.handle('app:setWorkDir', (event, dir) => {
  workDir = dir
  return { success: true }
})

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  mainWindow?.maximize()
})

ipcMain.handle('window:unmaximize', () => {
  mainWindow?.unmaximize()
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false
})

ipcMain.handle('window:toggleDevTools', () => {
  if (mainWindow?.webContents.isDevToolsOpened()) {
    mainWindow.webContents.closeDevTools()
  } else {
    mainWindow?.webContents.openDevTools()
  }
})

ipcMain.on('window:startDrag', () => {
  // No-op: handled by CSS -webkit-app-region: drag
})

// Acquire a port lock: returns a server handle if port is free, or null if in use.
// Holding the server prevents others from grabbing the port between check and use.
async function acquirePort(port) {
  const net = require('net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.once('listening', () => resolve(server))
    server.listen(port)
  })
}

// App lifecycle
app.whenReady().then(async () => {
  // Remove default menu bar
  Menu.setApplicationMenu(null)

  // Set app icon for Windows
  if (process.platform === 'win32') {
    try {
      const winIconPath = path.join(__dirname, '..', 'public', 'Helix.ico')
      if (fs.existsSync(winIconPath)) {
        const winIcon = nativeImage.createFromPath(winIconPath)
        if (!winIcon.isEmpty()) {
          // Set the icon for the app
          app.setAppUserModelId('com.helix.desktop')
        }
      }
    } catch (e) {
      console.log('Failed to set Windows icon:', e)
    }
  }

  // Only start Next.js server if not already running (e.g. started by concurrently)
  const lock = await acquirePort(PORT)
  if (lock) {
    // Port was free — close our lock, then start Next.js
    lock.close()
    await startNextServer()
  }
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port} | findstr LISTENING`)
      const pids = new Set()
      for (const line of stdout.trim().split('\n')) {
        const m = line.match(/(\d+)\s*$/)
        if (m) pids.add(m[1])
      }
      for (const pid of pids) {
        try { await execAsync(`taskkill /F /T /PID ${pid}`) } catch {}
      }
    } else {
      const { stdout } = await execAsync(`lsof -ti:${port} 2>/dev/null`)
      for (const pid of stdout.trim().split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid), 'SIGTERM') } catch {}
      }
    }
  } catch {}
}

app.on('before-quit', async () => {
  if (nextServer) {
    const pid = nextServer.pid
    if (process.platform === 'win32') {
      try {
        await execAsync(`taskkill /F /T /PID ${pid}`)
      } catch { /* process already dead */ }
    } else {
      process.kill(-pid, 'SIGTERM')
    }
    nextServer = null
  }
  await killProcessOnPort(PORT)
})
