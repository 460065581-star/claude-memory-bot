#!/usr/bin/env node
// Remote Dashboard Server
// Deployed independently on a server, receives events from the local bot

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const pages = require('./pages')

// ===== Configuration =====
const PORT = parseInt(process.env.DASHBOARD_PORT) || 3860
const HOST = '127.0.0.1'
const BASE_PATH = process.env.BASE_PATH || '/dcm'
const DATA_DIR = path.join(__dirname, 'data')
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl')
const ACCESS_LOG = path.join(DATA_DIR, 'access.log')
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')

const LOGIN_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme'
const API_SECRET = process.env.REMOTE_API_SECRET || 'changeme'
const MAX_FAILED_ATTEMPTS = 3
const SESSION_MAX_AGE = 7 * 24 * 3600 * 1000 // 7 days

// ===== Startup warnings =====
if (LOGIN_PASSWORD === 'changeme') console.warn('WARNING: DASHBOARD_PASSWORD is default "changeme", set it via env var!')
if (API_SECRET === 'changeme') console.warn('WARNING: REMOTE_API_SECRET is default "changeme", set it via env var!')

// ===== Data Storage =====
fs.mkdirSync(DATA_DIR, { recursive: true })

// Events
let eventLog = []
try {
  const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean)
  eventLog = lines.slice(-5000).map(l => JSON.parse(l))
  console.log(`Loaded ${eventLog.length} events`)
} catch {}

// Blacklist: { ip: { blockedAt, reason, attempts } }
let blacklist = {}
try { blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')) } catch {}
function saveBlacklist() { fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2)) }

// Login sessions: { token: { ip, ua, createdAt, lastSeen } }
let sessions = {}
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) } catch {}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)) }

// Failed login attempts: { ip: count }
const failedAttempts = {}

// SSE clients
const sseClients = new Set()

// IP location cache (persisted)
const IP_LOCATION_FILE = path.join(DATA_DIR, 'ip-locations.json')
let ipLocations = {}
try { ipLocations = JSON.parse(fs.readFileSync(IP_LOCATION_FILE, 'utf8')) } catch {}
function saveIPLocations() { fs.writeFileSync(IP_LOCATION_FILE, JSON.stringify(ipLocations, null, 2)) }

async function resolveIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return 'localhost'
  if (ipLocations[ip]) return ipLocations[ip]
  try {
    const resp = await new Promise((resolve, reject) => {
      const r = http.get('http://ip-api.com/json/' + encodeURIComponent(ip) + '?lang=zh-CN&fields=country,regionName,city,status', { timeout: 3000 }, res => {
        let body = ''
        res.on('data', c => body += c)
        res.on('end', () => resolve(body))
      })
      r.on('error', reject)
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
    })
    const d = JSON.parse(resp)
    if (d.status === 'success') {
      ipLocations[ip] = [d.country, d.regionName, d.city].filter(Boolean).join(' ')
    } else {
      ipLocations[ip] = 'unknown'
    }
  } catch {
    ipLocations[ip] = 'unknown'
  }
  saveIPLocations()
  return ipLocations[ip]
}

// Session data from bot (persisted to disk)
const SYNCED_SESSIONS_FILE = path.join(DATA_DIR, 'synced-sessions.json')
let syncedSessions = []
let syncedHistory = {}
try {
  const saved = JSON.parse(fs.readFileSync(SYNCED_SESSIONS_FILE, 'utf8'))
  syncedSessions = saved.sessions || []
  syncedHistory = saved.history || {}
} catch {}

// ===== Utility Functions =====
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress?.replace('::ffff:', '')
}

function logAccess(ip, action, detail = '') {
  const line = `${new Date().toISOString()} | ${ip} | ${action} | ${detail}\n`
  fs.appendFileSync(ACCESS_LOG, line)
  if (ip && !ipLocations[ip]) resolveIP(ip).catch(() => {})
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || ''
  const match = cookies.match(new RegExp(`${name}=([^;]+)`))
  return match ? match[1] : null
}

function isAuthenticated(req) {
  const token = getCookie(req, 'dcm_token')
  if (!token || !sessions[token]) return false
  const s = sessions[token]
  if (Date.now() - s.createdAt > SESSION_MAX_AGE) {
    delete sessions[token]
    saveSessions()
    return false
  }
  s.lastSeen = Date.now()
  return true
}

function isBlacklisted(ip) {
  return !!blacklist[ip]
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) { req.destroy(); reject(new Error('Too large')) } })
    req.on('end', () => resolve(body))
  })
}

// ===== HTTP Server =====
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req)
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  // Strip BASE_PATH prefix for routing
  const routePath = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) || '/' : url.pathname

  // Blacklist check (except API push endpoints)
  if (isBlacklisted(ip) && routePath !== '/api/push' && routePath !== '/api/sessions-sync') {
    logAccess(ip, 'BLOCKED', 'blocked access')
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages.BLOCKED_HTML)
    return
  }

  // ── API: Bot push events ──
  if (req.method === 'POST' && routePath === '/api/push') {
    const auth = req.headers['x-api-secret'] || ''
    const authBuf = Buffer.from(auth)
    const secretBuf = Buffer.from(API_SECRET)
    if (authBuf.length !== secretBuf.length || !crypto.timingSafeEqual(authBuf, secretBuf)) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    try {
      const body = await readBody(req)
      const events = JSON.parse(body)
      const batch = Array.isArray(events) ? events : [events]
      for (const evt of batch) {
        eventLog.push(evt)
        if (eventLog.length > 5000) eventLog.shift()
        fs.appendFileSync(EVENTS_FILE, JSON.stringify(evt) + '\n')
        const msg = `data: ${JSON.stringify(evt)}\n\n`
        for (const client of sseClients) client.write(msg)
      }
      json(res, { ok: true, received: batch.length })
    } catch (e) {
      json(res, { ok: false, error: e.message }, 400)
    }
    return
  }

  // ── API: Bot push session data ──
  if (req.method === 'POST' && routePath === '/api/sessions-sync') {
    const auth = req.headers['x-api-secret'] || ''
    const authBuf2 = Buffer.from(auth)
    const secretBuf2 = Buffer.from(API_SECRET)
    if (authBuf2.length !== secretBuf2.length || !crypto.timingSafeEqual(authBuf2, secretBuf2)) { res.writeHead(401); res.end('Unauthorized'); return }
    try {
      const body = await readBody(req)
      const data = JSON.parse(body)
      syncedSessions = data.sessions || []
      syncedHistory = data.history || {}
      try { fs.writeFileSync(SYNCED_SESSIONS_FILE, JSON.stringify({ sessions: syncedSessions, history: syncedHistory })) } catch {}
      json(res, { ok: true })
    } catch (e) {
      json(res, { ok: false, error: e.message }, 400)
    }
    return
  }

  // ── Login page ──
  if (routePath === '/login') {
    logAccess(ip, 'VIEW_LOGIN')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages.LOGIN_HTML)
    return
  }

  // ── Login API ──
  if (req.method === 'POST' && routePath === '/api/login') {
    try {
      const body = await readBody(req)
      const { password } = JSON.parse(body)
      const pwdBuf = Buffer.from(password || '')
      const expectedBuf = Buffer.from(LOGIN_PASSWORD)
      const match = pwdBuf.length === expectedBuf.length && crypto.timingSafeEqual(pwdBuf, expectedBuf)
      if (match) {
        failedAttempts[ip] = 0
        const token = crypto.randomBytes(32).toString('hex')
        sessions[token] = { ip, createdAt: Date.now(), lastSeen: Date.now() }
        saveSessions()
        logAccess(ip, 'LOGIN_OK')
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `dcm_token=${token}; Path=/; HttpOnly; Max-Age=${SESSION_MAX_AGE / 1000}; SameSite=Strict`
        })
        res.end(JSON.stringify({ success: true }))
      } else {
        failedAttempts[ip] = (failedAttempts[ip] || 0) + 1
        logAccess(ip, 'LOGIN_FAILED', `attempt ${failedAttempts[ip]}/${MAX_FAILED_ATTEMPTS}`)
        if (failedAttempts[ip] >= MAX_FAILED_ATTEMPTS) {
          blacklist[ip] = { blockedAt: Date.now(), reason: `Failed ${MAX_FAILED_ATTEMPTS} times`, attempts: failedAttempts[ip] }
          saveBlacklist()
          logAccess(ip, 'AUTO_BLOCKED', `Failed ${MAX_FAILED_ATTEMPTS} times`)
          json(res, { success: false, message: 'Too many failed attempts, IP blocked' })
        } else {
          json(res, { success: false, message: `Wrong password (${failedAttempts[ip]}/${MAX_FAILED_ATTEMPTS})` })
        }
      }
    } catch (e) {
      json(res, { success: false, message: 'Invalid request' }, 400)
    }
    return
  }

  // ── Logout ──
  if (routePath === '/api/logout') {
    const token = getCookie(req, 'dcm_token')
    if (token) { delete sessions[token]; saveSessions() }
    logAccess(ip, 'LOGOUT')
    res.writeHead(302, { 'Location': BASE_PATH + '/login', 'Set-Cookie': 'dcm_token=; Path=/; Max-Age=0' })
    res.end()
    return
  }

  // ── All pages below require authentication ──
  if (!isAuthenticated(req)) {
    logAccess(ip, 'REDIRECT_LOGIN')
    res.writeHead(302, { 'Location': BASE_PATH + '/login' })
    res.end()
    return
  }

  // ── Main dashboard ──
  if (routePath === '/') {
    logAccess(ip, 'VIEW_DASHBOARD')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages.getDashboardHTML(BASE_PATH))
    return
  }

  // ── SSE event stream ──
  if (routePath === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    for (const evt of eventLog.slice(-100)) {
      res.write('data: ' + JSON.stringify(evt) + '\n\n')
    }
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // ── Active sessions API ──
  if (routePath === '/api/active-sessions') {
    const activeSessions = syncedSessions.filter(s => s.channelId)
    json(res, activeSessions)
    return
  }

  // ── History page ──
  if (routePath === '/history') {
    logAccess(ip, 'VIEW_HISTORY')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages.getHistoryHTML(BASE_PATH))
    return
  }

  // ── History API ──
  if (routePath === '/api/history') {
    const trackedIds = new Set()
    for (const ch of Object.values(syncedHistory)) {
      if (ch.current) trackedIds.add(ch.current)
      for (const h of ch.history) trackedIds.add(h.id)
    }
    const orphans = syncedSessions.filter(s => !trackedIds.has(s.id))
    json(res, { sessions: syncedSessions, history: syncedHistory, orphans })
    return
  }

  // ── Admin page ──
  if (routePath === '/admin') {
    logAccess(ip, 'VIEW_ADMIN')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pages.getAdminHTML(BASE_PATH))
    return
  }

  // ── Admin API ──
  if (routePath === '/api/admin') {
    let accessLines = []
    try {
      const raw = fs.readFileSync(ACCESS_LOG, 'utf8')
      accessLines = raw.split('\n').filter(Boolean).slice(-50).map(l => {
        const parts = l.split(' | ')
        return { time: parts[0]?.slice(11, 19) || '', ip: parts[1]?.trim() || '', action: parts[2]?.trim() || '', detail: parts[3]?.trim() || '' }
      })
    } catch {}
    const bl = Object.entries(blacklist).map(([ip, v]) => ({ ip, ...v }))
    const sl = Object.values(sessions)
    json(res, { blacklist: bl, accessLog: accessLines, sessions: sl, ipLocations })
    return
  }

  if (req.method === 'POST' && routePath === '/api/unblock') {
    try {
      const body = await readBody(req)
      const { ip: targetIP } = JSON.parse(body)
      if (blacklist[targetIP]) {
        delete blacklist[targetIP]
        delete failedAttempts[targetIP]
        saveBlacklist()
        logAccess(ip, 'UNBLOCK', targetIP)
        json(res, { success: true, message: 'Unblocked ' + targetIP })
      } else {
        json(res, { success: false, message: 'IP not in blacklist' })
      }
    } catch { json(res, { success: false, message: 'Invalid request' }, 400) }
    return
  }

  if (req.method === 'POST' && routePath === '/api/block') {
    try {
      const body = await readBody(req)
      const { ip: targetIP } = JSON.parse(body)
      if (!targetIP) { json(res, { success: false, message: 'Please provide an IP' }); return }
      blacklist[targetIP] = { blockedAt: Date.now(), reason: 'Manual block', attempts: 0 }
      saveBlacklist()
      logAccess(ip, 'MANUAL_BLOCK', targetIP)
      json(res, { success: true, message: 'Blocked ' + targetIP })
    } catch { json(res, { success: false, message: 'Invalid request' }, 400) }
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, HOST, () => {
  console.log(`\n  Remote Dashboard started`)
  console.log(`  Address: http://${HOST}:${PORT}`)
  console.log(`  Base path: ${BASE_PATH}\n`)
})
