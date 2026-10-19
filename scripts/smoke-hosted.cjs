const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { setTimeout: delay } = require('node:timers/promises');

async function verify(base, password, idleMs = 0) {
  const root = new URL(base);
  const authorization = 'Basic ' + Buffer.from('office:' + password).toString('base64');
  const anonymous = await fetch(root, { redirect: 'manual' });
  assert.equal(anonymous.status, 401, 'Anonymous access must be blocked');
  assert.match(anonymous.headers.get('www-authenticate') || '', /Basic/);
  const response = await fetch(root, { headers: { authorization } });
  assert.equal(response.status, 200, 'Authenticated application must load');
  assert.match(await response.text(), /src\/app\.js/);
  const health = await fetch(new URL('/healthz', root), { headers: { authorization } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const crossSite = await fetch(root, { headers: { authorization, origin: 'https://untrusted.example' } });
  assert.equal(crossSite.status, 403, 'Cross-site request must be blocked');
  const socketUrl = new URL(root);
  socketUrl.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
  async function deniedSocket(headers, expected) {
    await new Promise((resolve, reject) => {
      const client = new WebSocket(socketUrl, { headers, handshakeTimeout: 10000 });
      client.on('error', () => {});
      client.on('open', () => { client.close(); reject(new Error('Unauthorized socket opened')); });
      client.on('unexpected-response', (_req, res) => {
        res.resume(); client.terminate();
        try { assert.equal(res.statusCode, expected); resolve(); } catch (error) { reject(error); }
      });
      client.on('error', reject);
    });
  }
  await deniedSocket({}, 401);
  await deniedSocket({ authorization, origin: 'https://untrusted.example' }, 403);
  const origin = root.protocol === 'https:' ? root.origin : 'https://' + root.hostname;
  const client = new WebSocket(socketUrl, { headers: { authorization, origin }, handshakeTimeout: 10000 });
  let pings = 0;
  client.on('ping', () => { pings += 1; });
  try {
    const agents = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Agent list timeout')), 15000);
      client.once('error', error => { clearTimeout(timeout); reject(error); });
      client.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'agents_list') { clearTimeout(timeout); resolve(msg.agents); }
      });
    });
    assert.ok(agents.some(agent => agent.id === 'pm'), 'Real backend must supply the PM');
    if (idleMs) {
      await delay(idleMs);
      assert.equal(client.readyState, WebSocket.OPEN, 'Socket disconnected while idle');
      assert.ok(pings >= 2, 'Heartbeat frames must arrive through the proxy');
    }
  } finally { client.close(); }
  console.log('PASS: private HTTP access, real agent roster, authenticated WebSocket, cross-site blocking' + (idleMs ? ', idle heartbeat' : '') + '. No model task was submitted.');
}

module.exports = { verify };
if (require.main === module) {
  if (!process.env.OFFICE_TEST_PASSWORD) throw new Error('OFFICE_TEST_PASSWORD required');
  verify(process.env.OFFICE_TEST_URL || 'http://127.0.0.1:8080', process.env.OFFICE_TEST_PASSWORD)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
