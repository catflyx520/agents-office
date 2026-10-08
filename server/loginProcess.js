// Keep an older process's close event from clearing a newer login attempt.
function finishLogin(state, proc, code) {
  if (state.loginProc !== proc) return false;
  state.loginProc = null;
  state.loginExitCode = code;
  return true;
}

function submitLoginCode(state, code, onError) {
  const proc = state.loginProc;
  if (!proc || proc.exitCode != null || proc.killed || !proc.stdin?.writable || proc.stdin.destroyed) {
    return state.loginExitCode === 0 ? 'completed' : 'inactive';
  }
  if (typeof code !== 'string' || !code.trim() || /[\r\n]/.test(code)) return 'invalid';
  try {
    proc.stdin.write(code.trim() + '\n', (err) => { if (err) onError(); });
    return 'submitted';
  } catch {
    onError();
    return 'inactive';
  }
}

module.exports = { finishLogin, submitLoginCode };
