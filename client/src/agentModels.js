import { getLanguage } from './i18n.js';

const KEY = 'vo_agent_models_v1';
const providers = ['claude', 'codex'];
const text = (zh, en) => getLanguage() === 'zh' ? zh : en;
const valid = value => value && providers.includes(value.provider) && typeof value.modelId === 'string'
  && (!value.modelId || /^[a-zA-Z0-9._:-]{1,100}$/.test(value.modelId));
const same = (a, b) => a?.provider === b?.provider && a?.modelId === b?.modelId;

export function setupAgentModels(office) {
  let catalog = null, enabled = false, busy = false, fallback = 'claude', draft = null;
  let restoring = false;
  const staged = new Map(), actual = new Map();
  function redrawTeam() {
    if (document.getElementById('og-team').style.display !== 'none') office._renderTeam();
  }
  let saved = {};
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      saved = Object.fromEntries(Object.entries(value).filter(([id, selection]) => /^[a-zA-Z0-9_-]{1,80}$/.test(id) && valid(selection)));
    }
  } catch { /* A malformed preference never replaces a server selection. */ }
  const select = document.getElementById('og-f-agent-model');
  const encode = choice => `${choice.provider}:${choice.modelId}`;
  const decode = value => { const at = value.indexOf(':'); return { provider: value.slice(0, at), modelId: value.slice(at + 1) }; };
  function resolve(agent) {
    if (enabled && providers.includes(agent?.modelProvider) && typeof agent.modelId === 'string') return { provider: agent.modelProvider, modelId: agent.modelId };
    return { provider: fallback, modelId: (fallback === 'codex' ? agent?.codexModel : agent?.model) || '' };
  }
  function supported(choice) {
    return valid(choice) && catalog?.providers.some(group => group.id === choice.provider
      && (!choice.modelId || group.models.some(model => model.id === choice.modelId || model.aliases?.includes(choice.modelId))));
  }
  function describe(agent) {
    const choice = resolve(agent), group = catalog?.providers.find(item => item.id === choice.provider);
    const model = group?.models.find(item => item.id === choice.modelId);
    const alias = group?.models.some(item => item.aliases?.includes(choice.modelId));
    const label = !choice.modelId ? text('账号默认', 'Account default') : model?.label || choice.modelId;
    return `${group?.label || (choice.provider === 'codex' ? 'GPT / Codex' : 'Claude')} · ${label}`
      + (alias ? text('（原有别名）', ' (saved alias)') : catalog && !supported(choice) ? text('（需重新选择）', ' (reselect required)') : '');
  }
  function renderHeader() {
    const element = document.getElementById('og-active-model'), agent = office.byId?.[office.activeId];
    if (!element) return;
    if (!agent) { element.textContent = ''; return; }
    const last = actual.get(agent.id);
    element.textContent = text('选择：', 'Selected: ') + describe(agent)
      + (last ? text(' · 上次返回：', ' · Last reported: ') + (last.actualModel || text('服务商未返回实际模型', 'Provider did not report a model')) : '');
  }
  function renderPicker(choice) {
    select.replaceChildren();
    select.disabled = !catalog;
    document.getElementById('og-f-model-label').textContent = text('模型（每位成员只选择一个）', 'Model (one per teammate)');
    document.getElementById('og-f-model-note').textContent = catalog
      ? text(`列表更新：${catalog.updatedAt}。使用所选服务商的浏览器凭证；列表不代表账号拥有模型权限。账号默认由官方 CLI 决定。`,
        `Updated ${catalog.updatedAt}. Uses this provider’s browser credentials; availability depends on your account. Account default is chosen by the official CLI.`)
      : text('模型列表未加载完成，请稍后重试。', 'The model list has not loaded. Please try again shortly.');
    if (!catalog) return;
    for (const group of catalog.providers) {
      // The separately launched legacy CLI server still has one global engine.
      if (!enabled && group.id !== fallback) continue;
      const options = document.createElement('optgroup'); options.label = group.label;
      for (const model of [{ id: '', label: text('账号默认', 'Account default') }, ...group.models]) {
        const option = document.createElement('option'); option.value = encode({ provider: group.id, modelId: model.id });
        option.textContent = `${group.label} · ${model.label}`; options.append(option);
      }
      select.append(options);
    }
    const value = encode(choice);
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = `${choice.provider === 'codex' ? 'GPT / Codex' : 'Claude'} · ${choice.modelId}`
        + (supported(choice) ? text('（原有别名，保持原值）', ' (saved alias, unchanged)') : text('（旧选项，请重新选择）', ' (old option, please reselect)'));
      option.disabled = !supported(choice); select.append(option);
    }
    select.value = value;
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(saved)); }
    catch { office._toast(text('模型选择未能保存到 localStorage，刷新后可能丢失。', 'Could not save model choices to localStorage; they may be lost after refresh.')); }
  }
  function sync() {
    if (!enabled || !catalog || busy || restoring || !office.agents?.length) return;
    const changes = [];
    for (const agent of office.agents) {
      const current = resolve(agent), pending = staged.get(agent.id);
      if (pending && same(current, pending)) { saved[agent.id] = pending; staged.delete(agent.id); persist(); }
      const target = saved[agent.id] || current;
      if (!staged.has(agent.id) && (!same(current, target) || agent.modelProvider !== target.provider || agent.modelId !== target.modelId)) {
        changes.push({ agentId: agent.id, modelProvider: target.provider, modelId: target.modelId });
      } else if (!saved[agent.id] && !pending) { saved[agent.id] = current; persist(); }
    }
    if (changes.length) {
      restoring = true;
      if (!office.ws.send({ type: 'set_agent_models', choices: changes })) restoring = false;
    }
  }
  office.ws.addEventListener('agents_list', () => {
    restoring = false; sync(); renderHeader();
    redrawTeam();
  });
  office.ws.addEventListener('agent_models_result', event => {
    restoring = false;
    if (!event.detail.success) office._toast(text('模型选择未恢复，请等任务结束后重试。', 'Model choices were not restored. Retry after the task finishes.'));
  });
  office.ws.addEventListener('agent_save_result', event => {
    if (!event.detail.success) { staged.delete(event.detail.agentId); sync(); }
  });
  office.ws.addEventListener('hosted_state', event => { enabled = true; busy = !!event.detail.busy; sync(); renderHeader(); });
  office.ws.addEventListener('auth_status_result', event => {
    if (providers.includes(event.detail.activeProvider)) fallback = event.detail.activeProvider;
    if (!enabled) {
      document.getElementById('og-provider-description').textContent = text('本地旧版使用全局服务商，在此管理本机 CLI 登录。', 'The legacy local server uses one global provider. Manage local CLI sign-in here.');
      document.getElementById('og-provider-default-label').textContent = text('首选模型服务商（本地旧版）：', 'Active provider (legacy local server):');
    }
    sync(); renderHeader();
  });
  office.ws.addEventListener('agent_model', event => {
    const { stage, agentId, provider, requestedModel, actualModel, requestId } = event.detail;
    console.log('[Office Models]', { stage, agentId, provider, requestedModel: requestedModel || '(account default)', actualModel: actualModel || null, requestId });
    if (stage === 'reported') actual.set(agentId, { provider, actualModel });
    renderHeader();
  });
  office.ws.addEventListener('disconnected', () => { restoring = false; staged.clear(); });
  window.addEventListener('office-language', () => {
    renderHeader();
    if (document.getElementById('og-edit').style.display !== 'none' && office.editingId !== '__self') renderPicker(select.disabled ? draft || resolve(null) : decode(select.value));
  });
  fetch(new URL('../data/models.json', import.meta.url), { cache: 'no-store' }).then(response => {
    if (!response.ok) throw new Error('CATALOG_UNAVAILABLE'); return response.json();
  }).then(value => {
    catalog = value; sync(); renderHeader(); redrawTeam();
    if (document.getElementById('og-edit').style.display !== 'none' && office.editingId !== '__self') renderPicker(draft || resolve(null));
  }).catch(() => { document.getElementById('og-f-model-note').textContent = text('模型列表加载失败，请刷新页面。', 'Model list failed to load. Refresh the page.'); });
  return { resolve, describe, renderHeader,
    ready() { return !!catalog && !restoring && !staged.size && office.agents.every(agent => {
      const current = resolve(agent);
      return agent.modelProvider === current.provider && agent.modelId === current.modelId && (!saved[agent.id] || same(current, saved[agent.id]));
    }); },
    open(agent) { draft = resolve(agent); renderPicker(draft); },
    selection() {
      const choice = select.disabled ? null : decode(select.value);
      if (!supported(choice)) { office._toast(text('请选择有效模型，或等待模型列表加载完成。', 'Select a current model, or wait for the list to load.')); return null; }
      return { modelProvider: choice.provider, modelId: choice.modelId };
    },
    stage(agentId, choice) { staged.set(agentId, { provider: choice.modelProvider, modelId: choice.modelId }); },
  };
}
