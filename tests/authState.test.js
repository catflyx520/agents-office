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
