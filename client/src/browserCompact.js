import { getLanguage } from './i18n.js';

const KEY = 'vo_office_compact_v1';
const HISTORY = 'vo_office_history';
const LIMIT = 15000;
const text = (zh, en) => getLanguage() === 'zh' ? zh : en;
const eligible = message => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'
  && !message.contextControl && !message.isPlan && !message.isDemoTranscript;

export function setupBrowserCompact(office) {
  const originalSend = office.ws.send.bind(office.ws);
  let saved = { agents: {}, log: [] }, current = null, flight = null, live = false, requestBusy = false;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (value?.agents && typeof value.agents === 'object' && !Array.isArray(value.agents) && Array.isArray(value.log)) {
      saved = { agents: value.agents, log: value.log.filter(entry => entry && typeof entry.agentId === 'string'
        && Number.isSafeInteger(entry.gen) && Number.isFinite(entry.ts) && typeof entry.newSid === 'string'
        && (entry.oldSid == null || typeof entry.oldSid === 'string') && typeof entry.summary === 'string') };
    }
  } catch { /* Existing chat is never discarded because compact metadata is invalid. */ }
  const emit = (type, detail) => office.ws.dispatchEvent(Object.assign(new Event(type), { detail: { type, ...detail } }));
  const trace = (stage, extra = {}) => console.log('[Office Compact]', { stage, storageKey: KEY, backendStorage: 'request-only', ...extra });
  function context(agentId, source) {
    let entries = source.filter(eligible);
    const memory = Object.hasOwn(saved.agents, agentId) ? saved.agents[agentId] : null;
    const cutoff = typeof memory?.cutoffId === 'string' ? entries.findIndex(message => message.id === memory.cutoffId) : -1;
    const fresh = entries.findLastIndex(message => message.role === 'user' && message.fresh);
    if (cutoff >= 0 && fresh <= cutoff && typeof memory.summary === 'string' && memory.summary.length <= 8000) {
      return { summary: memory.summary, entries: entries.slice(cutoff + 1), generation: Number.isSafeInteger(memory.gen) && memory.gen >= 0 ? memory.gen : 0 };
    }
    if (fresh >= 0) entries = entries.slice(fresh);
    return { summary: '', entries, generation: 0 };
  }
  function render() {
    const button = document.getElementById('og-compact-btn');
    const entries = office.histories[office.activeId] || [];
    button.style.display = live && entries.some(eligible) ? 'block' : 'none';
    button.disabled = !!current || requestBusy;
    button.style.opacity = button.disabled ? '.55' : '';
    button.title = current ? text('正在压缩浏览器聊天记录…', 'Compacting browser chat history…')
      : text('从 localStorage 读取聊天并生成摘要；完整记录保留在你的浏览器。', 'Summarize chat from localStorage; complete messages remain in your browser.');
  }
  function chunks(entries) {
    const output = [];
    let pending = '';
    for (const entry of entries) {
      let part = `${entry.role}: ${entry.text}\n\n`;
      while (part.length) {
        let take = Math.min(LIMIT - pending.length, part.length);
        const last = part.charCodeAt(take - 1);
        if (take < part.length && last >= 0xd800 && last <= 0xdbff) take -= 1;
        if (!take) { output.push(pending); pending = ''; continue; }
        pending += part.slice(0, take); part = part.slice(take);
        if (pending.length >= LIMIT - 1) { output.push(pending); pending = ''; }
      }
    }
    if (pending) output.push(pending);
    return output;
  }
  function batch(run, input, summary, index) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      flight = { id, agentId: run.agentId, resolve, reject, summary: null, failure: null };
      const sent = originalSend({ type: 'compact', agentId: run.agentId, compactId: id,
        compactInput: input, previousSummary: summary, language: getLanguage() });
      if (!sent) { flight = null; reject(new Error(text('连接不可用，未开始压缩。', 'Connection unavailable; compaction did not start.'))); return; }
      emit('log', { ts: Date.now(), agent: office._name(run.agentId), agentId: run.agentId,
        text: text(`🗜️ Compact ${index + 1}/${run.chunks.length}：从浏览器发送此段聊天，摘要返回后仅保存在浏览器。`,
          `🗜️ Compact ${index + 1}/${run.chunks.length}: sending this browser-owned segment; summaries are saved only in the browser.`) });
      trace('segment_sent', { agentId: run.agentId, index: index + 1, segments: run.chunks.length });
    });
  }
  async function start(agentId) {
    if (!live || !office.byId[agentId]) return;
    if (current || requestBusy) { office._toast(text('请先等待当前任务完成。', 'Wait for the current task to finish.')); return; }
    office.browserState.saveHistory();
    let all;
    try { all = JSON.parse(localStorage.getItem(HISTORY) || '{}')[agentId] || []; }
    catch { office._toast(text('无法读取 localStorage，未开始压缩。', 'Could not read localStorage; compaction did not start.')); return; }
    if (!Array.isArray(all)) return;
    const source = context(agentId, all), pieces = chunks(source.entries);
    if (!pieces.length) { office._toast(text('没有需要压缩的新聊天记录。', 'There are no new messages to compact.')); return; }
    if (!window.confirm(text(
      `把 ${office._name(agentId)} 的聊天压缩成摘要？\n模型：${office.modelPicker.describe(office.byId[agentId])}\n预计 AI 调用：${pieces.length} 次，使用你自己的账号额度。\n完整聊天仍保留在 localStorage，后续对话使用摘要及新增消息。`,
      `Compact ${office._name(agentId)}'s chat into a summary?\nModel: ${office.modelPicker.describe(office.byId[agentId])}\nAI calls: ${pieces.length}, using your own account.\nComplete chat stays in localStorage; future replies use the summary and new messages.`))) return;
    const run = { agentId, chunks: pieces, cancelled: false, oldSid: office.byId[agentId].sessionId,
      cutoffId: source.entries.at(-1).id, gen: source.generation + 1,
      billableBefore: office._sessionUsage(agentId, office.byId[agentId].sessionId)?.total?.billable ?? null };
    current = run; render();
    emit('compact_status', { agentId, stage: 'summarizing' });
    try {
      let summary = source.summary;
      for (let index = 0; index < pieces.length; index++) {
        if (run.cancelled) return;
        summary = await batch(run, pieces[index], summary, index);
      }
      if (run.cancelled) return;
      const newSid = crypto.randomUUID();
      const entry = { agentId, oldSid: run.oldSid, newSid, gen: run.gen, ts: Date.now(), summary,
        auto: false, billableBefore: run.billableBefore };
      const next = { agents: { ...saved.agents, [agentId]: { summary, cutoffId: run.cutoffId, gen: run.gen, newSid } }, log: [...saved.log, entry] };
      // Commit only after every segment succeeds. Failed/cancelled work preserves
      // the prior summary and the complete original chat.
      localStorage.setItem(KEY, JSON.stringify(next)); saved = next;
      emit('compact_status', { agentId, stage: 'seeding' });
      emit('compact_log', { log: saved.log });
      emit('compact_status', { agentId, stage: 'done', newSessionId: newSid, summary });
      trace('summary_saved', { agentId, segments: pieces.length, summaryCharacters: summary.length });
    } catch (error) {
      if (!run.cancelled) emit('compact_status', { agentId, stage: 'error', message: text('压缩未完成或无法保存，原聊天和原摘要保留。',
        'Compaction could not finish or save. Original messages and the previous summary are preserved.') + ` ${error.message}` });
    } finally {
      if (current === run) current = null;
      render();
    }
  }
  function cancel() {
    if (!current) return;
    const run = current; run.cancelled = true; current = null;
    if (flight) { flight.reject(new Error('CANCELLED')); flight = null; }
    emit('compact_status', { agentId: run.agentId, stage: 'error', message: text('已取消，原聊天和原摘要保留。', 'Cancelled. Original messages and the previous summary are preserved.') });
    render();
  }
  office.ws.send = message => {
    if (message.type === 'compact') { void start(message.agentId); return true; }
    if (current && ['cancel', 'logout', 'set_experience', 'start_login'].includes(message.type)) {
      cancel(); if (message.type !== 'cancel') originalSend({ type: 'cancel' });
    }
    return originalSend(message);
  };
  office.ws.addEventListener('compact_result', event => {
    if (!flight || event.detail.compactId !== flight.id || event.detail.agentId !== flight.agentId) return;
    const summary = event.detail.summary;
    if (typeof summary === 'string' && summary.trim() && summary.length <= 8000) flight.summary = summary;
    else flight.failure = new Error(text('模型未返回有效摘要。', 'The model did not return a valid summary.'));
  });
  office.ws.addEventListener('error', event => { if (flight) flight.failure = new Error(event.detail.message); });
  office.ws.addEventListener('task_state', event => {
    if (event.detail.busy || !flight) return;
    const done = flight; flight = null;
    if (done.failure || !done.summary) done.reject(done.failure || new Error(text('压缩请求没有返回摘要。', 'No compact summary was returned.')));
    else done.resolve(done.summary);
  });
  office.ws.addEventListener('hosted_state', event => {
    live = event.detail.experience === 'live'; requestBusy = !!event.detail.busy; render();
    emit('compact_log', { log: saved.log });
  });
  office.ws.addEventListener('disconnected', () => { cancel(); requestBusy = false; render(); });
  window.addEventListener('office-language', render);
  return { context, render, start, get busy() { return !!current; } };
}
