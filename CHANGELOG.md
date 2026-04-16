# Changelog

## [1.2.0] - 2026-04-16

### Added
- **流式回复** — text block 实时发送到聊天平台，不再等 Claude CLI 全部执行完
- **!stop 命令** — 立即中止当前任务（SIGINT 优雅退出），支持 `!stop` / `/stop` / `!停止`
- **!browse 命令** — 可选的浏览器自动化，通过 Playwright MCP + 独立 Sonnet 进程执行
- **Skill 目录** — `commands/` 目录存放自定义 Skill 文件，通过软链接被 Claude CLI 自动加载
- **activeProcs 进程追踪** — 每个频道的 Claude 进程可被追踪和中止

### Changed
- `runClaude()` 新增 `onText` 回调参数，支持流式输出
- `callClaude()` 透传 `onText` 到所有 `runClaude()` 调用
- `baseArgs` 新增 `--add-dir commands` 允许 Claude CLI 读写 Skill 文件
- `.env.example` 新增 `BROWSE_MODEL` 配置项

## [1.1.0] - 2026-04-14

### Added
- English README (`README_EN.md`) with language switcher
- Dashboard screenshots in README

## [1.0.0] - 2026-04-13

### Initial Release
- **记忆系统** — 热冷分离、踩坑置顶、15KB 截断保护、代码级记忆更新提醒、记忆膨胀提醒
- **Session 管理** — 1.2MB 轮转阈值、最近 5 轮对话桥接（1500 字符）、Resume 3 次重试
- **Claude CLI 集成** — stream-json 解析、Watchdog 进程监控、403 熔断保护
- **Discord 网关** — 消息收发、附件处理（图片/PDF/DOCX/XLSX/ZIP/音视频）、命令系统
- **Web 看板** — 本地 HTTP+SSE 实时看板 + 可选远程部署
- **模块化架构** — core / gateway / dashboard 三层分离，BaseGateway 抽象接口
