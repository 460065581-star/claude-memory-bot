// 本地 Web Dashboard 服务
// 提供实时事件流、Session 管理、健康检查等 API

'use strict'

const { createServer } = require('http')
const { execSync } = require('child_process')
const { join } = require('path')
const {
  readFileSync, writeFileSync, existsSync, statSync,
  readdirSync, mkdirSync, copyFileSync, unlinkSync, appendFileSync
} = require('fs')

const bus = require('../core/event-bus')
const config = require('../core/config')
const sessionManager = require('../core/session-manager')
const { getDashboardHTML, getHealthHTML } = require('./local-pages')

// ── Event system ──
const eventLog = []
const EVENT_FILE = join(config.getBotDir(), 'events.jsonl')
const sseClients = new Set()

// Load existing events from disk
try {
  const lines = readFileSync(EVENT_FILE, 'utf8').split('\n').filter(Boolean)
  for (const line of lines.slice(-3000)) {
    try { eventLog.push(JSON.parse(line)) } catch {}
  }
  console.log(`[dashboard] Loaded ${eventLog.length} events from disk`)
} catch {}

// Listen for events from other modules
bus.on('event:push', (evt) => {
  if (!evt.ts) evt.ts = Date.now()
  eventLog.push(evt)
  if (eventLog.length > 3000) eventLog.shift()
  // Persist to disk
  try { appendFileSync(EVENT_FILE, JSON.stringify(evt) + '\n') } catch {}
  // Push to SSE clients
  const msg = `data: ${JSON.stringify(evt)}\n\n`
  for (const res of sseClients) {
    res.write(msg)
  }
})

// ── Start time for uptime calculation ──
const startTime = Date.now()

// ── Health monitoring functions ──

function getProcessStatus() {
  try {
    const pid = process.pid.toString()
    const info = execSync(`ps -o pid=,rss=,%mem=,%cpu=,etime= -p ${pid}`, { encoding: 'utf-8' }).trim()
    const parts = info.split(/\s+/)
    return {
      running: true,
      pid: parts[0],
      memoryMB: Math.round(parseInt(parts[1]) / 1024),
      memPercent: parseFloat(parts[2]),
      cpuPercent: parseFloat(parts[3]),
      uptime: parts[4],
    }
  } catch {
    return {
      running: true,
      pid: process.pid.toString(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      memPercent: 0,
      cpuPercent: 0,
      uptime: Math.round((Date.now() - startTime) / 1000) + 's',
    }
  }
}

function getSessionsHealth() {
  const toK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString()
  const SESSION_DIR = config.getSessionDir()
  const { sessionMap, toSessionId } = sessionManager

  // Build reverse map: sessionId -> channelId
  const reverseMap = new Map()
  for (const [chId, sId] of sessionMap) reverseMap.set(sId, chId)

  // channelNames and channelUsage are accessed via bus events or passed context
  // For now, use what sessionManager exposes
  try {
    const files = readdirSync(SESSION_DIR).filter(f => f.endsWith('.jsonl'))
    return files.map(f => {
      const fp = join(SESSION_DIR, f)
      const st = statSync(fp)
      const sizeBytes = st.size
      const sizeHuman = sizeBytes < 1024 ? sizeBytes + ' B'
        : sizeBytes < 1048576 ? (sizeBytes / 1024).toFixed(1) + ' KB'
        : (sizeBytes / 1048576).toFixed(1) + ' MB'
      let status = 'normal'
      if (sizeBytes > 3 * 1024 * 1024) status = 'danger'
      else if (sizeBytes > 1024 * 1024) status = 'warning'
      else if (sizeBytes > 100 * 1024) status = 'info'
      const sid = f.replace('.jsonl', '')
      const chIdFound = reverseMap.get(sid) || null
      const name = chIdFound ? (channelNames.get(chIdFound) || sid.slice(0, 8)) : sid.slice(0, 8)
      const tokens = channelUsage.has && channelUsage.get ? _getTokens(sid, toK) : null
      return {
        id: sid, filename: f, channelId: chIdFound,
        name, sizeBytes, sizeHuman, status,
        mtime: st.mtime.toISOString(), tokens,
      }
    }).sort((a, b) => b.sizeBytes - a.sizeBytes)
  } catch { return [] }
}

function _getTokens(sid, toK) {
  for (const [chId, u] of channelUsage) {
    if (sessionManager.toSessionId(chId) === sid) {
      return {
        input: toK(u.inputTokens + u.cacheRead + u.cacheCreate),
        output: toK(u.outputTokens),
        cost: u.totalCost.toFixed(4),
      }
    }
  }
  return null
}

function trimSession(filename) {
  const SESSION_DIR = config.getSessionDir()
  if (!/^[a-zA-Z0-9_\-\.]+\.jsonl$/.test(filename)) return { success: false, message: 'Invalid filename' }
  const src = join(SESSION_DIR, filename)
  if (!existsSync(src)) return { success: false, message: 'File not found' }
  const TEXT_THRESHOLD = 10 * 1024 // 10KB for text tool results
  try {
    const raw = readFileSync(src, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim())
    let trimCount = 0, savedBytes = 0

    function trimContent(content) {
      if (!Array.isArray(content)) return false
      let modified = false
      for (let i = 0; i < content.length; i++) {
        const c = content[i]
        if (c.type === 'image' && c.source?.type === 'base64') {
          const oldLen = JSON.stringify(c).length
          content[i] = { type: 'text', text: '[trimmed image] original size: ' + Math.round(oldLen / 1024) + 'KB' }
          savedBytes += oldLen - JSON.stringify(content[i]).length
          trimCount++
          modified = true
        }
        if (c.type === 'text' && c.text && c.text.length > TEXT_THRESHOLD) {
          const oldLen = c.text.length
          const preview = c.text.slice(0, 200).replace(/\n/g, ' ')
          c.text = '[trimmed] original size: ' + Math.round(oldLen / 1024) + 'KB | preview: ' + preview + '...'
          savedBytes += oldLen - c.text.length
          trimCount++
          modified = true
        }
        if (c.content && Array.isArray(c.content)) {
          if (trimContent(c.content)) modified = true
        }
      }
      return modified
    }

    const newLines = lines.map(line => {
      try {
        const obj = JSON.parse(line)
        const msg = obj.message
        if (msg && msg.content && Array.isArray(msg.content)) {
          if (trimContent(msg.content)) return JSON.stringify(obj)
        }
      } catch {}
      return line
    })
    if (trimCount === 0) return { success: true, message: 'Nothing to trim' }
    copyFileSync(src, src + '.pretrim')
    writeFileSync(src, newLines.join('\n') + '\n')
    const newSize = statSync(src).size
    return {
      success: true,
      message: 'Trimmed ' + trimCount + ' items (images+large text), saved ' +
        (savedBytes / 1024 / 1024).toFixed(1) + 'MB, now ' +
        (newSize / 1024 / 1024).toFixed(1) + 'MB',
    }
  } catch (e) { return { success: false, message: e.message } }
}

function getStuckDetection() {
  const now = Date.now()
  const recent = eventLog.filter(e => e.ts > now - 3600000) // last 1h
  const longRunning = []
  // Check channels that have a user message but no done after it for > 3 min
  const channelsSeen = new Set()
  for (const e of recent) {
    if (e.channelId) channelsSeen.add(e.channelId)
  }
  for (const chId of channelsSeen) {
    const lastDone = [...eventLog].reverse().find(e => e.channelId === chId && e.type === 'done')
    const lastUser = [...eventLog].reverse().find(e => e.channelId === chId && e.type === 'user')
    if (lastUser && (!lastDone || lastDone.ts < lastUser.ts) && (now - lastUser.ts > 180000)) {
      longRunning.push({
        channelId: chId,
        channelName: lastUser.channelName || chId.slice(-6),
        waitingSince: lastUser.ts,
        waitingMinutes: Math.round((now - lastUser.ts) / 60000),
      })
    }
  }
  return { hasIssues: longRunning.length > 0, longRunning }
}

// ── Shared state references (set by the main app via setContext) ──
let channelNames = new Map()
let channelUsage = new Map()

/**
 * Allow the main app to inject runtime context
 * @param {{ channelNames: Map, channelUsage: Map }} ctx
 */
function setContext(ctx) {
  if (ctx.channelNames) channelNames = ctx.channelNames
  if (ctx.channelUsage) channelUsage = ctx.channelUsage
}

/**
 * Start the local dashboard HTTP server
 * @param {number} port - Port number to listen on
 */
function start(port) {
  const SESSION_DIR = config.getSessionDir()

  const httpServer = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getDashboardHTML())
    } else if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      // Send last 300 events on connect
      for (const evt of eventLog.slice(-300)) {
        res.write('data: ' + JSON.stringify(evt) + '\n\n')
      }
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
    } else if (req.url.startsWith('/api/events?')) {
      // Pagination: ?before=TIMESTAMP&limit=50&channel=ID
      const params = new URLSearchParams(req.url.split('?')[1])
      const before = parseInt(params.get('before')) || Date.now()
      const limit = Math.min(parseInt(params.get('limit')) || 50, 200)
      const channel = params.get('channel') || null

      // First try memory
      let filtered = channel ? eventLog.filter(e => e.channelId === channel) : eventLog
      filtered = filtered.filter(e => e.ts < before)

      if (filtered.length >= limit) {
        const page = filtered.slice(-limit)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events: page, hasMore: filtered.length > limit }))
      } else {
        // Fall back to reading from file for older history
        try {
          const allLines = readFileSync(EVENT_FILE, 'utf8').split('\n').filter(Boolean)
          let allFiltered = []
          for (const line of allLines) {
            try {
              const evt = JSON.parse(line)
              if (evt.ts < before && (!channel || evt.channelId === channel)) allFiltered.push(evt)
            } catch {}
          }
          const page = allFiltered.slice(-limit)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ events: page, hasMore: allFiltered.length > limit }))
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ events: filtered.slice(-limit), hasMore: false }))
        }
      }
    } else if (req.url === '/api/sessions') {
      const toK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString()
      try {
        const files = readdirSync(SESSION_DIR).filter(f => f.endsWith('.jsonl'))
        const sessions = files.map(f => {
          const fp = join(SESSION_DIR, f)
          const st = statSync(fp)
          const sizeKB = (st.size / 1024).toFixed(1) + ' KB'
          const lines = readFileSync(fp, 'utf8').split('\n').filter(Boolean).length
          const age = ((Date.now() - st.birthtimeMs) / 3600000).toFixed(1) + 'h'
          const sid = f.replace('.jsonl', '')
          let tokens = null, name = null, chIdFound = null
          for (const [chId, u] of channelUsage) {
            if (sessionManager.toSessionId(chId) === sid) {
              tokens = { input: toK(u.inputTokens + u.cacheRead + u.cacheCreate), output: toK(u.outputTokens), cost: u.totalCost.toFixed(4) }
              name = channelNames.get(chId)
              chIdFound = chId
              break
            }
          }
          if (!name) {
            for (const [chId, n] of channelNames) {
              if (sessionManager.toSessionId(chId) === sid) { name = n; chIdFound = chId; break }
            }
          }
          return { id: sid, channelId: chIdFound, name: name || sid.slice(0, 8), size: sizeKB, lines, age, tokens }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(sessions))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('[]')
      }
    } else if (req.url === '/api/health') {
      const data = {
        status: getProcessStatus(),
        sessions: getSessionsHealth(),
        stuck: getStuckDetection(),
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    } else if (req.method === 'POST' && req.url === '/api/trim') {
      let body = ''
      req.on('data', chunk => { body += chunk; if (body.length > 1024) { res.writeHead(413); res.end('Too large'); req.destroy() } })
      req.on('end', () => {
        try {
          const { filename } = JSON.parse(body)
          const result = trimSession(filename)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: 'Invalid request' }))
        }
      })
    } else if (req.method === 'POST' && req.url === '/api/delete-session') {
      let body = ''
      req.on('data', chunk => { body += chunk; if (body.length > 1024) { res.writeHead(413); res.end('Too large'); req.destroy() } })
      req.on('end', () => {
        try {
          const { filename } = JSON.parse(body)
          if (!/^[a-zA-Z0-9_\-\.]+\.jsonl$/.test(filename)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'Invalid filename' }))
            return
          }
          const fp = join(SESSION_DIR, filename)
          if (!existsSync(fp)) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: false, message: 'File not found' }))
            return
          }
          // Backup before deleting
          const bakDir = join(SESSION_DIR, 'backups')
          mkdirSync(bakDir, { recursive: true })
          copyFileSync(fp, join(bakDir, filename + '.' + Date.now() + '.bak'))
          unlinkSync(fp)
          // Remove from sessionMap if present
          const sid = filename.replace('.jsonl', '')
          for (const [chId, sId] of sessionManager.sessionMap) {
            if (sId === sid) { sessionManager.sessionMap.delete(chId); sessionManager.saveSessionMap(); break }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Deleted ' + filename }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, message: e.message }))
        }
      })
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(getHealthHTML())
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[dashboard] http://127.0.0.1:${port}`)
  })

  return httpServer
}

module.exports = { start, setContext, eventLog, sseClients }
