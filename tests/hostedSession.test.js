const { createSession } = require('../server/hostedSession');

test('switching to Demo aborts in-flight API work and suppresses late output', async () => {
  const events = []; let pending;
  const generateImpl = jest.fn(({ signal, onText }) => new Promise(resolve => { pending = { signal, onText, resolve }; }));
  const session = createSession(event => events.push(event), { generateImpl });
  await session.receive({ type: 'set_experience', experience: 'live' });
  await session.receive({ type: 'connect_api', provider: 'openai', model: 'test-model', key: 'test-key-not-real' });
  const work = session.receive({ type: 'chat', agentId: 'backend-dev', message: 'hello' });
  await session.receive({ type: 'set_experience', experience: 'demo' });
  expect(pending.signal.aborted).toBe(true);
  pending.onText('late output'); pending.resolve({ text: 'late output', usage: { input: 1, output: 1 } });
  await work;
  expect(events.some(e => e.text === 'late output')).toBe(false);
  expect(events.filter(e => e.type === 'hosted_state').at(-1)).toMatchObject({ experience: 'demo', connected: false });
  session.close();
});

test('live PM planning executes dependent API teammates and summarizes their actual replies', async () => {
  const events = [], requests = [];
  const responses = [JSON.stringify({ plan: 'Design a task app', tasks: [
    { agent: 'backend-dev', task: 'Draft an API', waitFor: null },
    { agent: 'frontend-dev', task: 'Draft the UI', waitFor: 'backend-dev' },
  ] }), 'API contract proposal', 'UI proposal using the API contract', 'Summary of proposed code'];
  const generateImpl = jest.fn(async args => {
    requests.push(args); const text = responses.shift(); args.onText(text); return { text, usage: { input: 3, output: 2 } };
  });
  const session = createSession(event => events.push(event), { generateImpl });
  await session.receive({ type: 'set_experience', experience: 'live' });
  await session.receive({ type: 'connect_api', provider: 'anthropic', model: 'test-model', key: 'test-key-not-real' });
  await session.receive({ type: 'set_mode', mode: 'confirm' });
  await session.receive({ type: 'chat', agentId: 'pm', message: 'Design a task app' });
  expect(generateImpl).toHaveBeenCalledTimes(1);
  expect(events.some(e => e.type === 'plan_preview')).toBe(true);
  await session.receive({ type: 'confirm_plan' });
  expect(generateImpl).toHaveBeenCalledTimes(4);
  expect(requests[2].messages.at(-1).content).toContain('API contract proposal');
  expect(requests[3].messages.at(-1).content).toContain('UI proposal');
  expect(events.filter(e => e.type === 'usage').at(-1).report.office.total.billable).toBe(20);
  session.close();
});

test('close clears credentials and aborts active provider calls', async () => {
  let signal;
  const session = createSession(() => {}, { generateImpl: args => { signal = args.signal; return new Promise(() => {}); } });
  await session.receive({ type: 'set_experience', experience: 'live' });
  await session.receive({ type: 'connect_api', provider: 'openai', model: 'test-model', key: 'test-key-not-real' });
  session.receive({ type: 'chat', agentId: 'backend-dev', message: 'hello' });
  session.close(); expect(signal.aborted).toBe(true);
});
