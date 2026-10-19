import { getLanguage } from './i18n.js';

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
  const $ = id => document.getElementById(id);
  const text = (zh, en) => getLanguage() === 'zh' ? zh : en;
  let state = null;
  const bar = document.createElement('section');
  bar.id = 'og-experience'; bar.hidden = true;
  bar.innerHTML = `<div class="experience-top"><div class="experience-tabs" role="group" aria-label="Office mode">
    <button id="og-demo-mode" type="button">Demo</button><button id="og-live-mode" type="button"></button></div>
    <span id="og-connection-label" role="status"></span><button id="og-demo-run" type="button"></button></div>
    <p id="og-mode-description"></p><p id="og-upload-note"></p>`;
  $('og-toolbar').after(bar);
  const modal = document.createElement('div');
  modal.id = 'og-api-modal'; modal.hidden = true; modal.className = 'api-overlay';
  modal.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="og-api-title" class="api-dialog">
    <div class="api-heading"><h2 id="og-api-title"></h2><button id="og-api-close" aria-label="Close" type="button">✕</button></div>
    <p id="og-api-copy"></p><form id="og-api-form">
    <label><span id="og-api-provider-label"></span><select id="og-api-provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic / Claude</option></select></label>
    <label><span id="og-api-model-label"></span><input id="og-api-model" name="model" required maxlength="100" pattern="[a-zA-Z0-9._:\\-]+" value="gpt-4.1-mini" autocapitalize="off" spellcheck="false"></label>
    <label>API key<input id="og-api-key" type="password" required minlength="12" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <p id="og-api-privacy"></p><p id="og-api-status" role="status"></p>
    <div class="api-actions"><button id="og-api-connect" type="submit"></button><button id="og-api-disconnect" type="button"></button></div>
    </form></section>`;
  $('og-root').appendChild(modal);

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
    $('og-live-mode').textContent = text('正式模式 · 自带 AI', 'Live · Your AI');
    $('og-demo-mode').setAttribute('aria-pressed', String(demo));
    $('og-live-mode').setAttribute('aria-pressed', String(!demo));
    $('og-demo-run').hidden = !demo;
    $('og-demo-run').textContent = text('▶ 体验示例流程', '▶ Run sample workflow');
    $('og-connection-label').textContent = demo ? text('示例演示 · 不调用 AI', 'Scripted demo · no AI calls')
      : state.connected ? `${state.provider === 'openai' ? 'OpenAI' : 'Claude'} · ${state.model} · ` + (state.verified ? text('已验证', 'Verified') : text('等待首次请求验证', 'Not yet verified'))
        : text('尚未连接自己的 AI', 'Your AI is not connected');
    $('og-mode-description').textContent = demo
      ? text('先看看办公室如何协作。示例会展示 PM 规划、成员分工和汇总，不会运行真实任务。', 'Explore how the office works. The preset sample shows PM planning, teammate handoffs and a summary without running real tasks.')
      : text('使用自己的 OpenAI 或 Claude API，与团队对话、分配任务、获取代码建议。网页版不运行服务器命令或读写项目文件。', 'Use your OpenAI or Claude API for real conversations, team tasks and code suggestions. The web version does not run server commands or access project files.');
    $('og-upload-note').textContent = text('📎 为减少运行成本，暂不支持上传文件。', '📎 File uploads are disabled to reduce running costs.');
    $('og-login-btn').textContent = text('🔑 连接自己的 AI', '🔑 Connect your AI');
    $('og-upload-btn').textContent = text('📎 上传已禁用', '📎 Uploads disabled');
    $('og-upload-btn').title = $('og-upload-note').textContent;
    $('og-api-title').textContent = text('连接自己的 AI', 'Connect your AI');
    $('og-api-copy').textContent = text('填写你的 API key 和可用模型。发送任务会使用你自己的 API 额度，团队流程可能产生多次请求。', 'Enter your API key and an available model. Sending tasks uses your provider credits; team workflows can make multiple requests.');
    $('og-api-provider-label').textContent = text('服务商', 'Provider');
    $('og-api-model-label').textContent = text('模型 ID（可修改）', 'Model ID (editable)');
    $('og-api-privacy').textContent = text('Key 经本站服务器转发给你选择的服务商，仅保留在当前连接的内存中。不会写入文件、日志或浏览器存储。断开、切换 Demo 或刷新后需重新连接。', 'Your key passes through this server to your selected provider and stays only in memory for this connection. It is not written to files, logs or browser storage. Disconnecting, switching to Demo or refreshing clears it.');
    $('og-api-status').textContent = state.connected ? text('已接入当前连接。首次成功回复后显示“已验证”。', 'Configured for this connection. It becomes verified after a successful response.') : text('尚未连接。保存 key 不会发送付费请求。', 'Not connected. Saving a key does not make a paid request.');
    $('og-api-connect').textContent = text('连接并进入正式模式', 'Connect to Live mode');
    $('og-api-disconnect').textContent = text('断开并清除 Key', 'Disconnect & clear key');
    $('og-api-disconnect').disabled = !state.connected;
    $('og-board-office').title = demo ? text('Demo 不调用 AI，用量为 0。', 'Demo makes no AI calls: 0 tokens.') : text('仅当前连接的服务商返回用量，非美元费用。', 'Provider-reported tokens for this connection, not dollar cost.');
    office._renderHeader();
    $('og-compact-btn').style.display = 'none';
  }
  function open() {
    if (!state) return;
    if (state.experience !== 'live') office.ws.send({ type: 'set_experience', experience: 'live', language: getLanguage() });
    modal.hidden = false; draw(); $('og-api-key').focus();
  }
  const originalOpen = office._openLogin.bind(office);
  office._openLogin = () => state ? open() : originalOpen();
  $('og-demo-mode').onclick = () => { modal.hidden = true; $('og-api-key').value = ''; office.ws.send({ type: 'set_experience', experience: 'demo', language: getLanguage() }); };
  $('og-live-mode').onclick = open;
  $('og-demo-run').onclick = () => {
    office.activeId = 'pm'; office._renderHeader();
    $('og-input').value = text('演示一个待办事项应用的团队协作流程。', 'Show a sample team workflow for a to-do app.'); office._send();
  };
  $('og-api-provider').onchange = () => { $('og-api-model').value = $('og-api-provider').value === 'openai' ? 'gpt-4.1-mini' : 'claude-haiku-4-5-20251001'; };
  $('og-api-form').onsubmit = event => {
    event.preventDefault();
    if (!office.ws.send({ type: 'connect_api', provider: $('og-api-provider').value,
      model: $('og-api-model').value.trim(), key: $('og-api-key').value.trim(), language: getLanguage() })) {
      office._toast(text('连接已断开，请刷新页面。', 'Connection closed. Refresh the page.')); return;
    }
    $('og-api-key').value = '';
  };
  $('og-api-disconnect').onclick = () => { $('og-api-key').value = ''; office.ws.send({ type: 'disconnect_api' }); };
  const close = () => { modal.hidden = true; $('og-api-key').value = ''; };
  $('og-api-close').onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  office.ws.addEventListener('hosted_state', event => {
    const first = !state;
    office.hosted = true; state = event.detail; bar.hidden = false; document.body.classList.add('hosted-office');
    if (first) office._toggleConsole(false);
    if (state.reset) clearView();
    if (state.connected) modal.hidden = true;
    $('og-autocompact').parentElement.hidden = true;
    $('og-board-iterm').hidden = true;
    draw();
  });
  office.ws.addEventListener('disconnected', () => {
    if (!state) return;
    state = { ...state, connected: false, verified: false }; office.pending = {}; office.streamMsg = {};
    $('og-api-key').value = ''; draw();
    $('og-connection-label').textContent = text('连接已断开 · 刷新以重新连接', 'Disconnected · refresh to reconnect');
    office._renderChat();
  });
  window.addEventListener('office-language', draw);
  const originalUsage = office._renderUsage.bind(office);
  const originalHeader = office._renderHeader.bind(office);
  office._renderHeader = () => { originalHeader(); if (state) $('og-compact-btn').style.display = 'none'; };
  const originalEdit = office._openEdit.bind(office);
  office._openEdit = id => {
    originalEdit(id);
    if (state && id !== '__self') {
      for (const row of ['og-f-row-cwd', 'og-f-row-tools', 'og-f-row-model']) $(row).style.display = 'none';
      $('og-f-cwd').value = 'Browser workspace';
    }
  };
  office._renderUsage = () => {
    if (!state) return originalUsage();
    const counts = office.usage?.office?.total || { input: 0, output: 0, billable: 0 };
    $('og-usage-title').textContent = text('本次连接 · API 用量', 'This connection · API usage');
    $('og-usage-stats').replaceChildren();
    for (const [label, value] of [[text('输入 Tokens', 'Input tokens'), counts.input], [text('输出 Tokens', 'Output tokens'), counts.output]]) {
      const item = document.createElement('p'); item.textContent = `${label}: ${value.toLocaleString()}`; $('og-usage-stats').appendChild(item);
    }
    $('og-usage-tabs').replaceChildren(); $('og-usage-dims').style.display = 'none';
    $('og-usage-rank').textContent = text('用量来自本次连接的真实服务商响应。Demo 不产生模型用量。', 'Usage comes from actual provider responses in this connection. Demo uses no model tokens.');
    $('og-usage-foot').textContent = text('Token 数量不等于美元费用；实际账单以你的服务商账户为准。', 'Token counts are not dollar costs. Your provider account determines the actual bill.');
  };
}
