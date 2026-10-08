# Agents Office 🏢

A pixel-art office for coordinating **Claude Code and Codex agents** on your local projects.

像素风 AI 办公室：向 PM 描述需求，由它拆分任务并协调多个 agent 在本地项目中执行。

## Features / 功能

- Walk around the office and chat with agents · 像素办公室与角色对话
- PM task planning, team coordination, and confirmation mode · 任务编排与确认模式
- Session history, compaction, and usage tracking · 会话记录、压缩和用量统计

**Stack:** Phaser 3 · Node.js · Express · WebSocket

## Quick start / 快速开始

Use Node.js 24 and install the CLI you want to use (`claude` or `codex`) separately.

准备 Node.js 24，并单独安装要使用的 Claude Code 或 Codex CLI。

```sh
git clone https://github.com/catflyx520/agents-office.git
cd agents-office
npm ci
```

If your CLI is already logged in, no key is required. To use API keys, copy `.env.example` to `.env` in the project root and fill in the provider you need:

已有 CLI 账户登录时可直接使用；使用 API key 时，在项目根目录将 `.env.example` 复制为 `.env`，填写对应 key：

```dotenv
ANTHROPIC_API_KEY=
CODEX_API_KEY=
```

PowerShell: `Copy-Item .env.example .env` · macOS/Linux: `cp .env.example .env`

```sh
npm start
```

Open **http://localhost:3000**, select a provider in **模型与登录**, and set each agent's `workDir` to your project before assigning tasks. Restart after changing `.env`.

打开页面后选择服务商，并先将各 agent 的 `workDir` 改为自己的项目目录。修改 `.env` 后重启服务。

Use **中文 / English** in the toolbar to change the interface language; your choice is remembered. Chat messages and custom names keep their original content.

顶部工具栏可切换 **中文 / English**，下次打开会记住选择；聊天内容和自定义名称保持原文。

## Configuration / 配置

`.env` is ignored by Git. CLI paths, Windows notes, agent directories, and troubleshooting: **[Setup guide / 配置指南](docs/SETUP.md)**.

`.env` 已被 Git 忽略；CLI 路径、Windows 使用限制及工作目录设置见配置指南。

**Local use:** Agents can modify files and run commands with approval checks bypassed; Codex also bypasses its sandbox. Use only with trusted projects.

**本地使用：** agent 会跳过执行审批并修改文件、运行命令；Codex 同时跳过沙箱。请只对可信项目使用。

## Development

Run `npm test` for the Jest test suite. Source: `client/` and `server/`.

## License

MIT
