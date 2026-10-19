const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { createSession } = require('./hostedSession');

function createPublicServer(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.headers.origin && ![`https://${req.headers.host}`, `http://${req.headers.host}`].includes(req.headers.origin)) {
      res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return;
    }
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', access: 'public', uploads: false, defaultMode: 'demo' }));
  // Reject before reading/parsing request bodies. Neither mode writes uploads.
  app.all('/upload', (req, res) => {
    res.set('Connection', 'close').status(410).json({ code: 'UPLOADS_DISABLED',
      error: 'Uploads are disabled to reduce running costs.' });
  });
  app.use(express.static(path.join(__dirname, '../client'), { etag: false, lastModified: false }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768, perMessageDeflate: false });
  const sessions = new Set();
  let activeCalls = 0;
  const { generate } = require('./providerApi');
  async function limitedGenerate(args) {
    if (activeCalls >= 8) throw Object.assign(new Error('BUSY'), { code: 'BUSY' });
    activeCalls += 1;
    try { return await (options.generateImpl || generate)(args); } finally { activeCalls -= 1; }
  }
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host;
    const allowed = [`https://${host}`, `http://${host}`];
    // A browser always supplies Origin; CLI/test clients may omit it.
    if (req.url !== '/' || (req.headers.origin && !allowed.includes(req.headers.origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (sessions.size >= 64) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    socket.alive = true;
    let lastActivity = Date.now(), windowStart = Date.now(), count = 0;
    const send = event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    const session = createSession(send, { generateImpl: limitedGenerate, demoDelay: options.demoDelay });
    sessions.add(session);
    socket.on('pong', () => { socket.alive = true; });
    socket.on('message', raw => {
      lastActivity = Date.now();
      if (lastActivity - windowStart > 60000) { windowStart = lastActivity; count = 0; }
      if (++count > 60) { send({ type: 'error', message: 'Too many messages. Please wait a minute.' }); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { send({ type: 'error', message: 'Invalid message.' }); return; }
      Promise.resolve(session.receive(message)).catch(() => send({ type: 'error', message: 'The request could not be completed.' }));
    });
    const timer = setInterval(() => {
      if (!socket.alive || Date.now() - lastActivity > 15 * 60000) { socket.terminate(); return; }
      socket.alive = false; socket.ping();
    }, 25000);
    timer.unref();
    socket.on('close', () => { clearInterval(timer); session.close(); sessions.delete(session); });
    socket.on('error', () => {});
  });
  return { app, server, wss, close: () => { for (const socket of wss.clients) socket.terminate(); wss.close(); return new Promise(resolve => server.close(resolve)); } };
}
if (require.main === module) {
  const { server } = createPublicServer();
  server.listen(process.env.PORT || 3000, () => console.log('Agents Office: public Demo + visitor API modes; uploads disabled.'));
}
module.exports = { createPublicServer };
