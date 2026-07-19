/**
 * Filesystem IPC handlers — extracted from main.js.
 * Path-validated file operations scoped to the working directory.
 */
const { ipcMain } = require('electron')
const fsPromises = require('fs').promises
const fs = require('fs')
const path = require('path')

module.exports = function registerFsHandlers(getWorkDir) {
  // Idempotent registration — dev reloads may re-execute this module.
  const handles = ['fs:read', 'fs:write', 'fs:edit', 'fs:readdir', 'fs:stat', 'fs:rename', 'fs:scanTree']
  for (const channel of handles) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }

  function safePath(filePath) {
    const workDir = getWorkDir()
    const resolved = path.resolve(workDir, filePath)
    if (!resolved.startsWith(workDir)) return null
    try {
      const realResolved = fs.realpathSync(resolved)
      const realWorkDir = fs.realpathSync(workDir)
      return realResolved.startsWith(realWorkDir) ? realResolved : null
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
}
