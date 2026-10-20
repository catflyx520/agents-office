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
    calls.push({ bin, args, options, proc }); return proc;
  };
  return { spawn, calls };
}
function finishCodexLogin(call) {
  call.proc.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
  call.proc.stdout.write(JSON.stringify({ id: 2, result: { type: 'chatgpt', loginId: 'fixture-login', authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' } }) + '\n');
  call.proc.stdout.write(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } }) + '\n');
  call.proc.stdout.write(JSON.stringify({ id: 3, result: { account: { type: 'chatgpt' } } }) + '\n');
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

test('two visitors get distinct CLI homes and events; disconnect deletes only its own cache', async () => {
  const aEvents = [], bEvents = [], spawner = fakeSpawner();
  const a = client(aEvents, spawner), b = client(bEvents, spawner);
  await a.start('codex'); await b.start('claude');
  const [aCall, bCall] = spawner.calls;
  expect(aCall.options.env.HOME).not.toBe(bCall.options.env.HOME);
  expect(aCall.args).toContain('app-server');
  expect(aCall.args).not.toContain('--device-auth');
  aCall.proc.stderr.write('private diagnostic token=never-relay-this');
  aCall.proc.stdout.write('{"id":1,"result":{}}\n');
  aCall.proc.stdout.write('{"id":2,"result":{"type":"chatgpt","loginId":"fixture-login","authUrl":"https://auth.openai.com/oauth/authorize?state=fixture"}}\n');
  expect(aEvents.at(-1)).toMatchObject({ phase: 'waiting', url: 'https://auth.openai.com/oauth/authorize?state=fixture' });
  expect(bEvents.some(e => e.phase === 'waiting')).toBe(false);
  expect(JSON.stringify(aEvents)).not.toContain('never-relay-this');
  aCall.proc.stdout.write('{"method":"account/login/completed","params":{"loginId":"fixture-login","success":true}}\n');
  aCall.proc.stdout.write('{"id":3,"result":{"account":{"type":"chatgpt"}}}\n');
  expect(aEvents.at(-1)).toMatchObject({ phase: 'connected', provider: 'codex' });
  await a.clear();
  await expect(fs.stat(aCall.options.env.HOME)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(bCall.options.env.HOME)).isDirectory()).toBe(true);
  bCall.proc.finish(1); await b.clear();
});

test('cancelled login cannot report a late successful authorization', async () => {
  const events = [], spawner = fakeSpawner(), account = client(events, spawner);
  await account.start('codex'); const proc = spawner.calls[0].proc;
  const clearing = account.clear(); proc.emit('close', 0); await clearing;
  expect(events.some(e => e.phase === 'connected')).toBe(false);
});

test('account replies use the matching private home, parse actual usage and never relay CLI diagnostics', async () => {
  const events = [], spawner = fakeSpawner(), account = client(events, spawner);
  await account.start('codex'); const login = spawner.calls[0]; finishCodexLogin(login);
  const onText = jest.fn();
  const reply = account.generate({ credentials: { cliProvider: 'codex', model: '' }, system: 'Chat only.', messages: [{ role: 'user', content: 'hello' }], signal: new AbortController().signal, onText });
  const inference = spawner.calls[1]; expect(inference.options.env.HOME).toBe(login.options.env.HOME);
  inference.proc.stderr.write('private account details');
  inference.proc.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Hello 你好"}}\n');
  inference.proc.stdout.write('{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":2,"output_tokens":3}}\n');
  inference.proc.finish(0);
  expect(await reply).toMatchObject({ text: 'Hello 你好', usage: { input: 5, output: 3, cacheRead: 2, cacheCreate: null } });
  expect(onText).toHaveBeenCalledWith('Hello 你好');
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
