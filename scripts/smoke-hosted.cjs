const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { setTimeout: delay } = require('node:timers/promises');

async function verify(base, idleMs = 0) {
  const root = new URL(base);
  const response = await fetch(root, { redirect: 'manual' });
  assert.equal(response.status, 200, 'Public office must load without a website password');
  assert.match(await response.text(), /src\/app\.js/);
  for (const asset of ['/src/app.js', '/src/hosted.js', '/src/browserState.js', '/data/models.json', '/hosted.css']) {
    const result = await fetch(new URL(asset, root)); assert.equal(result.status, 200, asset);
    await result.arrayBuffer();
  }
  const health = await fetch(new URL('/healthz', root));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', access: 'public', uploads: false, defaultMode: 'demo' });
  const origin = root.protocol === 'https:' ? root.origin : 'https://' + root.host;
  const upload = await fetch(new URL('/upload', root), { method: 'POST', headers: { origin }, body: 'fixture-not-stored' });
  assert.equal(upload.status, 410, 'Uploads must be disabled on the server');
  assert.equal((await upload.json()).code, 'UPLOADS_DISABLED');
  const crossSite = await fetch(root, { headers: { origin: 'https://untrusted.example' } });
  assert.equal(crossSite.status, 403, 'Cross-site request must be blocked');
  await crossSite.arrayBuffer();
  const socketUrl = new URL(root); socketUrl.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise((resolve, reject) => {
    const client = new WebSocket(socketUrl, { headers: { origin: 'https://untrusted.example' }, handshakeTimeout: 10000 });
    client.on('error', () => {});
    client.on('open', () => { client.terminate(); reject(new Error('Cross-site socket opened')); });
    client.on('unexpected-response', (_req, res) => { res.destroy(); client.terminate(); try { assert.equal(res.statusCode, 403); resolve(); } catch (error) { reject(error); } });
    client.on('error', reject);
  });
  const client = new WebSocket(socketUrl, { headers: { origin }, handshakeTimeout: 10000 });
  let pings = 0;
  const events = [];
  client.on('ping', () => { pings += 1; });
  client.on('message', raw => {
    const event = JSON.parse(raw); events.push(event);
    if (event.type === 'request_agent_auth') client.send(JSON.stringify({ type: 'agent_auth', requestId: event.requestId, agentId: event.agentId, code: 'NOT_CONNECTED' }));
  });
  client.on('error', () => {});
  async function until(check) {
    for (let i = 0; i < 300; i++) { if (check()) return; if (client.readyState > 1) throw new Error('Socket closed'); await delay(100); }
    throw new Error('Office event timeout');
  }
  try {
    await until(() => events.some(e => e.type === 'office_bootstrap'));
    const bootstrap = events.find(e => e.type === 'office_bootstrap');
    assert.equal(bootstrap.browserOwned, true);
    assert.ok(bootstrap.agents.some(agent => agent.id === 'pm'));
    const snapshot = experience => ({ experience, controlMode: 'auto', agents: bootstrap.agents, histories: {} });
    client.send(JSON.stringify({ type: 'start_demo', language: 'en', snapshot: snapshot('demo') }));
    const demoState = () => events.filter(e => e.type === 'demo_state').at(-1);
    await until(() => demoState()?.phase === 'complete' && !demoState().busy);
    assert.equal(events.filter(e => e.type === 'demo_user_message').length, 8);
    assert.equal(events.some(e => e.type === 'plan_preview'), false);
    assert.equal(events.filter(e => e.type === 'demo_transcript').length, 12);
    assert.equal(demoState().completedAgents.length, 3);
    assert.ok(events.some(e => e.type === 'agent_move'));
    assert.match(events.filter(e => e.type === 'chat_chunk').map(e => e.text).join(''), /Demo sample/);
    await until(() => events.at(-1)?.type === 'task_state' && !events.at(-1).busy);
    client.send(JSON.stringify({ type: 'chat', agentId: 'backend-dev', message: 'Not signed in.', language: 'en', snapshot: snapshot('live') }));
    await until(() => events.some(e => e.type === 'error' && e.message.includes('not connected')));
    await until(() => events.filter(e => e.type === 'request_released').length === 2);
    assert.equal(events.some(e => e.type === 'workspace_snapshot' || e.type === 'auth_status_result'), false);
    if (idleMs) {
      const before = pings; await delay(idleMs);
      assert.equal(client.readyState, WebSocket.OPEN); assert.ok(pings - before >= 2, 'Heartbeat must survive idle');
    }
  } finally { client.terminate(); }
  console.log('PASS: password-free HTTP, uploads disabled, scripted Demo, account sign-in required, WebSocket and cross-site rejection' + (idleMs ? ', 70-second idle heartbeat' : '') + '. No paid AI request was made.');
}
module.exports = { verify };
if (require.main === module) verify(process.env.OFFICE_TEST_URL || 'http://127.0.0.1:8080')
  .catch(error => { console.error(error.message); process.exitCode = 1; });
