// 通用工具函数：UUID生成、消息分割等
const crypto = require('crypto')

/**
 * 生成 UUID v5（确定性，基于命名空间+名称）
 */
function uuidv5(name) {
  const ns = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const hash = crypto.createHash('sha1').update(ns).update(Buffer.from(name)).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const h = hash.toString('hex').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * 将长文本按 Discord 限制拆分（默认2000字符）
 */
function splitMessage(text, max = 2000) {
  if (text.length <= max) return [text]
  const parts = []
  while (text.length > 0) {
    if (text.length <= max) { parts.push(text); break }
    let cut = text.lastIndexOf('\n', max)
    if (cut <= 0) cut = text.lastIndexOf(' ', max)
    if (cut <= 0) cut = max
    parts.push(text.slice(0, cut))
    text = text.slice(cut).trimStart()
  }
  return parts
}

module.exports = { uuidv5, splitMessage }
