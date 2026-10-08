const invalid = new Set();
function recordAuthError(provider, text) {
  if (!/(?:\b401\b|OAuth access token is invalid|OAuth token has expired|invalid_api_key|authentication_error)/i.test(text)) return false;
  invalid.add(provider);
  return true;
}
function getAuthState(provider, hasCredentials) {
  if (invalid.has(provider)) return 'invalid';
  return hasCredentials ? 'unverified' : 'missing';
}
function clearAuthError(provider) { invalid.delete(provider); }
module.exports = { recordAuthError, getAuthState, clearAuthError };
