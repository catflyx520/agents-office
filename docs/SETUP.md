# Agents Office 配置指南

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
- 已通过 CLI 账户登录时，可以留空对应 key。CLI 确认本机账号登录后显示「已登录（本机账号）」；仅配置 API key 时显示「等待首次请求验证」。实际请求返回认证错误时显示「授权失效」。
- 执行 `npm ci` 和 `npm start`，打开 http://localhost:3000，在「模型与登录」选择服务商。修改 `.env` 后重启服务。
- 找不到 CLI 时，把 `CLAUDE_BIN` / `CODEX_BIN` 改成可执行文件完整路径；带空格的路径加双引号。Windows 若命令只有 `.cmd` 启动器，需指定实际可执行文件或在 WSL 中运行。
- 系统环境变量优先于 `.env`；Claude 环境变量 key 优先于旧的 `~/.virtual-office/config.json` 中的 `apiKey`。
- `.env` 和 `.env.*` 已被 Git 忽略，仅提交不含密钥的 `.env.example`。密钥只供本地服务使用，不要放在 `client/` 下。

Codex key 配置依据：[OpenAI 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

## 工作目录

首次启动会在 `~/.virtual-office/agents/`（PowerShell：`$HOME\.virtual-office\agents`）创建 agent 文件。修改每个文件中的 `workDir`，指向本机实际存在的项目目录。默认 frontend/backend/mobile 路径是示例；使用 Codex 时，包括 PM 在内的工作目录都应指向 Git 仓库。

## 其他配置

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Claude 可执行文件名或路径 |
| `CODEX_BIN` | `codex` | Codex 可执行文件名或路径 |
| `PORT` | `3000` | 本地服务端口 |
| `TOKEN_REPORT_SEC` | `120` | 用量统计刷新间隔（秒） |

上传文件、会话和压缩记录保存在用户目录的 `~/.virtual-office/`。旧版 `config.json` 中的 key 为明文保存。

## 项目结构

- `client/`：Phaser 3 界面，无需构建。
- `server/`：Express / WebSocket、任务编排和 CLI 子进程。
- `tests/`：Jest 单元测试，运行 `npm test`。

浏览器通过 WebSocket 发起任务，服务端调用所选 CLI，在 agent 配置的项目中执行。Claude 的工具白名单和会话参数由服务端组装；Codex 使用 `codex exec`。

[返回 README](../README.md)