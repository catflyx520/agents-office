jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../server/configStore', () => ({ getConfig: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { getConfig } = require('../server/configStore');
const { spawnAgent } = require('../server/claudeRunner');
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  spawn.mockReturnValue(proc);
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('Codex receives its key and configurable executable', () => {
  getConfig.mockImplementation(key => key === 'activeProvider' ? 'codex' : null);
  process.env.CODEX_BIN = '/test/codex';
  process.env.CODEX_API_KEY = 'test-key';
  spawnAgent({ tools: [], workDir: '/test' }, 'hello', () => {});
  expect(spawn.mock.calls[0][0]).toBe('/test/codex');
  expect(spawn.mock.calls[0][2].env.CODEX_API_KEY).toBe('test-key');
});

test('Claude environment key takes precedence over legacy saved key', () => {
  getConfig.mockImplementation(key => key === 'apiKey' ? 'legacy-test-key' : 'claude');
  process.env.ANTHROPIC_API_KEY = 'env-test-key';
  spawnAgent({ tools: [] }, 'hello', () => {});
  expect(spawn.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBe('env-test-key');
});

test('Blank keys are omitted so saved CLI authentication remains available', () => {
  getConfig.mockReturnValue(null);
  process.env.CODEX_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  spawnAgent({ tools: [] }, 'hello', () => {});
  expect(spawn.mock.calls[0][2].env).not.toHaveProperty('CODEX_API_KEY');
  expect(spawn.mock.calls[0][2].env).not.toHaveProperty('ANTHROPIC_API_KEY');
});
