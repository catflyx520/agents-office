const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHostedCli, cliEnv, loginChallenge, inferenceArgs } = require('../server/hostedCli');

function fakeSpawner() {
  const calls = [];
  const spawn = (bin, args, options) => {
    const proc = new EventEmitter();
    Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 123, exitCode: null });
    proc.finish = code => { proc.exitCode = code; proc.emit('close', code); };
    proc.kill = () => { queueMicrotask(() => proc.finish(143)); return true; };
    calls.push({ bin, args, options: { ...options, env: { ...options.env } }, proc }); return proc;
  };
  return { spawn, calls };
}
async function nextCall(spawner, index) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (spawner.calls[index]) return spawner.calls[index];
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture subprocess did not start');
}
const credentials = token => ({ cliProvider: 'codex', model: '', accessToken: token, expiresAt: Date.now() + 600000 });
const replyArgs = token => ({ credentials: credentials(token), system: 'Chat only.',
  messages: [{ role: 'user', content: 'hello' }], signal: new AbortController().signal, onText: jest.fn() });
function finishReply(call) {
  call.proc.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Hello 你好"}}\n');
  call.proc.stdout.write('{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":2,"output_tokens":3}}\n');
  call.proc.finish(0);
}
let root, clients;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-test-')); clients = []; });
afterEach(async () => { await Promise.all(clients.map(client => client.close())); await fs.rm(root, { recursive: true, force: true }); });
function client(events, spawner, options = {}) {
  const value = createHostedCli(event => events.push(event), { spawnImpl: spawner.spawn, tempRoot: root, ...options }); clients.push(value); return value;
}

test('only exact official HTTPS hosts become login links; device output can be split across chunks', () => {
  expect(loginChallenge('codex', '\u001b[31mhttps://auth.openai.com/codex/device\nABCD-EFGH')).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' });
  for (const link of ['https://auth.openai.com.evil.test/', 'https://auth.openai.com@evil.test/', 'http://auth.openai.com/', 'https://auth.openai.com:9443/']) expect(loginChallenge('codex', link).url).toBeNull();
  expect(loginChallenge('claude', 'https://claude.ai/oauth/authorize?state=sample\n').url).toContain('claude.ai');
  expect(loginChallenge('codex', 'https://auth.openai.com/codex/').url).toBeNull();
});

test('subprocess environment never inherits owner credentials or login directories', () => {
  process.env.OPENAI_API_KEY = 'owner-test-secret'; process.env.ANTHROPIC_API_KEY = 'owner-anthropic';
  process.env.AWS_SECRET_ACCESS_KEY = 'owner-aws';
  try {
    const env = cliEnv(root);
    expect(env.HOME).toBe(root); expect(env.CODEX_HOME).toBe(path.join(root, '.codex'));
    expect(JSON.stringify(env)).not.toMatch(/owner-test-secret|owner-anthropic|owner-aws/);
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.AWS_SECRET_ACCESS_KEY; }
});

test('two visitors get distinct request runtimes; cancellation deletes only its own runtime', async () => {
  const aEvents = [], bEvents = [], spawner = fakeSpawner();
  const a = client(aEvents, spawner), b = client(bEvents, spawner);
  const aReply = a.generate(replyArgs('fixture-visitor-a-token'));
  const cancelled = expect(aReply).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  const aCall = await nextCall(spawner, 0);
  const bReply = b.generate(replyArgs('fixture-visitor-b-token'));
  const bCall = await nextCall(spawner, 1);
  expect(aCall.options.env.HOME).not.toBe(bCall.options.env.HOME);
  expect(aCall.options.env.OFFICE_ACCESS_TOKEN).toBe('fixture-visitor-a-token');
  expect(bCall.options.env.OFFICE_ACCESS_TOKEN).toBe('fixture-visitor-b-token');
  aCall.proc.stderr.write('private diagnostic token=never-relay-this');
  await a.clear(); await cancelled;
  await expect(fs.stat(aCall.options.env.HOME)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(bCall.options.env.HOME)).isDirectory()).toBe(true);
  finishReply(bCall); await bReply;
  expect(JSON.stringify([...aEvents, ...bEvents])).not.toContain('never-relay-this');
  expect(await fs.readdir(root)).toEqual([]);
});

test('cancelled login cannot report a late successful authorization', async () => {
  const events = [], spawner = fakeSpawner(), account = client(events, spawner);
  const originalFetch = global.fetch;
  let complete;
  global.fetch = jest.fn(() => new Promise(resolve => { complete = resolve; }));
  try {
    await account.start('claude');
    expect(events.at(-1)).toMatchObject({ phase: 'waiting', provider: 'claude' });
    const pending = account.submit('fixture-authorization-code');
    await account.clear();
    complete({ ok: true, json: async () => ({ access_token: 'fixture-access-token-only', expires_in: 3600 }) });
    await pending;
    expect(events.some(e => e.phase === 'credentials')).toBe(false);
    expect(spawner.calls).toHaveLength(0);
    expect(await fs.readdir(root)).toEqual([]);
  } finally { global.fetch = originalFetch; }
});

test('account replies require a browser token, parse actual usage and delete the runtime without retaining credentials', async () => {
  const events = [], spawner = fakeSpawner(), account = client(events, spawner);
  const args = replyArgs('fixture-browser-access-token'), onCleanup = jest.fn();
  const reply = account.generate({ ...args, onCleanup });
  const inference = await nextCall(spawner, 0);
  expect(inference.options.env.OFFICE_ACCESS_TOKEN).toBe('fixture-browser-access-token');
  expect(inference.args).toContain('--ephemeral');
  expect(await fs.readdir(path.join(inference.options.env.HOME, '.codex'))).toEqual([]);
  expect(await fs.readdir(path.join(inference.options.env.HOME, '.claude'))).toEqual([]);
  inference.proc.stderr.write('private account details');
  finishReply(inference);
  expect(await reply).toMatchObject({ text: 'Hello 你好', usage: { input: 5, output: 3, cacheRead: 2, cacheCreate: null } });
  expect(args.onText).toHaveBeenCalledWith('Hello 你好');
  expect(onCleanup).toHaveBeenCalledWith({ credentialFilePresent: false, runtimeDirectoryRemoved: true });
  await expect(fs.stat(inference.options.env.HOME)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(account.generate({ ...args, credentials: { cliProvider: 'codex', model: '' } })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  expect(spawner.calls).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain('private account');
});

test('public account inference disables file/command tools instead of relying on a prompt', () => {
  const models = require('../server/codex-chat-models.json').models;
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(model).toMatchObject({ apply_patch_tool_type: null, shell_type: 'disabled', tool_mode: 'direct', node_repl_disabled: true });
  const codex = inferenceArgs('codex', '', 'chat');
  expect(codex.join(' ')).toContain('--disable view_image');
  expect(codex).toContain('--ignore-user-config'); expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  const claude = inferenceArgs('claude', '', 'chat');
  expect(claude[claude.indexOf('--tools') + 1]).toBe(''); expect(claude).toContain('--restricted'); expect(claude).toContain('--strict-mcp-config');
});
