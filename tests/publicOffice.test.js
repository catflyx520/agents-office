const { createPublicServer } = require('../server/publicServer');
const { WebSocket } = require('ws');
const { defaultAgents } = require('../server/officeTask');
const snapshot = (experience = 'live') => ({ experience, controlMode: 'auto', agents: defaultAgents().map(agent => ({ ...agent, modelProvider: 'claude', modelId: '' })), histories: {} });

let office, base, sockets;
async function connect(path = '', options = {}) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + path, options);
  const events = [];
  socket.on('message', raw => events.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  sockets.push(socket);
  return { socket, events, send: message => socket.send(JSON.stringify(message)) };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for office events');
}
beforeEach(async () => {
  sockets = [];
  office = createPublicServer({ demoDelay: 0, accountFactory: callback => ({ start: async provider => callback({ phase: 'credentials', provider, credentials: { accessToken: 'fixture-login-token-only', expiresAt: Date.now() + 600000 } }), submit() {}, clear() {}, close() {} }), generateImpl: jest.fn(async ({ credentials, onText }) => {
    onText(`Real transport fixture for ${credentials.cliProvider}`); return { text: 'Test response', usage: { input: 4, output: 2 } };
  }) });
  await new Promise(resolve => office.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${office.server.address().port}`;
});
afterEach(async () => { for (const socket of sockets) socket.terminate(); await office.close(); });

test('public HTML and health load without password; upload is rejected before parsing bytes', async () => {
  expect((await fetch(base)).status).toBe(200);
  expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ access: 'public', uploads: false, defaultMode: 'demo' });
  const upload = await fetch(`${base}/upload?name=test.txt`, { method: 'POST', body: 'not saved' });
  expect(upload.status).toBe(410);
  expect(await upload.json()).toMatchObject({ code: 'UPLOADS_DISABLED' });
});

test('the dedicated WebSocket endpoint returns browser bootstrap with a matching Origin', async () => {
  const a = await connect('/ws', { origin: base });
  await until(() => a.events.some(event => event.type === 'office_bootstrap'));
  expect(a.events.find(event => event.type === 'office_bootstrap')).toMatchObject({ browserOwned: true });
});

test('shop Demo automatically plays discussion, sample approval, parallel work and final reports', async () => {
  const a = await connect();
  await until(() => a.events.some(e => e.type === 'office_bootstrap'));
  expect(a.events.find(e => e.type === 'office_bootstrap').browserOwned).toBe(true);
  a.send({ type: 'start_demo', language: 'en', snapshot: snapshot('demo') });
  const demoState = () => a.events.filter(e => e.type === 'demo_state').at(-1);
  await until(() => demoState()?.phase === 'complete' && !demoState().busy);
  const dialogue = a.events.filter(e => e.type === 'demo_user_message');
  expect(dialogue).toHaveLength(8);
  expect(dialogue.every(e => e.text.includes('Sample user'))).toBe(true);
  const approval = a.events.findIndex(e => e.type === 'demo_user_message' && e.text.includes('I approve these requirements'));
  expect(approval).toBeGreaterThan(-1);
  expect(a.events.findIndex(e => e.type === 'agent_move')).toBeGreaterThan(approval);
  expect(a.events.some(e => e.type === 'plan_preview')).toBe(false);
  expect(a.events.filter(e => e.type === 'demo_transcript')).toHaveLength(12);
  const memberIds = ['backend-dev', 'frontend-dev', 'app-dev'];
  const starts = memberIds.map(id => a.events.findIndex(e => e.type === 'agent_status' && e.agentId === id && e.status === 'working'));
  const finishes = memberIds.map(id => a.events.findIndex(e => e.type === 'agent_status' && e.agentId === id && e.status === 'done'));
  const finalSummary = a.events.findIndex(e => e.type === 'chat_chunk' && e.agentId === 'pm' && e.text.includes('Final shop delivery summary'));
  expect(Math.min(...starts)).toBeGreaterThan(-1);
  expect(Math.min(...finishes)).toBeGreaterThan(Math.max(...starts));
  expect(finalSummary).toBeGreaterThan(Math.max(...finishes));
  expect(demoState().completedAgents).toHaveLength(3);
  expect(a.events.filter(e => e.type === 'chat_chunk').map(e => e.text).join('')).toContain('Demo sample');
  expect(a.events.some(e => e.type === 'token_usage' || e.type === 'usage' && e.report)).toBe(false);
});

test('only the requesting visitor receives model output; account state is never cached on the server', async () => {
  const a = await connect(), b = await connect();
  let provideToken = true;
  a.socket.on('message', raw => {
    const event = JSON.parse(raw);
    if (event.type === 'request_agent_auth') a.send({ type: 'agent_auth', requestId: event.requestId, agentId: event.agentId,
      ...(provideToken ? { authentication: { provider: event.provider, accessToken: 'fixture-access-token-only', expiresAt: Date.now() + 600000 } } : { code: 'NOT_CONNECTED' }) });
  });
  a.send({ type: 'chat', agentId: 'backend-dev', message: 'Hello', language: 'en', snapshot: snapshot() });
  await until(() => a.events.some(event => event.type === 'request_released'));
  await until(() => a.events.at(-1)?.type === 'task_state' && !a.events.at(-1).busy);
  expect(a.events.find(event => event.type === 'token_usage').record).toMatchObject({ input: 4, output: 2 });
  expect(b.events.some(event => ['chat_chunk', 'token_usage', 'browser_credentials'].includes(event.type))).toBe(false);
  expect(a.events.some(event => event.type === 'chat_chunk' && event.text.includes('claude'))).toBe(true);
  provideToken = false;
  a.send({ type: 'chat', agentId: 'backend-dev', message: 'Again', language: 'en', snapshot: snapshot() });
  await until(() => a.events.some(event => event.type === 'error' && event.message.includes('not connected')));
  expect(a.events.some(event => ['workspace_snapshot', 'auth_status_result'].includes(event.type))).toBe(false);
});

test('removed API-key and filesystem messages are rejected', async () => {
  const a = await connect();
  for (const type of ['get_config', 'set_config', 'connect_api', 'disconnect_api']) a.send({ type, key: 'must-not-be-used' });
  a.send({ type: 'chat', agentId: 'pm', message: 'read this', language: 'en', snapshot: snapshot(), attachments: [{ path: '/home/node/.env' }] });
  await until(() => a.events.filter(e => e.type === 'error').length === 5);
  expect(JSON.stringify(a.events)).not.toContain('must-not-be-used');
  expect(a.events.some(e => e.type === 'chat_chunk')).toBe(false);
});

test.each(['/', '/ws'])('browser cross-origin WebSocket handshakes are rejected at %s', async endpoint => {
  const socket = new WebSocket(base.replace('http:', 'ws:') + endpoint, { origin: 'https://untrusted.example' });
  await new Promise((resolve, reject) => {
    socket.on('error', () => {});
    socket.on('open', () => { socket.terminate(); reject(new Error('Cross-site socket opened')); });
    socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); expect(res.statusCode).toBe(403); resolve(); });
  });
});
