// server/claudeRunner.js
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { getConfig } = require('./configStore');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// 日志总线：spawnAgent 的每行运行日志都 emit 到这里，
// index.js 订阅后广播给前端「日志台」，让网页里也能看到 agent 在干嘛。
const logBus = new EventEmitter();

/**
 * 构建 claude CLI 参数列表
 */
function buildClaudeArgs({ systemPrompt, tools, model }) {
  const args = [
    '--output-format', 'stream-json',
    '--verbose', // CLI 要求：--print + stream-json 时必须加 --verbose，否则直接报错退出
    // full auto：非交互模式下没有人工审批入口，必须跳过权限确认，agent 才能真正写文件/跑命令
    // ⚠️ agent 会在其 workDir 真实仓库里执行任意工具调用（含 Bash），无需确认
    '--dangerously-skip-permissions',
    // ⚠️ 必须用 --tools（限制工具"是否存在"）而不是 --allowedTools（只管免不免审批）。
    // --dangerously-skip-permissions 会把 --allowedTools 白名单整个架空，导致 agent 拿到完整默认工具集
    // （含递归开子代理的 Agent/Task），一个问题被放大成三层几十个子代理，token 爆炸。
    // --tools 才是真正的开关：只加载列出的工具，Agent/Task 根本不存在，无法递归裂变。
    '--tools', tools.join(','),
  ];
  if (model) {
    args.push('--model', model);
  }
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

  // Claude Standard stream-json
  if (obj.type === 'assistant') {
    const content = obj.message?.content || [];
    const textBlock = content.find(b => b.type === 'text');
    if (textBlock && typeof textBlock.text === 'string') return { type: 'text', text: textBlock.text, done: false };
  }
  if (obj.type === 'result') {
    return { type: 'done', done: true, sessionId: obj.session_id };
  }

  // Codex JSONL event format
  if (obj.type === 'thread.started' && obj.thread_id) {
    return { type: 'text', text: '', done: false, sessionId: obj.thread_id };
  }
  if (obj.type === 'item.completed' && obj.item && obj.item.type === 'agent_message' && typeof obj.item.text === 'string') {
    return { type: 'text', text: obj.item.text, done: false };
  }
  if (obj.type === 'turn.completed' || obj.type === 'result') {
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
  const label = agentConfig.name || agentConfig.id || 'agent';
  const agentId = agentConfig.id || label;
  const startTime = Date.now();
  const log = (...a) => {
    const line = a.map(x => (typeof x === 'string' ? x : String(x))).join(' ');
    console.log(`[agent:${label}]`, line);
    logBus.emit('line', { agent: label, agentId, text: line, ts: Date.now() });
  };

  let buffer = '';
  let sessionId = null;
  let finished = false;
  let lineCount = 0;
  let textLen = 0;
  let currentProc = null;
  let resumeFailed = false; // 本次 --resume 的 session 失效
  let retried = false;      // 已经用全新会话重试过，避免无限重试
  // 心跳：进程长时间不输出时，每 15s 打一行，让你知道它还活着、还是真卡了
  let lastActivity = Date.now();
  const heartbeat = setInterval(() => {
    const idle = Math.round((Date.now() - lastActivity) / 1000);
    log(`  ⏳ 仍在处理中… 已运行 ${Math.round((Date.now() - startTime) / 1000)}s，距上次输出 ${idle}s（收到 ${lineCount} 行 / ${textLen} 字）`);
  }, 15000);

  // done 只触发一次：result 行和 close 都可能想结束，去重，避免 PM 计划被执行两次
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    log(`✔ 完成  耗时 ${Math.round((Date.now() - startTime) / 1000)}s  共 ${lineCount} 行 / ${textLen} 字  session=${sessionId || '无'}`);
    onChunk({ type: 'done', done: true, sessionId });
  };

  const handleLine = (line) => {
    if (!line || !line.trim()) return;
    lastActivity = Date.now();
    lineCount++;
    // 打出每行的原始类型（assistant/result/system/user 等），看清 agent 在跑工具还是在回话
    let rawType = '?';
    try { rawType = JSON.parse(line).type || '?'; } catch { /* 非 JSON 行忽略 */ }

    const chunk = parseStreamChunk(line);
    if (!chunk) {
      log(`  · 输出 type=${rawType}（非文本，可能在调用工具）`);
      return;
    }
    // resume 失效时 CLI 仍会吐一个带旧 session_id 的 result 行；忽略它，交给 close 触发重试，
    // 否则旧的失效 id 会被存回、下次继续 resume，形成永久死循环。
    if (chunk.done && resumeFailed && !retried) {
      log(`  · 忽略失效 session 的 result 行，准备重试`);
      return;
    }
    if (chunk.sessionId) sessionId = chunk.sessionId; // 记下本次会话 id 供下次 --resume
    if (chunk.type === 'text') {
      textLen += chunk.text.length;
      log(`  💬 文本 +${chunk.text.length} 字`);
    }
    if (chunk.done) finish();
    else onChunk(chunk);
  };

  const launch = (resumeId) => {
    const activeProvider = getConfig('activeProvider') || 'claude';
    let bin, args;

    if (activeProvider === 'codex') {
      bin = '/Applications/Codex.app/Contents/Resources/codex';
      args = [
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox'
      ];
      if (agentConfig.workDir) {
        args.push('--cd', agentConfig.workDir);
      }
      const codexModelVal = agentConfig.codexModel || agentConfig.model;
      if (codexModelVal) {
        const m = String(codexModelVal).toLowerCase();
        if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-')) {
          args.push('--model', codexModelVal);
        }
      }
      if (agentConfig.systemPrompt) {
        args.push('-c', `developer_instructions=${JSON.stringify(agentConfig.systemPrompt)}`);
      }
      if (resumeId) {
        args.push('resume', resumeId, message);
      } else {
        args.push(message);
      }
    } else {
      bin = process.env.CLAUDE_BIN || 'claude';
      args = buildClaudeArgs(agentConfig);
      if (resumeId) args.push('--resume', resumeId);
      args.push('-p', message);
    }

    log(`▶ 启动 ${activeProvider}  cwd=${agentConfig.workDir}  resume=${resumeId || '无'}  msg="${String(message).slice(0, 60).replace(/\n/g, ' ')}..."`);

    const apiKey = getConfig('apiKey');
    const spawnEnv = { ...process.env };
    if (apiKey && activeProvider === 'claude') {
      spawnEnv.ANTHROPIC_API_KEY = apiKey;
    }

    const proc = spawn(bin, args, {
      cwd: agentConfig.workDir,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentProc = proc;
    log(`  pid=${proc.pid}`);

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 最后一行可能不完整
      for (const line of lines) handleLine(line);
    });

    proc.on('close', (code, signal) => {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
      // session 失效 → 丢弃失效 id，用全新会话重试一次
      if (resumeFailed && !retried) {
        retried = true;
        resumeFailed = false;
        sessionId = null;   // 关键：不要把失效的 id 存回去
        lineCount = 0;
        textLen = 0;
        log(`↻ session 失效（${resumeId}），丢弃并用全新会话重试`);
        launch(null);
        return;
      }
      if (!finished) log(`⚠ 进程退出但未收到 result 行  code=${code}  signal=${signal}`);
      finish();
    });

    proc.on('error', (err) => {
      clearInterval(heartbeat);
      log(`✖ 进程启动失败: ${err.message}`);
      onChunk({ type: 'error', text: `进程启动失败: ${err.message}`, done: false });
    });

    proc.stderr.on('data', (data) => {
      lastActivity = Date.now();
      const text = data.toString();
      // 探测 resume 失败：CLI 会输出 "No conversation found with session ID"
      if (/no conversation found/i.test(text)) {
        resumeFailed = true;
        log(`  ⚠ stderr: session 失效，将自动用全新会话重试`);
        return; // 不把这条当真错误推给前端（重试会处理）
      }
      log(`  ⚠ stderr: ${text.trim().slice(0, 200)}`);
      onChunk({ type: 'error', text, done: false });
    });
  };

  launch(agentConfig.resumeSessionId);

  return { proc: () => currentProc, kill: () => currentProc && currentProc.kill() };
}

module.exports = { buildClaudeArgs, parseStreamChunk, spawnAgent, logBus };
