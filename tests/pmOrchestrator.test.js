// tests/pmOrchestrator.test.js
const { extractPMPlan, buildPMSystemPrompt, scheduleTasks } = require('../server/pmOrchestrator');

const agents = [
  { id: 'frontend-dev', name: '小前', role: 'Frontend Developer', workDir: '/tmp/web' },
  { id: 'app-dev',      name: '小安', role: 'App Developer',      workDir: '/tmp/app' },
];

test('buildPMSystemPrompt includes all agent names and ids', () => {
  const prompt = buildPMSystemPrompt(agents);
  expect(prompt).toContain('frontend-dev');
  expect(prompt).toContain('小前');
  expect(prompt).toContain('app-dev');
  expect(prompt).toContain('JSON');
});

test('extractPMPlan parses valid JSON from PM response', () => {
  const response = `收到需求，这是我的计划：
{"plan":"前后端各做一个导出","tasks":[{"agent":"frontend-dev","task":"加按钮","waitFor":null},{"agent":"app-dev","task":"加页面","waitFor":null}]}`;
  const plan = extractPMPlan(response);
  expect(plan.tasks).toHaveLength(2);
  expect(plan.tasks[0].agent).toBe('frontend-dev');
  expect(plan.tasks[1].waitFor).toBeNull();
});

test('extractPMPlan returns null when no JSON found', () => {
  expect(extractPMPlan('好的，我来安排')).toBeNull();
});

test('scheduleTasks groups tasks by dependency level', () => {
  const tasks = [
    { agent: 'frontend-dev', task: '加按钮',   waitFor: null },
    { agent: 'app-dev',      task: '加页面',   waitFor: null },
    { agent: 'qa',           task: '写测试',   waitFor: 'frontend-dev' },
  ];
  const waves = scheduleTasks(tasks);
  // wave 0: frontend-dev + app-dev（无依赖）
  expect(waves[0].map(t => t.agent)).toEqual(expect.arrayContaining(['frontend-dev', 'app-dev']));
  // wave 1: qa（等 frontend-dev）
  expect(waves[1].map(t => t.agent)).toContain('qa');
});

test('extractPMPlan picks first valid JSON when response has extra content', () => {
  const response = `some text {"plan":"p","tasks":[{"agent":"a","task":"t","waitFor":null}]} trailing text`;
  const plan = extractPMPlan(response);
  expect(plan).not.toBeNull();
  expect(plan.tasks[0].agent).toBe('a');
});

// 回归：PM 说明文字里带内联 JSON 片段（如接口契约）时，旧的贪婪正则会从第一个 { 抓错、
// JSON.parse 失败而返回 null，导致 executePlan 永不触发。新的括号配对扫描必须跳过无 tasks 的内联片段。
test('extractPMPlan ignores inline JSON snippets in prose and finds the real plan', () => {
  const response = `整体思路：小后加接口 GET /api/v1/client/welcome-info → 返回 { "message": "welcome to example" }（按项目规范）。
小前和小安各做一个 welcome 页面。三端并行。

\`\`\`json
{
  "plan": "新增 welcomeInfo 接口并在两端做 welcome 页面",
  "tasks": [
    { "agent": "backend-dev", "task": "新增接口 welcome-info，返回 { \\"message\\": \\"welcome to example\\" }", "waitFor": null },
    { "agent": "frontend-dev", "task": "新增 welcome 页面调用该接口", "waitFor": null },
    { "agent": "app-dev", "task": "新增 welcome 页面调用该接口", "waitFor": null }
  ]
}
\`\`\``;
  const plan = extractPMPlan(response);
  expect(plan).not.toBeNull();
  expect(plan.tasks).toHaveLength(3);
  expect(plan.tasks.map(t => t.agent)).toEqual(['backend-dev', 'frontend-dev', 'app-dev']);
});

test('scheduleTasks returns empty array for circular dependencies', () => {
  const tasks = [
    { agent: 'a', task: 'x', waitFor: 'b' },
    { agent: 'b', task: 'y', waitFor: 'a' },
  ];
  const waves = scheduleTasks(tasks);
  expect(waves).toEqual([]);  // both stuck, nothing scheduled
});
