/**
 * Filesystem IPC handlers — extracted from main.js.
 * Path-validated file operations scoped to the working directory.
 */
const { ipcMain, shell } = require('electron')
const fsPromises = require('fs').promises
const fs = require('fs')
const path = require('path')

module.exports = function registerFsHandlers(getWorkDir, getAllowedRoots) {
  // Idempotent registration — dev reloads may re-execute this module.
  const handles = ['fs:read', 'fs:write', 'fs:edit', 'fs:readdir', 'fs:stat', 'fs:rename', 'fs:delete', 'fs:scanTree', 'fs:hermesMemoryDir', 'fs:allowRoot']
  for (const channel of handles) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }

  // 允许访问的根目录集合：当前 workDir + 用户在侧边栏点选过的每个项目目录。
  // 为什么需要：右侧目录面板按“选中的项目”传绝对路径扫描，若主进程模块级
  // workDir 还没切过去（时序竞争 / 旧进程），单一根的 startsWith(workDir) 会
  // 判越界 → "Path is outside working directory"。把每个用户选过的项目都登记为
  // 合法根，既放行跨项目浏览，又仍挡住真正的任意路径枚举。
  const extraRoots = new Set()
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  function allowedRoots() {
    const roots = [getWorkDir()]
    if (typeof getAllowedRoots === 'function') {
      try { roots.push(...(getAllowedRoots() || [])) } catch { /* ignore */ }
    }
    roots.push(...extraRoots)
    return roots.filter(Boolean).map((r) => path.resolve(r))
  }
  // 渲染进程主动登记一个合法根（目录面板扫描前调用）。app:setWorkDir 并非唯一
  // 改变“选中项目”的路径——点击历史对话会直接在 store 里写 selectedWorkDir，
  // 主进程收不到，单根校验就会判越界。扫描前 ensure 一次最稳。
  ipcMain.handle('fs:allowRoot', (event, dir) => {
    if (typeof dir === 'string' && dir.trim()) extraRoots.add(path.resolve(dir.trim()))
    return { success: true }
  })
  function safePath(filePath) {
    const workDir = getWorkDir()
    const resolved = path.resolve(workDir, filePath)
    // Allow hermes memory directory (used by learning view).
    // Normalize separators before comparing so a forward-slash path sent from
    // the renderer still matches a backslash-joined main-process dir.
    const hermesMemoryDir = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'memories')
    if (norm(resolved).startsWith(norm(hermesMemoryDir))) return resolved
    // 任一合法根（当前 workDir 或用户选过的项目）之内即放行。
    const inAnyRoot = allowedRoots().some((root) => {
      const r = norm(root)
      const p = norm(resolved)
      return p === r || p.startsWith(r + '/')
    })
    if (!inAnyRoot) return null
    try {
      const realResolved = fs.realpathSync(resolved)
      return allowedRoots().some((root) => {
        try {
          const rr = norm(fs.realpathSync(root))
          const rp = norm(realResolved)
          return rp === rr || rp.startsWith(rr + '/')
        } catch { return false }
      }) ? realResolved : null
    } catch {
      return resolved
    }
  }

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
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
  })

  // Returns the absolute Hermes memory directory. Computed in the MAIN process
  // (where process.env.LOCALAPPDATA is valid) so the renderer never has to infer
  // it from its own (build-time-only) process.env — which is undefined in a
  // Next.js client bundle and previously produced a bogus "/hermes/memory" path.
  ipcMain.handle('fs:hermesMemoryDir', async () => {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'memories')
    return path.resolve(dir)
  })

  ipcMain.handle('fs:stat', async (event, filePath) => {
    const resolved = safePath(filePath)
    if (!resolved) throw new Error('Path is outside working directory')
    const stat = await fsPromises.stat(resolved)
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs }
  })

  ipcMain.handle('fs:rename', async (event, oldPath, newPath) => {
    const resolvedOld = safePath(oldPath)
    const resolvedNew = safePath(newPath)
    if (!resolvedOld || !resolvedNew) throw new Error('Path is outside working directory')
    await fsPromises.mkdir(path.dirname(resolvedNew), { recursive: true })
    await fsPromises.rename(resolvedOld, resolvedNew)
    return { success: true }
  })

  // VS Code-style delete: move to the OS trash (recoverable), not permanent unlink.
  ipcMain.handle('fs:delete', async (event, filePath) => {
    const resolved = safePath(filePath)
    if (!resolved) throw new Error('Path is outside working directory')
    await shell.trashItem(resolved)
    return { success: true }
  })

  ipcMain.handle('fs:scanTree', async (event, relativePath) => {
    const workDir = getWorkDir()
    const rootDir = relativePath ? safePath(relativePath) : workDir
    if (!rootDir) throw new Error('Path is outside working directory')
    const counter = { n: 0 }
    return buildFileTree(rootDir, '', 0, counter)
  })

  async function buildFileTree(dir, base, depth, counter) {
    if (depth > 7) return []
    if (counter && counter.n > 4000) return []
    let entries
    try { entries = await fsPromises.readdir(dir, { withFileTypes: true }) } catch { return [] }
    const nodes = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      const rel = base ? base + '/' + e.name : e.name
      if (e.isDirectory()) {
        const children = await buildFileTree(abs, rel, depth + 1, counter)
        nodes.push({ id: rel, name: e.name, type: 'folder', children })
      } else if (e.isFile()) {
        nodes.push({ id: rel, name: e.name, type: 'file' })
      }
      if (counter) counter.n++
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return nodes
  }

  // 暴露给主进程：app:setWorkDir 成功切换项目时登记该目录为合法根，
  // 这样目录面板按绝对路径扫描任意已选项目都不会被 safePath 判越界。
  return {
    addAllowedRoot(dir) {
      if (typeof dir === 'string' && dir.trim()) extraRoots.add(path.resolve(dir.trim()))
    },
  }
}
