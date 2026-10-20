const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { createSession } = require('./hostedSession');
const { oauthCallback } = require('./browserAuth');

function createPublicServer(options = {}) {
  const workspace = options.workspace === true;
  const sessionOptions = { generateImpl: options.generateImpl, demoDelay: options.demoDelay, accountFactory: options.accountFactory, workspace };
  const sessions = new Set();
  let closing = false;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.headers.origin && ![`https://${req.headers.host}`, `http://${req.headers.host}`].includes(req.headers.origin)) {
      res.status(403).json({ error: 'Cross-site requests are not allowed.' }); return;
    }
    next();
  });
  app.use((req, res, next) => {
    if (!workspace || req.method !== 'GET' || !['/', '/index.html'].includes(req.path)) return next();
    // Retire the old recovery cookie; no backend lookup uses it anymore.
    res.clearCookie(`office_workspace_${req.socket.localPort}`, { httpOnly: true, sameSite: 'strict', path: '/' });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', access: 'public', uploads: false, defaultMode: 'demo' }));
  app.get('/auth/callback', oauthCallback);
  // Reject before reading/parsing request bodies. Neither mode writes uploads.
  app.all('/upload', (req, res) => {
    res.set('Connection', 'close').status(410).json({ code: 'UPLOADS_DISABLED',
      error: 'Uploads are disabled to reduce running costs.' });
  });
  app.use(express.static(path.join(__dirname, '../client'), { etag: false, lastModified: false }));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host;
    const allowed = [`https://${host}`, `http://${host}`];
    // A browser always supplies Origin; CLI/test clients may omit it.
    if (!['/', '/ws'].includes(req.url) || (req.headers.origin && !allowed.includes(req.headers.origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (sessions.size >= 64) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (socket, req) => {
    socket.alive = true;
    let lastActivity = Date.now(), windowStart = Date.now(), count = 0;
    const send = event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    const session = createSession(send, sessionOptions);
    sessions.add(session);
    socket.on('pong', () => { socket.alive = true; });
    socket.on('message', raw => {
      lastActivity = Date.now();
      let message;
      try { message = JSON.parse(raw.toString()); } catch { send({ type: 'error', message: 'Invalid message.' }); return; }
      if (lastActivity - windowStart > 60000) { windowStart = lastActivity; count = 0; }
      if (message?.type !== 'browser_tool_result' && ++count > 60) { send({ type: 'error', message: 'Too many messages. Please wait a minute.' }); return; }
      Promise.resolve(session.receive(message)).catch(() => send({ type: 'error', message: 'The request could not be completed.' }));
    });
    const timer = setInterval(() => {
      if (!socket.alive || (!workspace && Date.now() - lastActivity > 15 * 60000)) { socket.terminate(); return; }
      socket.alive = false; socket.ping();
    }, 25000);
    timer.unref();
    socket.on('close', () => {
      clearInterval(timer);
      if (closing) return;
      session.close(); sessions.delete(session);
    });
    socket.on('error', () => {});
  });
  return { app, server, wss, close: async () => {
    closing = true;
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([...sessions].map(session => session.close()));
    sessions.clear(); wss.close();
    await new Promise(resolve => server.close(resolve));
  } };
}
if (require.main === module) {
  const workspace = process.env.NODE_ENV !== 'production';
  const office = createPublicServer({ workspace });
  const { server } = office;
  const port = process.env.PORT || 3000;
  server.listen(port, workspace ? '127.0.0.1' : '0.0.0.0', () => console.log(`Agents Office: http://localhost:${port} · browser-owned data; request-only backend; uploads disabled.`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    office.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
module.exports = { createPublicServer };
