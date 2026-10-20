// File operations are executed by the visitor's browser, never against this host.
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');

const TOOLS = [
  { name: 'list_files', permission: 'List', description: 'List files and directories inside the visitor-selected project folder. Paths are relative to that folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path; empty means the project root.' } }, additionalProperties: false } },
  { name: 'read_file', permission: 'Read', description: 'Read a UTF-8 text file in the visitor-selected folder. Returns numbered lines; request another offset to continue.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', permission: 'Write', description: 'Create or overwrite a UTF-8 file inside the visitor-selected folder. Parent directories are created when needed.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'edit_file', permission: 'Edit', description: 'Replace an exact text match in a visitor-selected project file. Fails if the match is missing or ambiguous.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false } },
];

async function createBrowserWorkspace({ send, agentId, projectId, tools, signal }) {
  const token = randomBytes(32).toString('hex');
  const available = TOOLS.filter(tool => tools.includes(tool.permission));
  const pending = new Map();
  let closed = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let message;
    try {
      const parts = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; }
        parts.push(part);
      }
      message = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch { res.writeHead(400).end(); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { res.writeHead(400).end(); return; }
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = body => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body })); } };
    if (message.method === 'initialize') {
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      reply({ result: { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} }, serverInfo: { name: 'visitor-browser-files', version: '0.1.0' } } }); return;
    }
    if (message.method === 'ping') { reply({ result: {} }); return; }
    if (message.method === 'tools/list') { reply({ result: { tools: available.map(({ permission, ...tool }) => tool) } }); return; }
    if (message.method !== 'tools/call') { reply({ error: { code: -32601, message: 'Method not found' } }); return; }
    const name = message.params?.name;
    if (closed || signal.aborted || !available.some(tool => tool.name === name)) {
      reply({ result: { isError: true, content: [{ type: 'text', text: 'This file operation is unavailable.' }] } }); return;
    }
    const requestId = randomUUID();
    try {
      const result = await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        send({ type: 'browser_tool_call', requestId, agentId, projectId, name, arguments: message.params.arguments || {} });
      });
      reply({ result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] } });
    } catch (error) { reply({ result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
    finally { pending.delete(requestId); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  const close = () => {
    if (closed) return;
    closed = true; signal.removeEventListener('abort', close);
    for (const item of pending.values()) item.reject(new Error('File operation cancelled.'));
    pending.clear(); server.close(); server.closeAllConnections();
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) { close(); throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }); }
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, token, close,
    receive(message) {
      const item = pending.get(message.requestId);
      if (!item) return false;
      pending.delete(message.requestId);
      if (message.ok === true) item.resolve(message.result);
      else item.reject(new Error(String(message.error || 'The browser could not complete the file operation.').slice(0, 300)));
      return true;
    },
  };
}

module.exports = { createBrowserWorkspace };
