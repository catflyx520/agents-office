const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(language) {
  const dir = path.join(__dirname, '../client/src');
  const english = JSON.parse(fs.readFileSync(path.join(dir, 'translations.js'), 'utf8').replace(/^export default /, '').replace(/;\s*$/, ''));
  const source = fs.readFileSync(path.join(dir, 'i18n.js'), 'utf8')
    .replace(/^import english[^\n]*\n/, '').replace(/^export /gm, '');
  const context = { english, localStorage: { getItem: () => language } };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.translate = tr;', context);
  return context.translate;
}

test('stored language translates authored labels and authentication states', () => {
  const tr = load('en');
  expect(tr('🔑 模型与登录')).toBe('🔑 Models & sign-in');
  expect(tr('🟢 已登录（本机账号）')).toBe('🟢 Signed in (local account)');
  expect(tr('🔴 授权失效，请重新授权或检查 key')).toMatch(/Authorization failed/);
});

test('Chinese stays unchanged and unknown strings have a safe fallback', () => {
  expect(load('zh')('选择一位同事')).toBe('选择一位同事');
  expect(load('en')('example-project-123')).toBe('example-project-123');
});
