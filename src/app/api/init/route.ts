import { NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'

async function scanDirectory(dir: string, depth: number = 0, maxDepth: number = 3): Promise<string> {
  if (depth > maxDepth) return ''
  const entries: string[] = []
  try {
    const items = await fs.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === '.next' || item.name === 'dist' || item.name === 'build' || item.name === '.git') continue
      const fullPath = path.join(dir, item.name)
      if (item.isDirectory()) {
        entries.push(`${'  '.repeat(depth)}${item.name}/`)
        const sub = await scanDirectory(fullPath, depth + 1, maxDepth)
        if (sub) entries.push(sub)
      } else if (item.isFile()) {
        entries.push(`${'  '.repeat(depth)}${item.name}`)
      }
    }
  } catch { }
  return entries.join('\n')
}

async function detectTechStack(dir: string): Promise<string[]> {
  const tags: string[] = []
  try {
    const pkg = await fs.readFile(path.join(dir, 'package.json'), 'utf-8')
    const json = JSON.parse(pkg)
    const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) }
    if (deps.next) tags.push('Next.js')
    if (deps.react) tags.push('React')
    if (deps.vue) tags.push('Vue')
    if (deps.express) tags.push('Express')
    if (deps['@angular/core']) tags.push('Angular')
    if (deps.typescript) tags.push('TypeScript')
    if (deps.tailwindcss) tags.push('Tailwind CSS')
    if (deps.prisma) tags.push('Prisma')
    if (deps.pnpm) tags.push('pnpm')
    else if (deps.yarn) tags.push('Yarn')
    else tags.push('npm')
    if (json.scripts?.test) tags.push('has-tests')
  } catch { }
  try {
    const cargo = await fs.readFile(path.join(dir, 'Cargo.toml'), 'utf-8')
    tags.push('Rust')
    if (cargo.includes('tokio')) tags.push('Tokio')
  } catch { }
  try {
    await fs.access(path.join(dir, 'go.mod'))
    tags.push('Go')
  } catch { }
  try {
    const gems = await fs.readFile(path.join(dir, 'Gemfile'), 'utf-8')
    tags.push('Ruby')
    if (gems.includes('rails')) tags.push('Rails')
  } catch { }
  try {
    await fs.access(path.join(dir, 'pyproject.toml'))
    tags.push('Python')
  } catch { }
  try {
    await fs.access(path.join(dir, 'CMakeLists.txt'))
    tags.push('CMake')
  } catch { }
  return tags
}

export async function GET() {
  const workDir = process.cwd()
  const projectName = path.basename(workDir)

  try {
    const [tree, techStack] = await Promise.all([
      scanDirectory(workDir, 0, 2),
      detectTechStack(workDir),
    ])

    const tags = techStack.join(', ') || 'unknown'

    const agentsMd = `# ${projectName}

## 项目概述
- **技术栈**: ${tags}
- **项目目录**: ${workDir}

## 项目结构
\`\`\`
${tree || '(empty project)'}
\`\`\`

## 开发规范

### 代码风格
- 遵循项目已有的代码风格和命名约定
- TypeScript 项目使用严格模式
- 组件使用函数式组件 + Hooks

### 包管理
${techStack.includes('pnpm') ? '- 使用 pnpm 安装依赖\n- 不要使用 npm 或 yarn' : techStack.includes('Yarn') ? '- 使用 yarn 安装依赖' : '- 使用 npm 安装依赖'}

### 测试
${techStack.includes('has-tests') ? '- 修改代码后确保通过现有测试\n- 新功能添加对应测试' : '- 暂无测试配置'}

### Git
- 保持提交信息清晰简洁
- 遵循 Conventional Commits 规范

## 重要说明
- 此文件由 Helix 自动生成，请根据项目实际情况修改
`

    await fs.writeFile(path.join(workDir, 'AGENTS.md'), agentsMd, 'utf-8')

    return NextResponse.json({
      success: true,
      path: path.join(workDir, 'AGENTS.md'),
      workDir,
      projectName,
      techStack: tags,
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
