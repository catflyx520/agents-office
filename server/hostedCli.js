// Official CLIs run once per task. OAuth tokens arrive with that task from the browser.
// No reusable server credential cache or CLI login command is used.
const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startBrowserLogin, validSecret, debug } = require('./browserAuth');
class ProviderError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const { allowedModel } = require('./modelCatalog');
const CATALOG_PATH = path.join(__dirname, 'codex-chat-models.json');
const usageCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const usageFields = ['input', 'output', 'cacheCreate', 'cacheRead'];
function reportedUsage(choice, event, model) {
  const source = event.usage;
  const models = Object.create(null);
  let counts;
  if (choice === 'claude') {
    counts = { input: usageCount(source?.input_tokens), output: usageCount(source?.output_tokens),
      cacheCreate: usageCount(source?.cache_creation_input_tokens), cacheRead: usageCount(source?.cache_read_input_tokens) };
    // Each hosted inference is an independent call, without resume/continue.
    // Its final modelUsage is counted once, not once per assistant/tool message.
    for (const [name, value] of Object.entries(event.modelUsage || {})) {
      if (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(name)) continue;
      models[name] = { input: usageCount(value?.inputTokens), output: usageCount(value?.outputTokens),
        cacheCreate: usageCount(value?.cacheCreationInputTokens), cacheRead: usageCount(value?.cacheReadInputTokens) };
    }
    if (Object.keys(models).length) {
      for (const key of usageFields) {
        const values = Object.values(models).map(value => value[key]);
        if (values.every(value => value !== null)) counts[key] = values.reduce((sum, value) => sum + value, 0);
      }
    }
  } else {
    const input = usageCount(source?.input_tokens), cached = usageCount(source?.cached_input_tokens);
    counts = { input: input === null || cached !== null && cached > input ? null : input - (cached ?? 0),
      output: usageCount(source?.output_tokens), cacheCreate: null, cacheRead: cached };
  }
  if (usageFields.every(key => counts[key] === null)) return null;
  return { ...counts, model: Object.keys(models).length === 1 ? Object.keys(models)[0] : model || null, models };
}
function cliCommand(choice) {
  const override = choice === 'claude' ? process.env.CLAUDE_BIN : process.env.CODEX_BIN;
  if (override) return { bin: override, prefix: [] };
  // Resolve the pinned project dependency, so an older global CLI cannot silently
  // change the supported login/options. npm's native wrapper differs by OS.
  const name = choice === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  const manifest = path.join(__dirname, '..', 'node_modules', name, 'package.json');
  if (existsSync(manifest)) {
    const config = JSON.parse(readFileSync(manifest, 'utf8'));
    const entry = path.resolve(path.dirname(manifest), typeof config.bin === 'string' ? config.bin : config.bin[choice]);
    if (/\.[cm]?js$/.test(entry)) return { bin: process.execPath, prefix: [entry] };
    return { bin: entry, prefix: [] };
  }
  return { bin: choice, prefix: [] };
}
let processes = 0;
function lease() {
  if (processes >= 2) throw new ProviderError('BUSY');
  processes += 1; let released = false;
  return () => { if (!released) { released = true; processes -= 1; } };
}
function cliEnv(home) {
  // Allowlist deliberately excludes API keys, owner HOME/config, proxies and AWS credentials.
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: home, TMP: home, TEMP: home, PAGER: 'cat',
    // Claude returns its URL to our existing browser UI instead of launching
    // rundll32/open/xdg-open on the server. Codex uses its no-browser RPC below.
    BROWSER: 'none',
    NO_COLOR: '1', TERM: 'dumb', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true', DO_NOT_TRACK: '1' };
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'LANG', 'LC_ALL']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
function loginChallenge(provider, source) {
  const clean = source.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // Wait for a delimiter so a URL split between stdout chunks is never opened halfway.
  const urls = clean.match(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g) || [];
  const hosts = provider === 'codex' ? ['auth.openai.com', 'chatgpt.com'] : ['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com'];
  let url = null;
  for (const value of urls) {
    try { const parsed = new URL(value); if (hosts.includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port) url = parsed.href; } catch { /* Ignore incomplete chunks. */ }
  }
  const code = provider === 'codex' ? clean.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] || null : null;
  return { url, code };
}
function inferenceArgs(provider, model, system, workspace = null) {
  if (workspace && provider === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { browser_workspace: {
      type: 'http', url: workspace.url, headers: { Authorization: `Bearer ${workspace.token}` },
    } } }), '--allowedTools', 'mcp__browser_workspace__*', '--append-system-prompt', system, ...(model ? ['--model', model] : [])];
  if (provider === 'claude') return ['--restricted', '--safe-mode', '-p', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowedTools', 'mcp__*', '--append-system-prompt', system, ...(model ? ['--model', model] : [])];
  // This pinned model catalogue removes apply_patch and shell metadata. Disable the
  // remaining tool families too; read-only alone would still permit file reads.
  const disabled = ['shell_tool', 'view_image', 'image_generation', 'multi_agent', 'multi_agent_v2',
    'code_mode', 'code_mode_only', 'js_repl', 'apps', 'plugins', 'memories', 'hooks', 'tool_suggest',
    'search_tool', 'tool_search', 'request_permissions_tool', 'computer_use'];
  return ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', '--color', 'never', '-c', 'approval_policy="never"',
    '-c', `developer_instructions=${JSON.stringify(system)}`,
    '-c', 'web_search="disabled"', '-c', `model_catalog_json=${JSON.stringify(CATALOG_PATH)}`,
    '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false',
    ...disabled.flatMap(name => ['--disable', name]),
    ...(workspace ? ['-c', `mcp_servers.browser_workspace.url=${JSON.stringify(workspace.url)}`,
      '-c', `mcp_servers.browser_workspace.http_headers.Authorization=${JSON.stringify(`Bearer ${workspace.token}`)}`] : []),
    ...(model ? ['--model', model] : []), '-'];
}
function createHostedCli(send, { spawnImpl = spawn, tempRoot = os.tmpdir(), loginTimeout = 180000 } = {}) {
  let current = 0, closed = false, login = null;
  const children = new Set();
  function terminate(proc) {
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    const force = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 1000); force.unref();
  }
  function clear() {
    current += 1; login?.close(); login = null;
    const running = [...children];
    const exited = running.map(proc => new Promise(resolve => {
      if (proc.exitCode !== null) resolve(); else proc.once('close', resolve);
    }));
    for (const proc of running) terminate(proc);
    return Promise.all(exited);
  }
  async function start(choice, options = {}) {
    if (!['claude', 'codex'].includes(choice) || closed) throw new ProviderError('INVALID_PROVIDER');
    const cleanup = clear(), run = current;
    await cleanup;
    if (run !== current || closed) return;
    send({ phase: 'starting', provider: choice });
    login = startBrowserLogin(choice, options, event => {
      if (run !== current || closed) return;
      send(event);
      if (['credentials', 'failed', 'expired', 'cancelled'].includes(event.phase)) { login?.close(); login = null; }
    }, loginTimeout);
  }
  async function submit(code) {
    if (!login) throw new ProviderError('LOGIN_INACTIVE');
    const active = login;
    try { await active.submit(code); } finally { active.close(); if (login === active) login = null; }
  }
  async function generate({ credentials, system, messages, signal, onText, workspace = null, onActivity = () => {}, onUsage = () => {}, onCleanup = () => {} }) {
    const choice = credentials?.cliProvider, run = current;
    if (closed || !['claude', 'codex'].includes(choice) || !validSecret(credentials.accessToken)
      || !Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= Date.now()) throw new ProviderError('AUTH_FAILED');
    if (signal.aborted) throw new ProviderError('CANCELLED');
    const model = credentials.model;
    if (!allowedModel(choice, model || '')) throw new ProviderError('INVALID_MODEL');
    const folder = await fs.mkdtemp(path.join(tempRoot, 'office-task-'));
    let proc;
    const requestId = credentials.requestId;
    try {
      await fs.chmod(folder, 0o700);
      await fs.mkdir(path.join(folder, '.codex'), { mode: 0o700 });
      await fs.mkdir(path.join(folder, '.claude'), { mode: 0o700 });
      if (signal.aborted || run !== current || closed) throw new ProviderError('CANCELLED');
      const command = cliCommand(choice), env = cliEnv(folder), args = inferenceArgs(choice, model, system, workspace);
      if (choice === 'claude') env.CLAUDE_CODE_OAUTH_TOKEN = credentials.accessToken;
      else {
        // Official Responses provider configuration accepts the OAuth access token
        // via the child environment; no auth.json, keyring, or refresh token.
        env.OFFICE_ACCESS_TOKEN = credentials.accessToken;
        args.splice(args.length - 1, 0, ...[
          'cli_auth_credentials_store="ephemeral"', 'model_provider="office_chatgpt_plan"',
          'model_providers.office_chatgpt_plan.name="ChatGPT plan"',
          'model_providers.office_chatgpt_plan.base_url="https://api.openai.com/v1"',
          'model_providers.office_chatgpt_plan.env_key="OFFICE_ACCESS_TOKEN"',
          'model_providers.office_chatgpt_plan.wire_api="responses"',
          'model_providers.office_chatgpt_plan.requires_openai_auth=false',
          'model_providers.office_chatgpt_plan.supports_websockets=false',
        ].flatMap(value => ['-c', value]));
      }
      const release = lease();
      try { proc = spawnImpl(command.bin, [...command.prefix, ...args], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch { release(); throw new ProviderError('CLI_UNAVAILABLE'); }
      // The spawn options are no longer needed by this application.
      delete env.OFFICE_ACCESS_TOKEN; delete env.CLAUDE_CODE_OAUTH_TOKEN;
      children.add(proc);
      proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8'); proc.stdin.on('error', () => {});
      let released = false;
      const releaseOnce = () => { if (!released) { released = true; children.delete(proc); release(); } };
      proc.once('close', releaseOnce); proc.once('error', releaseOnce);
      debug('task_credentials_received', choice, { requestId, persistedOnServer: false });
      return await new Promise((resolve, reject) => {
        let buffer = '', text = '', complete = false, failure = null, size = 0;
        let usage = null, reportedModel = model || null, finished = false;
        const actualModels = new Set();
        function recordModel(value) {
          if (typeof value !== 'string' || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(value) || actualModels.size >= 8) return;
          actualModels.add(value);
          reportedModel = value;
        }
        const cancel = () => { failure = 'CANCELLED'; terminate(proc); };
        const timeout = setTimeout(() => { failure = 'CONNECTION_FAILED'; terminate(proc); }, workspace ? 10 * 60000 : 90000); timeout.unref();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        function emit(part) {
          if (signal.aborted || run !== current) return;
          text += part;
          if (text.length > 64000) { failure = 'OUTPUT_LIMIT'; terminate(proc); return; }
          onText(part);
        }
        function line(source) {
          let event; try { event = JSON.parse(source); } catch { return; }
          if (choice === 'claude') {
            if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') reportedModel = event.model;
            if (event.type === 'assistant') recordModel(event.message?.model);
            if (event.type === 'assistant') for (const block of event.message?.content || []) {
              if (block.type === 'text' && typeof block.text === 'string') emit(block.text);
              if (block.type === 'tool_use') {
                if (workspace && typeof block.name === 'string' && block.name.startsWith('mcp__browser_workspace__')) onActivity(`Tool: ${block.name.slice(0, 100)}`);
                else if (block.name !== 'EndConversation') { failure = 'TOOLS_DISABLED'; terminate(proc); }
              }
            }
            if (event.type === 'result') {
              for (const name of Object.keys(event.modelUsage || {})) recordModel(name);
              complete = !event.is_error; usage = reportedUsage(choice, event, reportedModel);
              if (event.is_error && /401|authentication|oauth.{0,30}(?:invalid|expired)|invalid.{0,20}token/i.test(JSON.stringify(event))) failure = 'AUTH_FAILED';
            }
          } else {
            // CLI output may omit response-model metadata. A requested --model or
            // local session configuration is not evidence of the model returned.
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') recordModel(event.item.model);
            if (['response.created', 'response.completed', 'turn.completed'].includes(event.type)) recordModel(event.response?.model);
            if (['item.started', 'item.completed'].includes(event.type) && ['command_execution', 'file_change'].includes(event.item?.type)) { failure = 'TOOLS_DISABLED'; terminate(proc); }
            if (workspace && ['item.started', 'item.completed'].includes(event.type) && event.item?.type === 'mcp_tool_call') onActivity(`Browser file tool: ${String(event.item.tool || '').slice(0, 80)}`);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') emit(event.item.text || '');
            if (event.type === 'turn.completed') { complete = true; usage = reportedUsage(choice, event, reportedModel); }
            if (event.type === 'turn.failed' || event.type === 'error') failure = /401|authentication|invalid.{0,20}token|token.{0,20}expired/i.test(JSON.stringify(event)) ? 'AUTH_FAILED' : 'PROVIDER_FAILED';
          }
        }
        proc.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) { failure = 'OUTPUT_LIMIT'; terminate(proc); return; }
          buffer += chunk; let end;
          while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
        });
        proc.stderr.resume(); // Never log provider/CLI diagnostics containing credentials.
        function finish(code) {
          if (finished) return; finished = true; clearTimeout(timeout); signal.removeEventListener('abort', cancel);
          if (buffer.trim()) line(buffer);
          if (usage) onUsage(usage);
          if (failure || code !== 0 || !complete || !text.trim()) reject(new ProviderError(failure || 'PROVIDER_FAILED'));
          else resolve({ text, usage, model: actualModels.size === 1 ? [...actualModels][0] : null, models: [...actualModels] });
        }
        proc.once('close', finish); proc.once('error', () => { failure = 'CLI_UNAVAILABLE'; finish(-1); });
        proc.stdin.end(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'));
      });
    } finally {
      if (proc && proc.exitCode === null && proc.pid) {
        const exited = new Promise(resolve => proc.once('close', resolve)); terminate(proc); await exited;
      }
      // Check presence only, never open a credential file. Unexpected native CLI
      // behavior is surfaced instead of silently claiming browser-only storage.
      const credentialFilePresent = ['.claude/.credentials.json', '.codex/auth.json']
        .some(relative => existsSync(path.join(folder, relative)));
      try { await fs.rm(folder, { recursive: true, force: true }); }
      catch {
        debug('runtime_cleanup_failed', choice, { requestId, credentialFilePresent, runtimeDirectoryRemoved: false });
        onCleanup({ credentialFilePresent, runtimeDirectoryRemoved: false });
        throw new ProviderError('CREDENTIAL_CLEANUP_FAILED');
      }
      debug('task_credentials_released', choice, { requestId, credentialFilePresent, runtimeDirectoryRemoved: true });
      onCleanup({ credentialFilePresent, runtimeDirectoryRemoved: true });
      if (credentialFilePresent) throw new ProviderError('SERVER_CREDENTIAL_CACHE_DETECTED');
    }
  }
  return { start, submit, generate, clear, close() { closed = true; return clear(); } };
}
module.exports = { createHostedCli, cliEnv, loginChallenge, inferenceArgs, cliCommand };
