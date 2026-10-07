// tests/agentManager.test.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  getAgentsDir,
  loadAgent,
  listAgents,
  saveAgent,
  deleteAgent,
} = require('../server/agentManager');

// 用临时目录隔离测试
const TMP_DIR = path.join(os.tmpdir(), 'vo-test-agents-' + Date.now());

beforeAll(() => fs.mkdirSync(TMP_DIR, { recursive: true }));
afterAll(() => fs.rmSync(TMP_DIR, { recursive: true }));

const sampleConfig = {
  id: 'test-dev',
  name: '小测',
  emoji: '🧪',
  role: 'QA Engineer',
  workDir: '/tmp/project',
  tools: ['Read', 'Bash'],
  avatar: null,
  systemPrompt: '你是测试工程师，负责写测试。',
};

test('saveAgent writes a parseable .md file', () => {
  saveAgent(sampleConfig, TMP_DIR);
  const filePath = path.join(TMP_DIR, 'test-dev.md');
  expect(fs.existsSync(filePath)).toBe(true);
});

test('loadAgent returns correct config', () => {
  saveAgent(sampleConfig, TMP_DIR);
  const loaded = loadAgent('test-dev', TMP_DIR);
  expect(loaded.name).toBe('小测');
  expect(loaded.role).toBe('QA Engineer');
  expect(loaded.systemPrompt).toContain('测试工程师');
  expect(loaded.tools).toEqual(['Read', 'Bash']);
});

test('listAgents returns all saved agents', () => {
  const config2 = { ...sampleConfig, id: 'dev2', name: '小二' };
  saveAgent(config2, TMP_DIR);
  const agents = listAgents(TMP_DIR);
  const ids = agents.map(a => a.id);
  expect(ids).toContain('test-dev');
  expect(ids).toContain('dev2');
});

test('deleteAgent removes the file', () => {
  saveAgent(sampleConfig, TMP_DIR);
  deleteAgent('test-dev', TMP_DIR);
  const filePath = path.join(TMP_DIR, 'test-dev.md');
  expect(fs.existsSync(filePath)).toBe(false);
});

test('loadAgent throws a clear error for non-existent agent id', () => {
  expect(() => loadAgent('does-not-exist', TMP_DIR)).toThrow(/Agent not found: "does-not-exist"/);
});

test('saveAgent throws for invalid id (path traversal attempt)', () => {
  const badConfig = { ...sampleConfig, id: '../evil' };
  expect(() => saveAgent(badConfig, TMP_DIR)).toThrow(/Invalid agent id/);
});

test('deleteAgent throws for invalid id', () => {
  expect(() => deleteAgent('../evil', TMP_DIR)).toThrow(/Invalid agent id/);
});

test('listAgents skips corrupt .md files and returns valid agents', () => {
  // Write a corrupt file that cannot be parsed as front-matter (force a read error scenario)
  // We simulate a corrupt file by writing one that gray-matter will throw on.
  // gray-matter is lenient, so simulate by making loadAgent fail: write a file whose
  // basename is a valid id but then remove read permissions (skip on Windows).
  const corruptId = 'corrupt-agent';
  const corruptPath = path.join(TMP_DIR, `${corruptId}.md`);
  fs.writeFileSync(corruptPath, 'good content', 'utf8');
  // Make unreadable
  fs.chmodSync(corruptPath, 0o000);

  const validConfig = { ...sampleConfig, id: 'valid-agent', name: 'Valid' };
  saveAgent(validConfig, TMP_DIR);

  let agents;
  try {
    agents = listAgents(TMP_DIR);
  } finally {
    // Restore so afterAll cleanup can delete it
    fs.chmodSync(corruptPath, 0o644);
  }

  const ids = agents.map(a => a.id);
  expect(ids).toContain('valid-agent');
  expect(ids).not.toContain('corrupt-agent');
});
