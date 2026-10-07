// server/pmOrchestrator.js

/**
 * 编排指令（共享）：怎么列团队、怎么在末尾吐 JSON 计划块
 */
function orchestrationInstructions(teamList) {
  return `你**只做规划与分配，绝不自己执行任务，也不要假装/“扮演”某个成员去做**——真正的执行由系统读取你的计划后自动派发给对应成员。你也无法亲自启动任何成员，输出计划即可。

当前团队：
${teamList}

收到需求后：先用一两句话说明整体思路（必要时可用 Read 看相关代码帮助判断），然后在回复**末尾**只附上一个如下 JSON 计划块：
{
  "plan": "整体思路简述",
  "tasks": [
    {
      "agent": "app-dev",
      "task": "具体要做什么，越详细越好",
      "waitFor": null
    }
  ]
}

要点：
- "agent" 必须填上面列表里的**英文 id**，不要填中文名字或角色名。
- waitFor 填某个 agent-id 表示等它完成后再开始，填 null 表示立即并行启动。
- 只在末尾返回一个 JSON 块，不要返回多个，也不要在 JSON 之后再描述“我来执行/我来扮演”。`;
}

function teamListOf(agents, teamIds) {
  return agents
    .filter(a => teamIds.includes(a.id))
    .map(a => `- ${a.id}（${a.name}，${a.role}）：负责 ${a.workDir}`)
    .join('\n');
}

/**
 * 生成 PM 的 system prompt。teamIds 可选：传了就只列这些成员（用于把
 * 已被其他管理者接管的成员排除在 PM 花名册之外），不传 = 除 pm 外全员（兼容旧行为）。
 */
function buildPMSystemPrompt(agents, teamIds = null) {
  const ids = teamIds || agents.filter(a => a.id !== 'pm').map(a => a.id);
  return `你是项目经理，负责把用户需求拆解并分配给团队成员。
${orchestrationInstructions(teamListOf(agents, ids))}`;
}

/**
 * 通用管理者（manager: true 的 agent）的编排 prompt：
 * 用它自己的 systemPrompt 当人设，团队只包含 config.team 里列的成员。
 */
function buildManagerSystemPrompt(config, agents) {
  const persona = (config.systemPrompt || '').trim() || `你是${config.name}，负责把需求拆解并分配给你的团队成员。`;
  const ids = Array.isArray(config.team) ? config.team : [];
  return `${persona}
${orchestrationInstructions(teamListOf(agents, ids))}`;
}

/**
 * 团队完成任务后，让管理者汇总向用户汇报用的 system prompt。
 * 不要求输出 JSON（区别于编排 prompt），避免又吐出一个计划块。
 */
function buildPMSummaryPrompt(roleLabel = '项目经理') {
  return `你是${roleLabel}。团队成员已完成你分配的任务，下面这条消息里是各成员的完成汇报。
请用简洁的中文向用户总结整体完成情况，逐个点出每位成员做了什么、结果如何。
直接说人话，不要输出任何 JSON。`;
}

/**
 * 从 PM 的完整回复文本中提取 JSON 计划，返回 { plan, tasks } 或 null。
 *
 * ⚠️ 不能用简单正则从「第一个 {」贪婪匹配：PM 的说明文字里常有内联 JSON 片段
 * （如接口契约 { "message": "welcome to example" }），会让正则抓错位置、JSON.parse 失败而返回 null，
 * 导致计划提取不到、executePlan 永不触发、三端收不到任务。
 *
 * 改用大括号配对扫描（正确处理字符串内的引号/转义）：枚举所有能配平并成功解析、
 * 且带 tasks 数组的 JSON 对象，取最后出现的那个作为真正的计划。这样内联示例（无 tasks）会被自然排除。
 */
function extractPMPlan(text) {
  if (!text || typeof text !== 'string') return null;
  const plans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {                       // 找到与 i 配平的闭合括号
          const candidate = text.slice(i, j + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && Array.isArray(obj.tasks)) plans.push({ start: i, obj });
          } catch { /* 不是合法 JSON，跳过 */ }
          break;
        }
      }
    }
  }
  if (plans.length === 0) return null;
  // 取最后出现（start 最大）的合法计划——PM 的正式计划总在回复末尾
  return plans.reduce((a, b) => (b.start > a.start ? b : a)).obj;
}

/**
 * 把 PM 写的 agent 标识（可能是 id、中文名、或角色名）解析成真正的 agent id。
 * 这样即使 PM 写了「小安」或「App Developer」，也能正确派给 app-dev。
 */
function resolveAgentId(key, agents) {
  if (key == null) return key;
  const k = String(key).trim();
  if (!k) return k;
  if (agents.some(a => a.id === k)) return k;             // 已是 id
  const lower = k.toLowerCase();
  const byName = agents.find(a => (a.name || '').toLowerCase() === lower);
  if (byName) return byName.id;                           // 按昵称
  const byRole = agents.find(a => (a.role || '').toLowerCase() === lower);
  if (byRole) return byRole.id;                           // 按角色
  return k;                                               // 都不匹配，原样返回（后续 loadAgent 会报错）
}

/**
 * 把计划里每个 task 的 agent / waitFor 统一解析成真实 agent id（就地修改并返回）。
 */
function normalizePlan(plan, agents) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  for (const t of plan.tasks) {
    t.agent = resolveAgentId(t.agent, agents);
    if (t.waitFor) t.waitFor = resolveAgentId(t.waitFor, agents);
  }
  return plan;
}

/**
 * 把任务列表按依赖关系分层（返回 wave 数组，每层可并行执行）
 */
function scheduleTasks(tasks) {
  const waves = [];
  const done = new Set();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const wave = remaining.filter(t => !t.waitFor || done.has(t.waitFor));
    if (wave.length === 0) {
      if (remaining.length > 0) {
        console.error('[pmOrchestrator] scheduleTasks: unresolvable dependencies, dropping tasks:', remaining.map(t => t.agent));
      }
      break; // 防止循环依赖死锁
    }
    waves.push(wave);
    wave.forEach(t => done.add(t.agent));
    remaining = remaining.filter(t => !wave.includes(t));
  }

  return waves;
}

module.exports = { buildPMSystemPrompt, buildManagerSystemPrompt, buildPMSummaryPrompt, extractPMPlan, scheduleTasks, resolveAgentId, normalizePlan };
