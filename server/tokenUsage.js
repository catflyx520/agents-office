// server/tokenUsage.js
// 从 Claude Code 的本地会话记录 ~/.claude/projects/*/*.jsonl 聚合 token 用量。
// 这是 /status、ccusage 背后的同一份数据 —— 每条 assistant 消息都带 usage。
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { getAllSessionIds } = require('./sessionStore');

// 两个来源：标准 claude CLI（~/.claude，含 Virtual Office 的 agent）+ iTerm 版 Claude Code（~/.claude_iterm，含你跟它在终端的对话）
const ROOTS = [
  { dir: path.join(os.homedir(), '.claude', 'projects'), source: 'CLI' },
  { dir: path.join(os.homedir(), '.claude_iterm', 'projects'), source: '终端' },
];

function listTranscripts(roots = ROOTS) {
  const out = [];
  for (const { dir, source } of roots) {
    let projects = [];
    try { projects = fs.readdirSync(dir); } catch { continue; }
    for (const p of projects) {
      const pdir = path.join(dir, p);
      let files = [];
      try { files = fs.readdirSync(pdir); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) out.push({ project: p, file: path.join(pdir, f), source });
    }
  }
  return out;
}

function normalizeModelName(m) {
  if (!m) return 'Sonnet';
  const l = m.toLowerCase();
  if (l.includes('sonnet')) return 'Sonnet';
  if (l.includes('opus')) return 'Opus';
  if (l.includes('haiku')) return 'Haiku';
  if (l.includes('synthetic')) return 'Sonnet';
  return m;
}

// 累加一个 usage 对象到 bucket
function addUsage(bucket, u, modelName = 'Sonnet', ts = 0) {
  if (!u) return;
  bucket.input += u.input_tokens || 0;
  bucket.output += u.output_tokens || 0;
  bucket.cacheCreate += u.cache_creation_input_tokens || 0;
  bucket.cacheRead += u.cache_read_input_tokens || 0;

  if (ts) {
    if (ts < bucket.minTs) bucket.minTs = ts;
    if (ts > bucket.maxTs) bucket.maxTs = ts;
  }

  if (modelName) {
    bucket.models = bucket.models || {};
    const mb = (bucket.models[modelName] = bucket.models[modelName] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, billable: 0 });
    mb.input += u.input_tokens || 0;
    mb.output += u.output_tokens || 0;
    mb.cacheCreate += u.cache_creation_input_tokens || 0;
    mb.cacheRead += u.cache_read_input_tokens || 0;
    mb.billable = mb.input + mb.output + mb.cacheCreate;
  }
}
function newBucket() { return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, msgs: 0, models: {}, minTs: Infinity, maxTs: -Infinity }; }
function billable(b) { return b.input + b.output + b.cacheCreate; } // cache_read 极廉价，单列不计入"计费量"

// 聚合：返回 { byDate, byProject, total }，可选 sinceMs 只统计该时间之后
async function aggregate({ sinceMs = 0 } = {}) {
  const byDate = {}, byProject = {}, bySource = {}, total = newBucket();
  for (const { project, file, source } of listTranscripts()) {
    // 只统计 sinceMs 之后的记录时，可直接跳过更早修改的文件（不可能含更新数据）
    if (sinceMs) { try { if (fs.statSync(file).mtimeMs < sinceMs) continue; } catch { /* ignore */ } }
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const u = obj?.message?.usage || obj?.usage;
      if (!u) continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      if (sinceMs && ts && ts < sinceMs) continue;
      const date = obj.timestamp ? obj.timestamp.slice(0, 10) : 'unknown';
      const modelRaw = obj?.message?.model;
      const modelName = normalizeModelName(modelRaw);
      (byDate[date] = byDate[date] || newBucket());
      (byProject[project] = byProject[project] || newBucket());
      (bySource[source] = bySource[source] || newBucket());
      addUsage(byDate[date], u, modelName, ts); byDate[date].msgs++;
      addUsage(byProject[project], u, modelName, ts); byProject[project].msgs++;
      addUsage(bySource[source], u, modelName, ts); bySource[source].msgs++;
      addUsage(total, u, modelName, ts); total.msgs++;
    }
  }
  return { byDate, byProject, bySource, total };
}

// 今天（本地）的用量摘要 —— 给定时任务/日志台用
async function todaySummary() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const { byDate, byProject, bySource } = await aggregate({ sinceMs: start });
  const today = Object.values(byDate).reduce((a, b) => {
    addUsage(a, { input_tokens: b.input, output_tokens: b.output, cache_creation_input_tokens: b.cacheCreate, cache_read_input_tokens: b.cacheRead }, null);
    if (b.minTs && b.minTs < a.minTs) a.minTs = b.minTs;
    if (b.maxTs && b.maxTs > a.maxTs) a.maxTs = b.maxTs;
    if (b.models) {
      for (const [model, mb] of Object.entries(b.models)) {
        a.models[model] = a.models[model] || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, billable: 0 };
        a.models[model].input += mb.input;
        a.models[model].output += mb.output;
        a.models[model].cacheCreate += mb.cacheCreate;
        a.models[model].cacheRead += mb.cacheRead;
        a.models[model].billable += mb.billable;
      }
    }
    a.msgs += b.msgs;
    return a;
  }, newBucket());
  return { today, byProject, bySource };
}

const fmt = (n) => n.toLocaleString('en-US');

function formatSummary({ today, byProject, bySource }) {
  const lines = [];
  lines.push(`今日 token：计费 ${fmt(billable(today))}（输入 ${fmt(today.input)} / 输出 ${fmt(today.output)} / 缓存写 ${fmt(today.cacheCreate)}）· 缓存读 ${fmt(today.cacheRead)} · ${today.msgs} 条消息`);
  if (bySource && Object.keys(bySource).length) {
    const parts = Object.entries(bySource).sort((a, b) => billable(b[1]) - billable(a[1])).map(([s, b]) => `${s} ${fmt(billable(b))}`).join(' · ');
    lines.push(`  来源：${parts}`);
  }
  const top = Object.entries(byProject).sort((a, b) => billable(b[1]) - billable(a[1])).slice(0, 6);
  for (const [proj, b] of top) {
    const name = proj.replace(/^-Users-[^-]+-/, '').replace(/-/g, '/');
    lines.push(`  · ${name}: 计费 ${fmt(billable(b))}（输出 ${fmt(b.output)}）`);
  }
  return lines.join('\n');
}

// 完整报表（供墙上用量牌 + 明细面板）。按 session id 归属，而不是按目录：
//   办公室 = 只统计 VO agent 真正创建的会话（来自 sessionStore），按 agent 拆分；不管它落在哪个 config 目录。
//   iTerm  = 你在终端 Claude Code（~/.claude_iterm）的会话，扣掉上面那些 agent 会话；按项目目录拆分。
//   ~/.claude 里跟 agent 无关的项目（lifecountdown/api 等）完全忽略。
async function report() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dow = (now.getDay() + 6) % 7;             // 0=周一
  const weekStart = todayStart - dow * 86400000;  // 本周一 00:00

  // session id -> agentId（VO agent 用过的所有会话）
  const sidToAgent = {};
  for (const [agentId, ids] of Object.entries(getAllSessionIds())) for (const sid of ids) sidToAgent[sid] = agentId;

  const office = { total: newBucket(), today: newBucket(), week: newBucket(), groups: {} };
  const officeSessions = { total: newBucket(), today: newBucket(), week: newBucket(), groups: {} };
  const iterm = { total: newBucket(), today: newBucket(), week: newBucket(), groups: {} };
  const ensure = (g, key) => (g.groups[key] = g.groups[key] || { total: newBucket(), today: newBucket(), week: newBucket() });
  const bump = (g, key, u, ts, modelName) => {
    const sub = ensure(g, key);
    addUsage(g.total, u, modelName, ts); g.total.msgs++; addUsage(sub.total, u, modelName, ts); sub.total.msgs++;
    if (ts >= todayStart) { addUsage(g.today, u, modelName, ts); g.today.msgs++; addUsage(sub.today, u, modelName, ts); sub.today.msgs++; }
    if (ts >= weekStart) { addUsage(g.week, u, modelName, ts); g.week.msgs++; addUsage(sub.week, u, modelName, ts); sub.week.msgs++; }
  };

  for (const { project, file, source } of listTranscripts()) {
    const sid = path.basename(file, '.jsonl');
    const agentId = sidToAgent[sid];
    const isTerminalRoot = source === '终端'; // ~/.claude_iterm
    // 不属于 agent、又不在终端目录（即 ~/.claude 的无关项目）→ 直接跳过，连文件都不读
    if (!agentId && !isTerminalRoot) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const u = obj?.message?.usage || obj?.usage;
      if (!u) continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
      const modelRaw = obj?.message?.model;
      const modelName = normalizeModelName(modelRaw);
      if (agentId) {
        bump(office, agentId, u, ts, modelName);   // 办公室：按 agent
        bump(officeSessions, `${agentId}::${sid}`, u, ts, modelName); // 办公室：按会话
      }
      else bump(iterm, project, u, ts, modelName);            // iTerm：按项目目录
    }
  }

  const ser = (b) => ({
    input: b.input,
    output: b.output,
    cacheCreate: b.cacheCreate,
    cacheRead: b.cacheRead,
    msgs: b.msgs,
    billable: billable(b),
    models: b.models || {},
    minTs: b.minTs === Infinity ? 0 : b.minTs,
    maxTs: b.maxTs === -Infinity ? 0 : b.maxTs
  });
  const serGroup = (g) => ({
    total: ser(g.total), today: ser(g.today), week: ser(g.week),
    items: Object.entries(g.groups)
      .map(([key, b]) => ({ key, total: ser(b.total), today: ser(b.today), week: ser(b.week) }))
      .sort((a, b) => b.total.billable - a.total.billable),
  });
  return { generatedAt: Date.now(), todayStart, weekStart, office: serGroup(office), officeSessions: serGroup(officeSessions), iterm: serGroup(iterm) };
}

module.exports = { aggregate, todaySummary, formatSummary, billable, listTranscripts, report };

// 直接运行：打印办公室(按 agent) + iTerm(按项目) 的今日/本周/累计
if (require.main === module) {
  (async () => {
    const r = await report();
    const show = (g) => {
      console.log(`  今日 ${fmt(g.today.billable)} · 本周 ${fmt(g.week.billable)} · 累计 ${fmt(g.total.billable)}`);
      g.items.slice(0, 8).forEach((it, i) => console.log(`    ${i + 1}. ${it.key}  累计 ${fmt(it.total.billable)}（今日 ${fmt(it.today.billable)}）`));
    };
    console.log('=== 🏢 办公室（按 agent，仅 VO agent 的会话）==='); show(r.office);
    console.log('\n=== 💻 iTerm（终端 Claude Code，按项目）==='); show(r.iterm);
  })();
}
