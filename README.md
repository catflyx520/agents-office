# Agents Office 🏢

> A 2D pixel-art virtual office where every NPC is a **real Claude Code agent**.

English | [中文](#agents-office--中文)

You walk around a cozy pixel office; walk up to a "coworker" to chat with them. Tell the **PM** what you need and it breaks the request into tasks, walks over to each teammate's desk, and hands out the work — behind the scenes, real `claude` CLI subprocesses are reading code, editing files, and running commands in real project repos.

Not a chat toy: every delegation you watch in the game is actual multi-agent parallel development happening on your machine.

## ✨ Features

**Core**
- 🎮 Phaser 3 pixel office: move with WASD, press E near a coworker to talk
- 🧑‍💼 **PM orchestration**: one request → JSON plan → dependency-aware waves executed in parallel → summary report, all visualized with walk-and-delegate animations
- 👥 **Multiple managers**: mark any agent with `manager: true` + `team: [...]` and it becomes an independent team lead — its roster and the PM's never overlap
- ⚡/✋ Auto / Confirm modes: in confirm mode you preview the plan before it runs
- 📄 Agents are Markdown files: `~/.virtual-office/agents/<id>.md` — YAML front-matter for config, body as system prompt

**Token management (the money savers)**
- 📊 Live usage boards on the wall + a detail panel: grouped by member / session / project, with **three-tier breakdown** (✍️ raw input 1x · 📷 cache write 1.25x · 📄 cache read 0.1x) plus cache hit rate & reuse ratio
- 🗜️ **Session compaction**: summarize a long session and continue in a fresh one — manual button + auto threshold (compact when a session exceeds N k tokens), with a browsable compaction history (generation, cost before, the summary itself)
- 🆕 **Ctrl+Enter for a fresh session**: ask without dragging old history along; PM-dispatched tasks always run in fresh sessions — no more snowballing resumes

**Atmosphere**
- 🕐 Real-time wall clock + ☀️🌙 **time-of-day window scenes** (dawn / day / dusk / night — the sun and moon travel a real arc, city lights come on at night)
- 🌤 Weather board: free APIs with auto location (click to set a zip code), refreshed every 30 min
- 🚪 Try to sneak out the EXIT door and you'll be roasted by dark-humor one-liners
- 🏷️ Rename your office; rename and recolor your own character

## 🚀 Quick start

Install Node.js and the CLI for the provider you want to use: Claude Code (`claude`) or Codex (`codex`). Node.js 24 is the runtime used for the repository's local checks.

```bash
git clone https://github.com/catflyx520/agents-office.git
cd agents-office
npm ci
```

For API key authentication, copy `.env.example` to `.env` in the project root:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux, use `cp .env.example .env`. Fill in only the key you need:

```dotenv
ANTHROPIC_API_KEY=
CODEX_API_KEY=
CLAUDE_BIN=claude
CODEX_BIN=codex
PORT=3000
```

`ANTHROPIC_API_KEY` is your Claude API key; `CODEX_API_KEY` is your OpenAI API key for `codex exec`. If the selected CLI already has an account login, you can leave its key blank and use that login instead. Both providers' CLIs must be installed separately from this project's npm dependencies.

Run `npm start`, open http://localhost:3000, and select Claude or Codex in **模型与登录**. Its login indicator reports CLI account status, not API key validity. Restart the server after editing `.env`.

Before assigning work, update each agent's `workDir` to an existing project directory on your machine, including the PM when using Codex. Agent files are created on first start under `~/.virtual-office/agents/` (`$HOME\.virtual-office\agents` in PowerShell). Default frontend/backend/mobile paths are examples; Codex expects a Git repository.

Existing terminal environment variables take precedence over `.env`. For Claude, an environment key also takes precedence over the legacy `apiKey` saved in `~/.virtual-office/config.json`. `.env` and `.env.*` are ignored by Git; only the blank `.env.example` is committed. Never put API keys in `client/`.

If the CLI cannot be found, set `CLAUDE_BIN` or `CODEX_BIN` to its executable's full path, quoting paths with spaces. On Windows, a `.cmd` launcher alone may not work with the current process runner; use the actual executable or run the project and CLI together in WSL.

```bash
npm test           # Jest unit tests
```

Environment variables:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Optional Claude API key |
| `CODEX_API_KEY` | Optional OpenAI API key for Codex execution |
| `CLAUDE_BIN` | Executable name or path; defaults to `claude` |
| `CODEX_BIN` | Executable name or path; defaults to `codex` |
| `PORT` | Server port, default 3000 |
| `TOKEN_REPORT_SEC` | Usage stats refresh interval in seconds, default 120 |

## 🏗️ Architecture

```
Browser (Phaser 3 + native ES modules)
   │  WebSocket (one type per message; client re-dispatches as DOM events)
   ▼
Node server (Express + ws)
   │  spawns one subprocess per agent call
   ▼
claude CLI (-p non-interactive + stream-json + --resume)
   → does real work inside each agent's workDir repo
```

- **Session continuity**: each turn is a one-shot process; memory comes from `--resume <session-id>` against the local session store
- **Tool control**: `--tools` whitelists what an agent can load at all (`Agent`/`Task` excluded — no recursive sub-agent explosions)
- **Usage stats**: aggregated straight from the real per-message `usage` in `~/.claude*/projects/**/*.jsonl` — same source as `/status`

## ⚠️ Security notes

Agent subprocesses run with `--dangerously-skip-permissions` (non-interactive mode has no approval prompt), which means **they can freely read/write files and run Bash inside their workDir repos**. Only point agents at directories you trust them with.

API keys can live in the ignored root `.env` file or your terminal environment. Legacy saved keys, uploads, session mappings, and compaction logs live in `~/.virtual-office/`, outside the repo. Claude skips permission prompts; Codex also bypasses approvals and sandboxing. Use this application locally with trusted projects.

## 📁 Project layout

```
client/            Browser side (no build step — edit & refresh)
  index.html       All UI layout / modals / character templates
  src/app.js       Main logic: chat, map, usage panel, compaction, clock & windows
server/
  index.js         Express + WS wiring, default agent seeding, timers
  wsHandler.js     Message routing, orchestration, session compaction
  pmOrchestrator.js Plan extraction (brace-matching scan), wave scheduling
  claudeRunner.js  Spawning claude subprocesses + stream-json parsing
  agentManager.js  Agent markdown file I/O
  tokenUsage.js    Token usage aggregation (three-tier breakdown)
  weather.js       Weather (ip-api + open-meteo + zippopotam, all free, no keys)
tests/             Pure-logic Jest tests
```

## License

MIT

---

# Agents Office · 中文

## 本地 API Key 配置

安装所选服务商的 CLI 后，在项目根目录将 `.env.example` 复制为 `.env`（PowerShell：`Copy-Item .env.example .env`），填写需要使用的 key：

```dotenv
ANTHROPIC_API_KEY=
CODEX_API_KEY=
CLAUDE_BIN=claude
CODEX_BIN=codex
PORT=3000
```

- Claude API key 填在 `ANTHROPIC_API_KEY`；OpenAI API key 填在 `CODEX_API_KEY`，用于本项目的 `codex exec` 调用。
- 已通过 CLI 账户登录时，可以留空对应 key。网页中的登录状态显示 CLI 账户状态，不用于验证这里填写的 API key。
- 执行 `npm ci` 和 `npm start`，打开 http://localhost:3000，在「模型与登录」选择服务商。修改 `.env` 后重启服务。
- 找不到 CLI 时，把 `CLAUDE_BIN` / `CODEX_BIN` 改成可执行文件完整路径；带空格的路径加双引号。Windows 若命令只有 `.cmd` 启动器，需指定实际可执行文件或在 WSL 中运行。
- 系统环境变量优先于 `.env`；Claude 环境变量 key 优先于旧的 `~/.virtual-office/config.json` 中的 `apiKey`。
- `.env` 和 `.env.*` 已被 Git 忽略，仅提交不含密钥的 `.env.example`。密钥只供本地服务使用，不要放在 `client/` 下。

Codex key 配置依据：[OpenAI 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

> **小办公室** — 一个 2D 像素风虚拟办公室，里面的每个 NPC 都是一个**真实的 Claude Code agent**。

你操控一个小人在办公室里走动，走到哪位"同事"面前就能和 TA 对话。跟 **PM** 说一句需求，它会拆解任务、走到对应同事的工位把活儿派下去——背后是真实的 `claude` CLI 子进程在真实的项目仓库里读代码、改文件、跑命令。

不是聊天玩具：你在游戏里看到的每一次派活，都是真实发生的多 agent 并行开发。

## ✨ 功能

**核心**
- 🎮 Phaser 3 像素办公室：WASD 走动，走近同事按 E 对话
- 🧑‍💼 **PM 编排**：一句需求 → 拆解成 JSON 计划 → 按依赖分波（wave）并行派发 → 完成后汇总汇报，全程有走动/递任务动画
- 👥 **多管理者**：任何 agent 加上 `manager: true` + `team: [...]` 就是一个独立小组长，管自己的人、和 PM 互不越权
- ⚡/✋ 全自动 / 先确认 两种模式：确认模式下先看计划预览再执行
- 📄 Agent 即 Markdown 文件：`~/.virtual-office/agents/<id>.md`，YAML front-matter 存配置，正文是 system prompt

**Token 管理（省钱三件套）**
- 📊 墙上实时用量牌 + 明细面板：按成员/会话/项目分组，**三级分解**（✍️ 纯输入 1x · 📷 缓存写 1.25x · 📄 缓存读 0.1x）+ 缓存命中率 / 复用倍数
- 🗜️ **会话压缩（compact）**：长会话总结成摘要、开新会话续命——手动按钮 + 自动阈值（超过 N k token 自动压），压缩谱系可回看（第几代、压缩前多少、当时的摘要）
- 🆕 **Ctrl+Enter 全新会话**：不带旧账发问；PM 派发的任务一律全新会话，杜绝"滚雪球式" resume

**氛围**
- 🕐 真实时钟 + ☀️🌙 **按时间变化的窗景**（清晨/白天/黄昏/夜晚，太阳月亮走真实弧线，夜里城市亮灯）
- 🌤 天气牌：免费 API 自动定位（可点开设邮编），30 分钟刷新
- 🚪 想从 EXIT 门溜走？会被黑色幽默劝退的（"小小牛马，想去哪儿呢？"）
- 🏷️ 办公室可改名、玩家可改名换色

## 🚀 快速开始

准备好 Node.js（本仓库本地检查使用 Node.js 24），并单独安装要使用的 Claude Code 或 Codex CLI；`npm ci` 不会安装这两个 CLI。

```bash
git clone https://github.com/catflyx520/agents-office.git
cd agents-office
npm ci
```

使用 API key 时，按上面的「本地 API Key 配置」复制模板并填写 `.env`；macOS/Linux 的复制命令是 `cp .env.example .env`。已有 CLI 账户登录时可跳过 key 配置。

执行 `npm start` 后打开 http://localhost:3000，在「模型与登录」中选择服务商。

首次启动会在用户目录的 `~/.virtual-office/agents/`（PowerShell：`$HOME\.virtual-office\agents`）创建 agent 文件。分派任务前，将每个 agent 的 `workDir` 改成自己机器上存在的项目目录。默认的 frontend/backend/mobile 路径只是示例；使用 Codex 时应指向 Git 仓库，PM 的工作目录也要配置。

```bash
npm test           # Jest 单元测试
```

环境变量：

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | 可选，Claude API key |
| `CODEX_API_KEY` | 可选，用于 Codex 执行的 OpenAI API key |
| `CLAUDE_BIN` | 可执行文件名或路径，默认 `claude` |
| `CODEX_BIN` | 可执行文件名或路径，默认 `codex` |
| `PORT` | 服务端口，默认 3000 |
| `TOKEN_REPORT_SEC` | 用量统计刷新间隔（秒），默认 120 |

## 🏗️ 架构

```
浏览器 (Phaser 3 + 原生 ES Modules)
   │  WebSocket（每条消息一个 type，客户端转成 DOM 事件分发）
   ▼
Node 服务端 (Express + ws)
   │  按 agent 配置 spawn 子进程
   ▼
claude CLI（-p 非交互 + stream-json + --resume 续会话）
   → 在各自 workDir 的真实仓库里干活
```

- **会话连续性**：每轮对话是独立进程，用 `--resume <session-id>` 从本地会话存储恢复记忆
- **工具管制**：用 `--tools` 白名单从根上限制 agent 能用什么（`Agent`/`Task` 不给，杜绝递归开子代理的 token 爆炸）
- **用量统计**：直接聚合 `~/.claude*/projects/**/*.jsonl` 里每条消息的真实 usage，和 `/status` 同源

## ⚠️ 安全须知

Agent 子进程以 `--dangerously-skip-permissions` 运行（非交互模式没有人工审批入口），**会在其 workDir 指向的真实仓库里执行任意读写和 Bash 命令**。只给你信得过的目录建 agent，别把 workDir 指向不想被改的地方。

API key 可保存在被 Git 忽略的根目录 `.env` 或终端环境变量中；旧版保存的 key、上传文件、会话映射和压缩记录位于仓库外的 `~/.virtual-office/`。Codex 后端也会跳过审批和沙箱，应在本机对可信项目使用。

## 📁 项目结构

```
client/            浏览器端（无构建，改完刷新即生效）
  index.html       所有 UI 布局/弹窗/角色模板
  src/app.js       主逻辑：聊天、地图、用量面板、压缩、窗景时钟
server/
  index.js         Express + WS 装配、默认 agent 种子、定时任务
  wsHandler.js     消息路由、编排执行、会话压缩
  pmOrchestrator.js 计划提取（括号配对扫描）、依赖分波调度
  claudeRunner.js  spawn claude 子进程 + stream-json 解析
  agentManager.js  agent 的 md 文件读写
  tokenUsage.js    token 用量聚合（三级分解）
  weather.js       天气（ip-api + open-meteo + zippopotam，全免费无 key）
tests/             Jest 纯逻辑单测
```

## License

MIT
