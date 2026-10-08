const { finishLogin, submitLoginCode } = require('../server/loginProcess');

test('late code after successful completion is a completed flow, not an error', () => {
  const proc = {};
  const state = { loginProc: proc };
  expect(finishLogin(state, proc, 0)).toBe(true);
  expect(submitLoginCode(state, 'test-code', jest.fn())).toBe('completed');
});

test('old login close cannot clear a newer attempt', () => {
  const current = {};
  const state = { loginProc: current };
  expect(finishLogin(state, {}, 0)).toBe(false);
  expect(state.loginProc).toBe(current);
});

test('writes a single code only to a running writable process', () => {
  const write = jest.fn();
  const state = { loginProc: { exitCode: null, stdin: { writable: true, write } } };
  expect(submitLoginCode(state, 'test-code', jest.fn())).toBe('submitted');
  expect(write).toHaveBeenCalledWith('test-code\n', expect.any(Function));
  state.loginProc.exitCode = 0;
  expect(submitLoginCode(state, 'test-code', jest.fn())).toBe('inactive');
  expect(write).toHaveBeenCalledTimes(1);
});

test('failed process and malformed codes are handled without writing', () => {
  expect(submitLoginCode({ loginExitCode: 1 }, 'test', jest.fn())).toBe('inactive');
  const write = jest.fn();
  const state = { loginProc: { stdin: { writable: true, write } } };
  expect(submitLoginCode(state, 'first\nsecond', jest.fn())).toBe('invalid');
  expect(write).not.toHaveBeenCalled();
});
