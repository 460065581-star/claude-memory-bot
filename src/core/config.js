// 配置管理：路径计算、config.json 读写、系统提示词
const path = require('path')
const os = require('os')
const { readFileSync, writeFileSync, mkdirSync } = require('fs')

const BOT_DIR = process.env.BOT_DIR || process.cwd()
const SESSION_DIR = path.join(
  os.homedir(), '.claude', 'projects',
  '-' + BOT_DIR.replace(/\//g, '-').slice(1)
)
const TEMP_DIR = path.join(BOT_DIR, 'temp')
mkdirSync(TEMP_DIR, { recursive: true })
const CONFIG_FILE = path.join(BOT_DIR, 'config.json')

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  catch { return { defaultSystemPrompt: '你是一个AI助手。请用中文回复。', channels: {} } }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
}

function getSystemPrompt(channelId) {
  const cfg = loadConfig()
  return cfg.channels[channelId]?.systemPrompt || cfg.defaultSystemPrompt
}

function getBotDir() { return BOT_DIR }
function getSessionDir() { return SESSION_DIR }
function getTempDir() { return TEMP_DIR }

module.exports = { loadConfig, saveConfig, getSystemPrompt, getBotDir, getSessionDir, getTempDir }
