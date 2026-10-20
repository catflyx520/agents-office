import { getLanguage } from './i18n.js';

const PREFIX = 'vo_ai_auth_v1:';
const PROVIDERS = ['claude', 'codex'];
const secret = value => typeof value === 'string' && value.length >= 16 && value.length <= 24000 && !/[\s\x00-\x1f]/.test(value);
const text = (zh, en) => getLanguage() === 'zh' ? zh : en;

export function setupBrowserAuth(office) {
  const originalSend = office.ws.send.bind(office.ws);
  const attempts = new Map(), pending = new Map();
  let enabled = false, experience = 'demo', taskEpoch = 0;
  const attemptKey = provider => `vo_ai_auth_pending_v1:${provider}`;
  for (const provider of PROVIDERS) {
    try {
      const requestId = sessionStorage.getItem(attemptKey(provider));
      if (/^[0-9a-f-]{36}$/i.test(requestId || '')) attempts.set(provider, requestId);
    } catch { /* Completed credentials still use localStorage, without a server fallback. */ }
  }
  function trace(stage, provider, metadata = {}) {
    // Never pass a token, credentials object, OAuth URL/code or request body here.
    console.log('[Office Auth]', { stage, provider, origin: location.origin, ...metadata, token: '[REDACTED]' });
  }
  function read(provider, traced = false) {
    if (!PROVIDERS.includes(provider)) return null;
    let value;
    try { value = JSON.parse(localStorage.getItem(PREFIX + provider) || 'null'); }
    catch { trace('storage_read_failed', provider); return null; }
    if (!value || !secret(value.accessToken) || !Number.isFinite(value.expiresAt)) return null;
    if (traced) trace('storage_read', provider, { tokenPresent: true, expiresAt: new Date(value.expiresAt).toISOString() });
    return value;
  }
  function remove(provider, reason) {
    attempts.delete(provider);
    try { sessionStorage.removeItem(attemptKey(provider)); } catch { /* No token is in this temporary marker. */ }
    try { localStorage.removeItem(PREFIX + provider); trace('storage_cleared', provider, { reason }); }
    catch { trace('storage_clear_failed', provider); throw new Error('STORAGE_FAILED'); }
  }
  function sync(extra = {}) {
    if (!enabled) return;
    const providers = Object.fromEntries(PROVIDERS.map(provider => {
      const value = read(provider);
      return [provider, { present: !!value, expiresAt: value?.expiresAt ?? null }];
    }));
    originalSend({ type: 'browser_auth_state', providers, ...extra });
  }
  function save(provider, value) {
    if (!secret(value?.accessToken) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('INVALID_CREDENTIALS');
    const record = { accessToken: value.accessToken, refreshToken: secret(value.refreshToken) ? value.refreshToken : null,
      idToken: secret(value.idToken) ? value.idToken : null, expiresAt: value.expiresAt,
      clientId: value.clientId, hostId: value.hostId || null, subject: value.subject || null,
      scope: typeof value.scope === 'string' ? value.scope : '', revision: crypto.randomUUID() };
    try { localStorage.setItem(PREFIX + provider, JSON.stringify(record)); }
    catch { trace('storage_save_failed', provider); throw new Error('STORAGE_FAILED'); }
    trace('storage_saved', provider, { storageKey: PREFIX + provider, expiresAt: new Date(record.expiresAt).toISOString(), hasRefreshToken: !!record.refreshToken });
    sync();
    return record;
  }
  function notifyError(error, agentId) {
    const storage = error.message === 'STORAGE_FAILED';
    office.ws.dispatchEvent(Object.assign(new Event('error'), { detail: { agentId,
      message: storage
        ? text('无法写入浏览器 localStorage，未保存登录。请允许此网站使用本地存储后重试。', 'Could not save sign-in to localStorage. Allow this site to use local storage and try again.')
        : text('凭证不可用、已过期或连接中断，请在「模型与登录」重新连接。', 'Credentials are unavailable, expired, or disconnected. Reconnect in Models & sign-in.') } }));
  }
  async function currentToken(provider) {
    const get = async () => {
      const stored = read(provider, true);
      if (!stored) throw new Error('AUTH_FAILED');
      if (stored.expiresAt > Date.now() + 60000) return stored;
      if (!stored.refreshToken) throw new Error('AUTH_FAILED');
      const requestId = crypto.randomUUID();
      trace('refresh_requested', provider, { requestId });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CONNECTION_FAILED')); }, 50000);
        pending.set(requestId, { provider, revision: stored.revision, resolve, reject, timer });
        if (!originalSend({ type: 'refresh_browser_auth', provider, requestId, credentials: {
          refreshToken: stored.refreshToken, clientId: stored.clientId, hostId: stored.hostId, subject: stored.subject, scope: stored.scope,
        } })) { clearTimeout(timer); pending.delete(requestId); reject(new Error('CONNECTION_FAILED')); }
      });
    };
    // Serialize rotating refresh tokens across tabs when the browser supports Web Locks.
    return navigator.locks ? navigator.locks.request(`office-auth-refresh:${provider}`, get) : get();
  }
  office.ws.send = message => {
    if (!enabled) return originalSend(message);
    if (['logout', 'cancel', 'set_experience', 'start_login'].includes(message.type)) taskEpoch += 1;
    if (message.type === 'start_login' && PROVIDERS.includes(message.provider)) {
      try {
        const previous = read(message.provider);
        remove(message.provider, 'reauthorization');
        const requestId = crypto.randomUUID(); attempts.set(message.provider, requestId);
        try { sessionStorage.setItem(attemptKey(message.provider), requestId); } catch { trace('pending_login_marker_not_saved', message.provider); }
        let hostId = localStorage.getItem('vo_ai_auth_host_v1');
        if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId || '')) {
          hostId = `urn:uuid:${crypto.randomUUID()}`; localStorage.setItem('vo_ai_auth_host_v1', hostId);
        }
        trace('authorization_requested', message.provider, { requestId });
        // Codex accepts a loopback callback. On hosted pages, the form also accepts
        // the full callback URL if no Agents Office server is running on that device.
        return originalSend({ ...message, requestId, hostId, clientId: previous?.hostId === hostId ? previous.clientId : null,
          callbackPort: Number(location.port) || 3000 });
      } catch (error) { notifyError(error); office.ws.dispatchEvent(Object.assign(new Event('login_close'), { detail: { code: 1 } })); return false; }
    }
    if (message.type === 'logout') {
      try { remove(message.provider, 'sign_out'); sync(); } catch (error) { notifyError(error); }
    }
    if (experience === 'live' && ['chat', 'confirm_plan', 'compact'].includes(message.type)) {
      if (office.ws.ws.readyState !== WebSocket.OPEN) return false;
      if (!office.modelPicker?.ready()) {
        office.ws.dispatchEvent(Object.assign(new Event('error'), { detail: { agentId: message.agentId || office.activeId,
          message: text('模型设置尚未恢复完成，请稍后再发送；列表加载失败时请刷新页面。', 'Model choices are not ready. Retry shortly; refresh if the list failed to load.') } }));
        return false;
      }
      // Each AI call requests its own teammate's credential just before execution.
      return originalSend({ ...message, requestId: crypto.randomUUID() });
    }
    return originalSend(message);
  };
  office.ws.addEventListener('request_agent_auth', event => {
    const { requestId, agentId, provider, modelId } = event.detail;
    if (!enabled || experience !== 'live' || !PROVIDERS.includes(provider) || !/^[0-9a-f-]{36}$/i.test(requestId || '')) return;
    const selected = office.byId[agentId] && office.modelPicker?.resolve(office.byId[agentId]), epoch = taskEpoch;
    if (!selected || selected.provider !== provider || selected.modelId !== modelId) {
      originalSend({ type: 'agent_auth', requestId, agentId, code: 'MODEL_SELECTION_CHANGED' }); return;
    }
    void (async () => {
      try {
        const credentials = await currentToken(provider);
        if (epoch !== taskEpoch) { originalSend({ type: 'agent_auth', requestId, agentId, code: 'CANCELLED' }); return; }
        trace('task_token_sent', provider, { requestId, agentId, modelId: modelId || '(account default)',
          expiresAt: new Date(credentials.expiresAt).toISOString(), serverUse: 'current-call-only' });
        originalSend({ type: 'agent_auth', requestId, agentId, authentication: { provider,
          accessToken: credentials.accessToken, expiresAt: credentials.expiresAt, revision: credentials.revision } });
      } catch (error) {
        trace('task_not_sent', provider, { requestId, agentId, reason: 'AUTH_OR_CONNECTION_FAILED' });
        originalSend({ type: 'agent_auth', requestId, agentId, code: error.message === 'CONNECTION_FAILED' ? 'CONNECTION_FAILED' : 'NOT_CONNECTED' });
      }
    })();
  });
  office.ws.addEventListener('browser_credentials', event => {
    const { provider, requestId, credentials } = event.detail;
    const refresh = pending.get(requestId);
    if (!PROVIDERS.includes(provider) || !refresh && attempts.get(provider) !== requestId) return;
    if (refresh) { clearTimeout(refresh.timer); pending.delete(requestId); }
    try {
      if (refresh && read(provider)?.revision !== refresh.revision) {
        trace('stale_refresh_discarded', provider, { requestId });
        const latest = read(provider);
        if (latest && latest.expiresAt > Date.now()) refresh.resolve(latest); else refresh.reject(new Error('AUTH_FAILED'));
        return;
      }
      const record = save(provider, credentials);
      if (refresh) refresh.resolve(record);
      else {
        attempts.delete(provider);
        try { sessionStorage.removeItem(attemptKey(provider)); } catch { /* No token is in the marker. */ }
        sync({ completedProvider: provider, requestId });
      }
    } catch (error) {
      if (refresh) refresh.reject(error);
      else { attempts.delete(provider); originalSend({ type: 'logout', provider }); office.ws.dispatchEvent(Object.assign(new Event('login_close'), { detail: { code: 1 } })); }
      notifyError(error);
    } finally {
      // Do not leave credentials on an event object that another UI component retains.
      event.detail.credentials = null;
    }
  });
  office.ws.addEventListener('browser_auth_error', event => {
    const item = pending.get(event.detail.requestId);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(event.detail.requestId);
    if (event.detail.code === 'AUTH_FAILED' && read(item.provider)?.revision === item.revision) {
      try { remove(item.provider, 'refresh_rejected'); sync(); } catch { /* Error is reported below. */ }
    }
    trace('refresh_failed', item.provider, { requestId: event.detail.requestId, code: event.detail.code });
    item.reject(new Error(event.detail.code));
  });
  office.ws.addEventListener('browser_auth_invalid', event => {
    const { provider, revision } = event.detail;
    const current = read(provider);
    if (!current || current.revision !== revision) return;
    try {
      if (current.refreshToken) {
        localStorage.setItem(PREFIX + provider, JSON.stringify({ ...current, expiresAt: 0 }));
        trace('access_token_rejected_renewal_required', provider);
      } else remove(provider, 'provider_rejected_token');
      sync();
    } catch { notifyError(new Error('STORAGE_FAILED')); }
  });
  office.ws.addEventListener('auth_debug', event => {
    const { stage, provider, requestId, persistedOnServer, credentialFilePresent, runtimeDirectoryRemoved } = event.detail;
    trace(stage, provider, { requestId, persistedOnServer, credentialFilePresent, runtimeDirectoryRemoved });
  });
  office.ws.addEventListener('hosted_state', event => {
    const first = !enabled, changed = experience !== event.detail.experience;
    enabled = true; experience = event.detail.experience;
    if (first || changed) { trace('browser_auth_restored', null, { serverStoresTokens: false }); sync(); }
  });
  office.ws.addEventListener('login_url', event => {
    const input = document.getElementById('og-login-verification-code');
    input.placeholder = text('粘贴一次性授权码', 'Paste the one-time authorization code');
    if (!event.detail.manualCallback) return;
    document.getElementById('og-login-status').textContent = text(
      '请在新标签页完成授权。若最后跳转到 127.0.0.1 无法打开，复制地址栏完整 URL，粘贴到下方提交。',
      'Authorize in a new tab. If the final 127.0.0.1 page cannot open, copy its complete address and submit it below.');
    input.placeholder = text('粘贴完整授权回调 URL', 'Paste the complete authorization callback URL');
  });
  office.ws.addEventListener('login_close', event => {
    const provider = event.detail.provider;
    if (!PROVIDERS.includes(provider)) return;
    attempts.delete(provider);
    try { sessionStorage.removeItem(attemptKey(provider)); } catch { /* Marker contains no credential. */ }
    trace(event.detail.code === 0 ? 'sign_in_completed' : 'sign_in_failed', provider);
  });
  office.ws.addEventListener('login_resumed', event => {
    const { provider, requestId } = event.detail;
    if (attempts.get(provider) === requestId) trace('authorization_resumed_after_refresh', provider, { requestId });
  });
  office.ws.addEventListener('disconnected', () => {
    taskEpoch += 1;
    attempts.clear();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CONNECTION_FAILED')); }
    pending.clear();
    trace('connection_closed_tokens_retained_in_browser', null);
  });
  const originalRender = office._renderAuthState.bind(office);
  office._renderAuthState = (provider, state) => {
    if (!enabled) return originalRender(provider, state);
    const value = read(provider);
    originalRender(provider, value ? 'signed_in' : state === 'invalid' ? 'invalid' : 'missing');
    const status = document.getElementById(`og-status-${provider}`);
    if (value && status) {
      status.textContent = value.expiresAt > Date.now()
        ? text('🟢 凭证已保存在此浏览器', '🟢 Credentials saved in this browser')
        : text('🟠 此浏览器凭证已到期，使用前将尝试续期', '🟠 Saved credentials expired; renewal will be attempted before use');
      status.title = text('Token 保存在 localStorage；AI 请求时临时发送给后端，模型权限在实际调用时验证。',
        'Tokens are saved in localStorage and sent to the backend for each task. Model access is verified by an actual request.');
    }
  };
  window.addEventListener('storage', event => {
    if (!event.key || event.key.startsWith(PREFIX)) { taskEpoch += 1; trace('storage_changed_in_another_tab', null); sync(); }
  });
  return { sync, status(provider) {
    const value = read(provider);
    return { present: !!value, expired: !!value && value.expiresAt <= Date.now() };
  } };
}
