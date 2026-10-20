import { getLanguage } from './i18n.js';
import { setupBrowserFolders } from './browserFolders.js';
import { setupBrowserUsage } from './browserUsage.js';
import { setupBrowserAuth } from './browserAuth.js';
import { setupAgentModels } from './agentModels.js';
import { setupBrowserState } from './browserState.js';
import { setupBrowserCompact } from './browserCompact.js';

// Rebuild Markdown into an allowlist of DOM nodes; never insert model HTML.
export function renderMarkdown(element, source) {
  if (!window.marked?.parse) { element.textContent = source; return; }
  const parsed = new DOMParser().parseFromString(window.marked.parse(source), 'text/html');
  const tags = new Set('P BR STRONG EM CODE PRE UL OL LI A BLOCKQUOTE H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TR TD TH HR DEL'.split(' '));
  function clean(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
    if (!tags.has(node.tagName)) return document.createTextNode(node.textContent);
    const output = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === 'A') {
      try {
        const url = new URL(node.getAttribute('href'), location.href);
        if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
          output.href = url.href; output.target = '_blank'; output.rel = 'noopener noreferrer';
        }
      } catch { /* Invalid links remain plain text. */ }
    }
    for (const child of node.childNodes) output.appendChild(clean(child));
    return output;
  }
  element.replaceChildren(...[...parsed.body.childNodes].map(clean));
}

export function setupHostedOffice(office) {
  office.browserState = setupBrowserState(office);
  office.modelPicker = setupAgentModels(office);
  office.browserAuth = setupBrowserAuth(office);
  office.browserCompact = setupBrowserCompact(office);
  const $ = id => document.getElementById(id);
  const text = (zh, en) => getLanguage() === 'zh' ? zh : en;
  let state = null, demoGuide = null;
  const bar = document.createElement('section');
  bar.id = 'og-experience'; bar.hidden = true;
  bar.innerHTML = `<div class="experience-top"><div class="experience-tabs" role="group" aria-label="Office mode">
    <button id="og-demo-mode" type="button">Demo</button><button id="og-live-mode" type="button"></button></div>
    <span id="og-connection-label" role="status"></span><button id="og-demo-run" type="button"></button></div>
    <p id="og-mode-description"></p><p id="og-demo-guide" hidden aria-live="polite"></p><p id="og-upload-note"></p>`;
  $('og-toolbar').after(bar);
  function clearView() {
    office.histories = {}; office.streamMsg = {}; office.pending = {}; office.logLines = [];
    office.usage = null; office.attachments = [];
    $('og-input').value = ''; $('og-console-body').replaceChildren();
    office._renderPending(); office._renderChat(); office._renderBoards();
  }
  function draw() {
    if (!state) return;
    const demo = state.experience === 'demo';
    $('og-demo-mode').textContent = 'Demo';
    $('og-live-mode').textContent = text('正式模式', 'Live');
    $('og-demo-mode').setAttribute('aria-pressed', String(demo));
    $('og-live-mode').setAttribute('aria-pressed', String(!demo));
    $('og-demo-run').hidden = !demo;
    const phase = demoGuide?.phase || 'idle';
    const working = state.busy || demoGuide?.busy || ['discussion', 'confirmation', 'running'].includes(phase);
    const completed = demoGuide?.completedAgents?.length || 0;
    $('og-demo-run').disabled = !!working || office.ws.ws.readyState !== WebSocket.OPEN;
    $('og-demo-run').textContent = working
      ? phase === 'running'
        ? (completed === 3 ? text('PM 正在汇总…', 'PM is summarizing…') : text('团队执行中…', 'Team working…'))
        : phase === 'confirmation' ? text('正在播放用户确认…', 'Playing sample approval…')
          : text('正在播放需求讨论…', 'Playing discussion…')
      : ['complete', 'cancelled'].includes(phase) ? text('↻ 重新播放商城示例', '↻ Replay shop sample')
        : text('▶ 开始商城示例', '▶ Start shop sample');
    const guide = $('og-demo-guide');
    guide.hidden = !demo;
    guide.textContent = phase === 'discussion'
      ? text(`自动播放：用户与 PM 的需求讨论（${Math.min(demoGuide.step + 1, demoGuide.totalRounds)}/${demoGuide.totalRounds}）。示例回复和方案修改会自动展示，无需操作。`,
        `Autoplay: sample user/PM discussion (${Math.min(demoGuide.step + 1, demoGuide.totalRounds)}/${demoGuide.totalRounds}). Replies and proposal revisions appear automatically.`)
      : phase === 'confirmation' ? text('自动展示最终接口、任务清单和示例用户的确认，随后自动派发任务，无需点击确认。',
        'The final API, assignments and sample user’s approval play automatically, followed by task dispatch. No confirmation click is needed.')
        : phase === 'running' ? text(`成员详细总结：${completed}/3。进度和总结会自动显示在下方，三份齐全后 PM 再汇总。`,
          `Detailed teammate reports: ${completed}/3. Progress and reports appear below automatically; PM summarizes after all three arrive.`)
          : phase === 'complete' ? text('播放完成：用户讨论、方案修改、任务执行、三份成员总结和 PM 整体汇总已全部展示。',
            'Playback complete: the discussion, revisions, execution, three teammate reports and final PM summary are all shown.')
            : phase === 'cancelled' ? text('播放已停止，可以从头重新播放。', 'Playback stopped. You can replay it from the beginning.')
              : text('点击一次开始，自动播放商城需求讨论、修改、确认、并行执行和全部总结。观看过程无需回复或确认。',
                'Start once to autoplay the shop discussion, revisions, approval, parallel work and all reports. No replies or confirmations are needed.');
    $('og-connection-label').textContent = ['claude', 'codex'].map(provider => {
      const saved = office.browserAuth.status(provider);
      return `${provider === 'claude' ? 'Claude' : 'GPT / Codex'}: ` + (saved.present
        ? saved.expired ? text('凭证待续期', 'Renewal needed') : text('凭证已保存', 'Credentials saved')
        : text('未登录', 'Not signed in'));
    }).join(' · ');
    $('og-mode-description').textContent = demo
      ? text('全自动演示：示例用户与 PM 讨论并修改方案，确认后派发任务；Backend、Frontend、Mobile 并行执行并各自总结，最后 PM 汇总。全部为预设剧情，不运行真实任务。',
        'Automatic demonstration: a sample user and PM discuss, revise and approve a proposal. Backend, Frontend and Mobile execute in parallel and report individually; PM summarizes last. All content is scripted.')
      : state.browserWorkspace
        ? text('在「团队 → 编辑」选择你电脑上的 Project Folder。AI 可通过浏览器读写获授权的文件；不会使用服务器目录，也不能运行本地终端命令。聊天记录和登录 Token 保存在你自己电脑的浏览器 localStorage 中。后端仅在处理请求时临时使用，不保存这些数据。', 'Choose a Project Folder on your computer in Team → Edit. AI can access authorized files through your browser, without using server project directories or running local terminal commands. Chat history and sign-in tokens are stored in localStorage in the browser on your own computer. The backend uses them temporarily to process requests and does not retain them.')
        : text('在「模型与登录」中连接自己的 Claude Code 或 Codex 账号。网页版提供对话与代码建议，不运行服务器命令或读写项目文件。', 'Connect your Claude Code or Codex account in Models & sign-in. The web version provides chat and code suggestions without running server commands or accessing project files.');
    $('og-upload-note').textContent = text('📎 为减少运行成本，暂不支持上传文件。', '📎 File uploads are disabled to reduce running costs.');
    $('og-login-btn').textContent = text('🔑 模型与登录', '🔑 Models & sign-in');
    $('og-provider-description').textContent = text('分别管理 Claude 和 GPT 的浏览器登录凭证。每位成员在「团队 → 编辑」选择自己的模型。',
      'Manage Claude and GPT browser credentials separately. Each teammate chooses a model in Team → Edit.');
    $('og-provider-default-label').textContent = text('新成员默认服务商（已有成员独立选择）：', 'Default provider for new teammates (existing choices stay independent):');
    $('og-upload-btn').textContent = text('📎 上传已禁用', '📎 Uploads disabled');
    $('og-upload-btn').title = $('og-upload-note').textContent;
    $('og-board-office').title = text('点击查看此浏览器保存的用量明细；Demo 不增加用量。', 'View usage saved in this browser. Demo adds no tokens.');
    office._renderHeader();
    office.browserCompact.render();
  }
  // Reuse the original login modal and all its existing provider/login/code handlers.
  const originalOpen = office._openLogin.bind(office);
  office._openLogin = () => {
    if (state?.experience === 'demo') office.ws.send({ type: 'set_experience', experience: 'live', language: getLanguage() });
    originalOpen();
  };
  $('og-demo-mode').onclick = () => {
    office._closeLogin(); office.loginInProgress = false;
    $('og-login-verification-code').value = '';
    office.ws.send({ type: 'set_experience', experience: 'demo', language: getLanguage() });
  };
  $('og-live-mode').onclick = () => office._openLogin();
  $('og-demo-run').onclick = () => {
    if (demoGuide?.busy || ['discussion', 'confirmation', 'running'].includes(demoGuide?.phase)) return;
    office.activeId = 'pm'; office._renderHeader(); office._renderChat();
    $('og-demo-run').disabled = true;
    if (!office.ws.send({ type: 'start_demo', language: getLanguage() })) {
      draw(); office._toast(text('连接已断开，请刷新页面。', 'Connection closed. Refresh the page.'));
    }
  };
  office.ws.addEventListener('demo_state', event => { demoGuide = event.detail; draw(); });
  function appendDemoMessage(message, role) {
    if (state?.experience !== 'demo') return;
    office._hist('pm').push({ role, text: message.text, ts: message.ts, sessionId: message.sessionId, isDemoTranscript: true });
    office._saveHistories();
    if (office.activeId === 'pm') { office._renderChat(); office._renderHeader(); }
  }
  office.ws.addEventListener('demo_user_message', event => appendDemoMessage(event.detail, 'user'));
  office.ws.addEventListener('demo_transcript', event => appendDemoMessage({ ...event.detail,
    text: `**${office._name(event.detail.agentId)} · ${text('任务执行记录', 'Task execution record')}**\n\n${event.detail.text}` }, 'assistant'));
  office.ws.addEventListener('hosted_state', event => {
    const first = !state;
    office.hosted = true; state = event.detail; bar.hidden = false; document.body.classList.add('hosted-office');
    if (first) {
      office._toggleConsole(true);
      office.ws.send({ type: 'get_auth_status', language: getLanguage() });
    }
    office.workspaceEnabled = !!state.browserWorkspace;
    if (state.reset) { demoGuide = null; clearView(); }
    $('og-autocompact').parentElement.hidden = true;
    draw();
  });
  office.ws.addEventListener('login_resumed', event => {
    if (!state?.workspace) return;
    const { provider, url } = event.detail;
    originalOpen(); office.loginInProgress = true;
    $('og-login-step-1').style.display = 'none';
    $('og-login-step-2').style.display = 'flex';
    $('og-login-provider-title').textContent = `${provider === 'codex' ? 'Codex' : 'Claude'} OAuth`;
    $('og-login-submit-code').disabled = false;
    $('og-login-status').textContent = url
      ? text('👉 请点击下方链接，在新标签页中继续授权：', '👉 Open the link below to continue authorization in a new tab:')
      : text('⏳ 正在等待授权链接…', '⏳ Waiting for the authorization link…');
    if (url) {
      $('og-login-oauth-url').href = url;
      $('og-login-link-box').style.display = 'block';
      $('og-login-code-box').style.display = 'flex';
      if (provider === 'codex') {
        $('og-login-status').textContent = text('在新标签页继续授权。若最终的 127.0.0.1 页面无法打开，将地址栏完整 URL 粘贴到下方提交。',
          'Continue authorization in a new tab. If the final 127.0.0.1 page cannot open, paste its complete address below.');
        $('og-login-verification-code').placeholder = text('粘贴完整授权回调 URL', 'Paste the complete authorization callback URL');
      }
    }
  });
  office.ws.addEventListener('disconnected', () => {
    if (!state) return;
    state = { ...state, connected: false, verified: false }; office.pending = {}; office.streamMsg = {};
    office.loginInProgress = false; $('og-login-verification-code').value = '';
    draw();
    $('og-connection-label').textContent = text('连接已断开 · 刷新以重新连接', 'Disconnected · refresh to reconnect');
    office._renderChat();
  });
  window.addEventListener('office-language', draw);
  office.ws.addEventListener('auth_status_result', draw);
  const originalHeader = office._renderHeader.bind(office);
  office._renderHeader = () => { originalHeader(); office.modelPicker.renderHeader(); office.browserCompact.render(); };
  const originalEdit = office._openEdit.bind(office);
  office._openEdit = id => {
    originalEdit(id);
    if (state && !state.workspace && id !== '__self') {
      for (const row of state.browserWorkspace ? [] : ['og-f-row-cwd', 'og-f-row-tools']) $(row).style.display = 'none';
      if (!state.browserWorkspace) $('og-f-cwd').value = 'Browser workspace';
    }
  };
  setupBrowserUsage(office);
  setupBrowserFolders(office);
}
