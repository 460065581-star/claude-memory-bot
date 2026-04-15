// 本地 Dashboard HTML 页面生成
// 从 bot.js 提取，去除硬编码路径和敏感信息

'use strict'

/**
 * 生成主面板 HTML
 * @param {string} basePath - URL 基础路径，默认 ''
 * @returns {string} HTML 字符串
 */
function getDashboardHTML(basePath = '') {
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
  .header .status { font-size: 12px; color: #4ecca3; }
  .health-bar { background: #0f3460; padding: 6px 24px; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 16px; font-size: 12px; color: #888; }
  .health-bar .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .health-bar .dot.ok { background: #4ecca3; box-shadow: 0 0 6px #4ecca3; }
  .health-bar .dot.warn { background: #f5a623; box-shadow: 0 0 6px #f5a623; }
  .health-bar .dot.bad { background: #e94560; box-shadow: 0 0 6px #e94560; }
  .health-bar .item { display: flex; align-items: center; gap: 4px; }
  .health-bar a { color: #4ecca3; text-decoration: none; margin-left: auto; font-size: 11px; }
  .health-bar a:hover { text-decoration: underline; }
  .container { display: flex; height: calc(100vh - 82px); }
  .sidebar { width: 280px; background: #16213e; border-right: 1px solid #0f3460; overflow-y: auto; padding: 12px; }
  .sidebar h3 { color: #e94560; font-size: 13px; margin-bottom: 8px; }
  .session-card { background: #1a1a2e; border: 1px solid #0f3460; border-radius: 6px; padding: 10px; margin-bottom: 8px; font-size: 12px; cursor: pointer; transition: border-color 0.2s; }
  .session-card:hover { border-color: #4ecca3; }
  .session-card.active { border-color: #e94560; background: #1e1e3a; }
  .filter-all { background: #0f3460; color: #4ecca3; border: 1px solid #0f3460; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; cursor: pointer; font-size: 12px; width: 100%; text-align: center; }
  .filter-all:hover { border-color: #4ecca3; }
  .filter-all.active { border-color: #e94560; background: #1e1e3a; }
  .session-card .sid { color: #4ecca3; font-family: monospace; }
  .session-card .size { color: #e94560; float: right; }
  .session-card .usage { color: #888; margin-top: 4px; }
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .events { flex: 1; overflow-y: auto; padding: 16px; }
  .event { margin-bottom: 12px; padding: 10px 14px; border-radius: 8px; animation: fadeIn 0.3s; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; } }
  .event.user { background: #0f3460; border-left: 3px solid #4ecca3; }
  .event.thinking { background: #1a1a2e; border-left: 3px solid #e94560; color: #c0c0c0; font-style: italic; }
  .event.text { background: #16213e; border-left: 3px solid #4ecca3; }
  .event.tool { background: #1a1a2e; border-left: 3px solid #f5a623; }
  .event.done { background: #16213e; border-left: 3px solid #4ecca3; font-size: 12px; color: #888; }
  .event .meta { font-size: 11px; color: #666; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
  .channel-tag { background: #0f3460; color: #4ecca3; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; }
  .event .label { font-weight: bold; margin-right: 6px; }
  .label-user { color: #4ecca3; }
  .label-think { color: #e94560; }
  .label-text { color: #4ecca3; }
  .label-tool { color: #f5a623; }
  .label-done { color: #4ecca3; }
  .event pre { white-space: pre-wrap; word-break: break-all; margin-top: 4px; font-size: 12px; color: #aaa; max-height: 200px; overflow-y: auto; }
  .event .content { white-space: pre-wrap; word-break: break-word; }
  .empty { text-align: center; color: #555; padding: 60px; font-size: 16px; }
</style>
</head>
<body>
<div class="header">
  <h1>Bot Dashboard</h1>
  <div class="status" id="status">connecting...</div>
</div>
<div class="health-bar" id="health-bar">
  <span class="item"><span class="dot ok" id="hb-dot"></span> <span id="hb-status">checking...</span></span>
  <span class="item" id="hb-mem"></span>
  <span class="item" id="hb-sessions"></span>
  <span class="item" id="hb-stuck"></span>
  <a href="${basePath}/health">health details</a>
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
let loadingMore = false
let noMoreHistory = false

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function renderEvent(evt) {
  const div = document.createElement('div')
  div.className = 'event ' + evt.type
  div.dataset.channel = evt.channelId
  const time = formatTime(evt.ts)
  const ch = evt.channelName || evt.channelId.slice(-6)
  const tag = '<span class="channel-tag">#' + escHtml(ch) + '</span>'
  if (evt.type === 'user') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-user">user ' + escHtml(evt.data.user) + ':</span> <span class="content">' + escHtml(evt.data.text) + '</span>'
  } else if (evt.type === 'thinking') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-think">thinking</span><span class="content">' + escHtml(evt.data) + '</span>'
  } else if (evt.type === 'text') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-text">reply</span><span class="content">' + escHtml(evt.data) + '</span>'
  } else if (evt.type === 'tool') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-tool">tool ' + escHtml(evt.data.name) + '</span><pre>' + escHtml(JSON.stringify(evt.data.input, null, 2).slice(0, 500)) + '</pre>'
  } else if (evt.type === 'done') {
    div.innerHTML = '<div class="meta">' + time + ' ' + tag + '</div><span class="label label-done">done</span> in: ' + evt.data.inputTokens + ' / out: ' + evt.data.outputTokens + ' / $' + evt.data.cost.toFixed(4)
  }
  return div
}

function renderAll() {
  eventsDiv.innerHTML = ''
  const filtered = filterChannelId ? allEvents.filter(e => e.channelId === filterChannelId) : allEvents
  if (filtered.length === 0) {
    eventsDiv.innerHTML = '<div class="empty">no events</div>'
    return
  }
  for (const evt of filtered) eventsDiv.appendChild(renderEvent(evt))
  eventsDiv.scrollTop = eventsDiv.scrollHeight
}

async function loadMore() {
  if (loadingMore || noMoreHistory) return
  loadingMore = true
  const filtered = filterChannelId ? allEvents.filter(e => e.channelId === filterChannelId) : allEvents
  const oldest = filtered.length > 0 ? filtered[0].ts : Date.now()
  const url = '${basePath}/api/events?before=' + oldest + '&limit=50' + (filterChannelId ? '&channel=' + filterChannelId : '')
  try {
    const res = await fetch(url)
    const data = await res.json()
    if (data.events.length === 0) { noMoreHistory = true; loadingMore = false; return }
    const prevHeight = eventsDiv.scrollHeight
    const newEvts = data.events.filter(e => !allEvents.some(x => x.ts === e.ts && x.type === e.type && x.channelId === e.channelId))
    allEvents.unshift(...newEvts)
    const frag = document.createDocumentFragment()
    for (const evt of newEvts) frag.appendChild(renderEvent(evt))
    eventsDiv.insertBefore(frag, eventsDiv.firstChild)
    eventsDiv.scrollTop = eventsDiv.scrollHeight - prevHeight
    if (!data.hasMore) noMoreHistory = true
  } catch(e) { console.error('loadMore failed:', e) }
  loadingMore = false
}

eventsDiv.addEventListener('scroll', () => {
  if (eventsDiv.scrollTop < 100) loadMore()
})

function addEvent(evt) {
  allEvents.push(evt)
  if (!filterChannelId || evt.channelId === filterChannelId) {
    if (allEvents.length === 1 || (filterChannelId && eventsDiv.querySelector('.empty'))) {
      eventsDiv.innerHTML = ''
    }
    eventsDiv.appendChild(renderEvent(evt))
    eventsDiv.scrollTop = eventsDiv.scrollHeight
  }
}

function setFilter(channelId) {
  filterChannelId = channelId
  noMoreHistory = false
  renderAll()
  document.querySelectorAll('.session-card, .filter-all').forEach(el => el.classList.remove('active'))
  if (!channelId) {
    document.querySelector('.filter-all')?.classList.add('active')
  } else {
    document.querySelector('.session-card[data-channel="' + channelId + '"]')?.classList.add('active')
  }
}

// SSE
const es = new EventSource('${basePath}/events')
es.onmessage = e => { addEvent(JSON.parse(e.data)) }
es.onopen = () => { statusDiv.textContent = 'connected'; statusDiv.style.color = '#4ecca3' }
es.onerror = () => { statusDiv.textContent = 'disconnected'; statusDiv.style.color = '#e94560' }

// Load sessions
async function loadSessions() {
  const res = await fetch('${basePath}/api/sessions')
  const data = await res.json()
  const div = document.getElementById('sessions')
  if (data.length === 0) { div.innerHTML = '<div style="color:#555">no sessions</div>'; return }
  div.innerHTML = '<div class="filter-all' + (!filterChannelId ? ' active' : '') + '" onclick="setFilter(null)">All channels</div>' +
    data.filter(s => s.channelId).map(s =>
    '<div class="session-card' + (filterChannelId === s.channelId ? ' active' : '') + '" data-channel="' + s.channelId + '" onclick="setFilter(&quot;' + s.channelId + '&quot;)">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
    '<span class="sid">#' + escHtml(s.name) + '</span>' +
    '<span class="size">' + s.size + '</span>' +
    '</div>' +
    '<div class="usage">rounds: ~' + s.lines + ' | ' + s.age + '</div>' +
    (s.tokens ? '<div class="usage">in: ' + s.tokens.input + ' | out: ' + s.tokens.output + ' | $' + s.tokens.cost + '</div>' : '') +
    '</div>'
  ).join('')
}
loadSessions()
setInterval(loadSessions, 15000)

// Health bar
async function loadHealthBar() {
  try {
    const res = await fetch('${basePath}/api/health')
    const d = await res.json()
    const dot = document.getElementById('hb-dot')
    const stuck = d.stuck?.hasIssues
    dot.className = 'dot ' + (d.status.running ? (stuck ? 'warn' : 'ok') : 'bad')
    document.getElementById('hb-status').textContent = d.status.running ? 'running' : 'offline'
    document.getElementById('hb-mem').textContent = 'mem ' + d.status.memoryMB + 'MB'
    document.getElementById('hb-sessions').textContent = d.sessions.length + ' sessions'
    document.getElementById('hb-stuck').textContent = stuck ? 'stuck: ' + d.stuck.longRunning.length : 'no issues'
    document.getElementById('hb-stuck').style.color = stuck ? '#f5a623' : '#888'
  } catch {}
}
loadHealthBar()
setInterval(loadHealthBar, 15000)
</script>
</body>
</html>`
}

/**
 * 生成健康监控 HTML
 * @param {string} basePath - URL 基础路径，默认 ''
 * @returns {string} HTML 字符串
 */
function getHealthHTML(basePath = '') {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Health Monitor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, 'SF Mono', monospace; font-size: 14px; }
  .header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #0f3460; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; color: #e94560; }
  .header a { color: #4ecca3; text-decoration: none; font-size: 13px; }
  .header a:hover { text-decoration: underline; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px 24px; max-width: 1200px; margin: 0 auto; }
  @media(max-width:800px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; padding: 18px; }
  .card h3 { color: #e94560; font-size: 14px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #0f3460; }
  .span-2 { grid-column: span 2; }
  @media(max-width:800px) { .span-2 { grid-column: span 1; } }
  .metric-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .metric { background: #1a1a2e; border-radius: 8px; padding: 12px; }
  .metric-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 3px; }
  .metric-value { font-size: 20px; font-weight: 700; font-family: 'SF Mono', monospace; }
  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot.ok { background: #4ecca3; box-shadow: 0 0 8px #4ecca3; }
  .dot.bad { background: #e94560; box-shadow: 0 0 8px #e94560; }
  .stuck-ok { color: #4ecca3; padding: 12px; font-size: 14px; }
  .stuck-item { background: #1a1a2e; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; border-left: 3px solid #f5a623; }
  .stuck-item .ch { color: #4ecca3; font-weight: bold; }
  .stuck-item .time { color: #e94560; font-size: 12px; }
  .sessions-table { width: 100%; border-collapse: collapse; }
  .sessions-table th { font-size: 11px; color: #888; text-transform: uppercase; text-align: left; padding: 8px 10px; border-bottom: 1px solid #0f3460; }
  .sessions-table td { font-size: 13px; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.03); font-family: 'SF Mono', monospace; }
  .sessions-table tr:hover td { background: rgba(255,255,255,0.02); }
  .size-badge { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 600; }
  .size-badge.normal { background: #1a1a2e; color: #888; }
  .size-badge.info { background: rgba(96,165,250,0.15); color: #60a5fa; }
  .size-badge.warning { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .size-badge.danger { background: rgba(233,69,96,0.15); color: #e94560; }
  .btn-trim { padding: 4px 12px; border-radius: 6px; background: #1a1a2e; color: #888; font-size: 12px; border: 1px solid #0f3460; cursor: pointer; }
  .btn-trim:hover { background: rgba(78,204,163,0.15); color: #4ecca3; border-color: rgba(78,204,163,0.3); }
  .btn-trim:disabled { opacity: 0.3; cursor: not-allowed; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; font-size: 13px; transform: translateY(80px); opacity: 0; transition: all 0.3s; z-index: 999; }
  .toast.visible { transform: translateY(0); opacity: 1; }
  .toast.success { background: #4ecca3; color: #1a1a2e; }
  .toast.error { background: #e94560; color: #fff; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
  .modal-overlay.show { opacity: 1; pointer-events: auto; }
  .modal { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; padding: 24px; max-width: 420px; width: 90%; }
  .modal h3 { border: none; padding: 0; margin-bottom: 12px; }
  .modal p { font-size: 13px; color: #888; margin-bottom: 20px; word-break: break-all; }
  .modal-btns { display: flex; gap: 10px; justify-content: flex-end; }
  .modal-btns button { padding: 8px 20px; border-radius: 8px; font-size: 13px; font-weight: 600; border: none; cursor: pointer; }
  .btn-cancel { background: #1a1a2e; color: #888; }
  .btn-confirm { background: #f5a623; color: #1a1a2e; }
  .last-updated { font-size: 12px; color: #888; }
</style>
</head>
<body>
<div class="header">
  <h1>Bot Health Monitor</h1>
  <div style="display:flex;align-items:center;gap:16px">
    <span class="last-updated" id="last-updated"></span>
    <a href="${basePath}/">back to dashboard</a>
  </div>
</div>
<div class="grid">
  <div class="card" id="card-process">
    <h3>Process Status</h3>
    <div id="process-body">loading...</div>
  </div>
  <div class="card" id="card-stuck">
    <h3>Stuck Detection</h3>
    <div id="stuck-body">loading...</div>
  </div>
  <div class="card span-2" id="card-sessions">
    <h3>Session Management</h3>
    <div id="sessions-body">loading...</div>
  </div>
</div>
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <h3 id="modal-title">Confirm</h3>
    <p id="modal-msg"></p>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" id="modal-confirm">Confirm</button>
    </div>
  </div>
</div>
<script>

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

async function fetchHealth() {
  try {
    const res = await fetch('${basePath}/api/health')
    const d = await res.json()
    renderProcess(d.status)
    renderStuck(d.stuck)
    renderSessions(d.sessions)
    document.getElementById('last-updated').textContent = 'updated: ' + new Date().toLocaleTimeString('zh-CN', {hour12:false})
  } catch(e) { console.error(e) }
}

function renderProcess(s) {
  const el = document.getElementById('process-body')
  if (!s.running) { el.innerHTML = '<div class="status-row"><span class="dot bad"></span> <span style="color:#e94560">not running</span></div>'; return }
  el.innerHTML =
    '<div class="status-row"><span class="dot ok"></span> <span style="color:#4ecca3;font-weight:600">running</span></div>' +
    '<div class="metric-grid">' +
    metric('PID', s.pid, '#60a5fa') +
    metric('Memory', s.memoryMB + ' MB', s.memoryMB > 500 ? '#fbbf24' : '#4ecca3') +
    metric('CPU', s.cpuPercent + '%', s.cpuPercent > 50 ? '#e94560' : '#e0e0e0') +
    metric('Uptime', s.uptime, '#e0e0e0') +
    '</div>'
}
function metric(label, value, color) {
  return '<div class="metric"><div class="metric-label">' + label + '</div><div class="metric-value" style="color:' + color + '">' + value + '</div></div>'
}

function renderStuck(data) {
  const el = document.getElementById('stuck-body')
  if (!data.hasIssues) { el.innerHTML = '<div class="stuck-ok">All channels responding normally</div>'; return }
  let html = ''
  for (const s of data.longRunning) {
    html += '<div class="stuck-item"><span class="ch">#' + esc(s.channelName) + '</span> waiting <span class="time">' + s.waitingMinutes + ' min</span></div>'
  }
  el.innerHTML = html
}

function renderSessions(list) {
  const el = document.getElementById('sessions-body')
  if (!list.length) { el.innerHTML = '<div style="color:#555;padding:12px">no sessions</div>'; return }
  const isOrphan = s => !s.channelId && s.sizeBytes < 10240
  let html = '<table class="sessions-table"><thead><tr><th>Channel</th><th>Size</th><th>Tokens</th><th>Last Active</th><th>Actions</th></tr></thead><tbody>'
  for (const s of list) {
    const tokenHtml = s.tokens
      ? '<div style="font-size:12px;color:#888">in ' + s.tokens.input + ' / out ' + s.tokens.output + '</div><div style="font-size:11px;color:#4ecca3">$' + s.tokens.cost + '</div>'
      : '<span style="color:#555">-</span>'
    const mtime = new Date(s.mtime).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
    const canTrim = s.status === 'danger' || s.status === 'warning'
    const orphan = isOrphan(s)
    let actions = ''
    if (canTrim) actions += '<button class="btn-trim" onclick="confirmTrim(\\'' + esc(s.filename) + '\\')">trim</button> '
    if (orphan) actions += '<button class="btn-trim" style="border-color:rgba(233,69,96,0.3)" onclick="confirmDelete(\\'' + esc(s.filename) + '\\')">delete</button>'
    if (!actions) actions = '<span style="color:#555">-</span>'
    const nameColor = orphan ? '#888' : '#4ecca3'
    const nameLabel = orphan ? '#' + esc(s.name) + ' <span style="color:#e94560;font-size:10px">orphan</span>' : '#' + esc(s.name)
    html += '<tr>' +
      '<td style="color:' + nameColor + ';font-weight:600">' + nameLabel + '</td>' +
      '<td><span class="size-badge ' + s.status + '">' + s.sizeHuman + '</span></td>' +
      '<td>' + tokenHtml + '</td>' +
      '<td style="color:#888">' + mtime + '</td>' +
      '<td>' + actions + '</td>' +
    '</tr>'
  }
  html += '</tbody></table>'
  el.innerHTML = html
}

let pendingAction = null
function confirmTrim(filename) {
  pendingAction = { type: 'trim', filename }
  document.getElementById('modal-title').textContent = 'Confirm Trim'
  document.getElementById('modal-msg').textContent = 'Trim ' + filename + '? Large tool results will be truncated. Original backed up as .pretrim'
  document.getElementById('modal-confirm').textContent = 'Confirm'
  document.getElementById('modal-overlay').classList.add('show')
}
function confirmDelete(filename) {
  pendingAction = { type: 'delete', filename }
  document.getElementById('modal-title').textContent = 'Confirm Delete'
  document.getElementById('modal-msg').textContent = 'Delete ' + filename + '? This cannot be undone.'
  document.getElementById('modal-confirm').textContent = 'Delete'
  document.getElementById('modal-confirm').style.background = '#e94560'
  document.getElementById('modal-overlay').classList.add('show')
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show')
  document.getElementById('modal-confirm').style.background = '#f5a623'
  pendingAction = null
}
document.getElementById('modal-confirm').addEventListener('click', async function() {
  if (!pendingAction) return
  const { type, filename } = pendingAction
  closeModal()
  try {
    const url = type === 'delete' ? '${basePath}/api/delete-session' : '${basePath}/api/trim'
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename}) })
    const r = await res.json()
    showToast(r.message, r.success ? 'success' : 'error')
    if (r.success) fetchHealth()
  } catch(e) { showToast('failed: ' + e.message, 'error') }
})
document.getElementById('modal-overlay').addEventListener('click', function(e) { if (e.target === this) closeModal() })

function showToast(msg, type) {
  const t = document.createElement('div')
  t.className = 'toast ' + type
  t.textContent = msg
  document.body.appendChild(t)
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('visible')))
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300) }, 3000)
}

fetchHealth()
setInterval(fetchHealth, 15000)
</script>
</body>
</html>`
}

module.exports = { getDashboardHTML, getHealthHTML }
