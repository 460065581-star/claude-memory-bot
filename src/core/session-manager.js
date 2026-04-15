// Session 管理：session-map 持久化、轮转、历史记录、频道队列
const { join } = require('path')
const { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } = require('fs')
const { uuidv5 } = require('./utils')
const config = require('./config')
const bus = require('./event-bus')

const ROTATE_THRESHOLD = 1200 * 1024 // 1.2MB

// ── Session Map (channel → current session UUID) ──
const sessionMap = new Map()
const SESSION_MAP_FILE = () => join(config.getBotDir(), 'session-map.json')

// ── Session History ──
const SESSION_HISTORY_FILE = () => join(config.getBotDir(), 'session-history.json')
let sessionHistory = {}

// ── Needs-new-session tracking ──
const needsNewSession = new Set()

// ── Per-channel queue (prevent concurrent claude calls) ──
const queues = new Map()

// ── Init: load from disk on startup ──
function init() {
  // Load session map
  try {
    const saved = JSON.parse(readFileSync(SESSION_MAP_FILE(), 'utf8'))
    for (const [k, v] of Object.entries(saved)) sessionMap.set(k, v)
    console.log(`📎 Loaded ${sessionMap.size} session mappings`)
  } catch {}

  // Load session history
  try {
    sessionHistory = JSON.parse(readFileSync(SESSION_HISTORY_FILE(), 'utf8'))
    console.log(`📜 Loaded session history (${Object.keys(sessionHistory).length} channels)`)
  } catch {}
}

function reloadSessionMap() {
  try {
    const saved = JSON.parse(readFileSync(SESSION_MAP_FILE(), 'utf8'))
    for (const [k, v] of Object.entries(saved)) sessionMap.set(k, v)
  } catch {}
}

function saveSessionMap() {
  // Read disk first to avoid overwriting other channels' concurrent updates
  let disk = {}
  try { disk = JSON.parse(readFileSync(SESSION_MAP_FILE(), 'utf8')) } catch {}
  for (const [k, v] of sessionMap) disk[k] = v
  writeFileSync(SESSION_MAP_FILE(), JSON.stringify(disk, null, 2) + '\n')
}

function saveSessionHistory() {
  writeFileSync(SESSION_HISTORY_FILE(), JSON.stringify(sessionHistory, null, 2) + '\n')
}

function toSessionId(channelId) {
  return sessionMap.get(channelId) || uuidv5(`discord-channel-${channelId}`)
}

function checkNeedsRotation(channelId) {
  const sessionId = toSessionId(channelId)
  const sessionFile = join(config.getSessionDir(), sessionId + '.jsonl')
  try {
    if (!existsSync(sessionFile)) return false
    const size = statSync(sessionFile).size
    if (size >= ROTATE_THRESHOLD) {
      console.log(`🔄 session ${(size / 1024).toFixed(0)}KB >= ${ROTATE_THRESHOLD / 1024}KB, rotating`)
      return true
    }
  } catch {}
  return false
}

function recordSessionArchive(channelId, channelName, oldSessionId) {
  if (!sessionHistory[channelId]) sessionHistory[channelId] = { name: channelName, current: null, history: [] }
  sessionHistory[channelId].name = channelName || sessionHistory[channelId].name
  // Avoid duplicates
  if (!sessionHistory[channelId].history.find(h => h.id === oldSessionId)) {
    const fp = join(config.getSessionDir(), oldSessionId + '.jsonl')
    let size = 0, lines = 0, created = null
    try {
      const st = statSync(fp)
      size = st.size
      created = st.birthtimeMs
      lines = readFileSync(fp, 'utf8').split('\n').filter(Boolean).length
    } catch {}
    sessionHistory[channelId].history.push({
      id: oldSessionId, size, lines,
      created: created ? new Date(created).toISOString() : null,
      archived: new Date().toISOString()
    })
  }
  saveSessionHistory()
}

function updateSessionHistoryCurrent(channelId, channelName, sessionId) {
  if (!sessionHistory[channelId]) sessionHistory[channelId] = { name: channelName, current: null, history: [] }
  sessionHistory[channelId].name = channelName || sessionHistory[channelId].name
  sessionHistory[channelId].current = sessionId
  saveSessionHistory()
}

/**
 * 更新频道的 session 映射（简单替换）
 */
function updateSessionMapping(channelId, newSessionId) {
  sessionMap.set(channelId, newSessionId)
  saveSessionMap()
}

/**
 * Session 轮转后：归档旧 session，更新映射到新 session
 */
function onSessionRotated(channelId, oldSessionId, newSessionId) {
  const chName = null // caller doesn't pass channelName; recordSessionArchive handles missing
  recordSessionArchive(channelId, chName, oldSessionId)
  updateSessionMapping(channelId, newSessionId)
  updateSessionHistoryCurrent(channelId, chName, newSessionId)
}

// ── needsNewSession Set 方法 ──
function markNeedsNewSession(channelId) { needsNewSession.add(channelId) }
function shouldStartNewSession(channelId) { return needsNewSession.has(channelId) }
function clearNeedsNewSession(channelId) { needsNewSession.delete(channelId) }

// ── Per-channel promise queue ──
function enqueue(channelId, fn) {
  const prev = queues.get(channelId) || Promise.resolve()
  const next = prev.then(fn).catch(e => console.error(`[${channelId}]`, e))
  queues.set(channelId, next)
  return next
}

/**
 * 匹配孤儿 session 文件到频道（启动时调用）
 * @param {Map<string,string>} channelNames - channelId → channelName 映射
 */
function matchOrphanSessions(channelNames) {
  const SESSION_DIR = config.getSessionDir()
  try {
    const allFiles = readdirSync(SESSION_DIR).filter(f => f.endsWith('.jsonl'))
    const mappedIds = new Set(sessionMap.values())
    let matched = 0

    // First, ensure all current mappings are in history
    for (const [chId, sid] of sessionMap) {
      const chName = channelNames.get(chId)
      updateSessionHistoryCurrent(chId, chName || chId.slice(-6), sid)
    }

    // Then match orphans by reading first message for [频道:xxx]
    for (const f of allFiles) {
      const sid = f.replace('.jsonl', '')
      if (mappedIds.has(sid)) continue
      // Already in history somewhere?
      let alreadyTracked = false
      for (const ch of Object.values(sessionHistory)) {
        if (ch.history.find(h => h.id === sid)) { alreadyTracked = true; break }
      }
      if (alreadyTracked) continue

      // Read first line to find channel name
      const fp = join(SESSION_DIR, f)
      try {
        const fd = openSync(fp, 'r')
        const buf = Buffer.alloc(2048)
        const bytesRead = readSync(fd, buf, 0, 2048, 0)
        closeSync(fd)
        const firstChunk = buf.toString('utf8', 0, bytesRead)
        const chMatch = firstChunk.match(/\[频道:([^\]]+)\]/)
        if (chMatch) {
          const chName = chMatch[1]
          // Find channelId by name
          let targetChId = null
          for (const [cid, cname] of channelNames) {
            if (cname === chName) { targetChId = cid; break }
          }
          if (targetChId) {
            recordSessionArchive(targetChId, chName, sid)
            matched++
          }
        }
      } catch {}
    }
    if (matched > 0) console.log(`📜 Auto-matched ${matched} orphan sessions to channels`)
    saveSessionHistory()
  } catch (e) {
    console.error('Failed to match orphan sessions:', e.message)
  }
}

module.exports = {
  sessionMap,
  sessionHistory,
  toSessionId,
  checkNeedsRotation,
  recordSessionArchive,
  updateSessionHistoryCurrent,
  reloadSessionMap,
  saveSessionMap,
  saveSessionHistory,
  markNeedsNewSession,
  shouldStartNewSession,
  clearNeedsNewSession,
  updateSessionMapping,
  onSessionRotated,
  enqueue,
  init,
  matchOrphanSessions,
}
