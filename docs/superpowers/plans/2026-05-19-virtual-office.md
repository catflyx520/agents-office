# Virtual Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地像素风 RPG 游戏，把 Claude agent 实体化为办公室 NPC，玩家走近 agent 对话并分配任务，PM agent 自动拆解需求并在地图上走过去指派给对应 agent。

**Architecture:** Phaser.js 游戏（浏览器）通过 WebSocket 连接本地 Node.js 服务器。每个 agent 是独立的 `claude` CLI 子进程。PM 返回 JSON 任务计划，Node.js 解析后驱动 agent 子进程和游戏动画。Agent 配置存为 `~/.virtual-office/agents/*.md`。

**Tech Stack:** Node.js 20, Express 4, ws 8, Phaser.js 3, Jest 29, claude CLI

---

## 文件结构

```
~/Projects/virtual-office/
├── package.json
├── jest.config.js
├── server/
│   ├── index.js              # Express + WebSocket 入口
│   ├── agentManager.js       # 读写 .md 配置，管理 claude 子进程
│   ├── claudeRunner.js       # 启动 claude 进程，流式读取输出
│   ├── pmOrchestrator.js     # 解析 PM JSON，调度 waitFor 依赖
│   ├── animController.js     # 构建地图动画事件序列
│   └── wsHandler.js          # WebSocket 消息路由
├── client/
│   ├── index.html
│   └── src/
│       ├── main.js            # Phaser 配置
│       ├── scenes/
│       │   ├── GameScene.js   # 地图、玩家、NPC、碰撞
│       │   └── UIScene.js     # 聊天框、添加 agent 面板、模式切换
│       ├── entities/
│       │   ├── Player.js      # WASD 移动
│       │   └── AgentNPC.js    # 桌子、状态指示、近身检测
│       └── net/
│           └── WSClient.js    # WebSocket 封装，事件 emitter
└── tests/
    ├── agentManager.test.js
    ├── claudeRunner.test.js
    ├── pmOrchestrator.test.js
    └── animController.test.js

~/.virtual-office/
└── agents/
    ├── pm.md
    ├── frontend-dev.md
    ├── app-dev.md
    └── backend-dev.md
```

---

## WebSocket 消息协议

**Client → Server:**
```json
{ "type": "chat",         "agentId": "pm", "message": "加导出功能" }
{ "type": "confirm_plan", "agentId": "pm" }
{ "type": "add_agent",    "config": { "id": "qa", "name": "小测", "role": "QA Engineer", "emoji": "🧪", "workDir": "/path", "tools": ["Edit","Read","Bash"], "systemPrompt": "..." } }
{ "type": "delete_agent", "agentId": "qa" }
{ "type": "set_mode",     "mode": "auto" }
```

**Server → Client:**
```json
{ "type": "chat_chunk",    "agentId": "pm",            "text": "收到...",   "done": false }
{ "type": "chat_chunk",    "agentId": "pm",            "text": "",          "done": true }
{ "type": "plan_preview",  "agentId": "pm",            "plan": { "plan": "...", "tasks": [...] } }
{ "type": "agent_move",    "agentId": "pm",            "toAgentId": "frontend-dev" }
{ "type": "agent_bubble",  "agentId": "pm",            "text": "帮我加导出按钮" }
{ "type": "agent_status",  "agentId": "frontend-dev",  "status": "working" }
{ "type": "agent_status",  "agentId": "frontend-dev",  "status": "done",   "result": "已完成，在 ExportButton.tsx 加了..." }
{ "type": "agents_list",   "agents": [...] }
{ "type": "error",         "message": "..." }
```

---

## Task 1：项目初始化

**Files:**
- Create: `virtual-office/package.json`
- Create: `virtual-office/jest.config.js`
- Create: `virtual-office/client/index.html`

- [ ] **Step 1：创建项目目录和 package.json**

```bash
mkdir -p ~/Projects/virtual-office
cd ~/Projects/virtual-office
```

创建 `package.json`：
```json
{
  "name": "virtual-office",
  "version": "0.1.0",
  "type": "commonjs",
  "scripts": {
    "start": "node server/index.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ws": "^8.17.0",
    "gray-matter": "^4.0.3",
    "chokidar": "^3.6.0"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

- [ ] **Step 2：安装依赖**

```bash
cd ~/Projects/virtual-office
npm install
```

Expected: `node_modules/` 出现，无 error。

- [ ] **Step 3：创建 jest.config.js**

```js
// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
};
```

- [ ] **Step 4：创建目录结构**

```bash
mkdir -p server client/src/scenes client/src/entities client/src/net tests
mkdir -p ~/.virtual-office/agents
```

- [ ] **Step 5：创建 client/index.html**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <title>Virtual Office</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d0d0d; display: flex; justify-content: center; align-items: center; height: 100vh; }
    canvas { image-rendering: pixelated; }
  </style>
</head>
<body>
  <script src="https://cdn.jsdelivr.net/npm/phaser@3.60.0/dist/phaser.min.js"></script>
  <script type="module" src="src/main.js"></script>
</body>
</html>
```

- [ ] **Step 6：Commit**

```bash
cd ~/Projects/virtual-office
git init
git add .
git commit -m "feat: init virtual-office project"
```

---

## Task 2：Agent 配置管理（agentManager）

**Files:**
- Create: `server/agentManager.js`
- Create: `tests/agentManager.test.js`

Agent `.md` 格式（用 gray-matter 解析 YAML front matter）：

```markdown
---
id: frontend-dev
name: 小前
emoji: "🧑‍🎨"
role: Frontend Developer
workDir: ~/Projects/frontend-app
tools:
  - Edit
  - Read
  - Bash
avatar: null
created: 2026-05-19
---
你是一个前端开发工程师，负责 frontend-app 这个 Next.js 项目。
你擅长 TypeScript、Tailwind CSS、Next.js。
收到任务后先读相关文件再动手，完成后简短汇报做了什么。
```

body 部分就是 `systemPrompt`。

- [ ] **Step 1：写失败测试**

```js
// tests/agentManager.test.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  getAgentsDir,
  loadAgent,
  listAgents,
  saveAgent,
  deleteAgent,
} = require('../server/agentManager');

// 用临时目录隔离测试
const TMP_DIR = path.join(os.tmpdir(), 'vo-test-agents-' + Date.now());

beforeAll(() => fs.mkdirSync(TMP_DIR, { recursive: true }));
afterAll(() => fs.rmSync(TMP_DIR, { recursive: true }));

const sampleConfig = {
  id: 'test-dev',
  name: '小测',
  emoji: '🧪',
  role: 'QA Engineer',
  workDir: '/tmp/project',
  tools: ['Read', 'Bash'],
  avatar: null,
  systemPrompt: '你是测试工程师，负责写测试。',
};

test('saveAgent writes a parseable .md file', () => {
  saveAgent(sampleConfig, TMP_DIR);
  const filePath = path.join(TMP_DIR, 'test-dev.md');
  expect(fs.existsSync(filePath)).toBe(true);
});

test('loadAgent returns correct config', () => {
  saveAgent(sampleConfig, TMP_DIR);
  const loaded = loadAgent('test-dev', TMP_DIR);
  expect(loaded.name).toBe('小测');
  expect(loaded.role).toBe('QA Engineer');
  expect(loaded.systemPrompt).toContain('测试工程师');
  expect(loaded.tools).toEqual(['Read', 'Bash']);
});

test('listAgents returns all saved agents', () => {
  const config2 = { ...sampleConfig, id: 'dev2', name: '小二' };
  saveAgent(config2, TMP_DIR);
  const agents = listAgents(TMP_DIR);
  const ids = agents.map(a => a.id);
  expect(ids).toContain('test-dev');
  expect(ids).toContain('dev2');
});

test('deleteAgent removes the file', () => {
  saveAgent(sampleConfig, TMP_DIR);
  deleteAgent('test-dev', TMP_DIR);
  const filePath = path.join(TMP_DIR, 'test-dev.md');
  expect(fs.existsSync(filePath)).toBe(false);
});
```

- [ ] **Step 2：运行测试，确认失败**

```bash
cd ~/Projects/virtual-office
npx jest tests/agentManager.test.js --no-coverage
```

Expected: `Cannot find module '../server/agentManager'`

- [ ] **Step 3：实现 agentManager.js**

```js
// server/agentManager.js
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const os = require('os');

const DEFAULT_AGENTS_DIR = path.join(os.homedir(), '.virtual-office', 'agents');

function getAgentsDir(override) {
  return override || DEFAULT_AGENTS_DIR;
}

function agentFilePath(id, dir) {
  return path.join(getAgentsDir(dir), `${id}.md`);
}

function saveAgent(config, dir) {
  const { systemPrompt, ...frontMatter } = config;
  const content = matter.stringify(systemPrompt || '', frontMatter);
  fs.mkdirSync(getAgentsDir(dir), { recursive: true });
  fs.writeFileSync(agentFilePath(config.id, dir), content, 'utf8');
}

function loadAgent(id, dir) {
  const filePath = agentFilePath(id, dir);
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(raw);
  return { ...parsed.data, systemPrompt: parsed.content.trim() };
}

function listAgents(dir) {
  const agentsDir = getAgentsDir(dir);
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => loadAgent(path.basename(f, '.md'), dir));
}

function deleteAgent(id, dir) {
  const filePath = agentFilePath(id, dir);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { getAgentsDir, saveAgent, loadAgent, listAgents, deleteAgent };
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npx jest tests/agentManager.test.js --no-coverage
```

Expected: 4 tests PASS

- [ ] **Step 5：Commit**

```bash
git add server/agentManager.js tests/agentManager.test.js
git commit -m "feat: agent config read/write via gray-matter markdown"
```

---

## Task 3：Claude 进程管理（claudeRunner）

**Files:**
- Create: `server/claudeRunner.js`
- Create: `tests/claudeRunner.test.js`

- [ ] **Step 1：写失败测试**

```js
// tests/claudeRunner.test.js
const { buildClaudeArgs, parseStreamChunk } = require('../server/claudeRunner');

test('buildClaudeArgs includes system prompt and tools', () => {
  const args = buildClaudeArgs({
    systemPrompt: '你是前端工程师',
    tools: ['Edit', 'Read'],
    workDir: '/tmp/project',
  });
  expect(args).toContain('--output-format');
  expect(args).toContain('stream-json');
  expect(args).toContain('--allowedTools');
  expect(args).toContain('Edit,Read');
});

test('parseStreamChunk extracts text from assistant message', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '任务完成' }] }
  });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'text', text: '任务完成', done: false });
});

test('parseStreamChunk returns done=true on result event', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success' });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'done', done: true });
});

test('parseStreamChunk returns null for unrecognized lines', () => {
  expect(parseStreamChunk('')).toBeNull();
  expect(parseStreamChunk('not json')).toBeNull();
});
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npx jest tests/claudeRunner.test.js --no-coverage
```

Expected: `Cannot find module '../server/claudeRunner'`

- [ ] **Step 3：实现 claudeRunner.js**

```js
// server/claudeRunner.js
const { spawn } = require('child_process');
const path = require('path');

const CLAUDE_BIN = 'claude';

/**
 * 构建 claude CLI 参数列表
 */
function buildClaudeArgs({ systemPrompt, tools, workDir }) {
  const args = [
    '--output-format', 'stream-json',
    '--allowedTools', tools.join(','),
  ];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }
  return args;
}

/**
 * 解析 stream-json 的一行输出
 * 返回 { type, text, done } 或 null（忽略该行）
 */
function parseStreamChunk(line) {
  if (!line || !line.trim()) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  if (obj.type === 'assistant') {
    const content = obj.message?.content || [];
    const textBlock = content.find(b => b.type === 'text');
    if (textBlock) return { type: 'text', text: textBlock.text, done: false };
  }
  if (obj.type === 'result') {
    return { type: 'done', done: true };
  }
  return null;
}

/**
 * 启动一个 claude 进程，流式输出给 onChunk 回调
 * @param {object} agentConfig - loadAgent() 的结果
 * @param {string} message - 发给 agent 的消息
 * @param {function} onChunk - ({ type, text, done }) => void
 * @returns {{ proc, kill }}
 */
function spawnAgent(agentConfig, message, onChunk) {
  const args = buildClaudeArgs(agentConfig);
  args.push('--print', message); // 非交互模式：-p / --print

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: agentConfig.workDir,
    env: { ...process.env },
  });

  let buffer = '';

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 最后一行可能不完整
    for (const line of lines) {
      const chunk = parseStreamChunk(line);
      if (chunk) onChunk(chunk);
    }
  });

  proc.on('close', () => {
    if (buffer.trim()) {
      const chunk = parseStreamChunk(buffer);
      if (chunk) onChunk(chunk);
    }
    onChunk({ type: 'done', done: true });
  });

  proc.stderr.on('data', (data) => {
    onChunk({ type: 'error', text: data.toString(), done: false });
  });

  return { proc, kill: () => proc.kill() };
}

module.exports = { buildClaudeArgs, parseStreamChunk, spawnAgent };
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npx jest tests/claudeRunner.test.js --no-coverage
```

Expected: 4 tests PASS

- [ ] **Step 5：Commit**

```bash
git add server/claudeRunner.js tests/claudeRunner.test.js
git commit -m "feat: claude subprocess runner with stream-json parsing"
```

---

## Task 4：PM Orchestrator（JSON 计划解析）

**Files:**
- Create: `server/pmOrchestrator.js`
- Create: `tests/pmOrchestrator.test.js`

- [ ] **Step 1：写失败测试**

```js
// tests/pmOrchestrator.test.js
const { extractPMPlan, buildPMSystemPrompt, scheduleTasks } = require('../server/pmOrchestrator');

const agents = [
  { id: 'frontend-dev', name: '小前', role: 'Frontend Developer', workDir: '/tmp/web' },
  { id: 'app-dev',      name: '小安', role: 'App Developer',      workDir: '/tmp/app' },
];

test('buildPMSystemPrompt includes all agent names and ids', () => {
  const prompt = buildPMSystemPrompt(agents);
  expect(prompt).toContain('frontend-dev');
  expect(prompt).toContain('小前');
  expect(prompt).toContain('app-dev');
  expect(prompt).toContain('JSON');
});

test('extractPMPlan parses valid JSON from PM response', () => {
  const response = `收到需求，这是我的计划：
{"plan":"前后端各做一个导出","tasks":[{"agent":"frontend-dev","task":"加按钮","waitFor":null},{"agent":"app-dev","task":"加页面","waitFor":null}]}`;
  const plan = extractPMPlan(response);
  expect(plan.tasks).toHaveLength(2);
  expect(plan.tasks[0].agent).toBe('frontend-dev');
  expect(plan.tasks[1].waitFor).toBeNull();
});

test('extractPMPlan returns null when no JSON found', () => {
  expect(extractPMPlan('好的，我来安排')).toBeNull();
});

test('scheduleTasks groups tasks by dependency level', () => {
  const tasks = [
    { agent: 'frontend-dev', task: '加按钮',   waitFor: null },
    { agent: 'app-dev',      task: '加页面',   waitFor: null },
    { agent: 'qa',           task: '写测试',   waitFor: 'frontend-dev' },
  ];
  const waves = scheduleTasks(tasks);
  // wave 0: frontend-dev + app-dev（无依赖）
  expect(waves[0].map(t => t.agent)).toEqual(expect.arrayContaining(['frontend-dev', 'app-dev']));
  // wave 1: qa（等 frontend-dev）
  expect(waves[1].map(t => t.agent)).toContain('qa');
});
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npx jest tests/pmOrchestrator.test.js --no-coverage
```

Expected: `Cannot find module '../server/pmOrchestrator'`

- [ ] **Step 3：实现 pmOrchestrator.js**

```js
// server/pmOrchestrator.js

/**
 * 生成 PM 的 system prompt，包含当前所有 agent 的信息
 */
function buildPMSystemPrompt(agents) {
  const teamList = agents
    .filter(a => a.id !== 'pm')
    .map(a => `- ${a.id}（${a.name}，${a.role}）：负责 ${a.workDir}`)
    .join('\n');

  return `你是项目经理，负责把用户需求拆解并分配给团队成员。

当前团队：
${teamList}

收到需求后，先用一两句话说明整体思路，然后在回复末尾附上如下 JSON 格式的任务分配计划：
{
  "plan": "整体思路简述",
  "tasks": [
    {
      "agent": "agent-id",
      "task": "具体要做什么，越详细越好",
      "waitFor": null
    }
  ]
}

waitFor 填 agent-id 字符串表示等该 agent 完成后再开始，填 null 表示立即并行启动。
只在末尾返回一个 JSON 块，不要返回多个。`;
}

/**
 * 从 PM 的完整回复文本中提取 JSON 计划
 * 返回 { plan, tasks } 或 null
 */
function extractPMPlan(text) {
  const match = text.match(/\{[\s\S]*"tasks"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * 把任务列表按依赖关系分层（返回 wave 数组，每层可并行执行）
 */
function scheduleTasks(tasks) {
  const waves = [];
  const done = new Set();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const wave = remaining.filter(t => !t.waitFor || done.has(t.waitFor));
    if (wave.length === 0) break; // 防止循环依赖死锁
    waves.push(wave);
    wave.forEach(t => done.add(t.agent));
    remaining = remaining.filter(t => !wave.includes(t));
  }

  return waves;
}

module.exports = { buildPMSystemPrompt, extractPMPlan, scheduleTasks };
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npx jest tests/pmOrchestrator.test.js --no-coverage
```

Expected: 4 tests PASS

- [ ] **Step 5：Commit**

```bash
git add server/pmOrchestrator.js tests/pmOrchestrator.test.js
git commit -m "feat: PM orchestrator - system prompt, JSON plan extraction, task scheduling"
```

---

## Task 5：动画控制器（animController）

**Files:**
- Create: `server/animController.js`
- Create: `tests/animController.test.js`

动画事件序列示例（Node.js → 游戏）：
```json
[
  { "type": "agent_move",   "agentId": "pm", "toAgentId": "frontend-dev" },
  { "type": "agent_bubble", "agentId": "pm", "text": "帮我加导出按钮" },
  { "type": "agent_status", "agentId": "frontend-dev", "status": "working" },
  { "type": "agent_move",   "agentId": "pm", "toAgentId": "pm" }
]
```

- [ ] **Step 1：写失败测试**

```js
// tests/animController.test.js
const { buildDelegationEvents, buildCompleteEvent } = require('../server/animController');

test('buildDelegationEvents creates move+bubble+status events per task', () => {
  const tasks = [
    { agent: 'frontend-dev', task: '加导出按钮', waitFor: null },
    { agent: 'app-dev',      task: '加导出页面', waitFor: null },
  ];
  const events = buildDelegationEvents(tasks);
  const moveEvents   = events.filter(e => e.type === 'agent_move');
  const bubbleEvents = events.filter(e => e.type === 'agent_bubble');
  const statusEvents = events.filter(e => e.type === 'agent_status');

  expect(moveEvents.length).toBeGreaterThanOrEqual(2);
  expect(bubbleEvents.length).toBe(2);
  expect(statusEvents.every(e => e.status === 'working')).toBe(true);
  // PM 最终返回自己桌子
  const lastMove = moveEvents[moveEvents.length - 1];
  expect(lastMove.agentId).toBe('pm');
  expect(lastMove.toAgentId).toBe('pm');
});

test('buildCompleteEvent returns done status with result', () => {
  const ev = buildCompleteEvent('frontend-dev', '已在 ExportButton.tsx 完成');
  expect(ev).toEqual({
    type: 'agent_status',
    agentId: 'frontend-dev',
    status: 'done',
    result: '已在 ExportButton.tsx 完成',
  });
});
```

- [ ] **Step 2：运行测试，确认失败**

```bash
npx jest tests/animController.test.js --no-coverage
```

Expected: `Cannot find module '../server/animController'`

- [ ] **Step 3：实现 animController.js**

```js
// server/animController.js

/**
 * 生成一批任务的 PM 走动 + 委派动画事件
 */
function buildDelegationEvents(tasks) {
  const events = [];
  for (const task of tasks) {
    events.push({ type: 'agent_move',   agentId: 'pm', toAgentId: task.agent });
    events.push({ type: 'agent_bubble', agentId: 'pm', text: task.task });
    events.push({ type: 'agent_status', agentId: task.agent, status: 'working' });
  }
  // PM 回到自己桌子
  events.push({ type: 'agent_move', agentId: 'pm', toAgentId: 'pm' });
  return events;
}

/**
 * 生成任务完成事件
 */
function buildCompleteEvent(agentId, result) {
  return { type: 'agent_status', agentId, status: 'done', result };
}

module.exports = { buildDelegationEvents, buildCompleteEvent };
```

- [ ] **Step 4：运行测试，确认通过**

```bash
npx jest tests/animController.test.js --no-coverage
```

Expected: 2 tests PASS

- [ ] **Step 5：全部测试跑一遍**

```bash
npx jest --no-coverage
```

Expected: 所有测试 PASS（目前共 14 个）

- [ ] **Step 6：Commit**

```bash
git add server/animController.js tests/animController.test.js
git commit -m "feat: animation controller for PM delegation events"
```

---

## Task 6：Node.js 服务器（Express + WebSocket）

**Files:**
- Create: `server/wsHandler.js`
- Create: `server/index.js`

- [ ] **Step 1：创建 wsHandler.js**

```js
// server/wsHandler.js
const { listAgents, saveAgent, deleteAgent, loadAgent } = require('./agentManager');
const { spawnAgent } = require('./claudeRunner');
const { buildPMSystemPrompt, extractPMPlan, scheduleTasks } = require('./pmOrchestrator');
const { buildDelegationEvents, buildCompleteEvent } = require('./animController');

// 每个 ws 连接维护一个 controlMode，默认全自动
const clientState = new WeakMap();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(wss, obj) {
  wss.clients.forEach(client => send(client, obj));
}

/**
 * 执行一个 wave（一组可并行的任务），完成后回调
 */
function executeWave(wss, wave, agentsDir) {
  return Promise.all(wave.map(task => new Promise((resolve) => {
    const agentConfig = loadAgent(task.agent, agentsDir);
    let fullText = '';

    spawnAgent(agentConfig, task.task, (chunk) => {
      if (chunk.type === 'text') {
        fullText += chunk.text;
        send([...wss.clients][0], { type: 'chat_chunk', agentId: task.agent, text: chunk.text, done: false });
      }
      if (chunk.done) {
        broadcast(wss, buildCompleteEvent(task.agent, fullText.slice(0, 200)));
        resolve();
      }
    });
  })));
}

async function executePlan(wss, plan, agentsDir) {
  const waves = scheduleTasks(plan.tasks);

  for (const wave of waves) {
    // 发送动画事件
    const animEvents = buildDelegationEvents(wave);
    animEvents.forEach(ev => broadcast(wss, ev));

    // 执行这一波任务
    await executeWave(wss, wave, agentsDir);
  }
}

function handleMessage(ws, wss, raw, agentsDir) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const state = clientState.get(ws) || { mode: 'auto', pendingPlan: null };
  clientState.set(ws, state);

  if (msg.type === 'set_mode') {
    state.mode = msg.mode; // 'auto' | 'confirm'
    return;
  }

  if (msg.type === 'agents_list') {
    send(ws, { type: 'agents_list', agents: listAgents(agentsDir) });
    return;
  }

  if (msg.type === 'add_agent') {
    saveAgent(msg.config, agentsDir);
    broadcast(wss, { type: 'agents_list', agents: listAgents(agentsDir) });
    return;
  }

  if (msg.type === 'delete_agent') {
    deleteAgent(msg.agentId, agentsDir);
    broadcast(wss, { type: 'agents_list', agents: listAgents(agentsDir) });
    return;
  }

  if (msg.type === 'chat') {
    const agentConfig = loadAgent(msg.agentId, agentsDir);

    // PM 特殊处理：捕获完整回复，提取 JSON 计划
    if (msg.agentId === 'pm') {
      const agents = listAgents(agentsDir);
      const pmWithPrompt = {
        ...agentConfig,
        systemPrompt: buildPMSystemPrompt(agents),
      };
      let fullText = '';

      spawnAgent(pmWithPrompt, msg.message, async (chunk) => {
        if (chunk.type === 'text') {
          fullText += chunk.text;
          send(ws, { type: 'chat_chunk', agentId: 'pm', text: chunk.text, done: false });
        }
        if (chunk.done) {
          send(ws, { type: 'chat_chunk', agentId: 'pm', text: '', done: true });
          const plan = extractPMPlan(fullText);
          if (!plan) return;

          if (state.mode === 'confirm') {
            state.pendingPlan = plan;
            send(ws, { type: 'plan_preview', agentId: 'pm', plan });
          } else {
            await executePlan(wss, plan, agentsDir);
          }
        }
      });
      return;
    }

    // 普通 agent：直接流式对话
    spawnAgent(agentConfig, msg.message, (chunk) => {
      if (chunk.type === 'text') {
        send(ws, { type: 'chat_chunk', agentId: msg.agentId, text: chunk.text, done: false });
      }
      if (chunk.done) {
        send(ws, { type: 'chat_chunk', agentId: msg.agentId, text: '', done: true });
      }
    });
    return;
  }

  if (msg.type === 'confirm_plan') {
    const plan = state.pendingPlan;
    state.pendingPlan = null;
    if (plan) executePlan(wss, plan, agentsDir);
    return;
  }
}

module.exports = { handleMessage };
```

- [ ] **Step 2：创建 server/index.js**

```js
// server/index.js
const express = require('express');
const http = require('http');
const ws = require('ws');
const path = require('path');
const os = require('os');
const { handleMessage } = require('./wsHandler');
const { saveAgent, listAgents } = require('./agentManager');

const PORT = 3000;
const AGENTS_DIR = path.join(os.homedir(), '.virtual-office', 'agents');

const app = express();
app.use(express.static(path.join(__dirname, '../client')));

const server = http.createServer(app);
const wss = new ws.WebSocketServer({ server });

// 初始化默认 agents（只在首次运行时创建）
function seedDefaultAgents() {
  const existing = listAgents(AGENTS_DIR).map(a => a.id);

  const defaults = [
    {
      id: 'pm',
      name: 'PM',
      emoji: '🧑‍💼',
      role: 'Project Manager',
      workDir: process.env.HOME,
      tools: ['Read'],
      avatar: null,
      systemPrompt: '（由系统动态生成，此字段会被覆盖）',
    },
    {
      id: 'backend-dev',
      name: '小后',
      emoji: '💻',
      role: 'Backend Developer',
      workDir: path.join(os.homedir(), 'Documents/Projects/backend-api'),
      tools: ['Edit', 'Read', 'Bash'],
      avatar: null,
      systemPrompt: '你是后端开发工程师，负责 backend-api 这个 .NET 项目。收到任务后先读相关文件再动手，完成后简短汇报。',
    },
    {
      id: 'frontend-dev',
      name: '小前',
      emoji: '🧑‍🎨',
      role: 'Frontend Developer',
      workDir: path.join(os.homedir(), 'Documents/Projects/frontend-app'),
      tools: ['Edit', 'Read', 'Bash'],
      avatar: null,
      systemPrompt: '你是前端开发工程师，负责 frontend-app 这个 Next.js 项目。收到任务后先读相关文件再动手，完成后简短汇报。',
    },
    {
      id: 'app-dev',
      name: '小安',
      emoji: '📱',
      role: 'App Developer',
      workDir: path.join(os.homedir(), 'Documents/Projects/app'),
      tools: ['Edit', 'Read', 'Bash'],
      avatar: null,
      systemPrompt: '你是 Flutter 移动端开发工程师，负责 app 这个 Flutter 项目。收到任务后先读相关文件再动手，完成后简短汇报。',
    },
  ];

  for (const agent of defaults) {
    if (!existing.includes(agent.id)) {
      saveAgent(agent, AGENTS_DIR);
      console.log(`✅ 初始化 agent: ${agent.name}`);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('游戏客户端已连接');
  // 连接后立即推送 agent 列表
  ws.send(JSON.stringify({ type: 'agents_list', agents: listAgents(AGENTS_DIR) }));

  ws.on('message', (raw) => {
    handleMessage(ws, wss, raw.toString(), AGENTS_DIR);
  });

  ws.on('close', () => console.log('客户端断开'));
});

seedDefaultAgents();
server.listen(PORT, () => {
  console.log(`Virtual Office 服务器运行在 http://localhost:${PORT}`);
});
```

- [ ] **Step 3：手动验证服务器启动**

```bash
cd ~/Projects/virtual-office
node server/index.js
```

Expected: 输出 `Virtual Office 服务器运行在 http://localhost:3000`，`~/.virtual-office/agents/` 下生成 4 个 `.md` 文件。

用 Ctrl+C 停止。

- [ ] **Step 4：Commit**

```bash
git add server/wsHandler.js server/index.js
git commit -m "feat: Express + WebSocket server with agent seeding"
```

---

## Task 7：Phaser 游戏基础（地图 + 玩家移动）

**Files:**
- Create: `client/src/main.js`
- Create: `client/src/net/WSClient.js`
- Create: `client/src/entities/Player.js`
- Create: `client/src/scenes/GameScene.js`

- [ ] **Step 1：创建 WSClient.js**

```js
// client/src/net/WSClient.js
export class WSClient extends EventTarget {
  constructor(url) {
    super();
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      this.dispatchEvent(Object.assign(new Event(msg.type), { detail: msg }));
    };
    this.ws.onclose = () => this.dispatchEvent(new Event('disconnected'));
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
```

- [ ] **Step 2：创建 Player.js**

```js
// client/src/entities/Player.js
export class Player {
  constructor(scene, x, y) {
    this.scene = scene;
    // 用彩色矩形占位（后续替换为 sprite）
    this.sprite = scene.add.rectangle(x, y, 16, 16, 0x00ff88).setDepth(10);
    this.nameLabel = scene.add.text(x, y - 16, '你', {
      fontSize: '8px', color: '#00ff88', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(11);

    this.speed = 120;
    this.cursors = scene.input.keyboard.createCursorKeys();
    this.wasd = scene.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
  }

  update(delta) {
    const speed = this.speed * (delta / 1000);
    let dx = 0, dy = 0;

    if (this.cursors.left.isDown  || this.wasd.left.isDown)  dx -= speed;
    if (this.cursors.right.isDown || this.wasd.right.isDown) dx += speed;
    if (this.cursors.up.isDown    || this.wasd.up.isDown)    dy -= speed;
    if (this.cursors.down.isDown  || this.wasd.down.isDown)  dy += speed;

    this.sprite.x += dx;
    this.sprite.y += dy;
    this.nameLabel.x = this.sprite.x;
    this.nameLabel.y = this.sprite.y - 16;

    // 边界限制（800x600 地图）
    this.sprite.x = Phaser.Math.Clamp(this.sprite.x, 16, 784);
    this.sprite.y = Phaser.Math.Clamp(this.sprite.y, 16, 584);
  }

  get x() { return this.sprite.x; }
  get y() { return this.sprite.y; }
}
```

- [ ] **Step 3：创建 GameScene.js（基础版，无 NPC）**

```js
// client/src/scenes/GameScene.js
import { Player } from '../entities/Player.js';
import { WSClient } from '../net/WSClient.js';

export class GameScene extends Phaser.Scene {
  constructor() { super('GameScene'); }

  create() {
    // 背景地板
    this.add.rectangle(400, 300, 800, 600, 0x1a1a2e);

    // 网格线（像素风地板感）
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x2a2a4e, 0.5);
    for (let x = 0; x <= 800; x += 32) grid.lineBetween(x, 0, x, 600);
    for (let y = 0; y <= 600; y += 32) grid.lineBetween(0, y, 800, y);

    this.player = new Player(this, 400, 300);

    // WebSocket 连接
    this.ws = new WSClient('ws://localhost:3000');
    this.ws.addEventListener('agents_list', (e) => {
      this.scene.get('UIScene')?.onAgentsList(e.detail.agents);
    });

    // 发送给 UIScene 的引用
    this.scene.launch('UIScene', { ws: this.ws, gameScene: this });
  }

  update(time, delta) {
    this.player.update(delta);
  }
}
```

- [ ] **Step 4：创建 main.js**

```js
// client/src/main.js
import { GameScene } from './scenes/GameScene.js';
import { UIScene }   from './scenes/UIScene.js';

const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#0d0d0d',
  scene: [GameScene, UIScene],
  pixelArt: true,
};

new Phaser.Game(config);
```

- [ ] **Step 5：创建空的 UIScene.js（占位）**

```js
// client/src/scenes/UIScene.js
export class UIScene extends Phaser.Scene {
  constructor() { super({ key: 'UIScene', active: false }); }
  init(data) { this.ws = data.ws; this.gameScene = data.gameScene; }
  create() {}
  onAgentsList(agents) { this._agents = agents; }
}
```

- [ ] **Step 6：启动服务器，用浏览器测试**

```bash
node server/index.js
# 在另一个终端 / 直接打开浏览器：
open http://localhost:3000
```

Expected: 看到深色网格地图，绿色方块（玩家），WASD 和方向键可以移动。控制台无报错。

- [ ] **Step 7：Commit**

```bash
git add client/
git commit -m "feat: Phaser game with player movement and WebSocket connection"
```

---

## Task 8：Agent NPC（桌子 + 状态 + 近身检测）

**Files:**
- Create: `client/src/entities/AgentNPC.js`
- Modify: `client/src/scenes/GameScene.js`

- [ ] **Step 1：创建 AgentNPC.js**

```js
// client/src/entities/AgentNPC.js

// 固定桌子位置（最多 8 个 agent）
const DESK_POSITIONS = [
  { x: 150, y: 150 }, { x: 400, y: 150 }, { x: 650, y: 150 },
  { x: 150, y: 350 }, { x: 650, y: 350 },
  { x: 150, y: 500 }, { x: 400, y: 500 }, { x: 650, y: 500 },
];

export class AgentNPC {
  constructor(scene, agentConfig, posIndex) {
    const { x, y } = DESK_POSITIONS[posIndex % DESK_POSITIONS.length];
    this.scene = scene;
    this.config = agentConfig;
    this.homeX = x;
    this.homeY = y;

    // 桌子（灰色矩形）
    scene.add.rectangle(x, y, 48, 36, 0x2a2a4e).setDepth(1);
    scene.add.rectangle(x, y, 46, 34, 0x1a1a3e).setDepth(2);

    // NPC 精灵（彩色矩形，后续替换为 sprite）
    this.sprite = scene.add.rectangle(x, y - 28, 16, 16, 0x4a90e2).setDepth(5);

    // emoji 标签
    this.emojiLabel = scene.add.text(x, y - 28, agentConfig.emoji, {
      fontSize: '14px'
    }).setOrigin(0.5).setDepth(6);

    // 名字标签
    this.nameLabel = scene.add.text(x, y + 24, agentConfig.name, {
      fontSize: '8px', color: '#aaaacc', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(6);

    // 状态指示器
    this.statusLabel = scene.add.text(x, y - 44, '', {
      fontSize: '8px', color: '#ffdd55', fontFamily: 'monospace'
    }).setOrigin(0.5).setDepth(6);

    // 对话气泡（隐藏）
    this.bubbleBg = scene.add.rectangle(x, y - 70, 120, 28, 0xffffff, 0.9).setDepth(7).setVisible(false);
    this.bubbleText = scene.add.text(x, y - 70, '', {
      fontSize: '7px', color: '#000000', fontFamily: 'monospace',
      wordWrap: { width: 110 }
    }).setOrigin(0.5).setDepth(8).setVisible(false);

    // 近身检测区域（半径 50px）
    this.proximityRadius = 50;
    this.isPlayerNear = false;
    this.onPlayerEnter = null; // 回调
  }

  checkProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.homeX, this.homeY);
    const wasNear = this.isPlayerNear;
    this.isPlayerNear = dist < this.proximityRadius;
    if (!wasNear && this.isPlayerNear && this.onPlayerEnter) {
      this.onPlayerEnter(this.config);
    }
    // 边框提示
    this.sprite.setStrokeStyle(this.isPlayerNear ? 2 : 0, 0xffffff);
  }

  setStatus(status, result) {
    const labels = { idle: '', working: '⚙ working...', done: '✅ done' };
    this.statusLabel.setText(labels[status] || '');
    if (status === 'done' && result) this.showBubble(result.slice(0, 50));
  }

  showBubble(text) {
    this.bubbleText.setText(text);
    this.bubbleBg.setVisible(true);
    this.bubbleText.setVisible(true);
    this.scene.time.delayedCall(4000, () => {
      this.bubbleBg.setVisible(false);
      this.bubbleText.setVisible(false);
    });
  }

  moveTo(targetNPC) {
    // 动画：NPC 精灵移到目标位置再回来
    this.scene.tweens.add({
      targets: [this.sprite, this.emojiLabel],
      x: targetNPC.homeX,
      y: targetNPC.homeY - 28,
      duration: 800,
      ease: 'Sine.easeInOut',
      yoyo: false,
      onComplete: () => {
        this.showBubble('...');
      }
    });
  }

  returnHome() {
    this.scene.tweens.add({
      targets: [this.sprite, this.emojiLabel],
      x: this.homeX,
      y: this.homeY - 28,
      duration: 600,
      ease: 'Sine.easeInOut',
    });
  }
}
```

- [ ] **Step 2：更新 GameScene.js 加入 NPC**

```js
// client/src/scenes/GameScene.js
import { Player }   from '../entities/Player.js';
import { AgentNPC } from '../entities/AgentNPC.js';
import { WSClient } from '../net/WSClient.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.npcs = {}; // agentId → AgentNPC
  }

  create() {
    this.add.rectangle(400, 300, 800, 600, 0x1a1a2e);
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x2a2a4e, 0.5);
    for (let x = 0; x <= 800; x += 32) grid.lineBetween(x, 0, x, 600);
    for (let y = 0; y <= 600; y += 32) grid.lineBetween(0, y, 800, y);

    this.player = new Player(this, 400, 300);

    this.ws = new WSClient('ws://localhost:3000');

    this.ws.addEventListener('agents_list', (e) => {
      this.buildNPCs(e.detail.agents);
      this.scene.get('UIScene')?.onAgentsList(e.detail.agents);
    });

    this.ws.addEventListener('agent_move', (e) => {
      const { agentId, toAgentId } = e.detail;
      const npc = this.npcs[agentId];
      const target = this.npcs[toAgentId];
      if (npc && target) {
        if (toAgentId === agentId) npc.returnHome();
        else npc.moveTo(target);
      }
    });

    this.ws.addEventListener('agent_bubble', (e) => {
      const { agentId, text } = e.detail;
      this.npcs[agentId]?.showBubble(text);
    });

    this.ws.addEventListener('agent_status', (e) => {
      const { agentId, status, result } = e.detail;
      this.npcs[agentId]?.setStatus(status, result);
    });

    this.scene.launch('UIScene', { ws: this.ws, gameScene: this });
  }

  buildNPCs(agents) {
    // 清除旧 NPC（简单实现：重新创建场景）
    Object.values(this.npcs).forEach(npc => {
      npc.sprite.destroy();
      npc.emojiLabel.destroy();
      npc.nameLabel.destroy();
      npc.statusLabel.destroy();
      npc.bubbleBg.destroy();
      npc.bubbleText.destroy();
    });
    this.npcs = {};

    agents.forEach((agent, i) => {
      const npc = new AgentNPC(this, agent, i);
      npc.onPlayerEnter = (config) => {
        this.scene.get('UIScene')?.openChat(config);
      };
      this.npcs[agent.id] = npc;
    });
  }

  update(time, delta) {
    this.player.update(delta);
    Object.values(this.npcs).forEach(npc => {
      npc.checkProximity(this.player.x, this.player.y);
    });
  }
}
```

- [ ] **Step 3：重启服务器，浏览器验证**

```bash
node server/index.js
open http://localhost:3000
```

Expected: 地图上出现 4 个 agent 桌子（PM、小后、小前、小安），走近时边框发光。

- [ ] **Step 4：Commit**

```bash
git add client/src/entities/AgentNPC.js client/src/scenes/GameScene.js
git commit -m "feat: agent NPC with desk, status indicator, proximity detection"
```

---

## Task 9：聊天框 UI（UIScene）

**Files:**
- Modify: `client/src/scenes/UIScene.js`

- [ ] **Step 1：实现完整 UIScene**

```js
// client/src/scenes/UIScene.js
export class UIScene extends Phaser.Scene {
  constructor() { super({ key: 'UIScene', active: false }); }

  init(data) {
    this.ws = data.ws;
    this.gameScene = data.gameScene;
    this._agents = [];
    this._currentAgent = null;
    this._mode = 'auto'; // 'auto' | 'confirm'
    this._pendingPlan = null;
  }

  create() {
    // ── 聊天框（右侧面板，默认隐藏）──
    this._buildChatPanel();

    // ── 模式切换按钮（右上角）──
    this._buildModeToggle();

    // ── 添加 Agent 按钮（左下角）──
    this._buildAddAgentButton();

    // WebSocket 事件
    this.ws.addEventListener('chat_chunk', (e) => this._onChatChunk(e.detail));
    this.ws.addEventListener('plan_preview', (e) => this._onPlanPreview(e.detail));
    this.ws.addEventListener('agents_list', (e) => this.onAgentsList(e.detail.agents));
  }

  // ── 聊天框 ──

  _buildChatPanel() {
    const W = 280, H = 400, X = 800 - W - 8, Y = 8;
    this._chatPanel = this.add.container(X, Y).setVisible(false).setDepth(100);

    const bg = this.add.rectangle(W/2, H/2, W, H, 0x0d0d2e, 0.95)
      .setStrokeStyle(1, 0x4a4a8a);
    this._chatTitle = this.add.text(12, 10, '', {
      fontSize: '11px', color: '#aaaaff', fontFamily: 'monospace', fontStyle: 'bold'
    });
    const closeBt = this.add.text(W - 16, 10, '✕', {
      fontSize: '11px', color: '#ff6666', fontFamily: 'monospace'
    }).setInteractive({ cursor: 'pointer' }).on('pointerdown', () => this.closeChat());

    // 对话历史区
    this._chatLog = this.add.text(12, 30, '', {
      fontSize: '9px', color: '#cccccc', fontFamily: 'monospace',
      wordWrap: { width: W - 24 }, lineSpacing: 4
    });

    // 输入框（DOM）
    this._input = this.add.dom(W/2, H - 40).createFromHTML(
      `<input type="text" placeholder="输入消息..." style="width:${W-80}px;background:#1a1a3e;color:#fff;border:1px solid #4a4a8a;padding:6px;font-size:11px;font-family:monospace;" />`
    );
    const sendBt = this.add.text(W - 36, H - 48, '发送', {
      fontSize: '9px', color: '#00ff88', fontFamily: 'monospace',
      backgroundColor: '#0a2a1a', padding: { x: 4, y: 3 }
    }).setInteractive({ cursor: 'pointer' }).on('pointerdown', () => this._sendMessage());

    this._chatPanel.add([bg, this._chatTitle, closeBt, this._chatLog, this._input, sendBt]);
    this._chatLog.setText('');
    this._chatBuffer = '';
  }

  openChat(agentConfig) {
    if (this._currentAgent?.id === agentConfig.id) return;
    this._currentAgent = agentConfig;
    this._chatTitle.setText(`💬 ${agentConfig.name}（${agentConfig.role}）`);
    this._chatLog.setText('');
    this._chatBuffer = '';
    this._chatPanel.setVisible(true);
  }

  closeChat() {
    this._chatPanel.setVisible(false);
    this._currentAgent = null;
  }

  _sendMessage() {
    const inputEl = this._input.node.querySelector('input');
    const text = inputEl?.value?.trim();
    if (!text || !this._currentAgent) return;

    this._appendLog(`🧑 你: ${text}`);
    inputEl.value = '';
    this._chatBuffer = '';

    this.ws.send({ type: 'chat', agentId: this._currentAgent.id, message: text });
  }

  _onChatChunk(detail) {
    if (detail.agentId !== this._currentAgent?.id) return;
    if (detail.text) {
      this._chatBuffer += detail.text;
    }
    if (detail.done && this._chatBuffer) {
      const agent = this._agents.find(a => a.id === detail.agentId);
      const name = agent?.name || detail.agentId;
      this._appendLog(`🤖 ${name}: ${this._chatBuffer.trim()}`);
      this._chatBuffer = '';
    }
  }

  _onPlanPreview(detail) {
    if (detail.agentId !== this._currentAgent?.id) return;
    this._pendingPlan = detail.plan;
    const taskLines = detail.plan.tasks.map(t => `  · ${t.agent}: ${t.task}`).join('\n');
    this._appendLog(`\n📋 计划：\n${taskLines}\n`);
    this._appendLog('[点"确认"执行，或重新输入调整]');
    this._showConfirmButton();
  }

  _showConfirmButton() {
    if (this._confirmBt) this._confirmBt.destroy();
    this._confirmBt = this.add.text(
      800 - 280 - 8 + 280/2, 8 + 400 - 20, '✅ 确认执行', {
        fontSize: '10px', color: '#00ff88', fontFamily: 'monospace',
        backgroundColor: '#0a2a1a', padding: { x: 8, y: 4 }
      }
    ).setOrigin(0.5).setDepth(101).setInteractive({ cursor: 'pointer' })
    .on('pointerdown', () => {
      this.ws.send({ type: 'confirm_plan', agentId: 'pm' });
      this._confirmBt?.destroy();
    });
  }

  _appendLog(text) {
    const current = this._chatLog.text;
    const lines = (current + '\n' + text).split('\n');
    // 最多保留 30 行
    this._chatLog.setText(lines.slice(-30).join('\n'));
  }

  // ── 模式切换 ──

  _buildModeToggle() {
    this._modeText = this.add.text(8, 8, '⚡ 全自动', {
      fontSize: '9px', color: '#ffdd55', fontFamily: 'monospace',
      backgroundColor: '#1a1a00', padding: { x: 6, y: 3 }
    }).setDepth(100).setInteractive({ cursor: 'pointer' })
    .on('pointerdown', () => this._toggleMode());
  }

  _toggleMode() {
    this._mode = this._mode === 'auto' ? 'confirm' : 'auto';
    this._modeText.setText(this._mode === 'auto' ? '⚡ 全自动' : '✋ 先确认');
    this._modeText.setColor(this._mode === 'auto' ? '#ffdd55' : '#ff8855');
    this.ws.send({ type: 'set_mode', mode: this._mode });
  }

  // ── 添加 Agent ──

  _buildAddAgentButton() {
    this.add.text(8, 600 - 24, '+ Add Agent', {
      fontSize: '9px', color: '#00ccff', fontFamily: 'monospace',
      backgroundColor: '#001a2e', padding: { x: 6, y: 3 }
    }).setDepth(100).setInteractive({ cursor: 'pointer' })
    .on('pointerdown', () => this._openAddAgentPanel());
  }

  _openAddAgentPanel() {
    if (this._addPanel) { this._addPanel.destroy(); this._addPanel = null; return; }

    const W = 300, H = 320, X = 8, Y = 200;
    this._addPanel = this.add.container(X, Y).setDepth(110);

    const bg = this.add.rectangle(W/2, H/2, W, H, 0x0a0a2e, 0.97)
      .setStrokeStyle(1, 0x00ccff);
    const title = this.add.text(12, 10, '➕ 新增 Agent', {
      fontSize: '11px', color: '#00ccff', fontFamily: 'monospace'
    });
    const closeBt = this.add.text(W - 16, 10, '✕', {
      fontSize: '11px', color: '#ff6666', fontFamily: 'monospace'
    }).setInteractive({ cursor: 'pointer' }).on('pointerdown', () => {
      this._addPanel.destroy(); this._addPanel = null;
    });

    const formHtml = `
      <div style="font-family:monospace;font-size:10px;color:#aaa;display:flex;flex-direction:column;gap:6px;width:270px">
        <label>昵称 <input id="vo-name" style="width:100%;background:#1a1a3e;color:#fff;border:1px solid #4a4a8a;padding:4px" /></label>
        <label>Emoji <input id="vo-emoji" value="🤖" style="width:60px;background:#1a1a3e;color:#fff;border:1px solid #4a4a8a;padding:4px" /></label>
        <label>角色 <input id="vo-role" placeholder="e.g. QA Engineer" style="width:100%;background:#1a1a3e;color:#fff;border:1px solid #4a4a8a;padding:4px" /></label>
        <label>工作目录 <input id="vo-dir" placeholder="/path/to/project" style="width:100%;background:#1a1a3e;color:#fff;border:1px solid #4a4a8a;padding:4px" /></label>
        <label>System Prompt<br/><textarea id="vo-prompt" rows="3" style="width:100%;background:#1a1a3e;color:#fff;border:1px solid #4a4a8a;padding:4px;font-size:9px"></textarea></label>
        <button id="vo-submit" style="background:#003a1e;color:#00ff88;border:1px solid #00ff88;padding:6px;cursor:pointer;font-family:monospace">✅ 创建 Agent</button>
      </div>`;

    const form = this.add.dom(W/2, H/2 + 20).createFromHTML(formHtml);
    form.node.querySelector('#vo-submit').addEventListener('click', () => {
      const name   = form.node.querySelector('#vo-name').value.trim();
      const emoji  = form.node.querySelector('#vo-emoji').value.trim() || '🤖';
      const role   = form.node.querySelector('#vo-role').value.trim();
      const dir    = form.node.querySelector('#vo-dir').value.trim();
      const prompt = form.node.querySelector('#vo-prompt').value.trim();
      if (!name || !role || !dir) return;

      const id = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
      this.ws.send({
        type: 'add_agent',
        config: { id, name, emoji, role, workDir: dir, tools: ['Edit','Read','Bash'], avatar: null, systemPrompt: prompt }
      });
      this._addPanel.destroy(); this._addPanel = null;
    });

    this._addPanel.add([bg, title, closeBt, form]);
  }

  onAgentsList(agents) { this._agents = agents; }
}
```

- [ ] **Step 2：在 index.html 开启 DOM 插件**

在 `client/index.html` 的 `<head>` 末尾确认有（Phaser 默认包含）：
无需额外修改，Phaser 3 自带 DOM 支持，但需在 Phaser config 里启用：

```js
// client/src/main.js — 更新 config
const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#0d0d0d',
  scene: [GameScene, UIScene],
  pixelArt: true,
  dom: { createContainer: true },  // ← 加这一行
};
```

- [ ] **Step 3：重启服务器，完整测试**

```bash
node server/index.js
open http://localhost:3000
```

测试流程：
1. 走近 PM 桌子 → 聊天框打开，标题显示"PM"
2. 左上角点击切换模式（全自动 / 先确认）
3. 左下角点击"+ Add Agent"→ 填写表单 → 点创建 → 地图出现新角色
4. 聊天框可以发送消息

- [ ] **Step 4：Commit**

```bash
git add client/src/scenes/UIScene.js client/src/main.js
git commit -m "feat: chat dialog, mode toggle, add agent panel"
```

---

## Task 10：端到端冒烟测试

- [ ] **Step 1：准备测试场景**

确保 `~/.virtual-office/agents/` 有 pm、frontend-dev、app-dev 三个配置，工作目录存在且包含代码文件。

- [ ] **Step 2：走到 PM，发送一个真实任务**

```
走到 PM 桌旁 → 打开聊天框 → 发送：
"在 frontend-app 的首页加一个 Hello 注释"
```

Expected:
1. PM 回复并附带 JSON 计划
2. 全自动模式下：小前头顶出现 `⚙ working...`，PM 走到小前桌旁，气泡显示任务
3. claude 进程在 frontend-app 目录执行（可能修改文件）
4. 小前头顶出现 `✅ done`，气泡显示结果摘要

- [ ] **Step 3：测试先确认模式**

切换到"先确认"模式 → 给 PM 发新任务 → 聊天框出现计划预览和"确认执行"按钮 → 点确认 → 执行流程开始

- [ ] **Step 4：测试添加新 agent**

点"+ Add Agent" → 填写 QA Engineer → 创建 → 地图出现新角色 → 走过去对话

- [ ] **Step 5：最终 commit**

```bash
git add .
git commit -m "feat: virtual office MVP complete - pixel RPG multi-agent system"
```

---

## 未来迭代（不在本计划内）

- **动漫形象**：在 AgentNPC 里加载 sprite sheet，`avatar` 字段指向图片，对话框左侧显示半身立绘
- **任务历史**：侧边栏显示所有已完成任务的摘要
- **方案 B 升级**：给 PM 加 `call_agent` tool，支持 PM 主动多轮协调
- **像素地图编辑器**：自定义办公室布局
