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
  // Two notice boards (mode + action, tutorial + sign-in status) pinned beside the controls sign
  // when the wall has room, otherwise a strip under the toolbar.
  const bar = document.createElement('section');
  bar.id = 'og-wall-board'; bar.hidden = true;
  bar.innerHTML = `<div class="wall-board" id="og-board-mode">
      <div class="wall-board-tabs" role="group" aria-label="Office mode">
        <button id="og-demo-mode" type="button">Demo</button><button id="og-live-mode" type="button"></button></div>
      <button id="og-demo-run" type="button" class="wall-board-primary"></button><span id="og-login-slot"></span>
      <span id="og-mode-hint" class="wall-board-note" aria-live="polite"></span></div>
    <div class="wall-board" id="og-board-help">
      <button id="og-help-btn" type="button" class="wall-board-secondary"></button>
      <span id="og-auth-title" class="wall-board-label"></span>
      <div id="og-connection-label" role="status"></div></div>`;
  const BOARDS_WIDTH = 170 + 12 + 162; // Matches the board widths and gap in hosted.css.
  const wall = $('og-wall-left');
  function placeBoard() {
    if (bar.hidden) return;
    const onWall = bar.parentElement === wall;
    // Width the other wall items need, plus the boards and the 16px flex gap.
    const others = wall.scrollWidth - (onWall ? bar.offsetWidth + 16 : 0);
    // The wall row is padded 18px each side and keeps a 16px gap before the door.
    const room = wall.parentElement.clientWidth - 36 - 16 - $('og-door').offsetWidth;
    const fits = others + BOARDS_WIDTH + 16 <= room;
    if (fits === onWall) return;
    bar.classList.toggle('board-top', !fits);
    if (fits) wall.append(bar); else $('og-toolbar').after(bar);
  }
  const watchWall = new ResizeObserver(placeBoard);
  for (const id of ['og-map', 'og-board-weather', 'og-usage-boards']) watchWall.observe($(id));
  $('og-toolbar').after(bar); bar.classList.add('board-top');
  const welcomeKey = 'vo_welcome_seen_v1';
  let welcomeDemo = false;
  const welcome = document.createElement('div');
  welcome.id = 'og-welcome'; welcome.hidden = true;
  welcome.setAttribute('role', 'dialog'); welcome.setAttribute('aria-modal', 'true'); welcome.setAttribute('aria-labelledby', 'og-welcome-title');
  welcome.innerHTML = `<div class="welcome-card"><h2 id="og-welcome-title">Agents Office</h2><p id="og-welcome-lead"></p>
    <ul id="og-welcome-points"></ul><div class="welcome-actions"><button id="og-welcome-demo" type="button"></button>
    <button id="og-welcome-skip" type="button"></button></div></div>`;
  document.body.appendChild(welcome);
  function drawWelcome() {
    $('og-welcome-lead').textContent = text('一个可视化的 AI 团队办公室：你把需求交给 PM，PM 拆分任务，再分派给 Backend、Frontend、Mobile 同事并行完成。',
      'A visual office for an AI team: give a request to the PM, who breaks it into tasks and hands them to Backend, Frontend and Mobile teammates working in parallel.');
    $('og-welcome-points').replaceChildren(...[
      text('🎬 Demo：预设剧情，免费观看，不调用 AI。', '🎬 Demo: a scripted walkthrough. Free, no AI calls.'),
      text('🔑 正式模式：连接你自己的 Claude 或 ChatGPT 账号。', '🔑 Live: connect your own Claude or ChatGPT account.'),
      text('🔒 聊天记录、登录凭证和项目文件都留在你自己的浏览器和电脑上。', '🔒 Chats, sign-in credentials and project files stay in your own browser and computer.'),
    ].map(line => Object.assign(document.createElement('li'), { textContent: line })));
    $('og-welcome-demo').textContent = text('▶ 观看演示', '▶ Watch the demo');
    $('og-welcome-skip').textContent = text('我自己看看', 'Explore on my own');
  }
  function openWelcome() { drawWelcome(); welcome.hidden = false; $('og-welcome-demo').focus(); }
  function closeWelcome() {
    welcome.hidden = true;
    try { localStorage.setItem(welcomeKey, '1'); } catch { /* The card may show again next visit. */ }
  }
  function runDemoIfReady() {
    if (!welcomeDemo || state?.experience !== 'demo' || office.ws.ws.readyState !== WebSocket.OPEN) return;
    welcomeDemo = false; $('og-demo-run').click();
  }
  $('og-welcome-demo').onclick = () => {
    closeWelcome(); welcomeDemo = true;
    if (state?.experience === 'demo') runDemoIfReady();
    else office.ws.send({ type: 'set_experience', experience: 'demo', language: getLanguage() });
  };
  $('og-welcome-skip').onclick = closeWelcome;
  welcome.onclick = event => { if (event.target === welcome) closeWelcome(); };
  welcome.onkeydown = event => { if (event.key === 'Escape') closeWelcome(); };
  $('og-help-btn').onclick = openWelcome;
  // The toolbar's sign-in button moves onto the board and becomes the Live-mode primary action.
  const login = $('og-login-btn');
  login.removeAttribute('style'); login.classList.add('wall-board-primary');
  login.setAttribute('role', 'button'); login.tabIndex = 0;
  login.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); login.click(); } };
  $('og-login-slot').replaceWith(login);
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
    $('og-login-btn').hidden = demo;
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
    const auth = ['claude', 'codex'].map(provider => {
      const saved = office.browserAuth.status(provider);
      return [provider === 'claude' ? 'Claude' : 'GPT', saved.present ? saved.expired ? '🟠' : '🟢' : '⚪',
        saved.present ? saved.expired ? text('凭证待续期', 'Renewal needed') : text('凭证已保存', 'Credentials saved') : text('未登录', 'Not signed in')];
    });
    $('og-mode-hint').textContent = demo
      ? phase === 'discussion' ? text(`需求讨论 ${round}`, `Discussion ${round}`)
        : phase === 'confirmation' ? text('示例用户确认中', 'Sample approval')
          : phase === 'running' ? text(`成员报告 ${completed}/3`, `Reports ${completed}/3`)
            : phase === 'complete' ? text('播放完成', 'Playback complete')
              : phase === 'cancelled' ? text('播放已停止', 'Playback stopped')
                : text('免费 · 不调用 AI', 'Free · no AI calls')
      : text('使用你自己的账号', 'Uses your own account');
    $('og-auth-title').textContent = text('登录状态', 'Sign-in status');
    $('og-connection-label').replaceChildren(...auth.map(([name, dot, label]) => {
      const row = document.createElement('div');
      row.className = 'wall-board-auth';
      row.append(Object.assign(document.createElement('b'), { textContent: `${dot} ${name}` }),
        Object.assign(document.createElement('span'), { textContent: label }));
      return row;
    }));
    $('og-demo-mode').title = text('预设演示：示例用户和 PM 讨论一个商城需求，随后 Backend、Frontend、Mobile 并行完成并由 PM 汇总。不调用 AI、不消耗 Token。',
      'Scripted demo: a sample user and the PM plan a shop feature, then Backend, Frontend and Mobile work in parallel and the PM summarizes. No AI calls or tokens.');
    $('og-live-mode').title = state.browserWorkspace
      ? text('使用你自己的 Claude / ChatGPT 账号。在「团队 → 编辑」选择你电脑上的 Project Folder；聊天记录和登录 Token 只保存在你的浏览器里。', 'Use your own Claude / ChatGPT account. Choose a Project Folder on your computer in Team → Edit; chats and sign-in tokens stay in your browser.')
      : text('使用你自己的 Claude / ChatGPT 账号进行对话与代码建议。', 'Use your own Claude / ChatGPT account for chat and code suggestions.');
    $('og-login-btn').textContent = text('🔑 登录与模型', '🔑 Sign in & models');
    $('og-provider-description').textContent = text('分别管理 Claude 和 GPT 的浏览器登录凭证。每位成员在「团队 → 编辑」选择自己的模型。',
      'Manage Claude and GPT browser credentials separately. Each teammate chooses a model in Team → Edit.');
    $('og-provider-default-label').textContent = text('新成员默认服务商（已有成员独立选择）：', 'Default provider for new teammates (existing choices stay independent):');
    $('og-upload-btn').textContent = text('📎 添加文件', '📎 Add files');
    $('og-upload-btn').title = text('把文件保存到这位同事在你电脑上的 Project Folder（uploads/），不会上传到服务器。', 'Save files into this teammate’s Project Folder on your computer (uploads/). Nothing is uploaded to the server.');
    $('og-attach-btn').title = $('og-upload-btn').title;
    $('og-help-btn').textContent = text('📖 使用教程', '📖 Tutorial');
    if (!welcome.hidden) drawWelcome();
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
    if (first) { let seen = null; try { seen = localStorage.getItem(welcomeKey); } catch { /* Show the card. */ } if (!seen) openWelcome(); }
    placeBoard();
    runDemoIfReady();
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
