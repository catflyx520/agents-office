// tests/claudeRunner.test.js
const { buildClaudeArgs, parseStreamChunk } = require('../server/claudeRunner');

test('buildClaudeArgs includes system prompt and tools', () => {
  const args = buildClaudeArgs({
    systemPrompt: '你是前端工程师',
    tools: ['Edit', 'Read'],
    // workDir removed — not a CLI arg, used as spawn cwd only
  });
  expect(args).toContain('--output-format');
  expect(args).toContain('stream-json');
  expect(args).toContain('--tools');
  expect(args).toContain('Edit,Read');
});

test('parseStreamChunk extracts text from assistant message', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '任务完成' }] }
  });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'text', text: '任务完成', done: false });
});

test('parseStreamChunk returns done=true on result event', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success' });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'done', done: true });
});

test('parseStreamChunk returns null for unrecognized lines', () => {
  expect(parseStreamChunk('')).toBeNull();
  expect(parseStreamChunk('not json')).toBeNull();
});

test('parseStreamChunk returns null when text block has no text property', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text' }] }  // no text property
  });
  const result = parseStreamChunk(line);
  expect(result).toBeNull();
});

test('parseStreamChunk parses Codex thread.started event', () => {
  const line = JSON.stringify({
    type: 'thread.started',
    thread_id: '019f24fc-0686-7db2-b7b5-53592e4c2718'
  });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'text', text: '', done: false, sessionId: '019f24fc-0686-7db2-b7b5-53592e4c2718' });
});

test('parseStreamChunk parses Codex agent_message item.completed event', () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: '你好！我是 Codex。'
    }
  });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'text', text: '你好！我是 Codex。', done: false });
});

test('parseStreamChunk parses Codex turn.completed event', () => {
  const line = JSON.stringify({
    type: 'turn.completed'
  });
  const result = parseStreamChunk(line);
  expect(result).toEqual({ type: 'done', done: true });
});
