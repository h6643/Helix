/**
 * Cross-platform path resolution for Hermes data / runtime locations.
 *
 * Windows stores Hermes under %LOCALAPPDATA%/hermes (i.e. ~/AppData/Local/hermes).
 * On Linux the XDG-data equivalent is $XDG_DATA_HOME/hermes, defaulting to
 * ~/.local/share/hermes. macOS is treated like Linux here (the app never had a
 * real macOS data dir before, so this is strictly an improvement).
 *
 * The venv layout also differs: Windows uses venv/Scripts/{python,hermes}.exe,
 * POSIX uses venv/bin/{python,hermes}.
 */
const os = require('os')
const path = require('path')

// Equivalent of %LOCALAPPDATA% (the ".../Local" app-data ROOT, NOT the hermes subdir).
function localAppDataDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  }
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? xdg : path.join(os.homedir(), '.local', 'share')
}

// The Hermes data directory (config.yaml, state.db, skills, memories, logs…).
function hermesDataDir() {
  return path.join(localAppDataDir(), 'hermes')
}

// The bundled / managed Hermes agent checkout.
function hermesAgentDir() {
  return path.join(hermesDataDir(), 'hermes-agent')
}

// Python interpreter inside a Hermes agent venv.
function venvPython(agentDir) {
  const base = agentDir || hermesAgentDir()
  if (process.platform === 'win32') return path.join(base, 'venv', 'Scripts', 'python.exe')
  return path.join(base, 'venv', 'bin', 'python')
}

// Hermes CLI executable inside a Hermes agent venv.
// venvName lets callers prefer "venv" or ".venv".
function venvHermesBin(agentDir, venvName) {
  const base = agentDir || hermesAgentDir()
  const vn = venvName || 'venv'
  if (process.platform === 'win32') return path.join(base, vn, 'Scripts', 'hermes.exe')
  return path.join(base, vn, 'bin', 'hermes')
}

module.exports = {
  localAppDataDir,
  hermesDataDir,
  hermesAgentDir,
  venvPython,
  venvHermesBin,
}
