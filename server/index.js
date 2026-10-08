// server/index.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const express = require('express');
const http = require('http');
const ws = require('ws');
const path = require('path');
const os = require('os');
const { handleMessage, checkAutoCompact, getAutoCompactK, getCompactLog, setUsageProvider, getOfficeName } = require('./wsHandler');
const { saveAgent, listAgents } = require('./agentManager');
const { saveUpload } = require('./uploads');
const { getSession } = require('./sessionStore');
const { logBus } = require('./claudeRunner');
const { report } = require('./tokenUsage');
const { fetchWeather, getWeather } = require('./weather');

const PORT = process.env.PORT || 3000;
const AGENTS_DIR = path.join(os.homedir(), '.virtual-office', 'agents');

const app = express();
app.use(express.static(path.join(__dirname, '../client'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
}));

// 文件上传：客户端把原始字节 POST 过来（不用 multipart，免依赖），存盘后返回绝对路径
app.post('/upload', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  try {
    const saved = saveUpload(req.query.name, req.body);
    res.json({ name: path.basename(saved).replace(/^\d+-/, ''), path: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new ws.WebSocketServer({ server });

function broadcastToClients(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// 把 agent 运行日志广播给所有客户端的「日志台」
logBus.on('line', (entry) => broadcastToClients({ type: 'log', ...entry }));
logBus.on('auth', (entry) => broadcastToClients({ type: 'auth_state_changed', ...entry }));

// 每隔 TOKEN_REPORT_SEC 秒（默认 120）刷新 token 用量：推结构化 usage（给墙上用量牌+明细）
// 并往日志台播一行汇总。结果缓存到 latestUsage，新连接进来时立刻下发。
const TOKEN_REPORT_MS = (parseInt(process.env.TOKEN_REPORT_SEC, 10) || 120) * 1000;
const fmt = (n) => (n || 0).toLocaleString('en-US');
let latestUsage = null;
setUsageProvider(() => latestUsage); // 供压缩时记录「压缩前累计计费」

async function refreshTokenUsage() {
  try {
    latestUsage = await report();
    broadcastToClients({ type: 'usage', report: latestUsage });
    // 日志台汇总行：今日 办公室 / iTerm
    const off = latestUsage.office.today.billable, it = latestUsage.iterm.today.billable;
    broadcastToClients({ type: 'log', agent: '💰用量', text: `今日 token：🏢办公室 ${fmt(off)} · 💻iTerm ${fmt(it)}`, ts: Date.now() });
    checkAutoCompact(wss, latestUsage, AGENTS_DIR); // 会话累计计费超阈值 → 自动压缩
  } catch (err) {
    console.error('token 用量统计失败:', err.message);
  }
}
setInterval(refreshTokenUsage, TOKEN_REPORT_MS);
setTimeout(refreshTokenUsage, 3000); // 启动后先算一次

// 天气：启动拉一次，之后每 30 分钟刷新（免费 API：ip-api 定位 + open-meteo 天气）
async function refreshWeather() {
  try {
    const weather = await fetchWeather();
    broadcastToClients({ type: 'weather', weather });
  } catch (err) {
    console.error('天气获取失败:', err.message);
  }
}
setInterval(refreshWeather, 30 * 60 * 1000);
refreshWeather();

function seedDefaultAgents() {
  const existing = listAgents(AGENTS_DIR).map(a => a.id);

  const defaults = [
    {
      id: 'pm',
      name: 'PM',
      emoji: '🧑‍💼',
      role: 'Project Manager',
      workDir: os.homedir(),
      tools: ['Read'],
      avatar: null,
      systemPrompt: '（系统动态生成）',
    },
    {
      id: 'backend-dev',
      name: '小后',
      emoji: '💻',
      role: 'Backend Developer',
      workDir: path.join(os.homedir(), 'Projects/backend'),
      tools: ['Edit', 'Read', 'Bash'],
      avatar: null,
      systemPrompt: '你是后端开发工程师，负责当前配置的后端项目。收到任务后先读相关文件再动手，完成后简短汇报。',
    },
    {
      id: 'frontend-dev',
      name: '小前',
      emoji: '🧑‍🎨',
      role: 'Frontend Developer',
      workDir: path.join(os.homedir(), 'Projects/frontend'),
      tools: ['Edit', 'Read', 'Bash'],
      avatar: null,
      systemPrompt: '你是前端开发工程师，负责当前配置的前端项目。收到任务后先读相关文件再动手，完成后简短汇报。',
    },
    {
      id: 'app-dev',
      name: '小安',
      emoji: '📱',
      role: 'App Developer',
      workDir: path.join(os.homedir(), 'Projects/mobile'),
      tools: ['Edit', 'Read', 'Bash'],
      avatar: null,
      systemPrompt: '你是 Flutter 移动端开发工程师，负责当前配置的移动端项目。收到任务后先读相关文件再动手，完成后简短汇报。',
    },
  ];

  for (const agent of defaults) {
    if (!existing.includes(agent.id)) {
      saveAgent(agent, AGENTS_DIR);
      console.log(`✅ 初始化 agent: ${agent.name}（${agent.id}）`);
    }
  }
}

function listAgentsWithSession(dir) {
  return listAgents(dir).map(agent => ({
    ...agent,
    sessionId: getSession(agent.id) || null
  }));
}

wss.on('connection', (ws) => {
  console.log('客户端已连接');
  ws.send(JSON.stringify({ type: 'agents_list', agents: listAgentsWithSession(AGENTS_DIR) }));
  if (latestUsage) ws.send(JSON.stringify({ type: 'usage', report: latestUsage })); // 立刻填充墙上用量牌
  ws.send(JSON.stringify({ type: 'autocompact', thresholdK: getAutoCompactK() })); // 同步自动压缩阈值
  ws.send(JSON.stringify({ type: 'compact_log', log: getCompactLog() })); // 同步压缩谱系（♻️标记 + 记录面板）
  if (getWeather()) ws.send(JSON.stringify({ type: 'weather', weather: getWeather() })); // 墙上天气牌
  ws.send(JSON.stringify({ type: 'office_name', name: getOfficeName() })); // 办公室名字

  ws.on('message', (raw) => {
    handleMessage(ws, wss, raw.toString(), AGENTS_DIR);
  });

  ws.on('close', () => console.log('客户端断开'));
  ws.on('error', (err) => console.error('WebSocket 错误:', err.message));
});

seedDefaultAgents();
server.listen(PORT, () => {
  console.log(`🏢 Virtual Office 运行在 http://localhost:${PORT}`);
});
