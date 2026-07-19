/**
 * Git IPC handlers — extracted from main.js.
 * Uses execFile with arg arrays (no shell) to prevent command injection.
 */
const { execFile } = require('child_process')
const { promisify } = require('util')
const { ipcMain } = require('electron')

const execFileAsync = promisify(execFile)

module.exports = function registerGitHandlers(getWorkDir) {
  // Idempotent registration — dev reloads may re-execute this module.
  const handles = ['git:status', 'git:diff', 'git:diffHead', 'git:revert', 'git:stage', 'git:unstage', 'git:commit', 'git:branchList', 'git:branchSwitch', 'git:branchCreate', 'git:log']
  for (const channel of handles) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
  }

  function gitCwd() {
    let cwd = getWorkDir()
    try {
      const fs = require('fs')
      if (!cwd || !fs.existsSync(cwd)) cwd = process.cwd()
    } catch { cwd = process.cwd() }
    return cwd
  }

  function gitExecArgs(args) {
    return execFileAsync('git', args, {
      cwd: gitCwd(),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }).then(({ stdout, stderr }) => ({ stdout: stdout || '', stderr: stderr || '' }))
  }

  ipcMain.handle('git:status', async () => {
    try {
      const { stdout } = await gitExecArgs(['status', '--porcelain=v2', '--branch'])
      return { ok: true, output: stdout.trim() }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:diff', async (event, filePath, staged) => {
    try {
      const args = ['diff']
      if (staged) args.push('--cached')
      if (filePath) args.push('--', filePath)
      const { stdout } = await gitExecArgs(args)
      return { ok: true, diff: stdout }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:diffHead', async (event, filePath) => {
    try {
      const args = ['diff', 'HEAD']
      if (filePath) args.push('--', filePath)
      const { stdout } = await gitExecArgs(args)
      return { ok: true, diff: stdout }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:revert', async (event, filePath) => {
    try {
      if (filePath) {
        await gitExecArgs(['checkout', 'HEAD', '--', filePath])
        await gitExecArgs(['clean', '-fd', '--', filePath])
      } else {
        await gitExecArgs(['checkout', 'HEAD', '--', '.'])
        await gitExecArgs(['clean', '-fd'])
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:stage', async (event, filePath) => {
    try {
      await gitExecArgs(['add', filePath || '.'])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:unstage', async (event, filePath) => {
    try {
      await gitExecArgs(['reset', '-q', 'HEAD', '--', filePath || '.'])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:commit', async (event, message) => {
    try {
      await gitExecArgs(['add', '-A'])
      const { stdout } = await gitExecArgs(['commit', '-m', message || 'chore: auto-commit'])
      return { ok: true, output: stdout.trim() }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:branchList', async () => {
    try {
      const { stdout } = await gitExecArgs(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      return { ok: true, branches: stdout.trim().split('\n').filter(Boolean) }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:branchSwitch', async (event, branch) => {
    try {
      await gitExecArgs(['switch', branch])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:branchCreate', async (event, branch) => {
    try {
      await gitExecArgs(['checkout', '-b', branch])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:log', async (event, count) => {
    try {
      const n = count || 20
      const { stdout } = await gitExecArgs(['log', '--oneline', '-n', String(n)])
      return { ok: true, output: stdout.trim() }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  // ── Worktree operations ────────────────────────────────────────────────────
  // git worktree: list, add, remove, lock, unlock, prune
  ipcMain.handle('git:worktreeList', async () => {
    try {
      const { stdout } = await gitExecArgs(['worktree', 'list', '--porcelain'])
      const entries = []
      let current = {}
      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) entries.push(current)
          current = { path: line.slice(9).trim() }
        } else if (line.startsWith('HEAD ')) {
          current.head = line.slice(5).trim()
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).trim().replace('refs/heads/', '')
        } else if (line === 'bare') {
          current.bare = true
        } else if (line === 'detached') {
          current.detached = true
        } else if (line.startsWith('locked')) {
          current.locked = true
        } else if (line.startsWith('prunable')) {
          current.prunable = true
        }
      }
      if (current.path) entries.push(current)
      // Mark the first entry as main worktree
      if (entries.length > 0) entries[0].isMain = true
      return { ok: true, worktrees: entries }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:worktreeAdd', async (event, { path: wtPath, branch, newBranch }) => {
    try {
      const args = ['worktree', 'add']
      if (newBranch) {
        args.push('-b', newBranch, wtPath)
        if (branch) args.push(branch)
      } else if (branch) {
        args.push(wtPath, branch)
      } else {
        args.push(wtPath)
      }
      await gitExecArgs(args)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:worktreeRemove', async (event, wtPath) => {
    try {
      await gitExecArgs(['worktree', 'remove', wtPath, '--force'])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:worktreeLock', async (event, wtPath) => {
    try {
      await gitExecArgs(['worktree', 'lock', wtPath])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:worktreeUnlock', async (event, wtPath) => {
    try {
      await gitExecArgs(['worktree', 'unlock', wtPath])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:worktreePrune', async () => {
    try {
      await gitExecArgs(['worktree', 'prune'])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  // ── Remote operations ──────────────────────────────────────────────────────
  ipcMain.handle('git:push', async (event, { remote, branch, force } = {}) => {
    try {
      const args = ['push']
      if (force) args.push('--force')
      if (remote) args.push(remote)
      if (branch) args.push(branch)
      const { stdout, stderr } = await gitExecArgs(args)
      return { ok: true, output: (stdout || '') + (stderr || '') }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:pull', async (event, { remote, branch } = {}) => {
    try {
      const args = ['pull']
      if (remote) args.push(remote)
      if (branch) args.push(branch)
      const { stdout, stderr } = await gitExecArgs(args)
      return { ok: true, output: (stdout || '') + (stderr || '') }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })

  ipcMain.handle('git:fetch', async (event, { remote } = {}) => {
    try {
      const args = ['fetch']
      if (remote) args.push(remote)
      const { stdout, stderr } = await gitExecArgs(args)
      return { ok: true, output: (stdout || '') + (stderr || '') }
    } catch (e) {
      return { ok: false, error: String(e.message) }
    }
  })
}
