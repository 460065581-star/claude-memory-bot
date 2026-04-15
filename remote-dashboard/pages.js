// 远程 Dashboard HTML 页面
// 独立部署在服务器上，不依赖主项目

'use strict'

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Monitor - Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-box { background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 40px; width: 360px; }
  .login-box h1 { color: #e94560; font-size: 20px; text-align: center; margin-bottom: 24px; }
  .login-box input { width: 100%; padding: 12px 16px; border: 1px solid #0f3460; border-radius: 8px; background: #1a1a2e; color: #e0e0e0; font-size: 14px; margin-bottom: 16px; outline: none; }
  .login-box input:focus { border-color: #4ecca3; }
  .login-box button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: #4ecca3; color: #1a1a2e; font-size: 14px; font-weight: 700; cursor: pointer; }
  .login-box button:hover { background: #3dbb94; }
  .error { color: #e94560; font-size: 12px; text-align: center; margin-bottom: 12px; display: none; }
</style>
</head>
<body>
<div class="login-box">
  <h1>Bot Monitor</h1>
  <div class="error" id="error"></div>
  <input type="password" id="pwd" placeholder="Password" autofocus>
  <button onclick="doLogin()">Login</button>
</div>
<script>
document.getElementById('pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
async function doLogin() {
  const pwd = document.getElementById('pwd').value
  const err = document.getElementById('error')
  try {
    const res = await fetch(location.pathname.replace(/\\/login$/, '') + '/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: pwd}) })
    const data = await res.json()
    if (data.success) { location.href = location.pathname.replace(/\\/login$/, '') + '/' }
    else { err.textContent = data.message; err.style.display = 'block' }
  } catch(e) { err.textContent = 'Network error'; err.style.display = 'block' }
}
</script>
</body>
</html>`

const BLOCKED_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8"><title>Blocked</title>
<style>body{background:#1a1a2e;color:#e94560;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:monospace;font-size:18px}</style>
</head><body>Your IP has been blocked</body></html>`

function getDashboardHTML(basePath) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, 'SF Mono', monospace; font-size: 14px; }
  .header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #0f3460; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; color: #e94560; }
  .header-right { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .header .status { color: #4ecca3; }
  .header a { color: #888; text-decoration: none; }
  .header a:hover { color: #e94560; }
  .nav-bar { background: #0f3460; padding: 6px 24px; display: flex; gap: 16px; font-size: 12px; }
  .nav-bar a { color: #4ecca3; text-decoration: none; }
  .nav-bar a:hover { text-decoration: underline; }
  .nav-bar a.active { color: #e94560; font-weight: bold; }
  .container { display: flex; height: calc(100vh - 86px); }
  .sidebar { width: 280px; background: #16213e; border-right: 1px solid #0f3460; overflow-y: auto; padding: 12px; }
  .sidebar h3 { color: #e94560; font-size: 13px; margin-bottom: 8px; }
  .filter-all { background: #0f3460; color: #4ecca3; border: 1px solid #0f3460; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; cursor: pointer; font-size: 12px; width: 100%; text-align: center; }
  .filter-all:hover { border-color: #4ecca3; }
  .filter-all.active { border-color: #e94560; background: #1e1e3a; }
  .session-card { background: #1a1a2e; border: 1px solid #0f3460; border-radius: 6px; padding: 10px; margin-bottom: 8px; font-size: 12px; cursor: pointer; transition: border-color 0.2s; }
  .session-card:hover { border-color: #4ecca3; }
  .session-card.active { border-color: #e94560; background: #1e1e3a; }
  .session-card .sid { color: #4ecca3; font-family: monospace; }
  .session-card .size { color: #e94560; }
  .session-card .meta-info { color: #888; margin-top: 4px; }
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .events { flex: 1; overflow-y: auto; padding: 16px; }
  .event { margin-bottom: 12px; padding: 10px 14px; border-radius: 8px; animation: fadeIn 0.3s; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }
  .event.user { background: #0f3460; border-left: 3px solid #4ecca3; }
  .event.thinking { background: #1a1a2e; border-left: 3px solid #e94560; color: #c0c0c0; font-style: italic; }
  .event.text { background: #16213e; border-left: 3px solid #4ecca3; }
  .event.tool { background: #1a1a2e; border-left: 3px solid #f5a623; }
  .event.done { background: #16213e; border-left: 3px solid #4ecca3; font-size: 12px; color: #888; }
  .event .meta { font-size: 11px; color: #666; margin-bottom: 4px; }
  .channel-tag { background: #0f3460; color: #4ecca3; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; }
  .event .label { font-weight: bold; margin-right: 6px; }
  .label-user { color: #4ecca3; } .label-think { color: #e94560; } .label-text { color: #4ecca3; } .label-tool { color: #f5a623; } .label-done { color: #4ecca3; }
  .event pre { white-space: pre-wrap; word-break: break-all; margin-top: 4px; font-size: 12px; color: #aaa; max-height: 200px; overflow-y: auto; }
  .event .content { white-space: pre-wrap; word-break: break-word; }
  .empty { text-align: center; color: #555; padding: 60px; font-size: 16px; }
</style>
</head>
<body>
<div class="header">
  <h1>Bot Dashboard</h1>
  <div class="header-right">
    <span class="status" id="status">connecting...</span>
    <a href="${basePath}/admin">admin</a>
    <a href="${basePath}/api/logout">logout</a>
  </div>
</div>
<div class="nav-bar">
  <a href="${basePath}/" class="active">Live Events</a>
  <a href="${basePath}/history">History</a>
  <a href="${basePath}/admin">IP Admin</a>
</div>
<div class="container">
  <div class="sidebar" id="sidebar">
    <h3>Sessions</h3>
    <div id="sessions">loading...</div>
  </div>
  <div class="main">
    <div class="events" id="events">
      <div class="empty">waiting for events...</div>
    </div>
  </div>
</div>
<script>
const eventsDiv = document.getElementById('events')
const statusDiv = document.getElementById('status')
const allEvents = []
let filterChannelId = null

function formatTime(ts) { return new Date(ts).toLocaleTimeString('zh-CN', {hour12:false}) }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

function renderEvent(evt) {
  const div = document.createElement('div')
  div.className = 'event ' + evt.type
  div.dataset.channel = evt.channelId
  const time = formatTime(evt.ts)
  const ch = evt.channelName || evt.channelId?.slice(-6) || '?'
  const tag = '<span class="channel-tag">#' + esc(ch) + '</span>'
  if (evt.type === 'user') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-user">user ' + esc(evt.data.user) + ':</span> <span class="content">' + esc(evt.data.text) + '</span>'
  } else if (evt.type === 'thinking') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-think">thinking</span><span class="content">' + esc(evt.data) + '</span>'
  } else if (evt.type === 'text') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-text">reply</span><span class="content">' + esc(evt.data) + '</span>'
  } else if (evt.type === 'tool') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-tool">tool ' + esc(evt.data.name) + '</span><pre>' + esc(JSON.stringify(evt.data.input, null, 2).slice(0, 500)) + '</pre>'
  } else if (evt.type === 'done') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-done">done</span> in: ' + (evt.data.inputTokens||0) + ' / out: ' + (evt.data.outputTokens||0) + ' / $' + (evt.data.cost||0).toFixed(4)
  }
  return div
}

function renderAll() {
  eventsDiv.innerHTML = ''
  const filtered = filterChannelId ? allEvents.filter(e => e.channelId === filterChannelId) : allEvents
  if (filtered.length === 0) { eventsDiv.innerHTML = '<div class="empty">no events</div>'; return }
  for (const evt of filtered) eventsDiv.appendChild(renderEvent(evt))
  eventsDiv.scrollTop = eventsDiv.scrollHeight
}

function setFilter(chId) {
  filterChannelId = chId
  renderAll()
  updateSessionList()
}

function updateSessionList() {
  const div = document.getElementById('sessions')
  let html = '<div class="filter-all' + (!filterChannelId ? ' active' : '') + '" onclick="setFilter(null)">All channels</div>'
  for (const s of cachedSessions) {
    if (!s.channelId) continue
    html += '<div class="session-card' + (filterChannelId === s.channelId ? ' active' : '') + '" data-channel="' + s.channelId + '" onclick="setFilter(\\'' + s.channelId + '\\')">'
    html += '<div style="display:flex;justify-content:space-between;align-items:center">'
    html += '<span class="sid">#' + esc(s.name) + '</span>'
    html += '<span class="size">' + esc(s.size) + '</span>'
    html += '</div>'
    if (s.tokens) html += '<div class="meta-info">in: ' + s.tokens.input + ' | out: ' + s.tokens.output + ' | $' + s.tokens.cost + '</div>'
    html += '</div>'
  }
  div.innerHTML = html
}

let cachedSessions = []
async function loadSessions() {
  try {
    const res = await fetch('${basePath}/api/active-sessions')
    cachedSessions = await res.json()
    updateSessionList()
  } catch {}
}
loadSessions()
setInterval(loadSessions, 15000)

// SSE
const es = new EventSource('${basePath}/events')
es.onmessage = e => {
  const evt = JSON.parse(e.data)
  allEvents.push(evt)
  if (!filterChannelId || evt.channelId === filterChannelId) {
    if (allEvents.length === 1 || eventsDiv.querySelector('.empty')) eventsDiv.innerHTML = ''
    eventsDiv.appendChild(renderEvent(evt))
    eventsDiv.scrollTop = eventsDiv.scrollHeight
  }
}
es.onopen = () => { statusDiv.textContent = 'connected'; statusDiv.style.color = '#4ecca3' }
es.onerror = () => { statusDiv.textContent = 'disconnected'; statusDiv.style.color = '#e94560' }
</script>
</body>
</html>`
}

function getAdminHTML(basePath) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Admin - IP Management</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, 'SF Mono', monospace; font-size: 14px; }
  .header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #0f3460; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; color: #e94560; }
  .header a { color: #888; text-decoration: none; font-size: 13px; }
  .header a:hover { color: #e94560; }
  .nav-bar { background: #0f3460; padding: 6px 24px; display: flex; gap: 16px; font-size: 12px; }
  .nav-bar a { color: #4ecca3; text-decoration: none; }
  .nav-bar a:hover { text-decoration: underline; }
  .nav-bar a.active { color: #e94560; font-weight: bold; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px 24px; max-width: 1200px; }
  @media(max-width:800px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; padding: 18px; }
  .card h3 { color: #e94560; font-size: 14px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #0f3460; }
  .span-2 { grid-column: span 2; }
  @media(max-width:800px) { .span-2 { grid-column: span 1; } }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 11px; color: #888; text-transform: uppercase; text-align: left; padding: 8px 10px; border-bottom: 1px solid #0f3460; }
  td { font-size: 13px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); font-family: monospace; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .btn { padding: 4px 12px; border-radius: 6px; font-size: 12px; border: 1px solid #0f3460; cursor: pointer; background: #1a1a2e; color: #888; }
  .btn:hover { border-color: #4ecca3; color: #4ecca3; }
  .btn-danger { border-color: rgba(233,69,96,0.3); }
  .btn-danger:hover { border-color: #e94560; color: #e94560; }
  .btn-unblock { border-color: rgba(78,204,163,0.3); }
  .btn-unblock:hover { border-color: #4ecca3; color: #4ecca3; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; font-size: 13px; transform: translateY(80px); opacity: 0; transition: all 0.3s; z-index: 999; }
  .toast.visible { transform: translateY(0); opacity: 1; }
  .toast.success { background: #4ecca3; color: #1a1a2e; }
  .toast.error { background: #e94560; color: #fff; }
  .ip-input { display: flex; gap: 8px; margin-bottom: 12px; }
  .ip-input input { flex: 1; padding: 8px 12px; border: 1px solid #0f3460; border-radius: 6px; background: #1a1a2e; color: #e0e0e0; font-size: 13px; outline: none; }
  .ip-input input:focus { border-color: #4ecca3; }
  .ip-input button { padding: 8px 16px; border-radius: 6px; border: none; background: #e94560; color: #fff; font-size: 13px; cursor: pointer; }
</style>
</head>
<body>
<div class="header">
  <h1>IP Admin</h1>
  <a href="${basePath}/api/logout">logout</a>
</div>
<div class="nav-bar">
  <a href="${basePath}/">Live Events</a>
  <a href="${basePath}/history">History</a>
  <a href="${basePath}/admin" class="active">IP Admin</a>
</div>
<div class="grid">
  <div class="card">
    <h3>Blacklist</h3>
    <div class="ip-input">
      <input type="text" id="block-ip" placeholder="Enter IP to block">
      <button onclick="blockIP()">Block</button>
    </div>
    <div id="blacklist">loading...</div>
  </div>
  <div class="card">
    <h3>Recent Access Log</h3>
    <div id="access-log">loading...</div>
  </div>
  <div class="card span-2">
    <h3>Active Login Sessions</h3>
    <div id="sessions-list">loading...</div>
  </div>
</div>
<script>
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

let ipLocs = {}

function fillIPLocations() {
  document.querySelectorAll('.ip-loc[data-ip]').forEach(el => {
    el.textContent = ipLocs[el.dataset.ip] || '-'
  })
}

async function loadAdmin() {
  try {
    const res = await fetch('${basePath}/api/admin')
    const d = await res.json()
    ipLocs = d.ipLocations || {}
    renderBlacklist(d.blacklist)
    renderAccess(d.accessLog)
    renderSessions(d.sessions)
    fillIPLocations()
  } catch(e) { console.error(e) }
}

function renderBlacklist(list) {
  const el = document.getElementById('blacklist')
  if (!list.length) { el.innerHTML = '<div style="color:#555;padding:8px">Empty</div>'; return }
  let html = '<table><thead><tr><th>IP</th><th>Location</th><th>Blocked At</th><th>Reason</th><th>Action</th></tr></thead><tbody>'
  for (const b of list) {
    html += '<tr><td>' + esc(b.ip) + '</td><td class="ip-loc" data-ip="' + esc(b.ip) + '" style="color:#f5a623;font-size:12px">...</td><td style="color:#888">' + new Date(b.blockedAt).toLocaleString('zh-CN') + '</td><td style="color:#888">' + esc(b.reason) + '</td><td><button class="btn btn-unblock" onclick="unblockIP(\\'' + esc(b.ip) + '\\')">Unblock</button></td></tr>'
  }
  html += '</tbody></table>'
  el.innerHTML = html
}

function renderAccess(lines) {
  const el = document.getElementById('access-log')
  if (!lines.length) { el.innerHTML = '<div style="color:#555;padding:8px">Empty</div>'; return }
  let html = '<table><thead><tr><th>Time</th><th>IP</th><th>Location</th><th>Action</th></tr></thead><tbody>'
  for (const l of lines.reverse()) {
    const color = l.action.includes('BLOCKED') || l.action.includes('FAILED') ? '#e94560' : l.action.includes('LOGIN_OK') ? '#4ecca3' : '#888'
    html += '<tr><td style="color:#888;white-space:nowrap">' + esc(l.time) + '</td><td>' + esc(l.ip) + '</td><td class="ip-loc" data-ip="' + esc(l.ip) + '" style="color:#f5a623;font-size:12px">...</td><td style="color:' + color + '">' + esc(l.action + (l.detail ? ' ' + l.detail : '')) + '</td></tr>'
  }
  html += '</tbody></table>'
  el.innerHTML = html
}

function renderSessions(list) {
  const el = document.getElementById('sessions-list')
  if (!list.length) { el.innerHTML = '<div style="color:#555;padding:8px">No active sessions</div>'; return }
  let html = '<table><thead><tr><th>IP</th><th>Location</th><th>Login Time</th><th>Last Seen</th></tr></thead><tbody>'
  for (const s of list) {
    html += '<tr><td>' + esc(s.ip) + '</td><td class="ip-loc" data-ip="' + esc(s.ip) + '" style="color:#f5a623;font-size:12px">...</td><td style="color:#888">' + new Date(s.createdAt).toLocaleString('zh-CN') + '</td><td style="color:#888">' + new Date(s.lastSeen).toLocaleString('zh-CN') + '</td></tr>'
  }
  html += '</tbody></table>'
  el.innerHTML = html
}

async function unblockIP(ip) {
  try {
    const res = await fetch('${basePath}/api/unblock', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ip}) })
    const r = await res.json()
    showToast(r.message, r.success ? 'success' : 'error')
    loadAdmin()
  } catch(e) { showToast('Failed', 'error') }
}

async function blockIP() {
  const ip = document.getElementById('block-ip').value.trim()
  if (!ip) return
  try {
    const res = await fetch('${basePath}/api/block', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ip}) })
    const r = await res.json()
    showToast(r.message, r.success ? 'success' : 'error')
    document.getElementById('block-ip').value = ''
    loadAdmin()
  } catch(e) { showToast('Failed', 'error') }
}

function showToast(msg, type) {
  const t = document.createElement('div')
  t.className = 'toast ' + type
  t.textContent = msg
  document.body.appendChild(t)
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('visible')))
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300) }, 3000)
}

loadAdmin()
setInterval(loadAdmin, 15000)
</script>
</body>
</html>`
}

function getHistoryHTML(basePath) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Monitor - History</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, 'SF Mono', monospace; font-size: 14px; }
  .header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #0f3460; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; color: #e94560; }
  .header a { color: #888; text-decoration: none; font-size: 13px; }
  .header a:hover { color: #e94560; }
  .nav-bar { background: #0f3460; padding: 6px 24px; display: flex; gap: 16px; font-size: 12px; }
  .nav-bar a { color: #4ecca3; text-decoration: none; }
  .nav-bar a:hover { text-decoration: underline; }
  .nav-bar a.active { color: #e94560; font-weight: bold; }
  .content { padding: 20px 24px; max-width: 1200px; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat-card { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; padding: 16px 20px; min-width: 150px; }
  .stat-card .num { font-size: 28px; font-weight: bold; color: #4ecca3; }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 4px; }
  .channel-group { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
  .channel-header { padding: 14px 18px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.2s; }
  .channel-header:hover { background: #1e1e3a; }
  .channel-header .name { font-size: 15px; font-weight: bold; color: #4ecca3; }
  .channel-header .badge { background: #0f3460; color: #888; padding: 2px 10px; border-radius: 12px; font-size: 12px; }
  .channel-header .badge.active { color: #4ecca3; }
  .channel-body { display: none; border-top: 1px solid #0f3460; }
  .channel-body.open { display: block; }
  .session-row { display: flex; align-items: center; padding: 10px 18px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.03); gap: 12px; }
  .session-row:last-child { border-bottom: none; }
  .session-row:hover { background: rgba(255,255,255,0.02); }
  .session-row .sid { color: #888; font-family: monospace; min-width: 80px; }
  .session-row .tag { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
  .tag-current { background: rgba(78,204,163,0.15); color: #4ecca3; }
  .tag-archived { background: rgba(136,136,136,0.15); color: #888; }
  .session-row .size { color: #f5a623; min-width: 80px; text-align: right; }
  .session-row .lines { color: #888; min-width: 60px; text-align: right; }
  .session-row .date { color: #666; min-width: 140px; }
  .orphan-section { margin-top: 24px; }
  .orphan-section h3 { color: #e94560; font-size: 14px; margin-bottom: 12px; }
  .empty { color: #555; padding: 40px; text-align: center; }
  .refresh-btn { background: #0f3460; color: #4ecca3; border: 1px solid #0f3460; border-radius: 6px; padding: 6px 16px; cursor: pointer; font-size: 12px; }
  .refresh-btn:hover { border-color: #4ecca3; }
</style>
</head>
<body>
<div class="header">
  <h1>History</h1>
  <div style="display:flex;gap:12px;align-items:center">
    <button class="refresh-btn" onclick="loadData()">Refresh</button>
    <a href="${basePath}/api/logout">logout</a>
  </div>
</div>
<div class="nav-bar">
  <a href="${basePath}/">Live Events</a>
  <a href="${basePath}/history" class="active">History</a>
  <a href="${basePath}/admin">IP Admin</a>
</div>
<div class="content">
  <div class="summary" id="summary"></div>
  <div id="channels-list"></div>
  <div class="orphan-section" id="orphan-section" style="display:none">
    <h3>Unmatched Sessions</h3>
    <div id="orphan-list"></div>
  </div>
</div>
<script>
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function fmtSize(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB'
  return (bytes/1024/1024).toFixed(1) + ' MB'
}
function fmtDate(d) { return d ? new Date(d).toLocaleString('zh-CN', {hour12:false}) : '-' }

function toggle(el) {
  el.nextElementSibling.classList.toggle('open')
}

async function loadData() {
  try {
    const res = await fetch('${basePath}/api/history')
    const d = await res.json()
    renderSummary(d)
    renderChannels(d)
    renderOrphans(d)
  } catch(e) { console.error(e) }
}

function renderSummary(d) {
  const channels = Object.keys(d.history).length
  const currentCount = d.sessions.length
  const archivedCount = Object.values(d.history).reduce((s, ch) => s + ch.history.length, 0)
  const totalSize = d.sessions.reduce((s, sess) => s + (sess.sizeBytes || 0), 0)
  const orphanCount = d.orphans ? d.orphans.length : 0
  document.getElementById('summary').innerHTML =
    '<div class="stat-card"><div class="num">' + channels + '</div><div class="label">Channels</div></div>' +
    '<div class="stat-card"><div class="num">' + currentCount + '</div><div class="label">Current Sessions</div></div>' +
    '<div class="stat-card"><div class="num">' + archivedCount + '</div><div class="label">Archived Sessions</div></div>' +
    '<div class="stat-card"><div class="num">' + fmtSize(totalSize) + '</div><div class="label">Total Size</div></div>' +
    (orphanCount > 0 ? '<div class="stat-card"><div class="num" style="color:#e94560">' + orphanCount + '</div><div class="label">Unmatched</div></div>' : '')
}

function renderChannels(d) {
  const el = document.getElementById('channels-list')
  if (!Object.keys(d.history).length) { el.innerHTML = '<div class="empty">No data, waiting for bot sync...</div>'; return }
  let html = ''
  const entries = Object.entries(d.history).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
  for (const [chId, ch] of entries) {
    const totalSessions = 1 + ch.history.length
    const curSess = d.sessions.find(s => s.id === ch.current)
    const curSize = curSess ? curSess.sizeBytes : 0
    const archiveSize = ch.history.reduce((s, h) => s + (h.size || 0), 0)
    html += '<div class="channel-group">'
    html += '<div class="channel-header" onclick="toggle(this)"><span class="name">#' + esc(ch.name || chId.slice(-6)) + '</span>'
    html += '<span><span class="badge active">' + totalSessions + ' sessions</span> <span class="badge">' + fmtSize(curSize + archiveSize) + '</span></span></div>'
    html += '<div class="channel-body">'
    if (curSess) {
      html += '<div class="session-row"><span class="sid">' + curSess.id.slice(0,8) + '...</span>'
      html += '<span class="tag tag-current">current</span>'
      html += '<span class="size">' + esc(curSess.size) + '</span>'
      html += '<span class="lines">-</span>'
      html += '<span class="date">active</span></div>'
    }
    const sorted = [...ch.history].sort((a, b) => new Date(b.archived || 0) - new Date(a.archived || 0))
    for (const h of sorted) {
      html += '<div class="session-row"><span class="sid">' + h.id.slice(0,8) + '...</span>'
      html += '<span class="tag tag-archived">archived</span>'
      html += '<span class="size">' + fmtSize(h.size) + '</span>'
      html += '<span class="lines">' + (h.lines || '-') + ' lines</span>'
      html += '<span class="date">' + fmtDate(h.archived) + '</span></div>'
    }
    html += '</div></div>'
  }
  el.innerHTML = html
}

function renderOrphans(d) {
  if (!d.orphans || !d.orphans.length) { document.getElementById('orphan-section').style.display = 'none'; return }
  document.getElementById('orphan-section').style.display = ''
  let html = '<div class="channel-group"><div class="channel-body open">'
  for (const o of d.orphans) {
    html += '<div class="session-row"><span class="sid">' + o.id.slice(0,8) + '...</span>'
    html += '<span class="tag tag-archived">orphan</span>'
    html += '<span class="size">' + esc(o.size) + '</span>'
    html += '<span class="lines">-</span>'
    html += '<span class="date">-</span></div>'
  }
  html += '</div></div>'
  document.getElementById('orphan-list').innerHTML = html
}

loadData()
setInterval(loadData, 30000)
</script>
</body>
</html>`
}

module.exports = { LOGIN_HTML, BLOCKED_HTML, getDashboardHTML, getAdminHTML, getHistoryHTML }
