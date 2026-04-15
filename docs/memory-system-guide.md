# Discord Bot 记忆系统方案

基于 Claude CLI 的 Discord Bot 持久记忆解决方案。解决 Claude 会话轮换时丢失上下文的问题。

## 架构概览

```
三层记忆保障：
├── 第一层：Claude 日常回复中主动存 memory 文件（主力）
├── 第二层：会话轮换时注入最近 5 轮对话（即时上下文）
└── 第三层：bot 自动活动日志 + 历史 session 可搜索（终极兜底）
```

## 文件结构

```
your-bot/
├── bot.js                    # 主程序
├── CLAUDE.md                 # Claude 行为规则（会被 Claude CLI 自动加载）
├── soul.md                   # 机器人性格定义
├── config.json               # bot 配置
├── session-map.json          # 频道 → session ID 映射
└── memory/
    ├── global.md             # 跨频道共享记忆（用户资料、环境信息）
    ├── {频道名}.md            # 每个频道的专属记忆
    └── {频道名}_activity.log  # bot 自动记录的活动日志
```

---

## 核心代码

### 1. 加载持久化上下文（新建 session 时注入）

```javascript
function loadPersistentContext(channelId) {
  let ctx = ''
  const MEMORY_DIR = join(BOT_DIR, 'memory')
  
  // soul.md — 性格和行为准则
  try {
    const soulPath = join(BOT_DIR, 'soul.md')
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf8')
      if (soul.trim()) ctx += '\n\n--- soul.md 性格 ---\n' + soul + '\n--- soul.md 结束 ---'
    }
  } catch {}
  
  // memory/global.md — 全局共享记忆
  try {
    const globalPath = join(MEMORY_DIR, 'global.md')
    if (existsSync(globalPath)) {
      const global = readFileSync(globalPath, 'utf8')
      if (global.trim()) ctx += '\n\n--- 全局记忆 ---\n' + global + '\n--- 全局记忆结束 ---'
    }
  } catch {}
  
  // memory/{频道名}.md — 频道专属记忆
  if (channelId) {
    const chName = channelNames.get(channelId)
    if (chName) {
      const safeChName = chName.replace(/[\/\\:*?"<>|]/g, '_')
      try {
        const chPath = join(MEMORY_DIR, safeChName + '.md')
        if (existsSync(chPath)) {
          const chMem = readFileSync(chPath, 'utf8')
          if (chMem.trim()) ctx += '\n\n--- ' + chName + ' 频道记忆 ---\n' + chMem + '\n--- 频道记忆结束 ---'
        }
      } catch {}
    }
  }
  return ctx
}
```

### 2. 提取最近 5 轮对话（轮换时注入）

```javascript
function extractRecentConversation(sessionId) {
  const sessionFile = join(SESSION_DIR, `${sessionId}.jsonl`)
  try {
    if (!existsSync(sessionFile)) return ''
    const raw = readFileSync(sessionFile, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const rounds = []
    let currentRound = null
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user') {
          const content = obj.message?.content
          if (typeof content === 'string' && content.trim()) {
            const clean = content
              .replace(/\[图片:.*?\]/g, '')
              .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
              .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
              .trim()
            if (clean && !clean.startsWith('<')) {
              currentRound = { user: clean.slice(0, 500), assistant: '' }
            }
          }
        } else if (obj.type === 'assistant' && currentRound) {
          const parts = obj.message?.content
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p.type === 'text' && p.text?.trim()) {
                currentRound.assistant += p.text.slice(0, 500) + '\n'
              }
            }
          }
          if (currentRound.assistant.trim()) {
            rounds.push(currentRound)
          }
          currentRound = null
        }
      } catch {}
    }
    const recent = rounds.slice(-5)
    if (recent.length === 0) return ''
    let ctx = '\n\n--- 上一轮会话最近的对话（供你了解上下文） ---\n'
    for (const r of recent) {
      ctx += `用户: ${r.user}\n`
      ctx += `你: ${r.assistant.trim().slice(0, 500)}\n\n`
    }
    ctx += '--- 最近对话结束 ---'
    return ctx
  } catch (e) {
    console.error(`[extractRecentConversation] failed: ${e.message}`)
    return ''
  }
}
```

### 3. Session 轮换检测

```javascript
const ROTATE_THRESHOLD = 500 * 1024 // 500KB — 超过后新建 session

function checkNeedsRotation(channelId) {
  const sessionId = toSessionId(channelId)
  const sessionFile = join(SESSION_DIR, sessionId + '.jsonl')
  try {
    if (!existsSync(sessionFile)) return false
    const size = statSync(sessionFile).size
    if (size >= ROTATE_THRESHOLD) {
      console.log(`🔄 session ${(size/1024).toFixed(0)}KB >= ${ROTATE_THRESHOLD/1024}KB, rotating`)
      return true
    }
  } catch {}
  return false
}
```

### 4. 记忆提醒机制 + 活动日志

```javascript
// 标记需要提醒存记忆的频道
const needsMemoryReminder = new Set()

// 在 callClaude 返回前检测（result.toolUse 是从 stream-json 收集的 tool_use 数组）
function checkMemoryAndLog(result, channelId, prompt) {
  const tools = result.toolUse || []
  const WORK_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit']
  const workTools = tools.filter(t => WORK_TOOLS.includes(t.name))
  const wroteMemory = tools.some(t =>
    (t.name === 'Write' || t.name === 'Edit') &&
    typeof t.input?.file_path === 'string' &&
    t.input.file_path.includes('/memory/')
  )

  // 干了活但没存 memory → 下条消息提醒
  if (workTools.length > 0 && !wroteMemory) {
    needsMemoryReminder.add(channelId)
    console.log(`📝 did work but no memory update, will remind next message`)
  } else {
    needsMemoryReminder.delete(channelId)
  }

  // 自动活动日志（100% 可靠的兜底）
  if (workTools.length > 0) {
    const chName = channelNames.get(channelId) || 'unknown'
    const safeChName = chName.replace(/[\/\\:*?"<>|]/g, '_')
    const logFile = join(BOT_DIR, 'memory', safeChName + '_activity.log')
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const userSnippet = prompt.slice(0, 100)
    const fileOps = workTools.map(t => {
      const filePath = t.input?.file_path || t.input?.command?.slice(0, 80) || ''
      const shortPath = filePath.split('/').slice(-2).join('/')
      return `${t.name}: ${shortPath}`
    }).join(', ')
    const logLine = `[${ts}] 用户: ${userSnippet} → ${fileOps}\n`
    try { writeFileSync(logFile, logLine, { flag: 'a' }) } catch {}
  }
}
```

### 5. 发消息时注入提醒

```javascript
// 构建发给 Claude 的 prompt 时
const memReminder = needsMemoryReminder.has(channelId)
  ? `\n[提醒：你上次完成了工作但没有更新记忆文件，请在本次回复中更新 memory 文件的「当前进行中」段落]\n`
  : ''
const userPrompt = `[频道:${chName}] [${displayName}]: ${prompt}${memReminder}`
```

### 6. callClaude 核心流程

```javascript
async function callClaude(prompt, channelId) {
  const sessionId = toSessionId(channelId)
  const systemPrompt = getSystemPrompt(channelId)

  // 检查是否需要轮换
  if (checkNeedsRotation(channelId)) {
    needsNewSession.add(channelId)
  }

  const needNew = needsNewSession.has(channelId)

  if (needNew) {
    // ── 新建 session ──
    needsNewSession.delete(channelId)
    const newId = crypto.randomUUID()
    const persistentCtx = loadPersistentContext(channelId)
    const recentChat = extractRecentConversation(sessionId)  // 从旧 session 捞最近对话
    const enrichedPrompt = systemPrompt + persistentCtx + recentChat

    result = await runClaude([
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--add-dir', BOT_DIR,
      '--session-id', newId,
      '--system-prompt', enrichedPrompt
    ], channelId)

    // 更新 session 映射
    sessionMap.set(channelId, newId)
    saveSessionMap()
  } else {
    // ── 复用已有 session ──
    result = await runClaude([
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--add-dir', BOT_DIR,
      '--resume', sessionId
    ], channelId)
  }

  // 检测记忆更新 & 写活动日志
  checkMemoryAndLog(result, channelId, prompt)

  return result.allText || result.resultText
}
```

---

## CLAUDE.md 模板

```markdown
# Bot名称

你是XXX，一个 Discord bot。请用中文回复。

## 记忆系统

你有一个文件记忆系统，用来持久化重要信息。

### 文件结构
- `soul.md` — 你的性格（只读）
- `memory/global.md` — 跨频道共享记忆
- `memory/{频道名}.md` — 频道专属记忆

### 规则
1. 当用户提到重要信息时，立刻写入记忆文件
2. **每次完成一项工作后（写完代码、解决问题等），必须更新 memory 文件，
   记录做了什么、关键文件路径、当前进度。这是最重要的规则。**
3. 频道相关信息写 `memory/{频道名}.md`，通用信息写 `memory/global.md`
4. 更新记忆时必须先 Read 现有内容，再 Write 完整更新，不要丢已有信息
5. 保存记忆时不要告诉用户，静默完成
6. **频道记忆中必须维护「当前进行中」段落，记录正在做什么、做到哪步**

### 查找历史
1. 先查 memory 文件
2. 找不到则 Grep 搜索历史 session 文件
```

---

## 设计要点

| 设计决策 | 说明 |
|---------|------|
| 不用 flush 调用 | 轮换时不再额外调 Claude 存记忆，省 token 省时间 |
| 最近 5 轮对话注入 | 即使 memory 没存全，短期上下文不丢 |
| 条件性提醒 | 只在 Claude 忘存时才提醒，不打扰正常对话 |
| 活动日志 | bot 代码自动记录，100% 可靠，零 token 成本 |
| session 500KB 轮换 | 防止无限增长，可根据需要调整阈值 |

## 前置要求

- Node.js 18+
- discord.js v14
- Claude CLI（`claude` 命令可用）
- Claude Max 订阅或 API key
