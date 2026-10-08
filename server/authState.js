const invalid = new Set();
function recordAuthError(provider, text) {
  if (!/(?:\b401\b|OAuth access token is invalid|OAuth token has expired|invalid_api_key|authentication_error)/i.test(text)) return false;
  invalid.add(provider);
  return true;
}
function getAuthState(provider, hasCredentials, loggedIn = false) {
  if (invalid.has(provider)) return 'invalid';
  if (loggedIn) return 'signed_in';
  return hasCredentials ? 'unverified' : 'missing';
}
function clearAuthError(provider) { invalid.delete(provider); }
module.exports = { recordAuthError, getAuthState, clearAuthError };
