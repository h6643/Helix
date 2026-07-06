/**
 * 初始化 MCP 服务器配置
 * 运行方式: npx tsx scripts/init-mcp-servers.ts
 * 
 * 配置:
 * 1. Tavily MCP - AI 搜索引擎，实时获取网络信息
 * 2. GitHub MCP - 操作 GitHub（PR、Issue、仓库等）
 */

import fs from 'fs'
import path from 'path'

// 找到 helix-store 的持久化文件位置
// zustand 默认将状态存在 localStorage，但我们可以通过 API 路由来设置

const STORE_FILE = path.join(process.cwd(), 'src', 'stores', 'helix-store.ts')

console.log('🔧 正在初始化 MCP 服务器配置...\n')

// MCP 配置定义
const MCP_SERVERS = {
  tavily: {
    type: 'local' as const,
    command: ['npx', '-y', 'tavily-mcp'],
    enabled: true,
  },
  github: {
    type: 'local' as const,
    command: ['npx', '-y', '@modelcontextprotocol/server-github'],
    enabled: true,
    environment: {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_your_token_here',
    },
  },
}

// 打印使用说明
console.log('✅ MCP 服务器配置模板已生成\n')
console.log('请按照以下步骤完成配置：\n')

console.log('📦 方式一：通过 Web UI 配置（推荐）')
console.log('   1. 启动项目: npm run dev')
console.log('   2. 打开设置 → MCP Servers')
console.log('   3. 添加以下服务器：\n')

for (const [name, config] of Object.entries(MCP_SERVERS)) {
  console.log(`   ┌─ ${name.toUpperCase()}`)
  console.log(`   │ 类型: ${config.type}`)
  console.log(`   │ 命令: ${config.command?.join(' ')}`)
  if ('environment' in config && config.environment) {
    for (const [key, val] of Object.entries(config.environment)) {
      console.log(`   │ 环境变量: ${key} = ${val}`)
    }
  }
  console.log(`   │ 启用: ${config.enabled ? '是' : '否'}`)
  console.log('   └─\n')
}

console.log('📦 方式二：通过配置文件')
console.log('   在项目根目录创建 helix.json 或 .helixrc.json：\n')

const configJson = JSON.stringify({ mcp: MCP_SERVERS }, null, 2)
console.log(configJson)
console.log()

console.log('⚙️  GitHub MCP 额外说明：')
console.log('   1. 前往 https://github.com/settings/tokens 创建 Personal Access Token')
console.log('   2. 勾选 repo 权限')
console.log('   3. 将 token 填入 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量')
console.log()

console.log('⚙️  Tavily MCP 额外说明：')
console.log('   1. 前往 https://tavily.com/ 注册获取 API Key')
console.log('   2. 如需 API Key，添加环境变量: TAVILY_API_KEY')
console.log()

console.log('📥 安装依赖（可选，用于本地开发）:')
console.log('   npm install -D @modelcontextprotocol/server-github')
console.log('   npm install -D tavily-mcp')
console.log()

console.log('💡 提示: 配置完成后重启开发服务器使配置生效')
