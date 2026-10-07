const { buildDelegationEvents, buildCompleteEvent } = require('../server/animController');

test('buildDelegationEvents creates move+bubble+status events per task', () => {
  const tasks = [
    { agent: 'frontend-dev', task: '加导出按钮', waitFor: null },
    { agent: 'app-dev',      task: '加导出页面', waitFor: null },
  ];
  const events = buildDelegationEvents(tasks);
  const moveEvents   = events.filter(e => e.type === 'agent_move');
  const bubbleEvents = events.filter(e => e.type === 'agent_bubble');
  const statusEvents = events.filter(e => e.type === 'agent_status');

  expect(moveEvents.length).toBeGreaterThanOrEqual(2);
  expect(bubbleEvents.length).toBe(2);
  expect(statusEvents.every(e => e.status === 'working')).toBe(true);
  // PM 最终返回自己桌子
  const lastMove = moveEvents[moveEvents.length - 1];
  expect(lastMove.agentId).toBe('pm');
  expect(lastMove.toAgentId).toBe('pm');
});

test('buildCompleteEvent returns done status with result', () => {
  const ev = buildCompleteEvent('frontend-dev', '已在 ExportButton.tsx 完成');
  expect(ev).toEqual({
    type: 'agent_status',
    agentId: 'frontend-dev',
    status: 'done',
    result: '已在 ExportButton.tsx 完成',
  });
});
