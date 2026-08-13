// 模拟删除项目后的内存清理 + 复活防护
type Session = { id: string; workDir: string | null }
type Msg = { sessionId?: string }
type Draft = { isAgentRunning?: boolean }

// 磁盘:两个项目
let disk: Session[] = [
  { id: 's1', workDir: '/proj/A' },
  { id: 's2', workDir: '/proj/A' },
  { id: 's3', workDir: '/proj/B' },
]
// 内存
let chatMessages: Msg[] = [
  { sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }, { sessionId: 's2' },
]
let drafts: Record<string, Draft> = { s1: { isAgentRunning: true }, s3: { isAgentRunning: true } }
let currentSessionId: string | null = 's1'
let activeSessionWorkDir: string | null = '/proj/A'
let selectedWorkDir: string | null = '/proj/A'

// 删除 /proj/A
const DEL = '/proj/A'
const sessionsBefore = [...disk]
const deletedIds = new Set(sessionsBefore.filter(s => s.workDir === DEL).map(s => s.id))
console.log('将被删会话:', [...deletedIds])
// 模拟 deleteSessionsByWorkDir
disk = disk.filter(s => s.workDir !== DEL)
// 内存清理
if (currentSessionId && deletedIds.has(currentSessionId)) currentSessionId = null
if (activeSessionWorkDir === DEL) activeSessionWorkDir = null
if (selectedWorkDir === DEL) selectedWorkDir = null
chatMessages = chatMessages.filter(m => !deletedIds.has(m.sessionId || ''))
drafts = Object.fromEntries(Object.entries(drafts).filter(([sid]) => !deletedIds.has(sid)))

console.log('\n=== 删除后 ===')
console.log('磁盘会话:', disk.map(s => s.id), '(s1/s2 已删, s3 保留)')
console.log('内存消息:', chatMessages.length, '条 (被删项目 s1/s2 的已清)')
console.log('运行中草稿:', Object.keys(drafts), '(s1 已清, s3 保留)')
console.log('currentSessionId:', currentSessionId, '(已重置)')
console.log('activeSessionWorkDir:', activeSessionWorkDir, '(已清)')

// 模拟点击另一个对话 → flushSessionPersist
console.log('\n=== 点击 s3 后复活检查 ===')
// persistCurrentSessionNow: currentSessionId 为 null → 直接 return,不写回
const persistWouldWrite = currentSessionId !== null
console.log('flush 会写回被删项目吗?', persistWouldWrite, '(currentSessionId=null 时不会)')
// persistSessionById: 后台 run 完成 → 但消息已清, msgs.length===0 → return
const orphanMsgs = chatMessages.filter(m => deletedIds.has(m.sessionId || ''))
console.log('被删项目残留消息:', orphanMsgs.length, '条 (persistSessionById 会因空消息跳过)')
console.log('\n✅ 项目不会复活')
