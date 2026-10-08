const { recordAuthError, getAuthState, clearAuthError } = require('../server/authState');

afterEach(() => { clearAuthError('claude'); clearAuthError('codex'); });

test('local credentials do not imply verified authorization', () => {
  expect(getAuthState('claude', true)).toBe('unverified');
  expect(getAuthState('codex', false)).toBe('missing');
});

test('401 remains invalid across status checks and does not affect the other provider', () => {
  expect(recordAuthError('claude', 'Failed to authenticate. API Error: 401 OAuth access token is invalid.')).toBe(true);
  expect(getAuthState('claude', true)).toBe('invalid');
  expect(getAuthState('codex', true)).toBe('unverified');
  clearAuthError('claude');
  expect(getAuthState('claude', true)).toBe('unverified');
});

test('ordinary process errors do not mark authorization invalid', () => {
  expect(recordAuthError('claude', 'spawn ENOENT')).toBe(false);
  expect(getAuthState('claude', true)).toBe('unverified');
});

test('CLI confirmed login is distinct from an untested key', () => {
  expect(getAuthState('codex', true, true)).toBe('signed_in');
  expect(getAuthState('claude', true, false)).toBe('unverified');
});

test('an observed authentication error overrides local login until reauthorization', () => {
  recordAuthError('codex', 'API Error: 401');
  expect(getAuthState('codex', true, true)).toBe('invalid');
  clearAuthError('codex');
  expect(getAuthState('codex', true, true)).toBe('signed_in');
});
