import { getLanguage } from './i18n.js';

// One immutable record per reported call avoids read/modify/write races between tabs.
// Only usage metadata is stored here, never prompts, files or account credentials.
const STORAGE_PREFIX = 'vo_token_usage_v1:';
const FIELDS = ['input', 'output', 'cacheCreate', 'cacheRead'];
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(value);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const counts = value => Object.fromEntries(FIELDS.map(key => [key, tokenCount(value?.[key])]));
function modelLabel(name) {
  // Match the model-family labels used by the original local usage report.
  const lower = name.toLowerCase();
  for (const family of ['Sonnet', 'Opus', 'Haiku']) if (lower.includes(family.toLowerCase())) return family;
  return name;
}

function normalizeRecord(value) {
  if (!value || !safeId(value.id) || !safeId(value.agentId) || !safeId(value.sessionId)
    || !['anthropic', 'openai'].includes(value.provider) || !Number.isSafeInteger(value.ts) || value.ts <= 0) return null;
  const usage = counts(value);
  if (FIELDS.every(key => usage[key] === null)) return null;
  const models = Object.create(null);
  for (const [name, usage] of Object.entries(value.models || {}).slice(0, 20)) {
    if (safeModel(name)) models[name] = counts(usage);
  }
  return { id: value.id, ts: value.ts, agentId: value.agentId, sessionId: value.sessionId,
    provider: value.provider, model: safeModel(value.model) ? value.model : null, ...usage, models };
}

function newBucket() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, billable: 0, msgs: 0,
    models: Object.create(null), missing: {}, minTs: 0, maxTs: 0 };
}

function addCounts(bucket, usage) {
  for (const key of FIELDS) {
    if (usage[key] === null) bucket.missing[key] = true;
    else bucket[key] += usage[key];
  }
  // Preserve the original token-count convention; this is not a dollar estimate.
  bucket.billable = bucket.input + bucket.output + bucket.cacheCreate;
}

export function buildUsageReport(records, now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const monday = new Date(today); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const todayStart = today.getTime(), weekStart = monday.getTime();
  const newPeriods = () => ({ total: newBucket(), today: newBucket(), week: newBucket() });
  const office = { ...newPeriods(), groups: new Map() };
  const sessions = { ...newPeriods(), groups: new Map() };
  const add = (bucket, record) => {
    addCounts(bucket, record); bucket.msgs += 1;
    bucket.minTs = bucket.minTs ? Math.min(bucket.minTs, record.ts) : record.ts;
    bucket.maxTs = Math.max(bucket.maxTs, record.ts);
    const unknown = record.provider === 'openai' ? 'Codex (model not reported)' : 'Claude (model not reported)';
    const models = Object.keys(record.models).length ? record.models : { [record.model || unknown]: record };
    for (const [model, usage] of Object.entries(models)) {
      const modelBucket = bucket.models[modelLabel(model)] ||= newBucket();
      addCounts(modelBucket, usage);
    }
  };
  const bump = (group, key, record) => {
    if (!group.groups.has(key)) group.groups.set(key, newPeriods());
    const member = group.groups.get(key);
    for (const period of ['total', ...(record.ts >= todayStart ? ['today'] : []), ...(record.ts >= weekStart ? ['week'] : [])]) {
      add(group[period], record); add(member[period], record);
    }
  };
  for (const record of records) {
    bump(office, record.agentId, record);
    bump(sessions, `${record.agentId}::${record.sessionId}`, record);
  }
  const serialize = group => ({ total: group.total, today: group.today, week: group.week,
    items: [...group.groups].map(([key, periods]) => ({ key, ...periods })).sort((a, b) => b.total.billable - a.total.billable) });
  return { generatedAt: now, source: 'browser-local', todayStart, weekStart,
    office: serialize(office), officeSessions: serialize(sessions), iterm: { ...newPeriods(), items: [] } };
}

export function setupBrowserUsage(office) {
  const $ = id => document.getElementById(id);
  const text = (zh, en) => getLanguage() === 'zh' ? zh : en;
  let enabled = false, storageFailed = false, warned = false;
  let records = new Map();
  const unsaved = new Map();
  const originalOnUsage = office._onUsage.bind(office);
  const originalRenderUsage = office._renderUsage.bind(office);
  const originalOpenUsage = office._openUsage.bind(office);

  function load() {
    try {
      const loaded = new Map();
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(STORAGE_PREFIX)) continue;
        try {
          const record = normalizeRecord(JSON.parse(localStorage.getItem(key)));
          if (record && key === STORAGE_PREFIX + record.id) loaded.set(record.id, record);
        } catch { /* Ignore malformed records without replacing the user's history. */ }
      }
      records = new Map([...loaded, ...unsaved]);
      storageFailed = unsaved.size > 0;
    } catch { storageFailed = true; }
  }
  function refresh() {
    if (!enabled) return;
    originalOnUsage(buildUsageReport(records.values()));
  }
  function warnIfNeeded() {
    if (!storageFailed || warned) return;
    warned = true;
    office._toast(text('无法保存用量到 localStorage。本页仍显示用量，未保存的记录刷新后可能丢失。',
      'Could not save usage to localStorage. Unsaved records may be lost after refresh.'));
  }

  // The original renderer remains in charge of cards, tabs, rankings and sessions.
  // A legacy server report must never replace this visitor's browser-only history.
  office._onUsage = report => { if (!enabled) originalOnUsage(report); };
  office._renderUsage = () => {
    originalRenderUsage();
    if (!enabled) return;
    const notes = [text('用量保存在此浏览器的 localStorage；仅统计已收到的真实用量，Demo 不增加用量。',
      'Usage is stored in this browser’s localStorage. Only received usage is counted; Demo adds no tokens.')];
    notes.push(text('统计口径：纯输入 + 缓存写 + 输出；缓存读单列，不是美元费用。未返回字段显示 —，累计只汇总已报告值。',
      'Count: uncached input + cache creation + output; cache reads are separate. These are not dollar costs. Unreported fields show —; totals sum reported values only.'));
    if (storageFailed) notes.push(text('localStorage 保存失败：未保存的记录刷新后可能丢失。',
      'localStorage save failed: unsaved records may be lost after refresh.'));
    const updated = new Date(office.usage.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('og-usage-foot').textContent = `${notes.join(' ')} · ${updated}`;
  };
  office._openUsage = source => { refresh(); originalOpenUsage(source); };
  office.ws.addEventListener('hosted_state', () => {
    if (!enabled) { enabled = true; load(); }
    refresh(); warnIfNeeded();
  });
  office.ws.addEventListener('token_usage', event => {
    if (!enabled) return;
    const record = normalizeRecord(event.detail.record);
    if (!record || records.has(record.id)) return;
    records.set(record.id, record);
    try { localStorage.setItem(STORAGE_PREFIX + record.id, JSON.stringify(record)); }
    catch { unsaved.set(record.id, record); storageFailed = true; }
    refresh(); warnIfNeeded();
  });
  window.addEventListener('storage', event => {
    if (event.key !== null && !event.key.startsWith(STORAGE_PREFIX)) return;
    load(); refresh();
  });
  window.addEventListener('focus', () => { if (enabled) { load(); refresh(); } });
  // Recompute date boundaries even when no AI calls arrive overnight.
  setInterval(refresh, 60000);
}
