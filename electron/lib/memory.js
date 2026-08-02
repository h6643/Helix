/**
 * Hermes memory sync (MEMORY.md / USER.md) + skill scanning helpers.
 * Extracted from main.js. Depends only on fs/os/path.
 *
 * Helix's manual memories are synchronized with Hermes's backend memory_manager
 * so the two systems stop keeping separate copies. Single source of truth:
 * <hermes_home>/memories/MEMORY.md (agent notes) and USER.md (user profile).
 * Entry format matches Hermes memory_tool: entries joined by "\n◊\n".
 */
const path = require('path')
const os = require('os')
const fsPromises = require('fs').promises

function hermesMemoriesDir() {
  const home = process.env.HERMES_HOME
    ? path.resolve(process.env.HERMES_HOME)
    : path.join(os.homedir(), 'AppData', 'Local', 'hermes')
  return path.join(home, 'memories')
}

const MEM_DELIM = '\n◊\n'

async function readMemFile(file) {
  try {
    const raw = await fsPromises.readFile(file, 'utf-8')
    if (!raw || !raw.trim()) return []
    return raw.split(MEM_DELIM).map(e => e.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function writeMemFile(file, entries) {
  const dir = path.dirname(file)
  await fsPromises.mkdir(dir, { recursive: true })
  const content = entries.join(MEM_DELIM)
  // Atomic write (temp + rename) to match Hermes memory_tool's contract and
  // avoid the truncation race window. Windows rename needs the target gone first.
  const tmp = path.join(dir, '.mem_' + Date.now() + '.tmp')
  await fsPromises.writeFile(tmp, content, 'utf-8')
  try { await fsPromises.unlink(file) } catch {}
  await fsPromises.rename(tmp, file)
}

// Manual-memory origin markers. Helix records which MEMORY.md entries it added
// manually so the UI can distinguish them from entries Hermes's self-evolution
// appended automatically. Stored as a separate dotfile (NOT an entry inside
// MEMORY.md) so it never pollutes agent-visible memory content or trips Hermes's
// drift detection (which only inspects MEMORY.md / USER.md entry bodies).
const MANUAL_MARKERS_FILE = '.helix_manual.json'

async function readManualMarkers(dir) {
  try {
    const raw = await fsPromises.readFile(
      path.join(dir, MANUAL_MARKERS_FILE),
      'utf-8',
    )
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

async function addManualMarker(dir, text) {
  const cur = await readManualMarkers(dir)
  if (cur.includes(text)) return
  cur.push(text)
  await fsPromises.mkdir(dir, { recursive: true })
  await fsPromises.writeFile(
    path.join(dir, MANUAL_MARKERS_FILE),
    JSON.stringify(cur, null, 2),
    'utf-8',
  )
}

async function removeManualMarker(dir, text) {
  const cur = await readManualMarkers(dir)
  const next = cur.filter((x) => x !== text)
  if (next.length === cur.length) return
  const file = path.join(dir, MANUAL_MARKERS_FILE)
  if (next.length === 0) {
    try { await fsPromises.unlink(file) } catch {}
    return
  }
  await fsPromises.writeFile(file, JSON.stringify(next, null, 2), 'utf-8')
}

const skillCallCounts = {}
const SKILL_CALL_COUNTS_FILE = 'skill-call-counts.json'

async function loadSkillCallCounts() {
  try {
    // First try to read from Hermes .usage.json (authoritative source)
    const usageFilePath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'skills', '.usage.json')
    const data = await fsPromises.readFile(usageFilePath, 'utf-8')
    const usageData = JSON.parse(data)
    // Map from .usage.json format: { skillName: { use_count: N } }
    for (const [name, info] of Object.entries(usageData)) {
      if (info && typeof info === 'object' && typeof info.use_count === 'number') {
        skillCallCounts[name] = info.use_count
      }
    }
  } catch {
    // Fallback to skill-call-counts.json
    try {
      const filePath = path.join(os.homedir(), 'AppData', 'Local', 'hermes', SKILL_CALL_COUNTS_FILE)
      const data = await fsPromises.readFile(filePath, 'utf-8')
      Object.assign(skillCallCounts, JSON.parse(data))
    } catch { /* file doesn't exist yet, use empty object */ }
  }
}

async function saveSkillCallCounts() {
  try {
    const dir = path.join(os.homedir(), 'AppData', 'Local', 'hermes')
    await fsPromises.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, SKILL_CALL_COUNTS_FILE)
    await fsPromises.writeFile(filePath, JSON.stringify(skillCallCounts, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Skills] Failed to save call counts:', err.message)
  }
}

function incrementSkillCallCount(skillName) {
  skillCallCounts[skillName] = (skillCallCounts[skillName] || 0) + 1
  saveSkillCallCounts()
  return skillCallCounts[skillName]
}

// Load call counts on startup
loadSkillCallCounts()

// Parse a skill's SKILL.md frontmatter into { name, description }.
function parseSkillFrontmatter(content, fallbackName) {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  let name = fallbackName
  let description = ''
  if (fm) {
    const block = fm[1]
    const nameM = block.match(/name:\s*(.+)/)
    const descM = block.match(/description:\s*(.+)/)
    if (nameM) name = nameM[1].trim()
    if (descM) description = descM[1].trim()
  }
  return { name, description }
}

async function collectSkillsFromDir(rootDir, isBuiltin, out) {
  // If rootDir itself is a skill (has SKILL.md), add it directly
  const selfSkillMd = path.join(rootDir, 'SKILL.md')
  try {
    await fsPromises.access(selfSkillMd)
    const content = await fsPromises.readFile(selfSkillMd, 'utf-8')
    const { name, description } = parseSkillFrontmatter(content, path.basename(rootDir))
    out.push({ id: selfSkillMd, name, description, isBuiltin, path: selfSkillMd, callCount: skillCallCounts[name] || 0 })
    return
  } catch { /* not a skill dir itself — scan subdirectories */ }

  let entries
  try {
    entries = await fsPromises.readdir(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'tests' || e.name.startsWith('.')) continue
    const full = path.join(rootDir, e.name)
    const skillMd = path.join(full, 'SKILL.md')
    try {
      await fsPromises.access(skillMd)
    } catch {
      await collectSkillsFromDir(full, isBuiltin, out)
      continue
    }
    const content = await fsPromises.readFile(skillMd, 'utf-8')
    const { name, description } = parseSkillFrontmatter(content, e.name)
    out.push({ id: skillMd, name, description, isBuiltin, path: skillMd, callCount: skillCallCounts[name] || 0 })
  }
}

module.exports = {
  hermesMemoriesDir,
  readMemFile,
  writeMemFile,
  readManualMarkers,
  addManualMarker,
  removeManualMarker,
  incrementSkillCallCount,
  collectSkillsFromDir,
}
