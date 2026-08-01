/**
 * Hermes executable resolution + kernel (runtime) verification.
 * Extracted from main.js. Depends only on fs/os/path/crypto.
 */
const path = require('path')
const os = require('os')
const fs = require('fs')
const fsPromises = require('fs').promises
const crypto = require('crypto')

function resolveHermesCandidates() {
  const managedRoot = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent')
  // Prefer `venv` (the user's known-good, integration-patched runtime) first;
  // fall back to `.venv` (provisioned by newer `hermes update`). Both may exist.
  const cands = [
    path.join(managedRoot, 'venv', 'Scripts', 'hermes.exe'),
    path.join(managedRoot, '.venv', 'Scripts', 'hermes.exe'),
  ]
  try {
    const { execSync } = require('child_process')
    const out = execSync('where hermes 2>nul || which hermes 2>/dev/null').toString().trim()
    if (out) out.split(/\r?\n/).forEach(l => l.trim() && cands.push(l.trim()))
  } catch { /* ignore */ }
  const seen = new Set()
  const existing = []
  for (const c of cands) {
    if (seen.has(c)) continue
    seen.add(c)
    try { if (fs.existsSync(c)) existing.push(c) } catch { /* ignore */ }
  }
  return existing
}

// Resolve the preferred hermes executable (first existing candidate).
function resolveHermesCmd() {
  return resolveHermesCandidates()[0] || null
}

// ── Kernel verification (source path + Ed25519 signature) ────────────────────

function isTrustedPath(p) {
  // Kernel should live under known managed locations, not arbitrary paths.
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const trustedRoots = [
    path.join(localApp, 'hermes'),
    process.resourcesPath,
    path.dirname(process.execPath),
    process.cwd(),
  ]
  const rp = path.resolve(p)
  return trustedRoots.some(root => rp.startsWith(path.resolve(root)))
}

async function sha256File(filePath) {
  const data = await fsPromises.readFile(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function listKernelArtifacts(hermesCmdPath) {
  const artifacts = []
  if (!hermesCmdPath || !fs.existsSync(hermesCmdPath)) return artifacts
  artifacts.push({ id: 'entry', path: hermesCmdPath, hash: await sha256File(hermesCmdPath) })
  const baseDir = path.dirname(hermesCmdPath)
  const candidates = [
    path.join(baseDir, 'hermes'),
    path.join(baseDir, 'hermes-cli'),
    path.join(baseDir, 'hermes_cli'),
    path.join(baseDir, 'python.exe'),
    path.join(baseDir, '..', 'Lib', 'site-packages', 'hermes', '__init__.py'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        artifacts.push({ id: path.relative(baseDir, c), path: c, hash: await sha256File(c) })
      }
    } catch {}
  }
  return artifacts
}

async function loadKernelPublicKey() {
  const candidates = [
    path.join(process.resourcesPath, 'kernel.pub'),
    path.join(process.resourcesPath, 'assets', 'kernel.pub'),
    path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'kernel.pub'),
    path.join(__dirname, '..', 'kernel.pub'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return await fsPromises.readFile(c)
    } catch {}
  }
  return null
}

async function verifyKernelSignature(hermesCmdPath) {
  const pubKey = await loadKernelPublicKey()
  if (!pubKey) {
    return { ok: false, hasKey: false, message: '未包含官方公钥（开发构建），已跳过 Ed25519 校验' }
  }
  const sigPath = hermesCmdPath + '.sig'
  if (!fs.existsSync(sigPath)) {
    return { ok: false, hasKey: true, hasSig: false, message: '未找到运行时签名文件 ' + sigPath }
  }
  try {
    const data = await fsPromises.readFile(hermesCmdPath)
    const sig = await fsPromises.readFile(sigPath)
    const ok = crypto.verify(null, data, pubKey, sig)
    return { ok, hasKey: true, hasSig: true, message: ok ? 'Ed25519 签名校验通过' : 'Ed25519 签名校验失败' }
  } catch (e) {
    return { ok: false, hasKey: true, hasSig: true, message: '签名校验出错：' + (e && e.message) }
  }
}

async function verifyKernel() {
  const hermesCmdPath = resolveHermesCmd()
  if (!hermesCmdPath) {
    return { ok: false, status: 'unknown', message: '未找到 Hermes 运行时可执行文件', artifacts: [], combinedHash: '' }
  }
  if (!isTrustedPath(hermesCmdPath)) {
    return { ok: false, status: 'untrusted', message: '运行时路径不在受信任安装目录中：' + hermesCmdPath, artifacts: [], combinedHash: '' }
  }
  const artifacts = await listKernelArtifacts(hermesCmdPath)
  const sigResult = await verifyKernelSignature(hermesCmdPath)
  const integrityInput = artifacts.map(a => a.hash).join('')
  const combinedHash = crypto.createHash('sha256').update(integrityInput).digest('hex').slice(0, 32)
  const status = sigResult.ok ? 'verified' : 'unverified'
  const message = sigResult.ok
    ? `内核来源已校验，完整性哈希 ${combinedHash}`
    : `${sigResult.message}；完整性哈希 ${combinedHash}`
  return { ok: sigResult.ok, status, message, artifacts, combinedHash, sig: sigResult }
}

module.exports = {
  resolveHermesCandidates,
  resolveHermesCmd,
  isTrustedPath,
  sha256File,
  listKernelArtifacts,
  loadKernelPublicKey,
  verifyKernelSignature,
  verifyKernel,
}
