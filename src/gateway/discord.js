// Discord 网关：继承 BaseGateway，实现 Discord 特有的消息收发逻辑
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js')
const { writeFileSync, existsSync, readdirSync, statSync, readFileSync } = require('fs')
const { join, extname } = require('path')
const { execSync } = require('child_process')

const { BaseGateway } = require('./base-gateway')
const fileParser = require('../core/file-parser')
const bus = require('../core/event-bus')
const sessionMgr = require('../core/session-manager')
const memoryMgr = require('../core/memory-manager')
const config = require('../core/config')
const { getChannelUsage } = require('../core/claude-cli')

class DiscordGateway extends BaseGateway {
  constructor() {
    super('discord', { messageLimit: 2000 })
    this.client = null
  }

  async start() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    })

    this.client.once('ready', async () => {
      console.log(`✅ Bot online: ${this.client.user.tag}`)
      console.log(`   Guilds: ${this.client.guilds.cache.map(g => g.name).join(', ')}`)

      // 缓存所有频道名
      const names = await this.fetchChannelNames()
      for (const [id, name] of names) {
        this.registerChannel(id, name)
      }
      console.log(`   Cached ${names.size} channel names`)

      // 自动匹配孤儿 session
      sessionMgr.matchOrphanSessions(DiscordGateway.getChannelNames())

      bus.emit('gateway:ready', { platform: 'discord', tag: this.client.user.tag })
    })

    this.client.on('messageCreate', async (msg) => {
      if (msg.author.bot) return
      await this._handleDiscordMessage(msg)
    })

    this.client.on('error', (err) => {
      console.error(`[Discord] client error: ${err.message}`)
    })
    this.client.on('disconnect', () => {
      console.log('[Discord] disconnected, will auto-reconnect')
    })

    const token = process.env.DISCORD_BOT_TOKEN
    if (!token) throw new Error('DISCORD_BOT_TOKEN 环境变量未设置')
    await this.client.login(token)
  }

  async stop() {
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
  }

  // ── 接口实现 ──

  async fetchChannelNames() {
    const names = new Map()
    for (const guild of this.client.guilds.cache.values()) {
      try {
        const channels = await guild.channels.fetch()
        for (const [id, ch] of channels) {
          if (ch && ch.name) names.set(id, ch.name)
        }
        // 活跃线程
        const threads = await guild.channels.fetchActiveThreads()
        for (const [id, th] of threads.threads) {
          names.set(id, th.name)
        }
      } catch (e) {
        console.error('Failed to cache channel names:', e.message)
      }
    }
    return names
  }

  async sendMessage(channelId, text) {
    const channel = await this._getChannel(channelId)
    if (channel) await channel.send(text)
  }

  async sendFile(channelId, filePath, filename) {
    const channel = await this._getChannel(channelId)
    if (channel) {
      const attachment = new AttachmentBuilder(filePath, { name: filename })
      await channel.send({ files: [attachment] })
    }
  }

  async showTyping(channelId) {
    const channel = await this._getChannel(channelId)
    if (channel) await channel.sendTyping()
  }

  // ── Discord 内部方法 ──

  async _getChannel(channelId) {
    try {
      return await this.client.channels.fetch(channelId)
    } catch (e) {
      console.error(`[Discord] failed to fetch channel ${channelId}: ${e.message}`)
      return null
    }
  }

  /** 下载 Discord 附件到本地临时目录 */
  async _downloadAttachment(att) {
    const res = await fetch(att.url)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = att.name?.split('.').pop() || 'png'
    const path = join(config.getTempDir(), `${Date.now()}-${att.id}.${ext}`)
    writeFileSync(path, buf)
    return path
  }

  /** 处理 Discord 消息：命令或普通消息 */
  async _handleDiscordMessage(msg) {
    const content = msg.content.trim().replace(/^！/, '!')

    // ── 命令处理 ──
    if (content === '!help') {
      return msg.channel.send([
        '**可用命令：**',
        '`!system` — 查看当前系统提示词',
        '`!system <提示词>` — 设置当前频道/子区的系统提示词',
        '`!reset` — 重置当前会话（清除上下文）',
        '`!status` — 查看当前子区会话大小',
        '`!sessions` — 查看所有会话概览',
        '`!help` — 显示帮助',
        '',
        '直接发消息或图片即可对话，每个频道/子区的会话独立。',
      ].join('\n'))
    }

    if (content === '!system') {
      const prompt = config.getSystemPrompt(msg.channelId)
      return msg.channel.send(`当前系统提示词:\n\`\`\`\n${prompt}\n\`\`\``)
    }

    if (content.startsWith('!system ')) {
      const newPrompt = content.slice(8).trim()
      if (!newPrompt) return msg.channel.send('用法: `!system <新的系统提示词>`')
      const cfg = config.loadConfig()
      cfg.channels[msg.channelId] = { ...cfg.channels[msg.channelId], systemPrompt: newPrompt }
      config.saveConfig(cfg)
      sessionMgr.markNeedsNewSession(msg.channelId)
      return msg.channel.send('✅ 系统提示词已更新，下一条消息开始新会话')
    }

    if (content === '!reset') {
      sessionMgr.markNeedsNewSession(msg.channelId)
      return msg.channel.send('✅ 会话已重置（之前的记忆会自动携带到新会话）')
    }

    if (content === '!status') {
      return this._handleStatusCommand(msg)
    }

    if (content === '!sessions' || content === '!session') {
      return this._handleSessionsCommand(msg)
    }

    // ── 普通消息 → Claude ──
    await this._processNormalMessage(msg, content)
  }

  /** !status 命令 */
  async _handleStatusCommand(msg) {
    const sessionId = sessionMgr.toSessionId(msg.channelId)
    const sessionFile = join(config.getSessionDir(), `${sessionId}.jsonl`)
    const info = []
    info.push('**当前会话状态**')
    info.push(`Session ID: \`${sessionId.slice(0, 8)}...\``)
    try {
      const st = statSync(sessionFile)
      const sizeKB = (st.size / 1024).toFixed(1)
      const lines = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).length
      const age = ((Date.now() - st.birthtimeMs) / 3600000).toFixed(1)
      info.push(`文件大小: ${sizeKB} KB`)
      info.push(`消息轮数: ~${lines}`)
      info.push(`已运行: ${age} 小时`)
    } catch {
      info.push('Session 文件: 尚未创建')
    }
    const usage = getChannelUsage().get(msg.channelId)
    if (usage) {
      info.push('')
      info.push('**Token 用量 (本次启动以来)**')
      const toK = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n.toString()
      info.push(`总调用次数: ${usage.calls}`)
      info.push(`累计输入: ${toK(usage.inputTokens + usage.cacheRead + usage.cacheCreate)}`)
      info.push(`累计输出: ${toK(usage.outputTokens)}`)
      info.push(`累计费用: $${usage.totalCost.toFixed(4)}`)
      info.push(`最近一次: 输入 ${toK(usage.lastInput + usage.lastCacheRead)} / 输出 ${toK(usage.lastOutput)} / $${usage.lastCost.toFixed(4)}`)
    } else {
      info.push('\nToken 用量: 本次启动后暂无调用记录')
    }
    return msg.channel.send(info.join('\n'))
  }

  /** !sessions 命令 */
  async _handleSessionsCommand(msg) {
    try {
      const sessionDir = config.getSessionDir()
      const files = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'))
      if (files.length === 0) return msg.channel.send('暂无会话')
      const lines = files.map(f => {
        const st = statSync(join(sessionDir, f))
        const sizeKB = (st.size / 1024).toFixed(1)
        const sid = f.replace('.jsonl', '')
        const isCurrent = sid === sessionMgr.toSessionId(msg.channelId) ? ' ← 当前' : ''
        return `\`${sid.slice(0, 8)}...\` ${sizeKB} KB${isCurrent}`
      }).sort()
      return msg.channel.send(`**所有会话 (${files.length}个)**\n${lines.join('\n')}`)
    } catch {
      return msg.channel.send('无法读取会话目录')
    }
  }

  /** 处理普通消息：下载附件、解析文件、调用 handleMessage */
  async _processNormalMessage(msg, content) {
    const imagePaths = []
    const parsedFiles = []
    const videoFramePaths = []

    // 下载并解析附件
    for (const [, att] of msg.attachments) {
      if (att.contentType?.startsWith('image/')) {
        const path = await this._downloadAttachment(att)
        imagePaths.push(path)
      } else {
        const path = await this._downloadAttachment(att)
        try {
          const parsed = await fileParser.parseFile(path, att.name || 'file')
          if (parsed) {
            parsedFiles.push(parsed)
            if (parsed.framePaths) videoFramePaths.push(...parsed.framePaths)
          }
        } catch (e) {
          console.error(`[WARN] 解析附件失败 ${att.name}: ${e.message}`)
          parsedFiles.push({ name: att.name || 'file', content: `[文件解析失败: ${e.message}]` })
        }
      }
    }

    const channelName = msg.channel.name || 'DM'
    const displayName = msg.member?.displayName || msg.author.displayName || msg.author.username
    const userId = msg.author.id

    await this.handleMessage({
      channelId: msg.channelId,
      channelName,
      userId,
      userName: displayName,
      text: content,
      imagePaths,
      parsedFiles,
      videoFramePaths,
    })
  }
}

module.exports = DiscordGateway
