// 网关抽象基类：定义平台网关接口，提供通用消息处理流程
const bus = require('../core/event-bus')
const { enqueue, callClaude } = require('../core/claude-cli')
const { splitMessage } = require('../core/utils')
const memoryMgr = require('../core/memory-manager')
const sessionMgr = require('../core/session-manager')
const config = require('../core/config')

// 频道名缓存（所有网关共享）
const channelNames = new Map()

class BaseGateway {
  /**
   * @param {string} platform - 平台标识，如 'discord', 'telegram'
   * @param {object} [options]
   * @param {number} [options.messageLimit=2000] - 单条消息字符上限
   */
  constructor(platform, options = {}) {
    this.platform = platform
    this.messageLimit = options.messageLimit || 2000
  }

  // ── 子类必须实现的方法 ──

  async start() { throw new Error(`${this.platform}: must implement start()`) }
  async stop() { throw new Error(`${this.platform}: must implement stop()`) }

  /** 获取所有频道名，返回 Map<channelId, name> */
  async fetchChannelNames() { throw new Error(`${this.platform}: must implement fetchChannelNames()`) }

  /** 发送文本消息 */
  async sendMessage(channelId, text) { throw new Error(`${this.platform}: must implement sendMessage()`) }

  /** 发送文件 */
  async sendFile(channelId, filePath, filename) { throw new Error(`${this.platform}: must implement sendFile()`) }

  /** 显示"正在输入" */
  async showTyping(channelId) { throw new Error(`${this.platform}: must implement showTyping()`) }

  // ── 频道名注册（子类和外部都可调用）──

  registerChannel(channelId, name) {
    channelNames.set(channelId, name)
    // 同步到 memory-manager 的频道名缓存
    memoryMgr.registerChannel(channelId, name)
  }

  getChannelName(channelId) {
    return channelNames.get(channelId) || channelId.slice(-6)
  }

  static getChannelNames() {
    return channelNames
  }

  // ── 通用消息处理流程（子类不需要 override）──

  /**
   * @param {object} msg
   * @param {string} msg.channelId
   * @param {string} msg.channelName
   * @param {string} msg.userId
   * @param {string} msg.userName
   * @param {string} msg.text - 用户消息文本
   * @param {string[]} [msg.imagePaths] - 图片本地路径
   * @param {object[]} [msg.parsedFiles] - 解析后的文件 [{ name, content, framePaths? }]
   * @param {string[]} [msg.videoFramePaths] - 视频截帧路径（通常已包含在 parsedFiles.framePaths 里）
   */
  async handleMessage(msg) {
    const { channelId, channelName, userId, userName, text, imagePaths = [], parsedFiles = [], videoFramePaths = [] } = msg

    // 1. 注册频道名
    this.registerChannel(channelId, channelName)

    // 2. 推送用户消息事件
    bus.emit('event:push', { type: 'user', channelId, channelName, data: { user: userName, text } })

    // 3. 拼接 prompt（图片、文件、视频帧）
    let prompt = text || ''

    const allImages = [...imagePaths, ...videoFramePaths]
    if (allImages.length > 0) {
      const refs = allImages.map(p => `[图片: ${p}]`).join('\n')
      prompt = prompt ? `${prompt}\n\n请同时分析以下图片:\n${refs}` : `请分析以下图片:\n${refs}`
    }
    if (parsedFiles.length > 0) {
      const refs = parsedFiles.map(f => `--- ${f.name} ---\n${f.content}`).join('\n\n')
      prompt = prompt ? `${prompt}\n\n以下是用户上传的文件内容:\n${refs}` : `以下是用户上传的文件内容:\n${refs}`
    }

    if (!prompt) return

    // 4. 获取记忆提醒
    const reminders = memoryMgr.getReminders(channelId)

    // 5. 构建完整 userPrompt
    const userPrompt = `[频道:${channelName}] [${userName} (ID:${userId})]: ${prompt}${reminders}`

    console.log(`[${channelName}] ${userName}: ${prompt.slice(0, 80)}...`)

    // 6. 入队 → typing → callClaude（流式发送）
    enqueue(channelId, async () => {
      try {
        await this.showTyping(channelId)
        const typingInterval = setInterval(() => this.showTyping(channelId).catch(() => {}), 8000)

        // ── 流式回调：每个 text block 实时发送到平台 ──
        const streamOnText = async (text) => {
          // 提取 [SEND_FILE:path] 并立即发送文件
          const { existsSync: fileExists, realpathSync: realPath } = require('fs')
          const botDir = config.getBotDir()
          const tempDir = config.getTempDir()
          const fileRegex = /\[SEND_FILE:([^\]]+)\]/g
          let fileMatch
          while ((fileMatch = fileRegex.exec(text)) !== null) {
            const filePath = fileMatch[1].trim()
            if (fileExists(filePath)) {
              try {
                const resolved = realPath(filePath)
                if (resolved.startsWith(botDir) || resolved.startsWith(tempDir)) {
                  const filename = filePath.split('/').pop()
                  await this.sendFile(channelId, filePath, filename)
                }
              } catch {}
            }
          }
          const cleanText = text.replace(fileRegex, '').trim()
          if (!cleanText) return
          // 分段发送
          const parts = splitMessage(cleanText, this.messageLimit)
          for (const part of parts) {
            await this.sendMessage(channelId, part)
          }
        }

        let response
        try {
          response = await callClaude(userPrompt, channelId, { onText: streamOnText })
        } finally {
          clearInterval(typingInterval)
        }

        // 如果流式没发出任何内容（空回复），发送 fallback
        if (!response) {
          await this.sendMessage(channelId, '（没有回复）')
        }
      } catch (err) {
        // 7. 错误处理
        console.error('Claude error:', err.message)
        await this.sendMessage(channelId, `❌ 出错了: ${err.message?.slice(0, 300)}`).catch(() => {})
      }
    })
  }
}

module.exports = { BaseGateway, channelNames }
