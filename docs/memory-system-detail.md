# Bot Discord Bot — 记忆系统完整手册

> 版本：2026-04-12 | 基于实际运行系统整理
>
> 这是一个基于 Claude CLI 驱动的 Discord Bot 的记忆系统。核心问题是：LLM 的对话上下文有限，session 轮转后会丢失所有记忆。本系统通过文件持久化 + 代码保障 + prompt 规则三层机制，让 Bot 具备跨 session 的长期记忆能力。

---

## 一、系统全景

### 1.1 核心矛盾

Claude CLI 的 session 文件会不断增长，达到阈值后必须轮转到新 session。轮转意味着：
- 新 session 里 LLM 看不到旧 session 的任何对话
- 如果不做额外处理，Bot 会彻底"失忆"

### 1.2 解决思路

```
信息持久化（不依赖 session 生存周期）
    ↓
每次新 session 自动注入持久化信息
    ↓
Bot 在新 session 里也能记住关键信息
```

### 1.3 三层保障体系

```
┌──────────────────────────────────────────────┐
│  第一层：文件记忆（主力）                       │
│  Bot 自己通过 Write/Edit 工具写入记忆文件        │
│  新 session 启动时自动加载到 system prompt       │
├──────────────────────────────────────────────┤
│  第二层：对话延续（轮转时的桥梁）                │
│  从旧 session 提取最近 5 轮对话注入新 session     │
│  保证短期上下文不断裂                           │
├──────────────────────────────────────────────┤
│  第三层：代码保障（兜底）                        │
│  bot.js 自动检测 Bot 是否遵守记忆规则            │
│  未遵守时在下条消息中插入提醒                    │
│  自动记录操作日志（不依赖 Bot 自觉）              │
└──────────────────────────────────────────────┘
```

---

## 二、文件存储结构

### 2.1 完整目录

```
discord-bot/
├── soul.md                        # Bot 性格定义（只读）
├── CLAUDE.md                      # 行为规则 + 记忆管理指南
├── config.json                    # 系统提示词配置
├── session-map.json               # 频道 → Session ID 映射
├── session-history.json           # Session 归档历史
│
├── memory/                        # 记忆文件目录
│   ├── global.md                  # 全局热记忆（所有频道共享）
│   ├── {频道名}.md                # 频道热记忆（自动加载）
│   ├── {频道名}_archive.md        # 频道冷记忆（不自动加载）
│   ├── {频道名}_activity.log      # 操作日志（代码自动写）
│   └── .git/                      # git 备份
│
└── ~/.claude/projects/.../        # Claude CLI session 文件
    └── {session-id}.jsonl         # 对话历史
```

### 2.2 各文件的角色

| 文件 | 谁写 | 何时加载 | 大小限制 | 用途 |
|------|------|----------|----------|------|
| `soul.md` | 人工 | 每次新 session | 无 | Bot 的性格、说话风格 |
| `CLAUDE.md` | 人工 | Claude CLI 自动加载 | 无 | 行为规则、记忆管理指南 |
| `global.md` | Bot | 每次新 session | 建议 < 5KB | 跨频道共享信息：用户资料、服务器账号、环境 |
| `{频道}.md` | Bot | 每次新 session | 15KB 截断 | 频道专属信息：当前任务、踩过的坑、项目概要 |
| `{频道}_archive.md` | Bot | **不自动加载** | 无限 | 已完成的历史记录，Bot 需要时主动 Read |
| `{频道}_activity.log` | bot.js 代码 | 不加载 | 无限 | 自动操作日志，审计用 |
| `session-map.json` | bot.js 代码 | 内部使用 | - | 记录每个频道当前使用哪个 session |
| `{session-id}.jsonl` | Claude CLI | resume 时自动 | 1.2MB 轮转 | 完整对话历史 |

---

## 三、记忆的读取（加载流程）

### 3.1 两种场景

**场景 A：继续已有 Session（最常见）**

```
用户发消息 → bot.js 查 session-map 找到 session ID
           → claude --resume {sessionId} -p "用户消息"
           → Session 文件里有完整对话历史，不需要额外注入记忆
```

此时 Bot 能记住本次 session 内所有对话。记忆文件不参与。

**场景 B：新建 Session（轮转/首次/恢复失败时）**

```
用户发消息 → bot.js 发现需要新 session
           → 调用 loadPersistentContext() 加载记忆
           → 调用 extractRecentConversation() 提取旧 session 最近对话
           → enrichedPrompt = 系统提示词 + 记忆 + 最近对话
           → claude --session-id {newId} --system-prompt {enrichedPrompt} -p "用户消息"
```

这是记忆系统真正发挥作用的时刻。

### 3.2 loadPersistentContext() 加载顺序

```
输入：channelId（频道ID）
输出：拼接好的记忆文本

步骤：
1. 读取 soul.md 全文 → 拼接
2. 读取 memory/global.md 全文 → 拼接
3. 读取 memory/{频道名}.md
   ├── 文件 ≤ 15KB → 全文拼接
   └── 文件 > 15KB → 截断到 15KB + 追加提示"详情请 Read _archive.md"
4. 返回拼接结果
```

**加载后的 system prompt 结构**：
```
[CLAUDE.md 定义的系统提示词]

--- soul.md 性格 ---
[Bot 性格定义]
--- soul.md 结束 ---

--- 全局记忆 ---
[用户资料、服务器信息、环境概要...]
--- 全局记忆结束 ---

--- 内容创作 频道记忆 ---
[踩过的坑、当前任务、项目概要...]
--- 频道记忆结束 ---

--- 上一轮会话最近的对话 ---
用户: ...
你: ...
（最多 5 轮）
--- 最近对话结束 ---
```

### 3.3 extractRecentConversation() 对话提取

从旧 session 的 JSONL 文件中提取最近 5 轮有效对话：

```
遍历旧 session 文件的每一行 JSON：
  ├── type=user 且有文本内容 → 开始一轮新对话（清洗掉图片标记、系统提醒等）
  └── type=assistant 且有 text 类型内容 → 追加到当前轮
      ├── 有文本 → 完成这一轮，推入 rounds 数组
      └── 只有 tool_use/thinking → 跳过，继续等下一个 assistant 消息

取最后 5 轮，每轮 user 和 assistant 各截取 1500 字符
```

**关键设计**：assistant 的回复在 JSONL 中被拆成多行（thinking → tool_use → tool_use → ... → text）。只有找到 text 内容后才算这一轮结束。之前有个 bug 是遇到没有 text 的 assistant 行就重置了当前轮，导致每次轮转上下文都是 0——已修复。

---

## 四、记忆的写入（Bot 主动写 + 代码自动写）

### 4.1 Bot 主动写入

Bot（Claude）通过 Write/Edit 工具直接修改记忆文件。写入时机和内容由 CLAUDE.md 中的规则控制：

**何时写**：
- 用户提到重要信息时（项目需求、服务器配置、关键决定）
- 完成一项工作后（必须更新"当前进行中"）
- 被用户纠正后（必须写入"踩过的坑"）

**写什么**：
- 必须存：被纠正的操作、关键决策、当前状态、待办
- 简要存：完成的工作（一行摘要）
- 不存：代码实现细节、能从 git 查到的信息

**怎么写**：
- 必须先 Read 现有内容，再 Write 完整更新（不丢已有信息）
- 保存时不告诉用户（静默完成）

### 4.2 频道热记忆的内部结构

CLAUDE.md 规定了严格的排列顺序，**按 LLM 注意力权重从高到低**：

```markdown
# {频道名}频道记忆

> 历史详情见 memory/{频道名}_archive.md

## 踩过的坑（被纠正过，务必遵守）     ← 最重要，置顶
- 打包不要传服务器！（2026-04-10 被纠正）
- 用户 Mac 是 Intel，一律 x64（2026-04-10 被纠正）
- ...

## 当前进行中                          ← 第2位
- v1.8.9 已打包，待测试

## 待做任务                            ← 第3位

## 项目概要                            ← 第4位

## 最近完成（只保留 5-8 条）           ← 第5位，最早的移到 archive
```

**为什么"踩过的坑"放第一**：LLM 对文本开头的注意力最强（"Primacy Effect"）。被用户纠正过的错误是最有价值的记忆——它们能防止同样的错误再次发生。借鉴了 Hermes Agent 的"减少用户纠正"原则。

### 4.3 全局记忆 vs 频道记忆的分工

| | global.md | {频道}.md |
|--|-----------|-----------|
| 加载范围 | 所有频道的每条消息 | 只有对应频道 |
| 存什么 | 用户画像、服务器账号、环境概要、频道索引 | 项目状态、踩过的坑、技术细节 |
| 原则 | 只放真正跨频道共享的内容 | 频道专属的所有信息 |

### 4.4 代码自动写入（activity.log）

bot.js 在每次 Bot 使用了 Write/Edit/Bash 等工具后，自动追加一行操作日志：

```
[2026-04-12 09:30] 用户: 修改字体下载源 → Edit: render-api.ts, Bash: node build.js
```

这完全由代码控制，不依赖 Bot 自觉，是 100% 可靠的审计追踪。

---

## 五、冷热分离

### 5.1 问题背景

一个频道的记忆文件曾膨胀到 47KB（从 v1.0 到 v1.6 的每个版本详情、竞品分析、12 版编辑器迭代记录）。每条消息都全量注入到 system prompt，导致：
- 大量 input token 浪费
- LLM 注意力被稀释（"Lost in the Middle" 效应）
- 关键信息被淹没在历史记录中

### 5.2 解决方案

```
热记忆 {频道}.md                     冷记忆 {频道}_archive.md
─────────────                      ─────────────────
每条消息自动加载                      不自动加载
只放当前工作相关                      存放所有历史详情
15KB 截断保护                        无大小限制
信息不删除，只移位置                   永久保留
```

**数据不丢失保障**：
- 冷热分离不删除任何信息，只改变存储位置
- 热记忆顶部有指引行：`> 历史详情见 memory/{频道}_archive.md`
- CLAUDE.md 规定：遇到不确定的历史问题，先 Read archive 再回答

### 5.3 实际效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 频道热记忆大小 | 47KB | ~4-9KB |
| 每次 persistent context | ~31,000 chars | ~6,000-9,000 chars |
| 信息丢失 | 无 | 无 |

---

## 六、Session 生命周期

### 6.1 完整流程

```
消息到来
  │
  ▼
查 session-map.json 获取当前频道的 Session ID
  │
  ▼
Session 文件存在？─── 否 ──→ 新建 Session（带完整记忆）
  │
  是
  │
  ▼
文件大小 >= 1.2MB？── 是 ──→ 轮转：归档旧 session，新建 session
  │                           │  注入：系统提示词 + 记忆 + 最近5轮对话
  否                           ▼
  │                         新 Session 开始
  ▼
尝试 resume 旧 Session
  │
  ├── 成功 → 继续对话
  │
  └── 失败 → 重试（最多 3 次，每次间隔 2 秒）
       │
       └── 全部失败 → 新建 Session（带记忆 + 最近对话）
```

### 6.2 轮转时发生了什么

```
1. bot.js 检测到 session 文件 >= 1.2MB
2. 生成新的 session UUID
3. loadPersistentContext()：读取 soul.md + global.md + 频道热记忆
4. extractRecentConversation()：从旧 session 提取最近 5 轮对话
5. 拼接为 enrichedPrompt，作为新 session 的 system prompt
6. 旧 session ID 记录到 session-history.json
7. 新 session ID 写入 session-map.json
8. 后续消息走新 session
```

### 6.3 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 轮转阈值 | 1.2MB | 太小轮转太频繁丢上下文，太大 token 浪费 |
| 对话轮数 | 5 轮 | 轮转时携带到新 session 的对话数 |
| 文本截取 | 1500 字符 | 每轮 user/assistant 各 1500 字符 |
| Resume 重试 | 3 次 / 间隔 2 秒 | 容错短暂的 session 异常 |
| 热记忆上限 | 15KB | 超过自动截断 |

---

## 七、代码级保障机制

Bot 是 LLM，不能 100% 保证自觉遵守规则。bot.js 提供三个代码级保障：

### 7.1 记忆更新提醒（needsMemoryReminder）

```
触发条件：Bot 本次回复使用了 Write/Edit/Bash 等工具，
         但没有修改 memory/ 目录下的文件

效果：下一条消息的 prompt 末尾自动附加：
"[提醒：你上次完成了工作但没有更新记忆文件，
  请更新 memory/{频道}.md 的「当前进行中」段落]"
```

实际运行数据：自启动以来触发了 57 次——说明 Bot 确实会忘记写记忆，这个提醒机制是必要的。

### 7.2 记忆膨胀提醒（needsMemoryConsolidation）

```
触发条件：Bot 写入记忆文件后，该文件大小超过 12KB

效果：下一条消息的 prompt 末尾自动附加：
"[提醒：频道记忆文件已超过12KB，请精简：
  合并「最近完成」的旧条目，
  把已完成的详细记录移到 _archive.md，
  「踩过的坑」和「当前进行中」保持不动]"
```

### 7.3 自动操作日志（activity.log）

```
触发条件：Bot 使用了任何工作工具

效果：自动追加一行到 {频道}_activity.log：
"[2026-04-12 09:30] 用户: 修改字体下载源 → Edit: render-api.ts"
```

完全由代码维护，零 token 成本，100% 可靠。

### 7.4 403 熔断保护

```
触发条件：30 秒内出现 2 次 API 403 错误

效果：自动关闭 Bot 和所有 Claude 进程，防止账号风险
```

### 7.5 Watchdog 进程监控

```
每 15 秒检查 Claude 子进程：
- sleep 命令超过 30 秒 → 自动 kill
- SSH/其他命令超过 90 秒 → 自动 kill
防止 Bot 被卡死的命令阻塞
```

---

## 八、消息的完整生命周期

从一条 Discord 消息进来到回复发出，完整流程：

```
1. Discord 用户发送消息
     │
2. bot.js 收到 messageCreate 事件
     │
3. 是命令消息？（!help / !reset / !status）
     ├── 是 → 处理命令，结束
     └── 否 → 继续
     │
4. 进入频道队列 enqueue(channelId)
   （同一频道同时只能有一个 Claude 调用，防止 session 冲突）
     │
5. 处理附件
   ├── 图片 → 下载到 temp/，路径传给 Claude
   ├── PDF/DOCX/XLSX → 解析提取文本
   ├── 视频 → ffprobe 元信息 + ffmpeg 截帧
   ├── ZIP → 解压并递归解析内部文件
   └── 代码/文本 → 直接读取
     │
6. 拼接 prompt
   "[频道:项目A] [用户名 (ID:xxx)]: 用户消息"
   + "[提醒：上次没更新记忆]"          ← needsMemoryReminder
   + "[提醒：记忆超12KB请精简]"        ← needsMemoryConsolidation
     │
7. callClaude(prompt, channelId)
     │
     ├── 需要新 Session？
     │    → loadPersistentContext() 加载记忆
     │    → extractRecentConversation() 提取最近对话
     │    → claude --session-id {new} --system-prompt {enriched}
     │
     └── 继续已有 Session？
          → claude --resume {sessionId}
          → 失败重试 3 次
          → 全失败则新建 session
     │
8. Claude CLI 执行
   （可能调用 Read/Write/Edit/Bash/Grep 等工具）
   （bot.js 实时解析 stream-json 输出，打印日志）
     │
9. Claude CLI 退出
     │
10. 后处理
    ├── 记录 token 用量和费用
    ├── 检查记忆更新：干了活没写记忆 → 标记 needsMemoryReminder
    ├── 检查记忆膨胀：写了记忆且超 12KB → 标记 needsMemoryConsolidation
    └── 追加 activity.log
     │
11. 将回复文本分段发送到 Discord（每段 ≤ 2000 字符）
```

---

## 九、信息检索路径

当 Bot 需要查找信息时，按以下优先级：

```
1. 当前 Session 对话历史（自动，不需要额外操作）
     │
     没找到
     ▼
2. 频道热记忆 {频道}.md（已自动注入 system prompt）
     │
     没找到
     ▼
3. 频道冷记忆 {频道}_archive.md（主动 Read）
     │
     没找到
     ▼
4. 全局记忆 global.md（已自动注入 system prompt）
     │
     没找到
     ▼
5. 历史 Session 文件（Grep 搜索 .jsonl 文件，找到后 Read 上下文）
     │
     没找到
     ▼
6. 代码/文件系统（直接 Read 源代码或 git log）
```

---

## 十、Git 备份

bot.js 启动时自动对 memory/ 目录执行 git commit：

```
📦 Memory files backed up (git)
```

保证即使记忆文件被误删或错误修改，也可以从 git 历史恢复。

---

## 十一、设计决策与权衡

### 11.1 全量加载 vs 索引式加载

**我们选择了全量加载热记忆**。

Hermes Agent 的方案是 system prompt 只放索引，LLM 按需 Read 完整文件。但其用户反馈：
- 2200 字符上限太小，信息被自动合并时丢失
- LLM 不一定会主动去 Read

我们的热记忆控制在 5-10KB，全量加载保证关键信息一定被 LLM 看到。

### 11.2 记忆排列顺序

借鉴 Hermes Agent 的"减少用户纠正"原则：被纠正过的操作放在最前面。

LLM 对文本开头注意力最强，把"踩过的坑"置顶，最大限度防止重复犯错。

### 11.3 代码提醒 vs 纯 prompt 规则

Hermes Agent 完全依赖 prompt 引导 LLM 自主管理记忆。

我们采用 prompt 规则 + 代码检测双保险：
- CLAUDE.md 定义规则（LLM 应该怎么做）
- bot.js 检测是否遵守（没遵守就提醒）
- activity.log 提供独立于 LLM 的审计追踪

### 11.4 轮转阈值 1.2MB

最初 500KB，轮转太频繁，每次轮转都有丢上下文的风险。提高到 1.2MB 后，一个 session 通常能持续数小时。Claude Opus 的 1M context 能处理远超 1.2MB 的内容。

### 11.5 不自动创建 Skill

Hermes Agent 通过 prompt 引导 LLM 完成复杂任务后自动生成 Skill 文档。我们评估后暂未采用：
- 纯 prompt 驱动的触发率不稳定
- 项目快速迭代期，流程频繁变化，Skill 容易过时
- 过时的 Skill 比没有 Skill 更危险

等项目稳定后可考虑引入。

---

## 十二、当前运行状态（2026-04-12）

### 12.1 记忆文件概况

| 文件 | 大小 | 说明 |
|------|------|------|
| global.md | 4.5KB | 用户资料、服务器账号、环境 |
| 内容创作.md | 8.7KB | 热记忆，含 21 条踩坑记录 |
| 内容创作_archive.md | 7.0KB | 冷记忆，历史版本详情 |
| 闲聊.md | 9.8KB | 百家号查重系统（未拆冷热） |
| 装龙虾.md | 6.4KB | 远程装虾流程 |
| 内容创作_activity.log | 155KB | 自动操作日志 |

### 12.2 运行统计

| 指标 | 数据 |
|------|------|
| Session 轮转次数 | 40 次 |
| 记忆更新提醒触发 | 57 次 |
| 记忆膨胀提醒触发 | 0 次 |
| 轮转时上下文提取成功率 | 32/37（修复 bug 后 100%） |

### 12.3 已知问题

1. **"踩过的坑"增长过快**：两天从 7 条涨到 21 条，很多是已修复的代码级 bug 细节，不需要留在热记忆里
2. **闲聊.md 和装龙虾.md 未做冷热分离**：还是全量加载，会随着使用持续膨胀
3. **踩坑记录是频道级的**：跨频道通用的坑（如 Electron 打包经验）只存在特定频道记忆里，其他频道遇到同样问题不一定能避开

---

## 附录 A：CLAUDE.md 记忆相关规则全文

```markdown
## 记忆系统

### 文件结构
- soul.md — 性格（只读）
- memory/global.md — 跨频道共享记忆
- memory/{频道名}.md — 频道专属记忆

### 规则
1. 重要信息立刻写入记忆文件
2. 每次完成工作后必须更新记忆（最重要的规则）
3. 频道信息写频道记忆，通用信息写 global
4. global.md 只放跨频道共享内容
5. 更新时先 Read 再 Write 完整内容（不丢信息）
6. 频道记忆不存在时自动创建
7. 可随时 Read 记忆文件
8. 保存记忆时不告诉用户
9. 必须维护「当前进行中」段落

### 记忆文件结构（按顺序）
1. 踩过的坑 — 被纠正过的操作，置顶
2. 当前进行中
3. 待做任务
4. 项目概要
5. 最近完成（只保留 5-8 条）

### 什么值得存
- 必须存：被纠正的操作、关键决策、当前状态、待办
- 简要存：完成的工作（一行摘要）
- 不存：代码细节、git 能查到的信息

### 冷热分离
- 热记忆：自动加载，≤ 15KB
- 冷记忆 _archive.md：不自动加载，无限大
- 热记忆太大时移旧内容到 archive
- 不确定的历史问题先查 archive
```

---

## 附录 B：关键参数速查

| 参数 | 值 | 代码位置 |
|------|-----|----------|
| Session 轮转阈值 | 1.2MB | `ROTATE_THRESHOLD` |
| 热记忆加载上限 | 15KB | `CH_MEM_LIMIT` |
| 记忆膨胀提醒阈值 | 12KB | 膨胀检查逻辑 |
| 轮转时携带对话轮数 | 5 轮 | `rounds.slice(-5)` |
| 每轮文本截取长度 | 1500 字符 | `slice(0, 1500)` |
| Resume 重试次数 | 3 次 | resume 循环 |
| Resume 重试间隔 | 2 秒 | `setTimeout(r, 2000)` |
| Watchdog 检查间隔 | 15 秒 | `setInterval(..., 15000)` |
| Sleep 命令超时 | 30 秒 | `SLEEP_TIMEOUT` |
| SSH/命令超时 | 90 秒 | `CMD_TIMEOUT` |
| 403 熔断窗口 | 30 秒内 2 次 | `last403Time` |
