// 记忆管理：频道名缓存、持久上下文加载、对话提取、记忆状态检测与提醒
const { join } = require('path')
const { readFileSync, writeFileSync, existsSync, statSync } = require('fs')
const config = require('./config')

// ── Channel name cache ──
const channelNames = new Map()

function registerChannel(channelId, name) {
  channelNames.set(channelId, name)
}

function getChannelName(channelId) {
  return channelNames.get(channelId)
}

function getChannelNames() {
  return channelNames
}

// ── Memory reminder & consolidation flags ──
const needsMemoryReminder = new Set()
const needsMemoryConsolidation = new Set()

/**
 * 加载持久上下文：soul.md + global.md + 频道热记忆（15KB截断）
 */
function loadPersistentContext(channelId) {
  const BOT_DIR = config.getBotDir()
  const MEMORY_DIR = join(BOT_DIR, 'memory')
  let ctx = ''

  // soul.md
  try {
    const soulPath = join(BOT_DIR, 'soul.md')
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf8')
      if (soul.trim()) ctx += '\n\n--- soul.md 性格 ---\n' + soul + '\n--- soul.md 结束 ---'
    }
  } catch {}

  // memory/global.md
  try {
    const globalPath = join(MEMORY_DIR, 'global.md')
    if (existsSync(globalPath)) {
      const globalMem = readFileSync(globalPath, 'utf8')
      if (globalMem.trim()) ctx += '\n\n--- 全局记忆 ---\n' + globalMem + '\n--- 全局记忆结束 ---'
    }
  } catch {}

  // memory/{频道名}.md — 热记忆，限制15KB
  const CH_MEM_LIMIT = 15 * 1024
  if (channelId) {
    const chName = channelNames.get(channelId)
    if (chName) {
      const safeChName = chName.replace(/[\/\\:*?"<>|]/g, '_')
      try {
        const chPath = join(MEMORY_DIR, safeChName + '.md')
        if (existsSync(chPath)) {
          let chMem = readFileSync(chPath, 'utf8')
          if (chMem.length > CH_MEM_LIMIT) {
            chMem = chMem.slice(0, CH_MEM_LIMIT) + '\n\n[... 记忆文件过大已截断，历史详情请 Read memory/' + safeChName + '_archive.md ...]'
          }
          if (chMem.trim()) ctx += '\n\n--- ' + chName + ' 频道记忆 ---\n' + chMem + '\n--- 频道记忆结束 ---'
        }
      } catch {}
    }
  }
  return ctx
}

/**
 * 从旧 session 提取最近 N 轮对话用于上下文延续
 */
function extractRecentConversation(sessionId, rounds = 5) {
  const sessionFile = join(config.getSessionDir(), `${sessionId}.jsonl`)
  try {
    if (!existsSync(sessionFile)) return ''
    const raw = readFileSync(sessionFile, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const collected = []
    let currentRound = null
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user') {
          const content = obj.message?.content
          let text = ''
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            text = content.filter(c => c.type === 'text').map(c => c.text || '').join('\n')
          }
          if (text.trim()) {
            const clean = text.replace(/\[图片:.*?\]/g, '').replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
            if (clean && !clean.startsWith('<')) {
              currentRound = { user: clean.slice(0, 1500), assistant: '' }
            }
          }
        } else if (obj.type === 'assistant' && currentRound) {
          const parts = obj.message?.content
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p.type === 'text' && p.text?.trim()) {
                currentRound.assistant += p.text.slice(0, 1500) + '\n'
              }
            }
          }
          if (currentRound.assistant.trim()) {
            collected.push(currentRound)
            currentRound = null
          }
        }
      } catch {}
    }
    const recent = collected.slice(-rounds)
    if (recent.length === 0) return ''
    let ctx = '\n\n--- 上一轮会话最近的对话（供你了解上下文） ---\n'
    for (const r of recent) {
      ctx += `用户: ${r.user}\n`
      ctx += `你: ${r.assistant.trim().slice(0, 1500)}\n\n`
    }
    ctx += '--- 最近对话结束 ---'
    return ctx
  } catch (e) {
    console.error(`[extractRecentConversation] failed for ${sessionId}: ${e.message}`)
    return ''
  }
}

/**
 * 检测 Claude 回复后是否需要记忆提醒：做了工作但没写记忆 + 膨胀检测 + activity.log
 * @param {string} channelId
 * @param {Array} toolUseBlocks - result.toolUse 数组
 * @param {string} userPrompt - 原始用户提示（用于 activity log）
 */
function checkMemoryStatus(channelId, toolUseBlocks, userPrompt) {
  const BOT_DIR = config.getBotDir()
  const tools = toolUseBlocks || []
  const WORK_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit']
  const workTools = tools.filter(t => WORK_TOOLS.includes(t.name))
  const wroteMemory = tools.some(t =>
    (t.name === 'Write' || t.name === 'Edit') &&
    typeof t.input?.file_path === 'string' &&
    t.input.file_path.includes('/memory/')
  )

  if (workTools.length > 0 && !wroteMemory) {
    needsMemoryReminder.add(channelId)
    const chName = channelNames.get(channelId) || 'unknown'
    console.log(`[${chName}] 📝 did work but no memory update, will remind next message`)
  } else {
    needsMemoryReminder.delete(channelId)
  }

  // Memory bloat check: warn if channel memory file exceeds 12KB
  if (wroteMemory) {
    const chName = channelNames.get(channelId) || 'unknown'
    const safeChName = chName.replace(/[\/\\:*?"<>|]/g, '_')
    const chMemPath = join(BOT_DIR, 'memory', safeChName + '.md')
    try {
      if (existsSync(chMemPath)) {
        const memSize = statSync(chMemPath).size
        if (memSize > 12 * 1024) {
          needsMemoryConsolidation.add(channelId)
          console.log(`[${chName}] 📦 memory ${(memSize / 1024).toFixed(1)}KB > 12KB, will remind to consolidate`)
        } else {
          needsMemoryConsolidation.delete(channelId)
        }
      }
    } catch {}
  }

  // Activity log
  if (workTools.length > 0) {
    const chName = channelNames.get(channelId) || 'unknown'
    const safeChName = chName.replace(/[\/\\:*?"<>|]/g, '_')
    const logFile = join(BOT_DIR, 'memory', safeChName + '_activity.log')
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const userSnippet = userPrompt.replace(/^\[频道:.*?\]\s*\[.*?\]:\s*/, '').slice(0, 100)
    const fileOps = workTools.map(t => {
      const filePath = t.input?.file_path || t.input?.command?.slice(0, 80) || ''
      const shortPath = filePath.split('/').slice(-2).join('/')
      return `${t.name}: ${shortPath}`
    }).join(', ')
    const logLine = `[${ts}] 用户: ${userSnippet} → ${fileOps}\n`
    try { writeFileSync(logFile, logLine, { flag: 'a' }) } catch {}
  }
}

/**
 * 返回拼接好的提醒文本（记忆更新提醒 + 膨胀提醒）
 */
function getReminders(channelId) {
  const chName = channelNames.get(channelId) || 'unknown'
  const safeChName = chName.replace(/[\/\\:*?"<>|]/g, '_')
  let text = ''
  if (needsMemoryReminder.has(channelId)) {
    text += `\n[提醒：你上次完成了工作但没有更新记忆文件，请在本次回复中更新 memory/${safeChName}.md 的「当前进行中」段落]\n`
  }
  if (needsMemoryConsolidation.has(channelId)) {
    text += `\n[提醒：频道记忆文件已超过12KB，请在本次工作完成后精简：合并「最近完成」的旧条目，把已完成的详细记录移到 memory/${safeChName}_archive.md，「踩过的坑」和「当前进行中」保持不动]\n`
  }
  return text
}

module.exports = {
  channelNames,
  registerChannel,
  getChannelName,
  getChannelNames,
  loadPersistentContext,
  extractRecentConversation,
  needsMemoryReminder,
  needsMemoryConsolidation,
  checkMemoryStatus,
  getReminders,
}
