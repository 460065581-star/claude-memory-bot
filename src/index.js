#!/usr/bin/env node

// 全局错误处理
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason)
})

// 加载 .env
require('dotenv').config()

const { execSync } = require('child_process')
const path = require('path')

// 初始化核心
const sessionMgr = require('./core/session-manager')
const memoryMgr = require('./core/memory-manager')
const config = require('./core/config')
const bus = require('./core/event-bus')

sessionMgr.init()

// Git 备份 memory/
const memoryDir = path.join(config.getBotDir(), 'memory')
try {
  // 如果 memory/ 还没有 .git，先初始化
  try {
    execSync('git rev-parse --git-dir', { cwd: memoryDir, stdio: 'pipe' })
  } catch {
    execSync('git init && git add -A && git commit -m "init memory"', { cwd: memoryDir, stdio: 'pipe' })
    console.log('📦 Memory git repo initialized')
  }
  execSync('git add -A && git diff --cached --quiet || git commit -m "auto-backup"', {
    cwd: memoryDir,
    stdio: 'pipe',
  })
  console.log('📦 Memory files backed up (git)')
} catch (e) {
  // 备份失败不影响启动
  console.log('📦 Memory git backup skipped:', e.message?.slice(0, 80))
}

// 启动看板
const dashboard = require('./dashboard/local-server')
const remotePusher = require('./dashboard/remote-pusher')
const claudeCli = require('./core/claude-cli')

// 给 dashboard 传递共享状态
dashboard.setContext({
  channelNames: memoryMgr.getChannelNames(),
  channelUsage: claudeCli.getChannelUsage(),
})
remotePusher.setContext({
  channelNames: memoryMgr.getChannelNames(),
  channelUsage: claudeCli.getChannelUsage(),
})

const port = parseInt(process.env.WEB_PORT) || 18792
dashboard.start(port)
remotePusher.init()

// 启动 Gateway
async function main() {
  const platform = (process.env.GATEWAY || 'discord').toLowerCase()

  if (platform === 'discord') {
    const DiscordGateway = require('./gateway/discord')
    const gw = new DiscordGateway()
    await gw.start()
  } else {
    console.error(`Unknown gateway: ${platform}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
