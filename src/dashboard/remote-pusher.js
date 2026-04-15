// 远程 Dashboard 事件推送器
// 将本地事件和 session 数据推送到远程监控面板
// 可选功能：如果 REMOTE_DASHBOARD_URL 未设置则不启用

'use strict'

const { readdirSync, statSync } = require('fs')
const { join } = require('path')

const bus = require('../core/event-bus')
const config = require('../core/config')
const sessionManager = require('../core/session-manager')

const REMOTE_DASHBOARD_URL = process.env.REMOTE_DASHBOARD_URL || ''
const REMOTE_API_SECRET = process.env.REMOTE_API_SECRET || ''

const remotePushQueue = []
let remotePushing = false

// ── Shared state references (set by main app via setContext) ──
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

async function flushRemoteQueue() {
  if (remotePushing || remotePushQueue.length === 0) return
  remotePushing = true
  const batch = remotePushQueue.splice(0, 50)
  try {
    const res = await fetch(REMOTE_DASHBOARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': REMOTE_API_SECRET },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) console.error(`[remote-push] HTTP ${res.status}`)
  } catch (e) {
    // Put back on failure, but drop if queue is too large
    if (remotePushQueue.length < 500) remotePushQueue.unshift(...batch)
  }
  remotePushing = false
  if (remotePushQueue.length > 0) setTimeout(flushRemoteQueue, 1000)
}

/**
 * Push session info to remote dashboard
 */
async function pushSessionsToRemote() {
  const SESSION_DIR = config.getSessionDir()
  try {
    const toK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString()
    const files = readdirSync(SESSION_DIR).filter(f => f.endsWith('.jsonl'))
    const sessions = files.map(f => {
      const fp = join(SESSION_DIR, f)
      const st = statSync(fp)
      const sizeKB = (st.size / 1024).toFixed(1) + ' KB'
      const sid = f.replace('.jsonl', '')
      let name = null, chIdFound = null, tokens = null
      for (const [chId, u] of channelUsage) {
        if (sessionManager.toSessionId(chId) === sid) {
          tokens = {
            input: toK(u.inputTokens + u.cacheRead + u.cacheCreate),
            output: toK(u.outputTokens),
            cost: u.totalCost.toFixed(4),
          }
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
      return { id: sid, channelId: chIdFound, name: name || sid.slice(0, 8), size: sizeKB, sizeBytes: st.size, tokens }
    })
    const syncUrl = REMOTE_DASHBOARD_URL.replace('/push', '/sessions-sync')
    await fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': REMOTE_API_SECRET },
      body: JSON.stringify({ sessions, history: sessionManager.sessionHistory }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

/**
 * Initialize remote pusher. Does nothing if REMOTE_DASHBOARD_URL is not set.
 */
function init() {
  if (!REMOTE_DASHBOARD_URL) {
    console.log('[remote-pusher] REMOTE_DASHBOARD_URL not set, skipping')
    return
  }

  console.log(`[remote-pusher] Pushing to ${REMOTE_DASHBOARD_URL}`)

  // Listen for events and queue them for remote push
  bus.on('event:push', (evt) => {
    remotePushQueue.push(evt)
    flushRemoteQueue()
  })

  // Push sessions every 30s
  setInterval(pushSessionsToRemote, 30000)
  setTimeout(pushSessionsToRemote, 5000) // first push after 5s
}

module.exports = { init, setContext }
