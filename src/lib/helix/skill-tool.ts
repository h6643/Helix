import type { ToolDefinition } from '@/lib/agent/tools'
import fs from 'fs/promises'
import path from 'path'

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'builtin' | 'user' | 'project'
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '~'
}

function getUserSkillsDir(): string {
  return path.join(getHomeDir(), '.helix', 'skills')
}

function getProjectSkillsDir(): string {
  return path.join(process.cwd(), 'skills')
}

function getBuiltinSkillsDir(): string {
  return path.join(getHomeDir(), '.helix', 'skills-builtin')
}

function parseFrontmatter(content: string): { description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return { description: '' }
  const descLine = match[1].split(/\r?\n/).find(l => l.trim().startsWith('description:'))
  if (!descLine) return { description: '' }
  const value = descLine.replace(/^description:\s*"?|"?\s*$/g, '').trim()
  return { description: value }
}

async function scanDir(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(dir, entry.name, 'SKILL.md')
      try {
        const content = await fs.readFile(skillPath, 'utf-8')
        const { description } = parseFrontmatter(content)
        skills.push({ name: entry.name, description, path: skillPath, source })
      } catch { /* no SKILL.md in this dir */ }
    }
  } catch { /* dir doesn't exist or unreadable */ }
  return skills
}

export async function listSkills(): Promise<SkillInfo[]> {
  const seen = new Set<string>()
  const skills: SkillInfo[] = []

  // Priority: project > user > builtin
  const dirs: [string, SkillInfo['source']][] = [
    [getProjectSkillsDir(), 'project'],
    [getUserSkillsDir(), 'user'],
    [getBuiltinSkillsDir(), 'builtin'],
  ]

  for (const [dir, source] of dirs) {
    for (const skill of await scanDir(dir, source)) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      skills.push(skill)
    }
  }

  return skills
}

export async function loadSkill(name: string): Promise<string | null> {
  const dirs = [getProjectSkillsDir(), getUserSkillsDir(), getBuiltinSkillsDir()]

  for (const dir of dirs) {
    // Try <name>/SKILL.md first (Helix convention)
    const dirPath = path.join(dir, name, 'SKILL.md')
    try {
      const content = await fs.readFile(dirPath, 'utf-8')
      const files: string[] = []
      try {
        const dirFiles = await fs.readdir(path.join(dir, name))
        files.push(...dirFiles.filter(f => f !== 'SKILL.md').map(f => path.join(dir, name, f)))
      } catch { /* ignore */ }

      const parts = [`<skill name="${name}">`, content.trim()]
      if (files.length > 0) {
        parts.push('', '<skill_files>', files.map(f => `<file>${f}</file>`).join('\n'), '</skill_files>')
      }
      parts.push('</skill>')
      return parts.join('\n')
    } catch { /* not found, try next dir */ }

    // Fallback: <name>.md flat file
    const flatPath = path.join(dir, `${name}.md`)
    try {
      const content = await fs.readFile(flatPath, 'utf-8')
      return `<skill name="${name}">\n${content.trim()}\n</skill>`
    } catch { /* not found */ }
  }

  return null
}

export async function buildAvailableSkillsXml(): Promise<string> {
  const skills = await listSkills()
  if (skills.length === 0) return ''

  const lines = ['<available_skills>']
  for (const skill of skills) {
    lines.push('  <skill>')
    lines.push(`    <name>${skill.name}</name>`)
    lines.push(`    <description>${skill.description}</description>`)
    lines.push(`    <source>${skill.source}</source>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

export async function saveSkill(name: string, description: string, content: string): Promise<SkillInfo> {
  const dir = getProjectSkillsDir()
  const skillDir = path.join(dir, name)
  const skillPath = path.join(skillDir, 'SKILL.md')
  await fs.mkdir(skillDir, { recursive: true })
  const frontmatter = `---
name: ${name}
description: "${description.replace(/"/g, '\\"')}"
---

`
  await fs.writeFile(skillPath, frontmatter + content, 'utf-8')
  return { name, description, path: skillPath, source: 'project' }
}

export async function deleteSkill(name: string): Promise<boolean> {
  // Only delete from user or project level — never builtin
  for (const dir of [getProjectSkillsDir(), getUserSkillsDir()]) {
    const skillDir = path.join(dir, name)
    try {
      await fs.access(skillDir)
      await fs.rm(skillDir, { recursive: true, force: true })
      return true
    } catch { /* not in this dir, try next */ }
  }
  return false
}

export const SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: 'skill',
  description: 'Load a specialized skill when the task at hand matches one of the skills listed in <available_skills>. Call this tool with the skill name to inject its instructions into the conversation.',
  parameters: {
    name: { type: 'string', description: 'The name of the skill to load from available_skills', required: true },
  },
  execute: async (params) => {
    const name = params.name as string
    const content = await loadSkill(name)
    if (content) return content
    const available = await listSkills()
    const names = available.map(s => `  - ${s.name} [${s.source}]: ${s.description}`).join('\n')
    return `Skill "${name}" not found.\n\nAvailable skills:\n${names || '  (none)'}\n\nDefine skills as .helix/skills/<name>/SKILL.md`
  },
}
