const { createSession } = require('../server/hostedSession');
const { defaultAgents } = require('../server/officeTask');
const snapshot = (extra = {}) => ({ experience: 'live', activeProvider: 'claude', controlMode: 'auto',
  agents: defaultAgents().map(agent => ({ ...agent, modelProvider: 'claude', modelId: '' })), histories: {}, ...extra });
const question = (message, extra = {}) => ({ type: 'chat', agentId: 'backend-dev', message, language: 'en', snapshot: snapshot(), ...extra });
function makeSession(send, options = {}) {
  let session;
  session = createSession(event => {
    send(event);
    if (event.type === 'request_agent_auth') queueMicrotask(() => session.receive({ type: 'agent_auth',
      requestId: event.requestId, agentId: event.agentId, ...(options.missingAuth ? { code: 'NOT_CONNECTED' } : { authentication: {
        provider: event.provider, accessToken: 'fixture-access-token-only', expiresAt: Date.now() + 600000,
      } }) }));
  }, { ...options, accountFactory: callback => ({
    start: jest.fn(async provider => callback({ phase: 'credentials', provider,
      credentials: { accessToken: 'fixture-login-token-only', expiresAt: Date.now() + 600000 } })),
    submit: jest.fn(), clear: jest.fn(), close: jest.fn(),
  }) });
  return session;
}

test('completed login returns credentials to the browser and cannot authorize a later call without a browser token', async () => {
  const events = [], generateImpl = jest.fn();
  const session = makeSession(event => events.push(event), { generateImpl, missingAuth: true });
  await session.receive({ type: 'start_login', provider: 'claude', requestId: 'fixture-login' });
  expect(events.some(event => event.type === 'browser_credentials')).toBe(true);
  await session.receive({ type: 'browser_auth_state', providers: { claude: { present: true, expiresAt: Date.now() + 600000 } } });
  await session.receive(question('hello'));
  expect(generateImpl).not.toHaveBeenCalled();
  expect(events.some(event => event.type === 'error' && event.message.includes('not connected'))).toBe(true);
  expect(events.some(event => ['auth_status_result', 'workspace_snapshot'].includes(event.type))).toBe(false);
  await session.close();
});

test('only the browser-supplied history reaches a call; a subsequent request receives no cached history', async () => {
  const received = [];
  const session = makeSession(() => {}, { generateImpl: async args => {
    received.push(args.messages.map(message => ({ ...message }))); args.onText('reply'); return { text: 'reply' };
  } });
  await session.receive(question('first', { snapshot: snapshot({ histories: { 'backend-dev': [{ role: 'user', content: 'browser context' }] } }) }));
  await session.receive(question('second'));
  expect(received[0].map(message => message.content)).toEqual(['browser context', 'first']);
  expect(received[1].map(message => message.content)).toEqual(['second']);
  await session.close();
});

test('PM confirmation sends its browser-owned plan and each teammate uses its selected provider', async () => {
  const events = [], requests = [];
  const responses = [JSON.stringify({ plan: 'Design a task app', tasks: [
    { agent: 'backend-dev', task: 'Draft an API', waitFor: null },
    { agent: 'frontend-dev', task: 'Draft the UI', waitFor: 'backend-dev' },
  ] }), 'API contract proposal', 'UI proposal using the API contract', 'Summary of proposed code'];
  const data = snapshot({ controlMode: 'confirm' });
  data.agents.find(agent => agent.id === 'frontend-dev').modelProvider = 'codex';
  const session = makeSession(event => events.push(event), { generateImpl: async args => {
    requests.push({ provider: args.credentials.cliProvider, messages: args.messages });
    const text = responses.shift(); args.onText(text); return { text, usage: { input: 3, output: 2 } };
  } });
  await session.receive(question('Design a task app', { agentId: 'pm', snapshot: data }));
  expect(requests).toHaveLength(1);
  const plan = events.find(event => event.type === 'plan_preview').plan;
  await session.receive({ type: 'confirm_plan', language: 'en', snapshot: snapshot() });
  expect(requests).toHaveLength(1);
  await session.receive({ type: 'confirm_plan', language: 'en', snapshot: data, plan });
  expect(requests.map(item => item.provider)).toEqual(['claude', 'claude', 'codex', 'claude']);
  expect(requests[2].messages.at(-1).content).toContain('API contract proposal');
  expect(requests[3].messages.at(-1).content).toContain('UI proposal');
  const usage = events.filter(event => event.type === 'token_usage').map(event => event.record);
  expect(usage).toHaveLength(4);
  expect(new Set(usage.map(record => record.id)).size).toBe(4);
  await session.close();
});

test('close aborts an active call and waits until its request data is released', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const events = [];
  const session = makeSession(event => events.push(event), { generateImpl: args => new Promise(resolve => {
    args.signal.addEventListener('abort', () => resolve({ text: 'cancelled' }), { once: true }); started(args.signal);
  }) });
  const running = session.receive(question('hello'));
  const signal = await ready;
  await session.close(); await running;
  expect(signal.aborted).toBe(true);
  expect(events.some(event => event.type === 'request_released' && event.userDataRetained === false)).toBe(true);
});

test('Compact returns a browser-owned summary without file tools or a retained summary for the next call', async () => {
  const events = [], calls = [];
  const session = makeSession(event => events.push(event), { generateImpl: async args => {
    calls.push({ workspace: args.workspace, messages: args.messages.map(message => ({ ...message })) });
    args.onText('compact fixture summary'); return { text: 'compact fixture summary' };
  } });
  const data = snapshot();
  Object.assign(data.agents.find(agent => agent.id === 'backend-dev'), {
    browserProject: true, browserProjectId: 'browser-folder', workDir: 'Visitor folder', projectConnected: false,
  });
  await session.receive({ type: 'compact', agentId: 'backend-dev', language: 'en', snapshot: data,
    compactId: '11111111-1111-4111-8111-111111111111', compactInput: 'user: Keep browser-owned data.', previousSummary: '' });
  expect(calls[0].workspace).toBeNull();
  expect(events.find(event => event.type === 'compact_result')).toMatchObject({ summary: 'compact fixture summary' });
  expect(events.some(event => event.type === 'chat_chunk' && event.text)).toBe(false);
  await session.receive(question('Continue', { snapshot: snapshot({ summaries: { 'backend-dev': 'Browser saved summary' } }) }));
  expect(calls[1].messages[0].content).toContain('Browser saved summary');
  await session.receive(question('Another question'));
  expect(calls[2].messages.map(message => message.content)).toEqual(['Another question']);
  await session.close();
});
