const { createPublicServer } = require('../server/publicServer');
const { WebSocket } = require('ws');

let office, base, sockets;
async function connect() {
  const socket = new WebSocket(base.replace('http:', 'ws:'));
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
  office = createPublicServer({ demoDelay: 0, generateImpl: jest.fn(async ({ credentials, onText }) => {
    onText(`Real transport fixture for ${credentials.model}`); return { text: 'Test response', usage: { input: 4, output: 2 } };
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

test('Demo defaults to scripted PM handoffs with no provider calls', async () => {
  const a = await connect();
  await until(() => a.events.some(e => e.type === 'agents_list'));
  expect(a.events.find(e => e.type === 'hosted_state')).toMatchObject({ experience: 'demo', connected: false });
  a.send({ type: 'chat', agentId: 'pm', message: 'demo please' });
  await until(() => a.events.filter(e => e.type === 'chat_chunk' && e.agentId === 'pm' && e.done).length >= 2);
  expect(a.events.some(e => e.type === 'agent_move')).toBe(true);
  expect(a.events.filter(e => e.type === 'chat_chunk').map(e => e.text).join('')).toContain('Demo sample');
  expect(a.events.some(e => e.type === 'usage' && e.report)).toBe(false);
});

test('each visitor owns their API key, output and verification state', async () => {
  const a = await connect(), b = await connect();
  a.send({ type: 'set_experience', experience: 'live' });
  a.send({ type: 'connect_api', provider: 'openai', model: 'visitor-a-model', key: 'visitor-a-key-not-real' });
  await until(() => a.events.some(e => e.type === 'hosted_state' && e.connected));
  a.send({ type: 'chat', agentId: 'backend-dev', message: 'Hello' });
  await until(() => a.events.some(e => e.type === 'hosted_state' && e.verified));
  expect(a.events.find(e => e.type === 'usage' && e.report).report.office.total.billable).toBe(6);
  expect(b.events.some(e => e.connected || e.type === 'chat_chunk' || e.type === 'usage')).toBe(false);
  expect(JSON.stringify(a.events)).not.toContain('visitor-a-key-not-real');
  expect(a.events.some(e => e.type === 'chat_chunk' && e.text.includes('visitor-a-model'))).toBe(true);
  a.send({ type: 'disconnect_api' });
  await until(() => a.events.filter(e => e.type === 'hosted_state').at(-1).connected === false);
  a.send({ type: 'chat', agentId: 'backend-dev', message: 'Again' });
  await until(() => a.events.some(e => e.type === 'error' && e.message === 'Connect your own AI first.'));
});

test('legacy credential/filesystem messages cannot reach the public runtime', async () => {
  const a = await connect();
  for (const type of ['get_config', 'set_config', 'start_login', 'submit_login_code', 'compact']) a.send({ type, key: 'must-not-be-used' });
  a.send({ type: 'chat', agentId: 'pm', message: 'read this', attachments: [{ path: '/home/node/.env' }] });
  await until(() => a.events.filter(e => e.type === 'error').length === 6);
  expect(JSON.stringify(a.events)).not.toContain('must-not-be-used');
  expect(a.events.some(e => e.type === 'chat_chunk')).toBe(false);
});

test('browser cross-origin WebSocket handshakes are rejected', async () => {
  const socket = new WebSocket(base.replace('http:', 'ws:'), { origin: 'https://untrusted.example' });
  await new Promise((resolve, reject) => {
    socket.on('error', () => {});
    socket.on('open', () => { socket.terminate(); reject(new Error('Cross-site socket opened')); });
    socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); expect(res.statusCode).toBe(403); resolve(); });
  });
});
