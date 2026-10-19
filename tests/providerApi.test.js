const { generate, ProviderError } = require('../server/providerApi');

const credentials = { provider: 'openai', model: 'test-model', key: 'test-key-not-real' };
function response(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
const args = () => ({ credentials, system: 'Test instructions', messages: [{ role: 'user', content: 'Hello' }], signal: new AbortController().signal, onText: jest.fn() });

test('OpenAI uses a fixed URL, visitor key, disabled storage and streamed text/usage', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(response([
    { type: 'response.output_text.delta', delta: 'Hello 世界' },
    { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 3 } } },
  ]));
  const input = args();
  const result = await generate({ ...input, fetchImpl });
  expect(result).toEqual({ text: 'Hello 世界', usage: { input: 9, output: 3 } });
  expect(input.onText).toHaveBeenCalledWith('Hello 世界');
  const [url, request] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  expect(request.headers.Authorization).toBe('Bearer test-key-not-real');
  expect(JSON.parse(request.body)).toMatchObject({ store: false, stream: true, max_output_tokens: 2048 });
  expect(JSON.parse(request.body).tools).toBeUndefined();
});

test('Anthropic handles split UTF-8/SSE chunks and cumulative usage', async () => {
  const data = [
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
    { type: 'message_delta', usage: { output_tokens: 7 } }, { type: 'message_stop' },
  ].map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(data);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const fetchImpl = jest.fn().mockResolvedValue(new Response(stream));
  const result = await generate({ ...args(), credentials: { ...credentials, provider: 'anthropic' }, fetchImpl });
  expect(result).toEqual({ text: '你好', usage: { input: 4, output: 7 } });
  expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe(credentials.key);
});

test('provider errors are redacted and truncated streams never report success', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(new Response('secret echoed: test-key-not-real', { status: 401 }));
  await expect(generate({ ...args(), fetchImpl })).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'AUTH_FAILED' });
  await expect(generate({ ...args(), fetchImpl: async () => response([{ type: 'response.output_text.delta', delta: 'partial' }]) }))
    .rejects.toBeInstanceOf(ProviderError);
});

test('refuses unknown provider URLs instead of proxying arbitrary hosts', async () => {
  const fetchImpl = jest.fn();
  await expect(generate({ ...args(), credentials: { ...credentials, provider: 'http://169.254.169.254' }, fetchImpl })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
