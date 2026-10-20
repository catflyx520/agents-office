import { getLanguage } from './i18n.js';

const SETTINGS = 'vo_office_settings_v1';
const HISTORY = 'vo_office_history';
const DEMO_HISTORY = 'vo_office_demo_history_v1';
const PLAN = 'vo_office_plan_v1';
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
const text = (zh, en) => getLanguage() === 'zh' ? zh : en;

// The browser owns all durable visitor state. Settings messages are handled here;
// only active AI/Demo requests and OAuth exchanges reach the backend.
export function setupBrowserState(office) {
  const networkSend = office.ws.send.bind(office.ws);
  let enabled = false, busy = false, settings = null, defaults = [], streamTimer = null, nextExperience = null;
  let storageWarning = false;
  const emit = (type, detail = {}) => queueMicrotask(() => office.ws.dispatchEvent(Object.assign(new Event(type), { detail: { type, ...detail } })));
  const trace = (stage, extra = {}) => console.log('[Office Storage]', { stage, origin: location.origin, backendStorage: 'request-only', ...extra });
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
    catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch {
      if (!storageWarning) office._toast(text('无法写入 localStorage：本页未保存的数据刷新后可能丢失，后端不会代为保存。',
        'Could not write localStorage. Unsaved page data may be lost after refresh; the backend will not save a copy.'));
      storageWarning = true; return false;
    }
  }
  function drop(key) {
    try { localStorage.removeItem(key); } catch { if (!storageWarning) office._toast(text('无法更新浏览器本地存储。', 'Could not update browser storage.')); storageWarning = true; }
  }
  function historyKey() { return settings?.experience === 'demo' ? DEMO_HISTORY : HISTORY; }
  function historyFrom(key) {
    const value = read(key, {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, messages]) => safeId(id) && Array.isArray(messages))
      .map(([id, messages]) => [id, messages.filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')]));
  }
  function saveSettings() {
    if (!enabled) return;
    settings.controlMode = office.mode;
    write(SETTINGS, settings);
  }
  function saveHistory() {
    if (!enabled) return;
    clearTimeout(streamTimer); streamTimer = null;
    for (const messages of Object.values(office.histories)) for (const message of messages) {
      if (!/^[0-9a-f-]{36}$/i.test(message.id || '')) message.id = crypto.randomUUID();
    }
    write(historyKey(), office.histories);
    saveSettings();
  }
  function pendingPlan() {
    const value = read(PLAN, null);
    return value && value.plan && Array.isArray(value.plan.tasks) ? value : null;
  }
  function clearPlan() {
    drop(PLAN);
    for (const messages of Object.values(office.histories)) for (const message of messages) message.isPlan = false;
    saveHistory();
  }
  function roster() {
    settings.agents = settings.agents.map(agent => ({ ...agent, systemPrompt: agent.systemPromptMode === 'default'
      ? agent.defaultSystemPrompts?.[getLanguage()] ?? agent.systemPrompt : agent.systemPrompt }));
    emit('agents_list', { agents: settings.agents });
  }
  function state() {
    emit('hosted_state', { experience: settings.experience, reset: false, busy, workspace: false,
      browserWorkspace: true, browserOwned: true, backendRetainsUserData: false });
  }
  function authStatus(providers = null) {
    const status = provider => {
      let present = providers?.[provider]?.present;
      if (present === undefined) present = office.browserAuth?.status(provider).present || false;
      return { loggedIn: !!present, state: present ? 'signed_in' : 'missing' };
    };
    emit('auth_status_result', { activeProvider: settings.activeProvider, claude: status('claude'), codex: status('codex') });
  }
  function fail(message, agentId) { emit('error', { message, agentId }); return false; }
  function snapshot(message) {
    // Flush first, then read the canonical history from the user's localStorage.
    saveHistory();
    const stored = storageWarning ? office.histories : historyFrom(historyKey());
    const summaries = {};
    const histories = Object.fromEntries(office.agents.filter(agent => message.type === 'chat' && agent.id === message.agentId && settings.experience === 'live').map(agent => {
      let entries = (stored[agent.id] || []).filter(item => !item.isPlan && !item.isDemoTranscript && !item.contextControl);
      const freshIndex = entries.findLastIndex(item => item.role === 'user' && item.fresh);
      if (freshIndex >= 0) entries = entries.slice(freshIndex);
      if (message.type === 'chat' && message.agentId === agent.id) {
        // _send() saved the current question already; answer() appends it once.
        const last = entries.at(-1);
        if (last?.role === 'user' && (last.text === message.message || last.text === `🆕 ${message.message}`)) entries = entries.slice(0, -1);
        if (message.fresh) entries = [];
      }
      if (!message.fresh && office.browserCompact) {
        const compact = office.browserCompact.context(agent.id, entries);
        entries = compact.entries;
        if (compact.summary) summaries[agent.id] = compact.summary;
      }
      return [agent.id, entries.slice(-8).map(item => ({ role: item.role, content: item.text.slice(0, 16000) }))];
    }));
    return { experience: settings.experience, activeProvider: settings.activeProvider, controlMode: office.mode,
      agents: office.agents.map(agent => ({ id: agent.id, name: agent.name, role: agent.role,
        systemPrompt: office._systemPromptFor(agent), systemPromptMode: agent.systemPromptMode,
        modelProvider: agent.modelProvider, modelId: agent.modelId, model: agent.model, codexModel: agent.codexModel,
        sessionId: agent.sessionId, workDir: agent.workDir, browserProject: agent.browserProject,
        browserProjectId: agent.browserProjectId, projectConnected: agent.projectConnected,
        projectWritable: agent.projectWritable, tools: agent.tools })), histories, summaries };
  }
  function saveAgent(config) {
    if (busy || office.browserCompact?.busy || !config || !safeId(config.id) || typeof config.name !== 'string' || !config.name.trim()
      || /[<>&]/.test(config.name) || /[<>&]/.test(String(config.role || ''))
      || (!office.byId[config.id] && office.agents.length >= 8)) {
      emit('agent_save_result', { success: false, agentId: config?.id });
      return fail(text('成员设置无效、当前任务未结束或已达到 8 人上限。', 'Invalid teammate settings, a task is running, or the 8-teammate limit was reached.'));
    }
    const template = defaults.find(agent => agent.id === config.id)?.defaultSystemPrompts;
    const defaultPrompt = template && config.systemPromptMode !== 'custom' && Object.values(template).some(prompt => prompt === String(config.systemPrompt || '').trim());
    const agent = { ...config, name: config.name.slice(0, 24), role: String(config.role || 'AI teammate').slice(0, 80),
      systemPrompt: String(config.systemPrompt || '').slice(0, 3000), sessionId: null,
      defaultSystemPrompts: template || null, systemPromptMode: defaultPrompt ? 'default' : 'custom',
      tools: [...new Set((config.tools || []).filter(tool => ['List', 'Read', 'Write', 'Edit'].includes(tool)))] };
    clearPlan();
    settings.agents = office.agents.filter(item => item.id !== agent.id).concat(agent);
    write(SETTINGS, settings); roster();
    emit('agent_save_result', { success: true, agentId: agent.id });
    return true;
  }
  office.ws.send = message => {
    if (!enabled) return networkSend(message);
    switch (message.type) {
      case 'get_auth_status': authStatus(); if (message.language) roster(); return true;
      case 'browser_auth_state': authStatus(message.providers); return true;
      case 'agents_list': roster(); return true;
      case 'switch_provider':
        if (busy || office.browserCompact?.busy || !['claude', 'codex'].includes(message.provider)) return false;
        settings.activeProvider = message.provider; saveSettings(); authStatus();
        emit('switch_provider_result', { success: true, provider: message.provider }); return true;
      case 'set_mode': settings.controlMode = message.mode === 'confirm' ? 'confirm' : 'auto'; write(SETTINGS, settings); return true;
      case 'set_office_name': settings.officeName = String(message.name || 'Agents Office').slice(0, 24); saveSettings(); emit('office_name', { name: settings.officeName }); return true;
      case 'add_agent': return saveAgent(message.config);
      case 'delete_agent':
        if (busy || office.browserCompact?.busy || message.agentId === 'pm') return false;
        clearPlan(); settings.agents = office.agents.filter(agent => agent.id !== message.agentId);
        write(SETTINGS, settings); roster(); return true;
      case 'set_agent_models': {
        if (busy || office.browserCompact?.busy || !Array.isArray(message.choices) || message.choices.length > 8) { emit('agent_models_result', { success: false }); return true; }
        for (const choice of message.choices) {
          const agent = settings.agents.find(item => item.id === choice.agentId);
          if (!agent || !['claude', 'codex'].includes(choice.modelProvider) || typeof choice.modelId !== 'string'
            || choice.modelId && !/^[a-zA-Z0-9._:-]{1,100}$/.test(choice.modelId)) { emit('agent_models_result', { success: false }); return true; }
        }
        if (message.choices.some(choice => {
          const current = office.modelPicker.resolve(settings.agents.find(agent => agent.id === choice.agentId));
          return current.provider !== choice.modelProvider || current.modelId !== choice.modelId;
        })) clearPlan();
        for (const choice of message.choices) {
          const agent = settings.agents.find(item => item.id === choice.agentId);
          if (agent.modelProvider !== choice.modelProvider || agent.modelId !== choice.modelId) agent.sessionId = null;
          agent.modelProvider = choice.modelProvider; agent.modelId = choice.modelId;
        }
        write(SETTINGS, settings); emit('agent_models_result', { success: true }); roster(); return true;
      }
      case 'set_browser_project': {
        const agent = settings.agents.find(item => item.id === message.agentId);
        if (!agent) return false;
        const changed = agent.browserProjectId !== message.projectId || agent.workDir !== message.name
          || agent.projectConnected !== !!message.connected || agent.projectWritable !== !!message.writable;
        if (!changed) return true;
        if (busy || office.browserCompact?.busy) office.ws.send({ type: 'cancel' });
        agent.workDir = String(message.name || '').slice(0, 128); agent.browserProjectId = message.projectId || '';
        agent.browserProject = !!agent.workDir && !!agent.browserProjectId;
        agent.projectConnected = agent.browserProject && message.connected === true;
        agent.projectWritable = agent.projectConnected && message.writable === true;
        write(SETTINGS, settings); roster(); return true;
      }
      case 'set_experience': {
        if (busy) {
          nextExperience = message.experience === 'live' ? 'live' : 'demo';
          networkSend({ type: 'cancel' }); return true;
        }
        saveHistory();
        settings.experience = message.experience === 'live' ? 'live' : 'demo'; write(SETTINGS, settings);
        office.histories = historyFrom(historyKey()); office.pending = {}; office.streamMsg = {}; office.attachments = [];
        office._renderPending(); office._renderChat(); state(); return true;
      }
      case 'cancel_plan': clearPlan(); return true;
      case 'logout':
        authStatus(); networkSend(message);
        emit('logout_result', { success: true, provider: message.provider }); return true;
      case 'start_login':
        if (busy) return fail(text('请先等待当前任务完成。', 'Wait for the current task to finish.'));
        return networkSend(message);
      case 'chat': case 'confirm_plan': case 'start_demo': case 'compact': {
        if (busy || message.type !== 'compact' && office.browserCompact?.busy) return fail(text('请等待当前任务完成，或先取消。', 'Wait for the current task or cancel it first.'), message.agentId);
        if (settings.experience === 'live' && message.type === 'chat' && pendingPlan()) return fail(text('请先确认或取消待执行计划。', 'Confirm or cancel the pending plan first.'), message.agentId);
        let plan = null;
        if (message.type === 'confirm_plan') {
          plan = pendingPlan()?.plan || message.plan;
          if (!plan) return fail(text('待执行计划不存在，请让 PM 重新规划。', 'No pending plan was found. Ask PM to plan again.'), message.agentId);
        }
        const payload = { ...message, language: getLanguage(), snapshot: snapshot(message), ...(plan ? { plan } : {}) };
        if (!networkSend(payload)) return false;
        busy = true;
        if (plan) clearPlan();
        state(); trace('request_context_sent', { storageKey: historyKey(), agentCount: office.agents.length });
        return true;
      }
      default: return networkSend(message);
    }
  };
  office.ws.addEventListener('office_bootstrap', event => {
    defaults = event.detail.agents;
    const saved = read(SETTINGS, null);
    settings = { experience: saved?.experience === 'live' ? 'live' : 'demo',
      activeProvider: saved?.activeProvider === 'codex' ? 'codex' : 'claude',
      controlMode: saved?.controlMode === 'confirm' ? 'confirm' : 'auto', officeName: saved?.officeName || 'Agents Office',
      agents: Array.isArray(saved?.agents) ? saved.agents.filter(agent => safeId(agent?.id) && typeof agent.name === 'string').slice(0, 8) : defaults.map(agent => ({ ...agent })) };
    if (!settings.agents.length || !settings.agents.some(agent => agent.id === 'pm')) settings.agents = defaults.map(agent => ({ ...agent }));
    for (const agent of settings.agents) {
      const template = defaults.find(item => item.id === agent.id)?.defaultSystemPrompts;
      if (template) agent.defaultSystemPrompts = template;
      // File permission is re-checked by browserFolders, never restored from a flag.
      agent.projectConnected = false; agent.projectWritable = false;
    }
    enabled = true; office.hosted = true;
    office.histories = historyFrom(historyKey()); office.mode = settings.controlMode; office._applyModeUI();
    state(); roster(); emit('office_name', { name: settings.officeName });
    office._renderChat(); trace('restored_from_localStorage', { historyKey: historyKey(), settingsKey: SETTINGS, pendingPlan: !!pendingPlan() });
  });
  office.ws.addEventListener('plan_preview', event => {
    if (!enabled || settings.experience !== 'live') return;
    write(PLAN, { agentId: event.detail.agentId || 'pm', plan: event.detail.plan });
    saveHistory();
  });
  office.ws.addEventListener('chat_chunk', event => {
    if (!enabled) return;
    if (event.detail.done) saveHistory();
    else if (!streamTimer) streamTimer = setTimeout(saveHistory, 250);
  });
  office.ws.addEventListener('task_state', event => {
    if (!enabled) return;
    busy = !!event.detail.busy;
    if (!busy && nextExperience) {
      const experience = nextExperience; nextExperience = null;
      office.ws.send({ type: 'set_experience', experience });
    } else state();
  });
  office.ws.addEventListener('request_released', event => {
    trace('backend_request_released', { userDataRetained: event.detail.userDataRetained, cleanupFailed: event.detail.cleanupFailed });
  });
  office.ws.addEventListener('disconnected', () => { if (enabled) { busy = false; saveHistory(); } });
  window.addEventListener('pagehide', saveHistory);
  return { saveHistory, get enabled() { return enabled; } };
}
