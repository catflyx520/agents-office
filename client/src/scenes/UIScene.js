// client/src/scenes/UIScene.js
export class UIScene extends Phaser.Scene {
  constructor() { super({ key: 'UIScene', active: true }); }  // active defaults to false in Phaser; must opt in so create() runs

  create() {
    this._agents = [];
    this._currentAgent = null;
    this._mode = 'auto';
    this._pendingPlan = null;
    this._logs = this._loadLogs(); // agentId -> 已落定的对话文本，持久化到 localStorage（刷新不丢）
    this._buffers = {};            // agentId -> 正在流式输出、尚未落定的文本
    this._pending = {};            // agentId -> 是否在等待响应（显示 loading）

    this._bindChatPanel();
    this._buildModeToggle();
    this._buildTeamButton();
    this._bindAgentManager();
    this._buildErrorDisplay();

    // Wire up ws — GameScene may be initialising in parallel; retry until available
    this._tryConnectWs();
  }

  _tryConnectWs() {
    this.ws = this.scene.get('GameScene')?.ws;
    if (!this.ws) {
      this.time.delayedCall(100, () => this._tryConnectWs());
      return;
    }
    this.ws.addEventListener('chat_chunk',   (e) => this._onChatChunk(e.detail));
    this.ws.addEventListener('plan_preview', (e) => this._onPlanPreview(e.detail));
    this.ws.addEventListener('agents_list',  (e) => this.onAgentsList(e.detail.agents));
    this.ws.addEventListener('error',        (e) => this._showError(e.detail.message));
    // agent_status 同时驱动 loading：working = 转圈，done = 停。每个 agent 各自独立。
    this.ws.addEventListener('agent_status', (e) => {
      const { agentId, status } = e.detail;
      if (status === 'working') this._setPending(agentId, true);
      else if (status === 'done') this._setPending(agentId, false);
    });
  }

  // ── Chat Panel ──────────────────────────────────────────────

  // 聊天面板是页面里的纯 HTML（在游戏画布外的右侧），这里只抓引用并绑事件
  _bindChatPanel() {
    const $ = (id) => document.getElementById(id);
    this._el = {
      panel:       $('chat-panel'),
      title:       $('chat-title'),
      log:         $('chat-log'),
      input:       $('vo-chat-input'),
      send:        $('chat-send'),
      close:       $('chat-close'),
      confirm:     $('chat-confirm'),
      attach:      $('chat-attach'),
      fileInput:   $('vo-file-input'),
      attachments: $('chat-attachments'),
    };
    this._attachments = []; // 当前待发送的附件 [{name, path}]

    this._el.close.addEventListener('click', () => this.closeChat());
    this._el.send.addEventListener('click', () => this._sendMessage());
    this._el.attach.addEventListener('click', () => this._el.fileInput.click());
    this._el.fileInput.addEventListener('change', (e) => {
      this._onFilesSelected(e.target.files);
      e.target.value = ''; // 重置，使同一文件可再次选择
    });

    // Enter 发送；Ctrl/⌘+Enter 换行；Shift+Enter 也换行（textarea 默认行为）
    this._el.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._insertNewline(); }
      else if (e.shiftKey) { /* 默认换行，不拦截 */ }
      else { e.preventDefault(); this._sendMessage(); }
    });

    // 随内容自适应高度（向上挤压日志区），到 max-height 后内部滚动
    this._el.input.addEventListener('input', () => this._autoGrow());

    // 输入框聚焦时关掉 Phaser 键盘捕获，否则方向键等会被游戏拦截
    this._el.input.addEventListener('focus', () => { this.game.input.keyboard.enabled = false; });
    this._el.input.addEventListener('blur',  () => { this.game.input.keyboard.enabled = true; });

    // 点游戏画面（地板）时让输入框失焦——Phaser 会 preventDefault 阻止默认失焦，所以手动 blur
    this.input.on('pointerdown', () => this._el.input.blur());

    // Esc / Ctrl(⌘)+C：有任务在跑就取消，否则 Esc 退出输入框把键盘还给小人。
    // 用 document 级监听，聚焦输入框与否都生效。
    document.addEventListener('keydown', (e) => {
      if (this._el.panel.classList.contains('hidden')) return;
      const id = this._currentAgent?.id;
      if (!id) return;
      const isCopy = (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C');
      if (e.key !== 'Escape' && !isCopy) return;
      if (this._taskRunning(id)) {
        if (isCopy && String(window.getSelection?.() || '')) return; // 有选中文本时让复制正常
        e.preventDefault();
        this._cancelCurrent();
      } else if (e.key === 'Escape') {
        this._el.input.blur();
      }
    });

    this._el.confirm.addEventListener('click', () => {
      this.ws.send({ type: 'confirm_plan', agentId: 'pm' });
      this._el.confirm.classList.add('hidden');
    });
  }

  openChat(agentConfig) {
    this._currentAgent = agentConfig;
    this._el.title.textContent = `💬 ${agentConfig.name}（${agentConfig.role}）`;
    this._el.panel.classList.remove('hidden'); // 先显示，否则面板隐藏时 scrollHeight=0、滚不到底
    this._attachments = [];                     // 切换 agent 清空待发送附件
    this._renderAttachments();
    this._renderLog();                          // 恢复历史并滚到最新
  }

  closeChat() {
    this._el.panel.classList.add('hidden');
    this._el.confirm.classList.add('hidden');
    this._currentAgent = null;
  }

  _nameOf(id) {
    return this._agents.find(a => a.id === id)?.name || id;
  }

  // 渲染当前 agent 的日志：已落定文本 +（正在流式的文本 或 loading 提示）
  _renderLog() {
    const id = this._currentAgent?.id;
    if (!id) { this._el.log.textContent = ''; return; }
    let text = this._logs[id] || '';
    if (this._buffers[id]) {
      text += `🤖 ${this._nameOf(id)}: ${this._buffers[id]}`; // 流式中的回复
    } else if (this._pending[id]) {
      text += '⏳ 处理中…';                                    // 还没开始吐字
    }
    this._el.log.textContent = text;
    this._el.log.scrollTop = this._el.log.scrollHeight;
  }

  // 切换某 agent 的 loading 状态，若正在查看则刷新
  _setPending(id, on) {
    if (!id) return;
    this._pending[id] = on;
    if (id === this._currentAgent?.id) this._renderLog();
  }

  // 把文本落定到某 agent 的持久日志
  _commitLog(id, text) {
    if (!id) return;
    this._logs[id] = (this._logs[id] || '') + text;
    this._saveLogs();
    if (id === this._currentAgent?.id) this._renderLog();
  }

  _sendMessage() {
    const text = this._el.input.value.trim();
    const atts = this._attachments;
    if ((!text && atts.length === 0) || !this._currentAgent) return;

    const id = this._currentAgent.id;
    let display = `🧑 你: ${text}`;
    if (atts.length) display += `\n   📎 ${atts.map(a => a.name).join('、')}`;
    this._commitLog(id, display + '\n');
    this._el.input.value = '';
    this._autoGrow(); // 发送后高度收回最小
    this._buffers[id] = '';
    this._setPending(id, true); // 立刻显示 loading

    this.ws.send({ type: 'chat', agentId: id, message: text, attachments: atts });
    this._attachments = [];
    this._renderAttachments();
  }

  // ── 附件上传 ────────────────────────────────────────────────
  _onFilesSelected(fileList) {
    for (const file of fileList) this._uploadFile(file);
  }

  async _uploadFile(file) {
    const id = this._currentAgent?.id || 'unknown';
    try {
      const res = await fetch(`/upload?agentId=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._attachments.push({ name: data.name, path: data.path });
      this._renderAttachments();
    } catch (err) {
      this._showError(`上传失败: ${err.message}`);
    }
  }

  _renderAttachments() {
    const box = this._el.attachments;
    box.innerHTML = '';
    this._attachments.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `📎 ${a.name}`;
      const x = document.createElement('span');
      x.className = 'attach-remove';
      x.textContent = '✕';
      x.addEventListener('click', () => { this._attachments.splice(i, 1); this._renderAttachments(); });
      chip.append(name, x);
      box.appendChild(chip);
    });
  }

  // 在光标处插入换行（Ctrl+Enter）
  _insertNewline() {
    const el = this._el.input;
    const s = el.selectionStart, e = el.selectionEnd;
    el.value = el.value.slice(0, s) + '\n' + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + 1;
    this._autoGrow();
  }

  // 让输入框高度跟随内容（CSS 的 max-height 负责封顶 + 内部滚动）
  _autoGrow() {
    const el = this._el.input;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  // 该 agent 是否有正在处理的任务（loading 中 或 正在流式输出）
  _taskRunning(id) {
    return !!(id && (this._pending[id] || this._buffers[id]));
  }

  // 取消当前对话框正在跑的任务
  _cancelCurrent() {
    const id = this._currentAgent?.id;
    if (!this._taskRunning(id)) return;
    this.ws.send({ type: 'cancel', agentId: id });
    const buf = (this._buffers[id] || '').trim();
    if (buf) this._commitLog(id, `🤖 ${this._nameOf(id)}: ${buf}\n`); // 落定已输出的部分
    this._buffers[id] = '';
    this._commitLog(id, `⛔ 已取消\n`);
    this._setPending(id, false);
  }

  // 每个 agent 的输出都写进它「自己」的日志（走到小前就能看到小前的详细记录），
  // 并支持多 agent 并行流式（PM 委派时各自缓冲，互不串台）。
  _onChatChunk(detail) {
    const id = detail.agentId;
    if (detail.text) {
      this._pending[id] = false;
      this._buffers[id] = (this._buffers[id] || '') + detail.text;
      if (id === this._currentAgent?.id) this._renderLog();
    }
    if (detail.done) {
      let buf = (this._buffers[id] || '').trim();
      // PM 回复里那段任务分配 JSON 不用展示给用户（服务器已自行解析）
      if (id === 'pm') buf = buf.replace(/\{[\s\S]*?"tasks"[\s\S]*?\]\s*\}/, '').trim();
      if (buf) this._commitLog(id, `🤖 ${this._nameOf(id)}: ${buf}\n`);
      this._buffers[id] = '';
      this._setPending(id, false);
    }
  }

  _onPlanPreview(detail) {
    this._pendingPlan = detail.plan;
    const taskLines = detail.plan.tasks
      .map(t => `  · ${t.agent}: ${t.task.slice(0, 50)}`)
      .join('\n');
    this._commitLog('pm', `📋 PM 计划：\n${taskLines}\n`);
    this._el.confirm.classList.remove('hidden');
  }

  _loadLogs() {
    try { return JSON.parse(localStorage.getItem('vo_logs') || '{}'); } catch { return {}; }
  }

  _saveLogs() {
    try { localStorage.setItem('vo_logs', JSON.stringify(this._logs)); } catch { /* 配额满等忽略 */ }
  }

  // ── Mode Toggle ─────────────────────────────────────────────

  _buildModeToggle() {
    this._modeText = this.add.text(8, 8, '⚡ 全自动', {
      fontSize: '9px', color: '#ffdd55', fontFamily: 'monospace',
      backgroundColor: '#1a1a00', padding: { x: 6, y: 3 }
    }).setDepth(100).setInteractive({ cursor: 'pointer' })
      .on('pointerdown', () => this._toggleMode());
  }

  _toggleMode() {
    this._mode = this._mode === 'auto' ? 'confirm' : 'auto';
    const isAuto = this._mode === 'auto';
    this._modeText.setText(isAuto ? '⚡ 全自动' : '✋ 先确认');
    this._modeText.setColor(isAuto ? '#ffdd55' : '#ff8855');
    this.ws.send({ type: 'set_mode', mode: this._mode });
  }

  // ── 团队管理弹窗 ─────────────────────────────────────────

  _buildTeamButton() {
    this.add.text(8, 600 - 24, '👥 团队管理', {
      fontSize: '9px', color: '#00ccff', fontFamily: 'monospace',
      backgroundColor: '#001a2e', padding: { x: 6, y: 3 }
    }).setDepth(100).setInteractive({ cursor: 'pointer' })
      .on('pointerdown', () => this._openAgentManager());
  }

  // 抓弹窗 DOM 引用并绑定事件（弹窗本身是 index.html 里的纯 HTML）
  _bindAgentManager() {
    const $ = (id) => document.getElementById(id);
    this._am = {
      panel: $('agent-manager'),
      list:  $('agent-list'),
      add:   $('am-add'),
      close: $('am-close'),
      form:  $('agent-form'),
      name:  $('af-name'),
      emoji: $('af-emoji'),
      role:  $('af-role'),
      dir:   $('af-dir'),
      tools: $('af-tools'),
      prompt:$('af-prompt'),
      save:  $('af-save'),
      cancel:$('af-cancel'),
    };
    this._editingAgent = null;

    this._am.close.addEventListener('click', () => this._closeAgentManager());
    // 点遮罩空白处关闭
    this._am.panel.addEventListener('click', (e) => { if (e.target === this._am.panel) this._closeAgentManager(); });
    this._am.add.addEventListener('click', () => this._showAgentForm(null));
    this._am.cancel.addEventListener('click', () => this._hideAgentForm());
    this._am.save.addEventListener('click', () => this._saveAgentForm());

    // 表单输入时关掉 Phaser 键盘捕获
    [this._am.name, this._am.emoji, this._am.role, this._am.dir, this._am.tools, this._am.prompt].forEach(el => {
      el.addEventListener('focus', () => { this.game.input.keyboard.enabled = false; });
      el.addEventListener('blur',  () => { this.game.input.keyboard.enabled = true; });
    });
  }

  _openAgentManager() {
    this._hideAgentForm();
    this._renderAgentList();
    this._am.panel.classList.remove('hidden');
  }

  _closeAgentManager() {
    this._am.panel.classList.add('hidden');
    this._hideAgentForm();
  }

  _renderAgentList() {
    const box = this._am.list;
    box.innerHTML = '';
    this._agents.forEach(agent => {
      const row = document.createElement('div');
      row.className = 'am-row';

      const emoji = document.createElement('span');
      emoji.className = 'am-emoji';
      emoji.textContent = agent.emoji || '🤖';

      const info = document.createElement('div');
      info.className = 'am-info';
      const name = document.createElement('div');
      name.className = 'am-name';
      name.textContent = `${agent.name}（${agent.role || ''}）`;
      const meta = document.createElement('div');
      meta.className = 'am-meta';
      meta.textContent = agent.workDir || '';
      info.append(name, meta);

      const editBt = document.createElement('button');
      editBt.className = 'am-btn';
      editBt.textContent = '更改';
      editBt.addEventListener('click', () => this._showAgentForm(agent));

      row.append(emoji, info, editBt);

      // PM 是核心编排者，不允许删除
      if (agent.id !== 'pm') {
        const delBt = document.createElement('button');
        delBt.className = 'am-btn danger';
        delBt.textContent = '删除';
        delBt.addEventListener('click', () => this._deleteAgent(agent));
        row.append(delBt);
      }

      box.appendChild(row);
    });
  }

  // agent 为 null => 新增；否则 => 编辑该 agent
  _showAgentForm(agent) {
    this._editingAgent = agent;
    this._am.name.value   = agent?.name   || '';
    this._am.emoji.value  = agent?.emoji  || '🤖';
    this._am.role.value   = agent?.role   || '';
    this._am.dir.value    = agent?.workDir || '';
    this._am.tools.value  = (agent?.tools || ['Edit', 'Read', 'Bash']).join(',');
    this._am.prompt.value = agent?.systemPrompt || '';
    this._am.form.classList.remove('hidden');
    this._am.name.focus();
  }

  _hideAgentForm() {
    this._editingAgent = null;
    this._am.form.classList.add('hidden');
  }

  _saveAgentForm() {
    const name   = this._am.name.value.trim();
    const emoji  = this._am.emoji.value.trim() || '🤖';
    const role   = this._am.role.value.trim();
    const dir    = this._am.dir.value.trim();
    const prompt = this._am.prompt.value.trim();
    const tools  = this._am.tools.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!name || !role || !dir) { this._showError('请填写昵称、角色和工作目录'); return; }

    let config;
    if (this._editingAgent) {
      // 编辑：保留原 id / avatar 等字段，只覆盖可改项
      config = { ...this._editingAgent, name, emoji, role, workDir: dir,
        tools: tools.length ? tools : this._editingAgent.tools,
        systemPrompt: prompt };
    } else {
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-' + Date.now();
      config = { id, name, emoji, role, workDir: dir,
        tools: tools.length ? tools : ['Edit', 'Read', 'Bash'],
        avatar: null,
        systemPrompt: prompt || `你是 ${role}，负责 ${dir} 项目。收到任务后先读相关文件再动手，完成后简短汇报。` };
    }
    this.ws.send({ type: 'add_agent', config });
    this._hideAgentForm();
    // 列表会在收到 agents_list 广播后自动刷新
  }

  _deleteAgent(agent) {
    if (!window.confirm(`确定删除 ${agent.name}？`)) return;
    this.ws.send({ type: 'delete_agent', agentId: agent.id });
  }

  // ── Error display ────────────────────────────────────────────

  _buildErrorDisplay() {
    this._errorText = this.add.text(400, 580, '', {
      fontSize: '9px', color: '#ff4444', fontFamily: 'monospace',
      backgroundColor: '#2a0000', padding: { x: 6, y: 3 }
    }).setOrigin(0.5).setDepth(200).setVisible(false);
  }

  _showError(msg) {
    this._errorText.setText(`⚠ ${msg}`).setVisible(true);
    this.time.delayedCall(4000, () => this._errorText.setVisible(false));
  }

  // ── Public API ───────────────────────────────────────────────

  onAgentsList(agents) {
    this._agents = agents;
    // 管理弹窗开着时，增删改后实时刷新列表
    if (this._am && !this._am.panel.classList.contains('hidden')) this._renderAgentList();
  }
}
