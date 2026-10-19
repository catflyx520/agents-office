// Public API mode never inherits owner credentials or executes local CLI tools.
const PROVIDERS = Object.freeze({
  openai: { url: 'https://api.openai.com/v1/responses', model: 'gpt-4.1-mini' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5-20251001' },
});
class ProviderError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  function parse(block) {
    const data = block.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? JSON.parse(data) : null;
  }
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = parse(block); if (event) yield event;
    }
    if (buffer.length > 1024 * 1024) throw new ProviderError('INVALID_STREAM');
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parse(buffer); if (event) yield event; }
}

async function generate({ credentials, system, messages, signal, onText, fetchImpl = fetch }) {
  const provider = Object.hasOwn(PROVIDERS, credentials.provider) ? PROVIDERS[credentials.provider] : null;
  if (!provider) throw new ProviderError('INVALID_PROVIDER');
  const isOpenAI = credentials.provider === 'openai';
  const body = isOpenAI
    ? { model: credentials.model, instructions: system, input: messages, stream: true, store: false, max_output_tokens: 2048 }
    : { model: credentials.model, system, messages, stream: true, max_tokens: 2048 };
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (isOpenAI) headers.Authorization = `Bearer ${credentials.key}`;
  else { headers['x-api-key'] = credentials.key; headers['anthropic-version'] = '2023-06-01'; }
  let response;
  try {
    response = await fetchImpl(provider.url, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    });
  } catch (error) {
    if (signal.aborted) throw new ProviderError('CANCELLED');
    throw new ProviderError('CONNECTION_FAILED');
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Raw provider errors may echo credentials or prompts. Never relay/log them.
    throw new ProviderError(response.status === 401 || response.status === 403 ? 'AUTH_FAILED'
      : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_FAILED', response.status);
  }
  let text = '', complete = false;
  let usage = { input: 0, output: 0 };
  try {
    for await (const event of readEvents(response.body)) {
      if (signal.aborted) throw new ProviderError('CANCELLED');
      const delta = isOpenAI ? (event.type === 'response.output_text.delta' ? event.delta : '')
        : (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? event.delta.text : '');
      if (delta) {
        text += delta;
        if (text.length > 64000) throw new ProviderError('OUTPUT_LIMIT');
        onText(delta);
      }
      if (event.type === 'message_start') usage.input = event.message?.usage?.input_tokens || 0;
      if (event.type === 'message_delta') usage.output = event.usage?.output_tokens || 0;
      if (event.type === 'message_stop') complete = true;
      if (event.type === 'response.completed') {
        complete = true;
        usage = { input: event.response?.usage?.input_tokens || 0, output: event.response?.usage?.output_tokens || 0 };
      }
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new ProviderError('PROVIDER_FAILED');
    }
  } catch (error) {
    if (signal.aborted) throw new ProviderError('CANCELLED');
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('STREAM_INTERRUPTED');
  }
  if (!complete || !text.trim()) throw new ProviderError('STREAM_INTERRUPTED');
  return { text, usage };
}
module.exports = { PROVIDERS, ProviderError, readEvents, generate };
