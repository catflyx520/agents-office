// Real, pinned official binaries against loopback fixtures; no paid model calls.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cliEnv, inferenceArgs, cliCommand } = require('../server/hostedCli');

async function check() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'office-cli-fixture-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (!body) { res.writeHead(404).end(); return; }
    const data = JSON.parse(body); requests.push({ url: req.url, data });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    if (req.url.includes('/messages')) {
      event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fixture reply' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      event('message_stop', {});
    } else {
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture reply', annotations: [] }] };
      event('response.created', { response: { id: 'resp_fixture', status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture reply' });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } });
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const provider of ['codex', 'claude']) {
      const folder = path.join(home, provider); await fs.mkdir(folder);
      await fs.mkdir(path.join(folder, '.codex')); await fs.mkdir(path.join(folder, '.claude'));
      const env = cliEnv(folder), args = inferenceArgs(provider, '', 'Chat only.');
      if (provider === 'codex') {
        args.splice(args.length - 1, 0, ...[
          'model_provider="fixture"', 'model_providers.fixture.name="Fixture"',
          `model_providers.fixture.base_url="${base}/v1"`, 'model_providers.fixture.wire_api="responses"',
        ].flatMap(value => ['-c', value]));
      } else { env.ANTHROPIC_API_KEY = 'fixture-key-not-real'; env.ANTHROPIC_BASE_URL = base; }
      const start = requests.length;
      const output = await new Promise((resolve, reject) => {
        const command = cliCommand(provider);
        const proc = spawn(command.bin, [...command.prefix, ...args], { env, cwd: folder, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '';
        proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${provider} CLI fixture timed out: ${stderr.slice(-1000)}`)); }, 30000);
        proc.once('error', error => { clearTimeout(timer); reject(error); });
        proc.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${provider} CLI exited ${code}: ${stderr.slice(-1500)} ${stdout.slice(-1000)}`)); });
        proc.stdin.end('Say hello.');
      });
      assert.match(output, /Fixture reply/, `${provider} must parse a real CLI response`);
      const actual = requests.slice(start).filter(request => request.data.messages || request.data.input);
      assert.ok(actual.length, `${provider} must call the loopback provider`);
      for (const { data } of actual) assert.equal((data.tools || []).length, 0, `${provider} must not offer any model tools`);
      console.log(`PASS ${provider}: real binary/configuration, loopback response, zero model tools. No paid request.`);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); }
}
check().catch(error => { console.error(error.message); process.exitCode = 1; });
