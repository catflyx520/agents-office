// server/sessionStore.js
// 持久化 agentId -> claude 会话 id，让 --resume 跨服务器重启也能续接。
// 同时记录每个 agent 用过的「所有」session id（不只最新），供 token 用量按 agent 精确归属。
// 存储格式：{ agentId: { current: "<最新 sid>", all: ["<sid>", ...] } }
// 兼容旧格式 { agentId: "<sid>" }。
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_FILE = path.join(os.homedir(), '.virtual-office', 'sessions.json');

function readAll(file = DEFAULT_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {}; // 文件不存在或损坏都当成空
  }
}

// 把一条记录（可能是旧的字符串、或新的对象）归一化成 { current, all }
function normalize(entry) {
  if (!entry) return { current: null, all: [] };
  if (typeof entry === 'string') return { current: entry, all: [entry] };
  return { current: entry.current || null, all: Array.isArray(entry.all) ? entry.all.slice() : (entry.current ? [entry.current] : []) };
}

function getSession(agentId, file = DEFAULT_FILE) {
  return normalize(readAll(file)[agentId]).current;
}

function setSession(agentId, sessionId, file = DEFAULT_FILE) {
  if (!sessionId) return;
  const all = readAll(file);
  const entry = normalize(all[agentId]);
  if (!entry.all.includes(sessionId)) entry.all.push(sessionId);
  entry.current = sessionId;
  all[agentId] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
}

// 返回 { agentId: [sid, ...] }，供按 agent 归属 token 用量
function getAllSessionIds(file = DEFAULT_FILE) {
  const all = readAll(file);
  const out = {};
  for (const [agentId, entry] of Object.entries(all)) out[agentId] = normalize(entry).all;
  return out;
}

module.exports = { getSession, setSession, getAllSessionIds };
