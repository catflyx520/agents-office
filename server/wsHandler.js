// server/wsHandler.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { listAgents, saveAgent, deleteAgent, loadAgent } = require('./agentManager');
const { spawnAgent } = require('./claudeRunner');
const { buildPMSystemPrompt, buildManagerSystemPrompt, buildPMSummaryPrompt, extractPMPlan, scheduleTasks, normalizePlan } = require('./pmOrchestrator');
const { buildDelegationEvents, buildCompleteEvent } = require('./animController');
const { setLocationByZip } = require('./weather');
const { getSession, setSession } = require('./sessionStore');
const { saveConfig, getConfig } = require('./configStore');
const { getAuthState, clearAuthError } = require('./authState');

function listAgentsWithSession(dir) {
  return listAgents(dir).map(agent => ({
    ...agent,
    sessionId: getSession(agent.id) || null
  }));
}

// 每个 ws 连接维护 controlMode、pendingPlan、和 pmRunning 标志
const clientState = new WeakMap();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(wss, obj) {
  wss.clients.forEach(client => send(client, obj));
}

// 把上传的附件路径拼进消息，提示 agent 用 Read 查看
function appendAttachments(message, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return message;
  const list = attachments.map(a => `- ${a.path}`).join('\n');
  return `${message || ''}\n\n【用户上传了以下文件，请先用 Read 工具查看再处理；Excel 等可用 Bash 解析】\n${list}`.trim();
}

// 正在运行的 claude 进程：agentId -> Set<kill 函数>，供「取消任务」用
const running = new Map();

// ── 会话压缩（compact）────────────────────────────────────
// CLI 的 /compact 在 -p 非交互模式下不可用（官方文档），所以自制：
// ① 用旧 session 跑最后一次「总结这段对话」 ② 开全新 session 把摘要作为记忆载入
// ③ 存新 session id，旧雪球不再被 resume。效果等价：长历史 → 一段摘要。
const SETTINGS_FILE = path.join(os.homedir(), '.virtual-office', 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}
let autoCompactK = Number(readSettings().autoCompactK) || 0; // 0 = 关闭；单位 k token（按会话累计计费量）
const compacting = new Set(); // 正在压缩中的 agentId，防并发

// ── 压缩谱系（compactLog）────────────────────────────────
// 每次压缩记一条 { agentId, oldSid, newSid, ts, auto, gen, billableBefore, summary }，
// 落盘 ~/.virtual-office/compactLog.json。前端用它标记「♻️第N代」会话 + 压缩记录面板。
const COMPACT_LOG_FILE = path.join(os.homedir(), '.virtual-office', 'compactLog.json');
function readCompactLog() { try { return JSON.parse(fs.readFileSync(COMPACT_LOG_FILE, 'utf8')); } catch { return []; } }
function appendCompactLog(entry) {
  const log = readCompactLog();
  log.push(entry);
  fs.mkdirSync(path.dirname(COMPACT_LOG_FILE), { recursive: true });
  fs.writeFileSync(COMPACT_LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
  return log;
}
function getCompactLog() { return readCompactLog(); }

// index.js 注入「取最新用量报表」的函数，压缩时用来记录该会话压缩前的累计计费
let usageProvider = () => null;
function setUsageProvider(fn) { usageProvider = fn; }
function sessionBillable(agentId, sid) {
  const report = usageProvider();
  const items = report && report.officeSessions && report.officeSessions.items;
  const item = items && items.find(it => it.key === `${agentId}::${sid}`);
  return item ? item.total.billable : null;
}

const COMPACT_SUMMARY_PROMPT = `请把我们这个会话到目前为止的全部内容压缩成一份简明摘要（500 字以内，纯文本），用于开启新会话时延续记忆。必须包含：
1. 已完成的关键工作（涉及的项目/文件/接口/页面）
2. 进行中或待办的事项
3. 用户的重要约定、偏好或反复强调的要求
只输出摘要本身，不要开场白、结尾和代码块。`;

function runCompact(wss, agentId, agentsDir, { auto = false } = {}) {
  const fail = (message) => broadcast(wss, { type: 'compact_status', agentId, stage: 'error', message });
  if (compacting.has(agentId)) return;
  if (running.has(agentId)) { if (!auto) fail('该同事正在工作中，等他忙完再压缩'); return; }
  const sid = getSession(agentId);
  if (!sid) { if (!auto) fail('还没有历史会话，无需压缩'); return; }
  let agentConfig;
  try { agentConfig = loadAgent(agentId, agentsDir); } catch (err) { fail(`加载 agent 失败: ${err.message}`); return; }

  compacting.add(agentId);
  broadcast(wss, { type: 'compact_status', agentId, stage: 'summarizing', auto });
  console.log(`[compact] ${agentId} 开始压缩 session=${sid}${auto ? '（自动触发）' : ''}`);

  let summary = '';
  const step1 = { ...agentConfig, resumeSessionId: sid };
  const h1 = spawnAgent(step1, COMPACT_SUMMARY_PROMPT, (chunk) => {
    if (chunk.type === 'text') summary += chunk.text;
    if (chunk.done) {
      unregisterProc(agentId, h1.kill);
      summary = summary.trim();
      if (!summary) { compacting.delete(agentId); fail('没拿到摘要，压缩中止（旧会话原样保留）'); return; }
      broadcast(wss, { type: 'compact_status', agentId, stage: 'seeding' });

      const step2 = { ...agentConfig, resumeSessionId: null };
      const h2 = spawnAgent(step2, `【记忆载入】以下是你之前工作会话的压缩摘要，请记住它作为背景。只需简短回复“记忆已载入”。\n\n${summary}`, (c2) => {
        if (c2.done) {
          unregisterProc(agentId, h2.kill);
          compacting.delete(agentId);
          if (c2.sessionId) setSession(agentId, c2.sessionId);
          console.log(`[compact] ${agentId} 完成，新 session=${c2.sessionId || '无'}`);
          // 记入压缩谱系：gen = 该 agent 第几次压缩
          const prior = readCompactLog().filter(e => e.agentId === agentId).length;
          const log = appendCompactLog({
            agentId, oldSid: sid, newSid: c2.sessionId || null,
            ts: Date.now(), auto, gen: prior + 1,
            billableBefore: sessionBillable(agentId, sid), summary,
          });
          broadcast(wss, { type: 'compact_status', agentId, stage: 'done', auto, newSessionId: c2.sessionId || null, summary: summary.slice(0, 400) });
          broadcast(wss, { type: 'compact_log', log });
        }
      });
      registerProc(agentId, h2.kill);
    }
  });
  registerProc(agentId, h1.kill);
}

// 用量报表刷新后调用：当前会话累计计费 ≥ 阈值 且 agent 空闲 → 自动压缩
function checkAutoCompact(wss, report, agentsDir) {
  if (!autoCompactK) return;
  const items = report && report.officeSessions && report.officeSessions.items;
  if (!items) return;
  for (const a of listAgents(agentsDir)) {
    const sid = getSession(a.id);
    if (!sid || running.has(a.id) || compacting.has(a.id)) continue;
    const item = items.find(it => it.key === `${a.id}::${sid}`);
    if (item && item.total.billable >= autoCompactK * 1000) {
      console.log(`[compact] ${a.id} 当前会话累计计费 ${item.total.billable} ≥ ${autoCompactK}k，自动压缩`);
      runCompact(wss, a.id, agentsDir, { auto: true });
    }
  }
}

function getAutoCompactK() { return autoCompactK; }
function getOfficeName() { return readSettings().officeName || '小办公室'; }

function registerProc(agentId, kill) {
  if (!running.has(agentId)) running.set(agentId, new Set());
  running.get(agentId).add(kill);
}

function unregisterProc(agentId, kill) {
  const set = running.get(agentId);
  if (!set) return;
  set.delete(kill);
  if (set.size === 0) running.delete(agentId);
}

// 杀掉某 agent 当前所有进程，返回是否有进程被取消
function cancelAgent(agentId) {
  const set = running.get(agentId);
  if (!set || set.size === 0) return false;
  for (const kill of set) { try { kill(); } catch { /* 忽略 */ } }
  running.delete(agentId);
  return true;
}

/**
 * 执行一个 wave（一组可并行的任务）。
 * resolve 成 [{ agent, result }]，供 PM 最终汇总用。
 */
function executeWave(wss, wave, agentsDir) {
  return Promise.all(wave.map(task => new Promise((resolve) => {
    let agentConfig;
    try {
      agentConfig = loadAgent(task.agent, agentsDir);
    } catch (err) {
      const firstClient = [...wss.clients][0];
      if (firstClient) send(firstClient, { type: 'error', message: `加载 agent ${task.agent} 失败: ${err.message}` });
      resolve({ agent: task.agent, result: `（加载失败：${err.message}）` });
      return;
    }

    // PM 派发的任务一律用全新会话：任务描述是自包含的，不需要旧记忆。
    // 续接旧会话会让 worker 每次把滚雪球式增长的历史全部重写进缓存
    // （实测：同一任务下小后 199k→301k 递增，worker 占任务总消耗 99%）。
    // 完成后 setSession 仍会记下新 session id，方便用户事后走过去和该 worker 聊“你刚做了什么”。
    agentConfig.resumeSessionId = null;
    let fullText = '';

    const handle = spawnAgent(agentConfig, task.task, (chunk) => {
      if (chunk.type === 'text') {
        fullText += chunk.text;
        // 详细输出推给客户端，写进该 agent 自己的日志（单用户场景：推第一个连接）
        const firstClient = [...wss.clients][0];
        if (firstClient) send(firstClient, { type: 'chat_chunk', agentId: task.agent, text: chunk.text, done: false });
      }
      if (chunk.done) {
        unregisterProc(task.agent, handle.kill);
        setSession(task.agent, chunk.sessionId);
        const firstClient = [...wss.clients][0];
        if (firstClient) send(firstClient, { type: 'chat_chunk', agentId: task.agent, text: '', done: true, sessionId: chunk.sessionId }); // 落定该 agent 日志
        broadcast(wss, buildCompleteEvent(task.agent, fullText.slice(0, 200)));   // 驱动 NPC 完成动画
        resolve({ agent: task.agent, result: fullText.trim() });
      }
    });
    registerProc(task.agent, handle.kill);
  })));
}

/**
 * 团队全部完成后，让管理者（pm 或任意 manager agent）汇总结果汇报给用户。
 * 这是一次性的无状态调用：不 --resume、不覆盖管理者主会话，避免污染其规划上下文。
 */
function summarizeByPM(wss, results, agentsDir, managerId = 'pm') {
  return new Promise((resolve) => {
    const firstClient = [...wss.clients][0];
    if (!firstClient || results.length === 0) { resolve(); return; }

    let mgrConfig;
    try {
      mgrConfig = loadAgent(managerId, agentsDir);
    } catch {
      resolve();
      return;
    }

    const agents = listAgents(agentsDir);
    const nameOf = id => agents.find(a => a.id === id)?.name || id;
    const report = results
      .map(r => `【${nameOf(r.agent)}（${r.agent}）】\n${r.result || '（无输出）'}`)
      .join('\n\n');

    const roleLabel = managerId === 'pm' ? '项目经理' : `${mgrConfig.name}（${mgrConfig.role || '负责人'}）`;
    const forSummary = { ...mgrConfig, systemPrompt: buildPMSummaryPrompt(roleLabel) };
    const handle = spawnAgent(forSummary, report, (chunk) => {
      if (chunk.type === 'text') {
        send(firstClient, { type: 'chat_chunk', agentId: managerId, text: chunk.text, done: false });
      }
      if (chunk.done) {
        unregisterProc(managerId, handle.kill);
        send(firstClient, { type: 'chat_chunk', agentId: managerId, text: '', done: true });
        resolve();
      }
    });
    registerProc(managerId, handle.kill);
  });
}

async function executePlan(wss, plan, agentsDir, managerId = 'pm') {
  try {
    const waves = scheduleTasks(plan.tasks);
    broadcast(wss, { type: 'agent_status', agentId: managerId, status: 'working' }); // 管理者进入「执行中」loading
    const allResults = [];
    for (const wave of waves) {
      const animEvents = buildDelegationEvents(wave, managerId);
      animEvents.forEach(ev => broadcast(wss, ev));
      const waveResults = await executeWave(wss, wave, agentsDir);
      allResults.push(...waveResults);
    }
    await summarizeByPM(wss, allResults, agentsDir, managerId); // 管理者汇总汇报
  } catch (err) {
    const firstClient = [...wss.clients][0];
    if (firstClient) send(firstClient, { type: 'error', message: `执行计划失败: ${err.message}` });
  } finally {
    broadcast(wss, { type: 'agent_status', agentId: managerId, status: 'done' }); // 关闭管理者 loading
  }
}

function handleMessage(ws, wss, raw, agentsDir) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const state = clientState.get(ws) || { mode: 'auto', pendingPlan: null, pmRunning: false };
  clientState.set(ws, state);

  switch (msg.type) {
    case 'save_apikey':
      try {
        saveConfig('apiKey', msg.key || '');
        send(ws, { type: 'save_apikey_result', success: true });
        console.log('[Auth] API Key saved successfully.');
      } catch (err) {
        send(ws, { type: 'save_apikey_result', success: false, error: err.message });
      }
      break;
    case 'get_config':
      send(ws, { type: 'config_data', apiKey: getConfig('apiKey') || '' });
      break;

    case 'get_auth_status': {
      const { exec } = require('child_process');
      const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
      exec(`"${CLAUDE_BIN}" auth status`, (err, stdout, stderr) => {
        let claudeStatus = { loggedIn: false, email: '' };
        try {
          const info = JSON.parse(stdout);
          claudeStatus.loggedIn = !!info.loggedIn;
          claudeStatus.email = info.email || '';
        } catch {}

        exec(`"${process.env.CODEX_BIN || 'codex'}" login status`, (err2, stdout2, stderr2) => {
          let codexStatus = { loggedIn: false };
          const combined = (stdout2 || '') + (stderr2 || '');
          if (combined.includes('Logged in')) {
            codexStatus.loggedIn = true;
          }

          claudeStatus.state = getAuthState('claude', claudeStatus.loggedIn || !!process.env.ANTHROPIC_API_KEY || !!getConfig('apiKey'));
          codexStatus.state = getAuthState('codex', codexStatus.loggedIn || !!process.env.CODEX_API_KEY);
          send(ws, {
            type: 'auth_status_result',
            activeProvider: getConfig('activeProvider') || 'claude',
            claude: claudeStatus,
            codex: codexStatus
          });
        });
      });
      break;
    }

    case 'switch_provider':
      try {
        const provider = msg.provider === 'codex' ? 'codex' : 'claude';
        saveConfig('activeProvider', provider);
        send(ws, { type: 'switch_provider_result', success: true, provider });
        console.log(`[Auth] Switched active provider to: ${provider}`);
      } catch (err) {
        send(ws, { type: 'switch_provider_result', success: false, error: err.message });
      }
      break;
    case 'logout': {
      const { exec } = require('child_process');
      const provider = msg.provider === 'codex' ? 'codex' : 'claude';
      let cmd;
      if (provider === 'codex') {
        cmd = `"${process.env.CODEX_BIN || 'codex'}" logout`;
      } else {
        const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
        cmd = `"${CLAUDE_BIN}" logout`;
      }
      exec(cmd, (err, stdout, stderr) => {
        const success = !err;
        send(ws, { type: 'logout_result', success, provider, error: err ? err.message : null });
        console.log(`[Auth] Executed logout for ${provider} (success=${success})`);
      });
      break;
    }

    case 'start_login': {
      if (state.loginProc) {
        try { state.loginProc.kill(); } catch {}
        state.loginProc = null;
      }
      const { spawn } = require('child_process');
      const provider = msg.provider === 'codex' ? 'codex' : 'claude';
      let bin, args;
      if (provider === 'codex') {
        bin = process.env.CODEX_BIN || 'codex';
        args = ['login'];
      } else {
        bin = process.env.CLAUDE_BIN || 'claude';
        args = ['auth', 'login'];
      }
      const proc = spawn(bin, args, {
        env: Object.assign({}, process.env, { PAGER: 'cat' }),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      state.loginProc = proc;
      console.log(`[Auth] Started interactive login process for ${provider} (pid=${proc.pid})`);

      let buffer = '';
      proc.stdout.on('data', (d) => {
        const text = d.toString();
        send(ws, { type: 'login_stdout', text });
        buffer += text;
        
        // Find OAuth URL (support both Claude and Codex)
        const match = buffer.match(/(https:\/\/(?:claude\.com|auth\.openai\.com)\S+)/);
        if (match) {
          send(ws, { type: 'login_url', url: match[1].trim() });
          buffer = '';
        }
      });
      proc.stderr.on('data', (d) => {
        send(ws, { type: 'login_stdout', text: d.toString() });
      });
      proc.on('close', (code) => {
        if (code === 0) clearAuthError(provider);
        send(ws, { type: 'login_close', code });
        state.loginProc = null;
        console.log(`[Auth] Interactive login process exited with code ${code}`);
      });
      break;
    }

    case 'submit_login_code':
      if (state.loginProc) {
        console.log(`[Auth] Submitting verification code to stdin...`);
        state.loginProc.stdin.write(msg.code + '\n');
      } else {
        send(ws, { type: 'login_stdout', text: 'Error: No active login process found.\n' });
      }
      break;

    case 'set_mode':
      state.mode = msg.mode;
      break;

    case 'agents_list':
      send(ws, { type: 'agents_list', agents: listAgentsWithSession(agentsDir) });
      break;

    case 'add_agent':
      try {
        saveAgent(msg.config, agentsDir);
        broadcast(wss, { type: 'agents_list', agents: listAgentsWithSession(agentsDir) });
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
      break;

    case 'delete_agent':
      try {
        deleteAgent(msg.agentId, agentsDir);
        broadcast(wss, { type: 'agents_list', agents: listAgentsWithSession(agentsDir) });
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
      break;

    case 'chat': {
      // 先加载目标 agent，判断是否为「管理者」（pm 或 manager: true）——管理者走编排路径
      let chatCfg;
      try {
        chatCfg = loadAgent(msg.agentId, agentsDir);
      } catch (err) {
        send(ws, { type: 'error', message: `加载 agent ${msg.agentId} 失败: ${err.message}` });
        return;
      }
      const isManager = msg.agentId === 'pm' || chatCfg.manager === true;

      if (isManager) {
        const mid = msg.agentId;
        // 若已有待确认计划（且属于这位管理者），用户发「派发/执行/确认」→ 直接执行
        const dispatchMsg = (msg.message || '').trim();
        if (state.pendingPlan && (state.pendingPlan.managerId || 'pm') === mid
            && /^(派发|派单|执行|确认执行|确认|开始执行|开始|开干|go|dispatch|run it|do it)[\s!！。.]*$/i.test(dispatchMsg)) {
          const pending = state.pendingPlan;
          state.pendingPlan = null;
          (async () => {
            try { await executePlan(wss, pending.plan, agentsDir, mid); }
            catch (err) { send(ws, { type: 'error', message: `执行计划失败: ${err.message}` }); }
          })();
          return;
        }

        // 每个管理者各自的「处理中」互斥
        state.mgrRunning = state.mgrRunning || {};
        if (state.mgrRunning[mid]) {
          send(ws, { type: 'error', message: `${chatCfg.name || mid} 正在处理中，请稍等` });
          return;
        }
        state.mgrRunning[mid] = true;

        const agents = listAgents(agentsDir);
        // 花名册：PM = 全员减去其他管理者和被他们接管的成员；manager = 只有自己的 team
        let allowedIds;
        if (mid === 'pm') {
          const managed = new Set(agents.filter(a => a.manager === true).flatMap(a => Array.isArray(a.team) ? a.team : []));
          allowedIds = agents.filter(a => a.id !== 'pm' && a.manager !== true && !managed.has(a.id)).map(a => a.id);
        } else {
          allowedIds = Array.isArray(chatCfg.team) ? chatCfg.team : [];
        }
        const sysPrompt = mid === 'pm' ? buildPMSystemPrompt(agents, allowedIds) : buildManagerSystemPrompt(chatCfg, agents);

        // msg.fresh（客户端 Ctrl+Enter）：本条不续接历史会话，用全新 session
        const mgrWithPrompt = { ...chatCfg, systemPrompt: sysPrompt, resumeSessionId: msg.fresh ? null : getSession(mid) };
        if (msg.fresh) console.log(`[${mid}] 用户要求全新会话（Ctrl+Enter），不 resume`);
        let fullText = '';

        const handle = spawnAgent(mgrWithPrompt, appendAttachments(msg.message, msg.attachments), async (chunk) => {
          if (chunk.type === 'text') {
            fullText += chunk.text;
            send(ws, { type: 'chat_chunk', agentId: mid, text: chunk.text, done: false });
          }
          if (chunk.done) {
            unregisterProc(mid, handle.kill);
            setSession(mid, chunk.sessionId);
            send(ws, { type: 'chat_chunk', agentId: mid, text: '', done: true, sessionId: chunk.sessionId });
            const plan = extractPMPlan(fullText);
            state.mgrRunning[mid] = false;
            // 诊断：把关键决策点打到服务器日志，方便定位「出了计划却没派活」
            console.log(`[${mid}诊断] fullText长度=${fullText.length}  提取到计划=${plan ? '是' : '否(null)'}  mode=${state.mode}  任务数=${plan?.tasks?.length ?? 0}`);
            if (!plan) return;
            normalizePlan(plan, agents); // 把 task.agent 从中文名/角色名解析成真实 id

            // 越权保护：只允许派给自己花名册里的成员，其余任务丢弃并告警
            const dropped = plan.tasks.filter(t => !allowedIds.includes(t.agent));
            if (dropped.length) {
              console.warn(`[${mid}诊断] 丢弃越权任务 → ${dropped.map(t => t.agent).join(', ')}（不在其团队里）`);
              plan.tasks = plan.tasks.filter(t => allowedIds.includes(t.agent));
            }
            if (!plan.tasks.length) return;

            if (state.mode === 'confirm') {
              console.log(`[${mid}诊断] confirm 模式 → 只发 plan_preview 预览，等待用户确认（不会自动执行）`);
              state.pendingPlan = { plan, managerId: mid };
              send(ws, { type: 'plan_preview', agentId: mid, plan });
            } else {
              console.log(`[${mid}诊断] auto 模式 → 立即 executePlan，派发 ${plan.tasks.map(t => t.agent).join(', ')}`);
              try {
                await executePlan(wss, plan, agentsDir, mid);
              } catch (err) {
                console.error(`[${mid}诊断] executePlan 抛异常:`, err);
                send(ws, { type: 'error', message: `执行计划失败: ${err.message}` });
              }
            }
          }
        });
        registerProc(mid, handle.kill);
      } else {
        // 普通 agent：直接流式对话
        const agentConfig = chatCfg;

        // msg.fresh（客户端 Ctrl+Enter）：本条不续接历史会话，用全新 session
        agentConfig.resumeSessionId = msg.fresh ? null : getSession(msg.agentId);
        if (msg.fresh) console.log(`[${msg.agentId}] 用户要求全新会话（Ctrl+Enter），不 resume`);
        const handle = spawnAgent(agentConfig, appendAttachments(msg.message, msg.attachments), (chunk) => {
          if (chunk.type === 'text') {
            send(ws, { type: 'chat_chunk', agentId: msg.agentId, text: chunk.text, done: false });
          }
          if (chunk.done) {
            unregisterProc(msg.agentId, handle.kill);
            setSession(msg.agentId, chunk.sessionId);
            send(ws, { type: 'chat_chunk', agentId: msg.agentId, text: '', done: true, sessionId: chunk.sessionId });
          }
        });
        registerProc(msg.agentId, handle.kill);
      }
      break;
    }

    case 'cancel': {
      cancelAgent(msg.agentId); // 杀掉该 agent 当前进程；被杀后进程 close 会自然走 done 流程
      if (state.mgrRunning) state.mgrRunning[msg.agentId] = false;
      if (state.pendingPlan && (state.pendingPlan.managerId || 'pm') === msg.agentId) state.pendingPlan = null;
      break;
    }

    case 'compact':
      runCompact(wss, msg.agentId, agentsDir);
      break;

    case 'set_location':
      // 天气位置：邮编 → 经纬度并持久化；zip 为空 = 恢复 IP 自动定位
      setLocationByZip(msg.zip, msg.country)
        .then(weather => {
          broadcast(wss, { type: 'weather', weather });
          console.log(`[weather] 位置已更新 → ${weather.city}${weather.manual ? `（邮编 ${weather.zip}）` : '（IP 自动）'}`);
        })
        .catch(err => send(ws, { type: 'error', message: `设置天气位置失败: ${err.message}` }));
      break;

    case 'set_office_name': {
      const name = String(msg.name || '').trim().slice(0, 24);
      if (!name) break;
      writeSettings({ officeName: name });
      broadcast(wss, { type: 'office_name', name });
      console.log(`[office] 改名 → ${name}`);
      break;
    }

    case 'set_autocompact': {
      autoCompactK = Math.max(0, Number(msg.thresholdK) || 0);
      writeSettings({ autoCompactK });
      broadcast(wss, { type: 'autocompact', thresholdK: autoCompactK });
      console.log(`[compact] 自动压缩阈值 → ${autoCompactK ? autoCompactK + 'k' : '关闭'}`);
      break;
    }

    case 'confirm_plan': {
      const pending = state.pendingPlan;
      state.pendingPlan = null;
      if (pending) {
        (async () => {
          try {
            await executePlan(wss, pending.plan, agentsDir, pending.managerId || 'pm');
          } catch (err) {
            send(ws, { type: 'error', message: `执行计划失败: ${err.message}` });
          }
        })();
      }
      break;
    }
  }
}

module.exports = { handleMessage, checkAutoCompact, getAutoCompactK, getCompactLog, setUsageProvider, getOfficeName };
