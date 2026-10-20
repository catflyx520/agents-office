// OAuth exchanges are request-local. This module never reads/writes credential files.
const { randomBytes, createHash, createPublicKey, verify } = require('node:crypto');

const callbacks = new Map(); // Pending authorization only; no access/refresh tokens.
const CONFIG = {
  claude: {
    authorize: 'https://claude.ai/oauth/authorize', token: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', redirect: 'https://platform.claude.com/oauth/code/callback',
    scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
  },
  codex: {
    authorize: 'https://auth.openai.com/api/accounts/authorize', token: 'https://auth.openai.com/api/accounts/oauth/token',
    clientId: 'dynamic_agent_client', scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  },
};
const fail = code => Object.assign(new Error(code), { code });
const validSecret = value => typeof value === 'string' && value.length >= 16 && value.length <= 24000 && !/[\s\x00-\x1f]/.test(value);
function debug(stage, provider, extra = {}) {
  // No per-user/request logs on the backend. Inspection events go to the owning browser.
  void stage; void provider; void extra;
}
async function postToken(provider, body, signal) {
  const form = provider === 'codex';
  let response;
  try {
    response = await fetch(CONFIG[provider].token, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
  } catch { throw fail('CONNECTION_FAILED'); }
  if (!response.ok) {
    debug('token_endpoint_rejected', provider, { httpStatus: response.status });
    await response.body?.cancel(); throw fail(response.status === 429 ? 'RATE_LIMITED' : 'AUTH_FAILED');
  }
  const result = await response.json().catch(() => { throw fail('AUTH_FAILED'); });
  if (!validSecret(result.access_token)) throw fail('AUTH_FAILED');
  return result;
}
async function verifyIdentity(token, clientId, nonce, signal) {
  if (!validSecret(token)) throw fail('AUTH_FAILED');
  try {
    const [head, payload, signature, extra] = token.split('.');
    if (!head || !payload || !signature || extra) throw fail('AUTH_FAILED');
    const header = JSON.parse(Buffer.from(head, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw fail('AUTH_FAILED');
    const options = { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]), redirect: 'error' };
    const discovery = await fetch('https://auth.openai.com/.well-known/openid-configuration', options);
    if (!discovery.ok) throw fail('AUTH_FAILED');
    const config = await discovery.json(), url = new URL(config.jwks_uri);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password) throw fail('AUTH_FAILED');
    const response = await fetch(url, options);
    if (!response.ok) throw fail('AUTH_FAILED');
    const jwk = (await response.json()).keys?.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk || !verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw fail('AUTH_FAILED');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== config.issuer || !audience.includes(clientId) || !Number.isFinite(claims.exp)
      || claims.exp * 1000 <= Date.now() || !claims.sub || nonce && claims.nonce !== nonce) throw fail('AUTH_FAILED');
    return claims;
  } catch { throw fail('AUTH_FAILED'); }
}
function bundle(result, previous = {}) {
  const expires = Number(result.expires_in);
  if (!Number.isFinite(expires) || expires <= 0) throw fail('AUTH_FAILED');
  return { accessToken: result.access_token, refreshToken: validSecret(result.refresh_token) ? result.refresh_token : previous.refreshToken || null,
    idToken: validSecret(result.id_token) ? result.id_token : previous.idToken || null,
    expiresAt: Date.now() + expires * 1000, clientId: previous.clientId,
    hostId: previous.hostId || null, subject: previous.subject || null, scope: result.scope || previous.scope || '' };
}
function startBrowserLogin(provider, options, send, timeout = 180000) {
  const config = CONFIG[provider];
  if (!config) throw fail('INVALID_PROVIDER');
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url'), controller = new AbortController();
  let active = true, exchanging = false;
  const clientId = provider === 'codex' && /^[a-zA-Z0-9_-]{8,200}$/.test(options.clientId || '') ? options.clientId : config.clientId;
  const hostId = provider === 'codex' && /^urn:uuid:[0-9a-f-]{36}$/i.test(options.hostId || '') ? options.hostId : null;
  const redirect = provider === 'claude' ? config.redirect : `http://127.0.0.1:${options.callbackPort || 3000}/auth/callback`;
  if (provider === 'codex' && (!hostId || !Number.isInteger(Number(options.callbackPort || 3000))
    || Number(options.callbackPort || 3000) < 1 || Number(options.callbackPort || 3000) > 65535)) throw fail('AUTH_FAILED');
  const url = new URL(config.authorize);
  const params = { client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: config.scope,
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
  if (provider === 'claude') params.code = 'true';
  else Object.assign(params, { nonce, ext_agent_host_id: hostId, resource: 'https://api.openai.com/v1',
    ...(clientId === config.clientId ? { agent_name_hint: 'Agents Office' } : {}) });
  url.search = new URLSearchParams(params).toString();
  const timer = setTimeout(() => { close(); send({ phase: 'expired', provider }); }, timeout); timer.unref();
  function close() { active = false; controller.abort(); clearTimeout(timer); callbacks.delete(state); }
  async function submit(value) {
    if (!active || exchanging || typeof value !== 'string' || value.length > 16000) throw fail('LOGIN_INACTIVE');
    let code = value.trim(), returnedState, issued = clientId;
    if (/^https?:\/\//.test(code)) {
      const callback = new URL(code);
      if (callback.origin !== new URL(redirect).origin || callback.pathname !== new URL(redirect).pathname) throw fail('AUTH_FAILED');
      code = callback.searchParams.get('code'); returnedState = callback.searchParams.get('state');
      issued = callback.searchParams.get('client_id') || clientId;
      if (callback.searchParams.has('error')) throw fail('AUTH_FAILED');
    } else if (provider === 'claude' && code.includes('#')) [code, returnedState] = code.split('#');
    if (returnedState && returnedState !== state || provider === 'codex' && returnedState !== state
      || !code || /[\s\x00-\x1f]/.test(code) || provider === 'codex' && issued === 'dynamic_agent_client'
      || !/^[a-zA-Z0-9_-]{8,200}$/.test(issued)) throw fail('AUTH_FAILED');
    exchanging = true;
    debug('authorization_exchange_started', provider);
    try {
      const response = await postToken(provider, { grant_type: 'authorization_code', code, client_id: issued,
        redirect_uri: redirect, code_verifier: verifier, ...(provider === 'codex' ? { resource: 'https://api.openai.com/v1' } : { state }) }, controller.signal);
      const claims = provider === 'codex' ? await verifyIdentity(response.id_token, issued, nonce, controller.signal) : null;
      if (!active) return;
      const credentials = bundle(response, { clientId: issued, hostId, subject: claims?.sub });
      if (provider === 'codex' && !credentials.scope.split(' ').includes('chatgpt.tokens.use.direct')) throw fail('AUTH_FAILED');
      // Deliver only to this connection, then drop all server-side references.
      send({ phase: 'credentials', provider, credentials });
      debug('credentials_returned_to_browser', provider, { expiresAt: credentials.expiresAt, persistedOnServer: false });
      close();
    } catch (error) {
      close(); debug('authorization_exchange_failed', provider, { code: error.code === 'CONNECTION_FAILED' ? 'CONNECTION_FAILED' : 'AUTH_FAILED' });
      send({ phase: 'failed', provider }); throw fail(error.code || 'AUTH_FAILED');
    }
  }
  callbacks.set(state, async callback => submit(callback));
  send({ phase: 'waiting', provider, url: url.href, manualCallback: provider === 'codex' });
  debug('authorization_started', provider, { persistedOnServer: false });
  return { submit, close };
}
async function oauthCallback(req, res) {
  const url = new URL(req.originalUrl, 'http://127.0.0.1');
  const callback = callbacks.get(url.searchParams.get('state'));
  if (!callback) return res.status(400).type('text').send('Authorization expired. Return to Agents Office and sign in again.');
  try {
    const port = req.socket.localPort;
    await callback(`http://127.0.0.1:${port}/auth/callback${url.search}`);
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Agents Office</title><p>Authorization received. Return to Agents Office.</p><script>history.replaceState(null,"","/auth/callback")</script>');
  } catch { res.status(400).type('text').send('Authorization failed. Return to Agents Office and try again.'); }
}
async function refreshBrowserCredentials(provider, previous, signal) {
  if (!CONFIG[provider] || !validSecret(previous?.refreshToken) || !/^[a-zA-Z0-9_-]{8,200}$/.test(previous.clientId || '')) throw fail('AUTH_FAILED');
  debug('refresh_started', provider);
  const result = await postToken(provider, { grant_type: 'refresh_token', refresh_token: previous.refreshToken,
    client_id: previous.clientId, ...(provider === 'codex' ? { resource: 'https://api.openai.com/v1' } : {}) }, signal);
  if (provider === 'codex' && result.id_token) {
    const claims = await verifyIdentity(result.id_token, previous.clientId, null, signal);
    if (claims.sub !== previous.subject) throw fail('AUTH_FAILED');
  }
  const credentials = bundle(result, previous);
  debug('refresh_returned_to_browser', provider, { expiresAt: credentials.expiresAt, persistedOnServer: false });
  return credentials;
}
module.exports = { startBrowserLogin, refreshBrowserCredentials, oauthCallback, validSecret, debug };
