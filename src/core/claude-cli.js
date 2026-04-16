// Claude CLI 调用：spawn claude 进程、stream-json 解析、watchdog、403 熔断、排队机制
const { spawn, execSync } = require('child_process')
const { existsSync, statSync, readFileSync, writeFileSync } = require('fs')
const { join } = require('path')
const crypto = require('crypto')

const bus = require('./event-bus')
const config = require('./config')
const sessionMgr = require('./session-manager')
const memoryMgr = require('./memory-manager')

// ── 403 连续错误追踪（30秒内2次 = 关闭进程）──
let last403Time = 0

// ── 超时阈值 ──
const SLEEP_TIMEOUT = 30000   // sleep 命令：30s 后 kill
const CMD_TIMEOUT = 90000     // ssh/其他命令：90s 后 kill

// ── Token 用量追踪（按频道）──
const channelUsage = new Map()

// ── 每频道队列（防止并发 claude 调用）──
const queues = new Map()

// ── 活跃 Claude 进程追踪（用于 !stop 命令）──
const activeProcs = new Map() // channelId → { proc, kill() }

function enqueue(channelId, fn) {
  const prev = queues.get(channelId) || Promise.resolve()
  const next = prev.then(fn).catch(e => console.error(`[${channelId}]`, e))
  queues.set(channelId, next)
  return next
}

// ── 获取子进程命令信息 ──
function getProcessInfo(pid) {
  try {
    return execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8' }).trim()
  } catch { return '' }
}

// ── 杀死卡住的子进程 ──
function killStuckChildren(pid, silentMs) {
  let killed = 0
  try {
    const children = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
    for (const childPid of children) {
      const cmd = getProcessInfo(parseInt(childPid))
      const isSleep = cmd.startsWith('sleep ')
      const threshold = isSleep ? SLEEP_TIMEOUT : CMD_TIMEOUT

      if (silentMs < threshold) continue

      // 先杀孙进程（如 sshpass -> ssh -> remote cmd）
      try {
        const grandchildren = execSync(`pgrep -P ${childPid}`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
        for (const gc of grandchildren) {
          try { process.kill(parseInt(gc)) } catch {}
        }
      } catch {}
      try { process.kill(parseInt(childPid)); killed++ } catch {}
      const label = isSleep ? 'sleep' : cmd.slice(0, 60)
      console.log(`  ⚡ watchdog killed [${label}] after ${Math.round(silentMs / 1000)}s`)
    }
  } catch {}
  return killed
}

// ── 处理 403 错误：30秒内2次则关闭 ──
function handle403(channelId, source) {
  const now = Date.now()
  if (now - last403Time < 30000) {
    console.error(`🛑 [SHUTDOWN] 30秒内第2次 403 错误(${source})，正在关闭 bot 和所有 Claude 进程...`)
    bus.emit('event:push', { type: 'text', channelId, data: `🛑 30秒内连续 2 次 API 403 错误，自动关闭 bot 和所有 Claude 进程。` })
    // Kill only claude child processes of this bot (not other claude instances)
    try { execSync(`pkill -P ${process.pid} || true`, { stdio: 'pipe' }) } catch {}
    setTimeout(() => process.exit(1), 1000)
  } else {
    console.error(`🚨 [403 DETECTED via ${source}] in channel ${channelId}, waiting to see if another follows within 30s`)
  }
  last403Time = now
}

/**
 * 底层调用：spawn claude 进程，实时解析 stream-json 输出
 * @param {string[]} args - claude CLI 参数
 * @param {string} channelId - 频道 ID
 * @param {object} [options]
 * @param {function} [options.onText] - 每个 text block 的回调，用于流式发送
 * @returns {{ resultJson, resultText, allText, raw, toolUse }}
 */
function runClaude(args, channelId, { onText } = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = process.env.CLAUDE_CLI_PATH || 'claude'
    const proc = spawn(cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: config.getBotDir(),
    })
    proc.stdin.end()

    // Track active process for !stop command
    activeProcs.set(channelId, {
      proc,
      kill() {
        // SIGINT = graceful shutdown, Claude CLI will finish writing and close cleanly
        try { proc.kill('SIGINT') } catch {}
        // Force kill after 5 seconds if still alive
        setTimeout(() => {
          try {
            process.kill(proc.pid, 0) // check if still alive
            proc.kill('SIGKILL')
            // Also kill child processes
            try {
              const children = execSync(`pgrep -P ${proc.pid}`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
              for (const pid of children) { try { process.kill(parseInt(pid), 'SIGKILL') } catch {} }
            } catch {}
          } catch {} // process already exited, good
        }, 5000)
      }
    })

    let stdout = ''
    let stderr = ''
    let resultJson = null
    let resultText = ''
    let allTextBlocks = []
    let toolUseBlocks = []
    let lastOutputTime = Date.now()

    // Watchdog：每15秒检查卡住的子进程
    const watchdog = setInterval(() => {
      const silentMs = Date.now() - lastOutputTime
      if (silentMs > SLEEP_TIMEOUT) {
        const killed = killStuckChildren(proc.pid, silentMs)
        if (killed > 0) {
          bus.emit('event:push', { type: 'tool', channelId, data: { name: '⚡ watchdog', input: { action: `killed ${killed} stuck processes after ${Math.round(silentMs / 1000)}s` } } })
        }
      }
    }, 15000)

    proc.stdout.on('data', chunk => {
      stdout += chunk
      lastOutputTime = Date.now()
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const evt = JSON.parse(line)
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'thinking') {
                console.log(`  💭 ${block.thinking.slice(0, 150)}`)
                bus.emit('event:push', { type: 'thinking', channelId, data: block.thinking })
              } else if (block.type === 'text') {
                console.log(`  💬 ${block.text.slice(0, 150)}`)
                bus.emit('event:push', { type: 'text', channelId, data: block.text })
                allTextBlocks.push(block.text)
                // Stream text to caller immediately
                if (onText) onText(block.text)
                // 403 检测
                if (block.text.includes('API Error: 403') || block.text.includes('Request not allowed')) {
                  handle403(channelId, 'stdout')
                }
              } else if (block.type === 'tool_use') {
                console.log(`  🔧 ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`)
                bus.emit('event:push', { type: 'tool', channelId, data: { name: block.name, input: block.input } })
                toolUseBlocks.push({ name: block.name, input: block.input })
              }
            }
          } else if (evt.type === 'result') {
            resultJson = evt
            resultText = evt.result || ''
          }
        } catch {}
      }
    })

    proc.stderr.on('data', d => {
      stderr += d
      const errStr = d.toString()
      if (errStr.includes('API Error: 403') || errStr.includes('Request not allowed')) {
        handle403(channelId, 'stderr')
      }
    })

    proc.on('close', code => {
      clearInterval(watchdog)
      activeProcs.delete(channelId)
      if (code !== 0) reject(new Error(stderr || stdout.slice(0, 300) || `exit code ${code}`))
      else resolve({ resultJson, resultText, allText: allTextBlocks.join('\n\n'), raw: stdout.trim(), toolUse: toolUseBlocks })
    })
    proc.on('error', e => { clearInterval(watchdog); reject(e) })
  })
}

/**
 * 高层调用：处理 session 轮转/resume/新建、token 跟踪、记忆检查
 * @param {string} prompt - 用户消息
 * @param {string} channelId - 频道 ID
 * @param {object} [options]
 * @param {function} [options.onText] - 每个 text block 的回调，用于流式发送
 * @returns {string} Claude 的回复文本
 */
async function callClaude(prompt, channelId, { onText } = {}) {
  const sessionDir = config.getSessionDir()
  const tempDir = config.getTempDir()
  const botDir = config.getBotDir()

  sessionMgr.reloadSessionMap()
  const sessionId = sessionMgr.toSessionId(channelId)
  const systemPrompt = config.getSystemPrompt(channelId)
  const forceNew = sessionMgr.shouldStartNewSession(channelId)

  // 检查是否需要轮转（文件过大）
  if (!forceNew && sessionMgr.checkNeedsRotation(channelId)) {
    sessionMgr.markNeedsNewSession(channelId)
  }

  const actualForceNew = forceNew || sessionMgr.shouldStartNewSession(channelId)

  const commandsDir = join(botDir, 'commands')
  const baseArgs = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--add-dir', tempDir,
    '--add-dir', botDir,
    '--add-dir', commandsDir,
  ]

  let result

  if (actualForceNew) {
    // ── 新建 session ──
    sessionMgr.clearNeedsNewSession(channelId)
    const oldSessionId = sessionId
    const newId = crypto.randomUUID()
    const persistentCtx = memoryMgr.loadPersistentContext(channelId)
    const recentChat = memoryMgr.extractRecentConversation(oldSessionId)
    const enrichedPrompt = systemPrompt + persistentCtx + recentChat
    console.log(`[${channelId}] new session ${newId.slice(0, 8)}, persistent context ${persistentCtx.length} chars, recent chat ${recentChat.length} chars, old ${oldSessionId.slice(0, 8)}`)
    result = await runClaude([...baseArgs, '--session-id', newId, '--system-prompt', enrichedPrompt], channelId, { onText })
    // 确认新 session 文件已创建后再更新映射
    if (existsSync(join(sessionDir, newId + '.jsonl'))) {
      sessionMgr.onSessionRotated(channelId, oldSessionId, newId)
    } else {
      console.log(`[${channelId}] !new session ${newId.slice(0, 8)} .jsonl not found, keeping old session-map`)
    }
  } else {
    // ── Resume 或自动新建 ──
    const sessionFile = join(sessionDir, sessionId + '.jsonl')
    if (!existsSync(sessionFile)) {
      // session 文件不存在，自动新建
      console.log(`[${channelId}] session ${sessionId.slice(0, 8)} has no .jsonl file, auto-creating new session`)
      const newId = crypto.randomUUID()
      const enrichedPrompt = systemPrompt + memoryMgr.loadPersistentContext(channelId) + memoryMgr.extractRecentConversation(sessionId)
      result = await runClaude([...baseArgs, '--session-id', newId, '--system-prompt', enrichedPrompt], channelId, { onText })
      if (existsSync(join(sessionDir, newId + '.jsonl'))) {
        sessionMgr.updateSessionMapping(channelId, newId)
        console.log(`[${channelId}] new session ${newId.slice(0, 8)} confirmed, session-map updated`)
      } else {
        console.log(`[${channelId}] new session ${newId.slice(0, 8)} .jsonl not found, keeping old session-map`)
      }
    } else {
      // Resume 重试3次
      let lastError
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`[${channelId}] trying resume session ${sessionId} (attempt ${attempt})`)
          result = await runClaude([...baseArgs, '--resume', sessionId], channelId, { onText })
          lastError = null
          break
        } catch (e) {
          lastError = e
          const isTimeout = e.message?.includes('TIMEOUT') || e.message?.includes('timed out') || e.killed
          if (isTimeout) {
            console.log(`[${channelId}] timeout on session ${sessionId}, keeping session for next message`)
            bus.emit('event:push', { type: 'done', channelId, data: { error: 'timeout', inputTokens: 0, outputTokens: 0, cost: 0 } })
            throw new Error('处理超时了，但我还记得之前的对话。请再发一次消息试试。')
          }
          console.log(`[${channelId}] resume attempt ${attempt} failed: ${e.message?.slice(0, 100)}`)
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000))
        }
      }
      if (lastError) {
        // 3次 resume 全部失败，自动新建 session（带上下文）
        console.error(`[${channelId}] all resume attempts failed for session ${sessionId}, auto-creating new session`)
        const newId = crypto.randomUUID()
        const persistentCtx = memoryMgr.loadPersistentContext(channelId)
        const recentChat = memoryMgr.extractRecentConversation(sessionId)
        const enrichedPrompt = systemPrompt + persistentCtx + recentChat
        console.log(`[${channelId}] fallback new session ${newId.slice(0, 8)}, persistent context ${persistentCtx.length} chars, recent chat ${recentChat.length} chars`)
        result = await runClaude([...baseArgs, '--session-id', newId, '--system-prompt', enrichedPrompt], channelId, { onText })
        if (existsSync(join(sessionDir, newId + '.jsonl'))) {
          sessionMgr.updateSessionMapping(channelId, newId)
          console.log(`[${channelId}] fallback session ${newId.slice(0, 8)} confirmed, session-map updated`)
        } else {
          console.log(`[${channelId}] fallback session ${newId.slice(0, 8)} .jsonl not found, keeping old session-map`)
        }
      }
    }
  }

  // ── Token 用量统计 ──
  const rj = result.resultJson
  if (rj) {
    const usage = rj.usage || {}
    const cost = rj.total_cost_usd || 0
    const prev = channelUsage.get(channelId) || { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, totalCost: 0, calls: 0 }
    channelUsage.set(channelId, {
      inputTokens: prev.inputTokens + (usage.input_tokens || 0),
      outputTokens: prev.outputTokens + (usage.output_tokens || 0),
      cacheRead: prev.cacheRead + (usage.cache_read_input_tokens || 0),
      cacheCreate: prev.cacheCreate + (usage.cache_creation_input_tokens || 0),
      totalCost: prev.totalCost + cost,
      calls: prev.calls + 1,
      lastInput: usage.input_tokens || 0,
      lastOutput: usage.output_tokens || 0,
      lastCacheRead: usage.cache_read_input_tokens || 0,
      lastCost: cost,
    })
    console.log(`  ✅ tokens: in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cost=$${cost.toFixed(4)}`)
    bus.emit('event:push', { type: 'done', channelId, data: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cost } })
  }

  // ── 记忆提醒 & activity log ──
  const tools = result.toolUse || []
  memoryMgr.checkMemoryStatus(channelId, tools, prompt)

  // 返回所有文本（多步骤回复完整发送）
  return result.allText || result.resultText
}

function getChannelUsage() {
  return channelUsage
}

/**
 * 停止指定频道正在执行的 Claude 进程
 * @param {string} channelId
 * @returns {boolean} 是否成功找到并停止了进程
 */
function stopChannel(channelId) {
  const active = activeProcs.get(channelId)
  if (active) {
    active.kill()
    return true
  }
  return false
}

module.exports = { enqueue, callClaude, getChannelUsage, stopChannel }
