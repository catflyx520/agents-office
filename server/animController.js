/**
 * 生成一批任务的管理者走动 + 委派动画事件（managerId 默认 pm，也可以是其他 manager agent）
 */
function buildDelegationEvents(tasks, managerId = 'pm') {
  const events = [];
  for (const task of tasks) {
    events.push({ type: 'agent_move',   agentId: managerId, toAgentId: task.agent });
    events.push({ type: 'agent_bubble', agentId: managerId, text: task.task });
    events.push({ type: 'agent_status', agentId: task.agent, status: 'working' });
  }
  // 管理者回到自己桌子
  events.push({ type: 'agent_move', agentId: managerId, toAgentId: managerId });
  return events;
}

/**
 * 生成任务完成事件
 */
function buildCompleteEvent(agentId, result) {
  return { type: 'agent_status', agentId, status: 'done', result };
}

module.exports = { buildDelegationEvents, buildCompleteEvent };
