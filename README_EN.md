# Claude Memory Bot

> AI Bot framework powered by Claude CLI with a persistent memory system
>
> **Never Loses Memory** | **Zero Extra Token Cost** | **Independent of Session Size**

Memory is stored in standalone files on disk, not inside the conversation context. No matter how many times the session rotates, how long the chat history grows, or if the process crashes — the bot's critical memory stays intact. Memory files are injected only once when a new session starts (~6-10KB), and never grow with the conversation. You won't pay a single extra cent for the memory feature.

![Dashboard](docs/images/dashboard.png)
![Session History](docs/images/session-history.png)

## Features

- **Never Loses Memory** — Memory lives in standalone files, independent of session lifecycle. Rotation, crashes, restarts — nothing affects it. Hot/cold split ensures info is moved, never deleted.
- **Zero Extra Token Cost** — Memory files are injected once on session creation (~6-10KB). No repeated loading during conversation. Unlike vector DB approaches that require embedding and retrieval on every turn.
- **Pitfall Prevention** — User-corrected mistakes are auto-pinned to the top. The most critical info sits where LLM attention is strongest, preventing repeat errors at the source.
- **Code-Level Enforcement** — Doesn't rely on LLM self-discipline. Code automatically detects if the bot wrote memory; if not, it forces a reminder. Auto-alerts on memory bloat. 100% automatic activity logging.
- **Automatic Session Management** — Rotation, context continuity (last 5 rounds bridged), resume with retry & fallback.
- **Multi-Platform** — Discord out of the box. Extend to Telegram, Slack, etc. by subclassing BaseGateway.
- **Web Dashboard** — Local real-time dashboard + optional remote deployment.

## Quick Start

```bash
git clone https://github.com/460065581-star/claude-memory-bot.git
cd claude-memory-bot
npm install
cp .env.example .env
# Edit .env and fill in DISCORD_BOT_TOKEN
npm start
```

## Prerequisites

- **Node.js** 18+
- **Claude CLI** — Installed and working (`claude --version` should output normally)
- **Claude Max subscription** or API key (Claude CLI requires valid authentication)
- **Discord Bot Token** — Get one from [Discord Developer Portal](https://discord.com/developers/applications)

## Configuration

| File | Purpose |
|------|---------|
| `.env` | Environment variables: Bot Token, ports, remote dashboard URL, and other secrets |
| `config.json` | Runtime config: default system prompt, per-channel prompt overrides |
| `CLAUDE.md` | Behavior rules auto-loaded by Claude CLI. Defines memory management guidelines and operational norms |
| `soul.md` | Bot personality definition. Affects speaking style and behavior preferences |

### .env Variables

```bash
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token_here

# Optional
GATEWAY=discord              # Platform selection, default: discord
CLAUDE_CLI_PATH=claude       # Path to Claude CLI binary
WEB_PORT=18792               # Local dashboard port
REMOTE_DASHBOARD_URL=        # Remote dashboard push URL
REMOTE_API_SECRET=           # Remote dashboard API secret
```

## Memory System

The bot ensures cross-session memory through three layers:

1. **File Memory (primary)** — Bot writes memory files via Write/Edit tools. Automatically loaded into system prompt when a new session starts.
2. **Conversation Continuity (bridge)** — On session rotation, the last 5 conversation rounds are extracted from the old session and injected into the new one.
3. **Code-Level Enforcement (safety net)** — Automatically detects if the bot followed memory rules. Inserts reminders when it didn't. Maintains an independent activity log.

### Hot/Cold Split

- **Hot memory** `memory/{channel}.md` — Auto-loaded on every message. Capped at 15KB.
- **Cold memory** `memory/{channel}_archive.md` — Not auto-loaded. Stores historical details. No size limit.
- Information is never deleted, only moved from hot to cold memory.

See `docs/` for detailed documentation.

## Commands

| Command | Description |
|---------|-------------|
| `!help` | Show help |
| `!reset` | Reset current session (memory auto-carries to new session) |
| `!status` | View current session size and token usage |
| `!sessions` | View all sessions overview |
| `!system` | View/set current channel's system prompt |

## Web Dashboard

### Local Dashboard

Starts automatically with the bot. Default URL:

```
http://127.0.0.1:18792
```

Provides real-time event stream, session management, and health monitoring (memory/CPU/stuck detection).

### Remote Dashboard

Set `REMOTE_DASHBOARD_URL` and `REMOTE_API_SECRET` in `.env` to enable auto-push. Deploy the remote dashboard from the `remote-dashboard/` directory:

```bash
cd remote-dashboard
npm install
node server.js
```

## Directory Structure

```
claude-memory-bot/
├── src/
│   ├── index.js                  # Entry point
│   ├── core/
│   │   ├── claude-cli.js         # Claude CLI invocation, watchdog, 403 breaker
│   │   ├── session-manager.js    # Session mapping, rotation, history
│   │   ├── memory-manager.js     # Memory loading, reminders, activity log
│   │   ├── config.js             # Configuration management, path calculation
│   │   ├── event-bus.js          # Global event bus
│   │   ├── file-parser.js        # Full-format file parsing
│   │   └── utils.js              # UUID, message splitting utilities
│   ├── gateway/
│   │   ├── base-gateway.js       # Gateway abstract base class
│   │   └── discord.js            # Discord gateway implementation
│   └── dashboard/
│       ├── local-server.js       # Local HTTP dashboard server
│       ├── local-pages.js        # Dashboard HTML pages
│       └── remote-pusher.js      # Remote dashboard event pusher
├── remote-dashboard/             # Standalone remote dashboard
│   ├── server.js
│   └── pages.js
├── memory/                       # Memory files directory
│   └── global.md                 # Global shared memory
├── docs/                         # Documentation
├── CLAUDE.md                     # Claude CLI behavior rules
├── soul.md                       # Bot personality
├── config.json                   # Runtime configuration
├── .env.example                  # Environment variable template
├── package.json
└── LICENSE
```

## Adding a New Platform

Subclass `BaseGateway` and implement these methods:

```javascript
const { BaseGateway } = require('../gateway/base-gateway')

class TelegramGateway extends BaseGateway {
  constructor() {
    super('telegram', { messageLimit: 4096 })
  }

  async start() { /* Connect to Telegram Bot API */ }
  async stop() { /* Disconnect */ }
  async fetchChannelNames() { /* Return Map<chatId, name> */ }
  async sendMessage(chatId, text) { /* Send text */ }
  async sendFile(chatId, filePath, filename) { /* Send file */ }
  async showTyping(chatId) { /* Show typing indicator */ }
}
```

Call `this.handleMessage(msg)` for incoming messages. The base class automatically handles: channel registration, memory reminders, queued Claude calls, and chunked reply delivery.

## License

MIT
