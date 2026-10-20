const { createHostedCli } = require('./hostedCli');
const { createTask, defaultAgents, DEFAULT_AGENTS } = require('./officeTask');
const { refreshBrowserCredentials } = require('./browserAuth');

// Connection routing only. Visitor data belongs to a single active request.
// No login, chat history, roster or plan is retained for the next request.
function createSession(send, options = {}) {
  let task = null, running = null, closed = false, login = null;
  const exchanges = new Set();
  const accountFactory = options.accountFactory || createHostedCli;
  function closeLogin() {
    const current = login; login = null;
    if (current) current.account.close();
  }
  function reject(message) { send({ type: 'error', message }); }
  async function receive(msg) {
    if (closed || !msg || typeof msg !== 'object') return;
    if (['agent_auth', 'browser_tool_result'].includes(msg.type)) {
      if (task) task.receive(msg);
      if (msg.authentication) msg.authentication.accessToken = null;
      msg.authentication = null; return;
    }
    switch (msg.type) {
      case 'start_login': {
        if (task || !['claude', 'codex'].includes(msg.provider)) return reject('Finish the current task before signing in.');
        closeLogin();
        const provider = msg.provider, requestId = msg.requestId;
        const pending = { provider, account: null };
        const account = accountFactory(event => {
          if (login !== pending || closed) return;
          if (event.phase === 'waiting') send({ type: 'login_url', provider, url: event.url, manualCallback: event.manualCallback === true });
          if (event.phase === 'credentials') {
            send({ type: 'browser_credentials', provider, requestId, credentials: event.credentials });
            send({ type: 'login_close', provider, code: 0 }); closeLogin();
          } else if (['failed', 'expired', 'cancelled'].includes(event.phase)) {
            send({ type: 'login_close', provider, code: 1 }); closeLogin();
          }
        });
        pending.account = account; login = pending;
        try { await account.start(provider, { hostId: msg.hostId, clientId: msg.clientId, callbackPort: msg.callbackPort }); }
        catch { if (login === pending) { send({ type: 'login_close', provider, code: 1 }); closeLogin(); } }
        return;
      }
      case 'submit_login_code': {
        if (!login) { msg.code = null; send({ type: 'login_code_result', status: 'inactive' }); return; }
        const current = login;
        try { await current.account.submit(msg.code); send({ type: 'login_code_result', status: 'submitted' }); }
        catch { send({ type: 'login_code_result', status: 'inactive' }); }
        finally { msg.code = null; if (login === current) closeLogin(); }
        return;
      }
      case 'refresh_browser_auth': {
        if (!['claude', 'codex'].includes(msg.provider) || typeof msg.requestId !== 'string') { msg.credentials = null; return; }
        const controller = new AbortController(); exchanges.add(controller);
        let previous = msg.credentials; msg.credentials = null;
        try {
          const renewed = await refreshBrowserCredentials(msg.provider, previous, controller.signal);
          if (!closed) send({ type: 'browser_credentials', provider: msg.provider, requestId: msg.requestId, credentials: renewed });
        } catch (error) {
          if (!closed) send({ type: 'browser_auth_error', provider: msg.provider, requestId: msg.requestId,
            code: error.code === 'CONNECTION_FAILED' ? 'CONNECTION_FAILED' : 'AUTH_FAILED' });
        } finally { previous = null; exchanges.delete(controller); }
        return;
      }
      case 'logout':
        if (login?.provider === msg.provider) closeLogin();
        task?.cancel(); return;
      case 'cancel': task?.cancel(); return;
      case 'chat': case 'confirm_plan': case 'start_demo': case 'compact': {
        if (task || login) { msg.snapshot = null; msg.plan = null; return reject('Wait for the current request or cancel it first.'); }
        let current;
        try {
          current = createTask(send, msg, options); task = current;
          running = current.run();
          await running;
        } catch { reject('The request could not be completed. Check browser settings and retry.'); }
        finally {
          if (task === current) { task = null; running = null; }
          msg.snapshot = null; msg.message = null; msg.plan = null; msg.compactInput = null; msg.previousSummary = null;
          send({ type: 'task_state', busy: false });
        }
        return;
      }
      // Browser-only settings must never create a server-side visitor cache.
      case 'browser_auth_state': case 'get_auth_status': case 'agents_list':
      case 'set_agent_models': case 'add_agent': case 'delete_agent':
      case 'set_browser_project': case 'set_mode': case 'switch_provider':
      case 'set_experience': case 'set_office_name': case 'cancel_plan': return;
      default: reject('This operation is unavailable in the web version.');
    }
  }
  send({ type: 'office_bootstrap', agents: defaultAgents(), browserOwned: true });
  return { receive,
    async close() {
      closed = true; closeLogin(); task?.cancel();
      for (const controller of exchanges) controller.abort();
      exchanges.clear();
      if (running) await running.catch(() => {});
    },
  };
}
module.exports = { createSession, DEFAULT_AGENTS };
