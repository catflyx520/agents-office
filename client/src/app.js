// client/src/app.js
// 「小办公室」前端控制器（纯 DOM/SVG，替代原 Phaser 版），接到真实 WebSocket 后端。
import { WSClient } from './net/WSClient.js';

const NEAR_DIST = 120;
const WALK_SPEED = 3.4;
const HIST_KEY = 'vo_office_history';

// 角色按网格排布：每行 4 个，第一排在上、溢出排到下一排
const PER_ROW = 4;
const ROW_Y = [390, 640, 890]; // 每一排的「身体中心」y（用于走近判定与定位）

const $ = (id) => document.getElementById(id);

class Office {
  constructor() {
    this.ws = new WSClient(`ws://${location.host}`);
    this.agents = [];           // 服务器下发的 agent 列表
    this.byId = {};             // id -> agent
    this.order = [];            // 展示顺序（PM 在最前）
    this.slots = {};            // id -> {el, bub, ringwrap, ringfg, anchor:[x,y]}
    this.activeId = null;
    this.histories = this._loadHistories();
    this.streamMsg = {};        // id -> 正在流式写入的 assistant 消息对象
    this.pending = {};          // id -> 是否在等待响应（loading）
    this.attachments = [];      // 待发送附件 [{name,path}]
    this.mode = 'auto';
    this.editingId = null;
    this.player = this._loadPlayer();
    this.keys = {};
    this.facing = 1;
    this.nearId = null;
    this.logLines = [];          // 日志台缓存的行（最多 LOG_MAX 行）
    this.consoleOpen = false;
    this.consoleH = this._loadConsoleH(); // 日志台高度（用户可拖动，记忆到 localStorage）
    this.usage = null;           // 服务器推来的 token 用量报表
    this.autoCompactK = 0;       // 自动压缩阈值（k token，0=关闭）
    this.compactLog = [];        // 压缩谱系（服务器推送）
    this.usageSource = 'office'; // 用量明细当前看的来源：office | iterm
    this.usageRank = 'total';    // 排行依据：today | week | total

    this._bindUI();
    this._bindWS();
    this._applyModeUI();
    this._applyPlayerBadge();
    this._startLoop();
    this._startClock();
    window.addEventListener('resize', () => this._positionSlots());
  }

  // 墙上天气牌：WMO weather_code → emoji + 中文描述
  _onWeather(w) {
    if (!w) return;
    const c = w.code;
    const [emoji, desc] =
      c === 0 ? ['☀️', '晴'] :
      c <= 2 ? ['🌤', '多云'] :
      c === 3 ? ['☁️', '阴'] :
      c <= 48 ? ['🌫', '雾'] :
      c <= 57 ? ['🌦', '毛毛雨'] :
      c <= 67 ? ['🌧', '雨'] :
      c <= 77 ? ['🌨', '雪'] :
      c <= 82 ? ['🌧', '阵雨'] :
      c <= 86 ? ['🌨', '阵雪'] :
      ['⛈', '雷雨'];
    this.weather = w;
    $('og-weather-emoji').textContent = emoji;
    $('og-weather-city').textContent = (w.manual ? '📍' : '') + (w.city || '本地');
    $('og-weather-temp').textContent = `${w.temp}°C`;
    $('og-weather-desc').textContent = `${desc} · ${w.tempMin}~${w.tempMax}° · 湿度${w.humidity}%`;
    const board = $('og-board-weather');
    board.style.display = 'block';
    board.title = `${w.city} ${desc} ${w.temp}°C（${w.tempMin}~${w.tempMax}°）· 湿度 ${w.humidity}% · 风速 ${w.wind}km/h`
      + `\n定位：${w.manual ? `手动邮编 ${w.zip}` : '按 IP 自动'} · 更新于 ${new Date(w.ts).toLocaleTimeString('zh-CN')}`
      + '\n点击可设置邮编位置';
  }

  // 墙上时钟：指针跟随真实时间，每秒刷新；窗景每分钟按时段刷新
  _startClock() {
    const tick = () => {
      const now = new Date();
      const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds();
      const rot = (el, deg) => { const n = $(el); if (n) n.setAttribute('transform', `rotate(${deg} 23 23)`); };
      rot('og-clock-h', h * 30 + m * 0.5);
      rot('og-clock-m', m * 6 + s * 0.1);
      rot('og-clock-s', s * 6);
      const clock = $('og-clock');
      if (clock) clock.setAttribute('title', now.toLocaleString('zh-CN'));
      // 测试模式：_winFakeTime 存在时窗景用假时间渲染（点时钟设置）
      const winNow = this._winFakeTime || now;
      if (this._winMinute !== winNow.getMinutes() || this._winForce) {
        this._winMinute = winNow.getMinutes();
        this._winForce = false;
        this._renderWindows(winNow);
      }
    };
    tick();
    setInterval(tick, 1000);
    // 【测试用】点时钟输入时间预览窗景，留空恢复真实时间
    const clock = $('og-clock');
    if (clock) {
      clock.style.cursor = 'pointer';
      clock.onclick = () => {
        const v = window.prompt('测试窗景：输入时间（如 20:30 / 6:00），留空恢复真实时间', '');
        if (v === null) return;
        const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
          const d = new Date();
          d.setHours(Number(m[1]), Number(m[2]));
          this._winFakeTime = d;
          this._toast(`🕐 窗景已切到 ${v.trim()}（测试模式，点时钟留空恢复）`);
        } else {
          this._winFakeTime = null;
          this._toast('🕐 窗景已恢复真实时间');
        }
        this._winForce = true;
      };
    }
  }

  // 窗景：按当地时间分时段（清晨/白天/黄昏/夜晚），太阳/月亮沿弧线走真实位置
  _renderWindows(now) {
    const win1 = $('og-win1');
    if (!win1) return;
    const hf = now.getHours() + now.getMinutes() / 60; // 小数小时
    const phase = (hf < 5 || hf >= 19.5) ? 'night' : hf < 7.5 ? 'dawn' : hf < 17 ? 'day' : 'dusk';

    const SCENES = {
      dawn:  { sky: 'linear-gradient(#f7b98c,#ffe8cf)', body: '#ffb36b', cloud: '#fff', cloudOp: .85, city: 'brightness(.85)', stars: false, lights: false, moon: false },
      day:   { sky: 'linear-gradient(#bfe6ff,#eaf7ff)', body: '#ffd36b', cloud: '#fff', cloudOp: .92, city: 'none',            stars: false, lights: false, moon: false },
      dusk:  { sky: 'linear-gradient(#f78a5e,#ffd9a0)', body: '#ff8c5a', cloud: '#ffe3c8', cloudOp: .8, city: 'brightness(.7) saturate(.8)', stars: false, lights: true, moon: false },
      night: { sky: 'linear-gradient(#2b3a5e,#48598a)', body: '#fff2c9', cloud: null, cloudOp: 0, city: 'brightness(.45) saturate(.5)', stars: true, lights: true, moon: true },
    };
    const sc = SCENES[phase];

    // 天体弧线：白天 6:00→19:30 走一遍，夜里 19:30→次日 5:30 月亮走一遍
    let t;
    if (phase === 'night') t = ((hf - 19.5 + 24) % 24) / 10;      // 0..1 横跨夜晚
    else t = Math.max(0, Math.min(1, (hf - 6) / 13.5));            // 0..1 横跨白天
    const x = Math.round(8 + t * 96);                               // 窗内宽 138px，天体 26px
    const y = Math.round(58 - Math.sin(Math.PI * t) * 44);          // 地平线 58 ↔ 正午 14

    win1.style.background = sc.sky;
    const win2 = $('og-win2');
    if (win2) win2.style.background = sc.sky;

    const sun = $('og-win1-sun');
    sun.style.left = x + 'px';
    sun.style.right = 'auto';
    sun.style.top = y + 'px';
    sun.style.background = sc.body;
    sun.style.boxShadow = phase === 'night' ? '0 0 8px rgba(255,242,201,.7)' : phase === 'day' ? '0 0 6px rgba(255,211,107,.6)' : '0 0 8px rgba(255,140,90,.55)';

    // 月亮 = 天体上叠一个天空色圆偏移出月牙
    const mask = $('og-win1-moonmask');
    mask.style.display = sc.moon ? 'block' : 'none';
    if (sc.moon) { mask.style.left = (x + 8) + 'px'; mask.style.top = (y - 3) + 'px'; }

    // 云：夜晚隐藏，黄昏染橙
    ['og-win1-c1', 'og-win1-c2'].forEach(id => {
      const c = $(id);
      c.style.display = sc.cloud ? 'block' : 'none';
      if (sc.cloud) { c.style.background = sc.cloud; c.style.opacity = sc.cloudOp; }
    });

    $('og-win1-stars').style.display = sc.stars ? 'block' : 'none';
    $('og-win2-stars').style.display = sc.stars ? 'block' : 'none';
    $('og-win2-city').style.filter = sc.city;
    $('og-win2-lights').style.display = sc.lights ? 'block' : 'none';

    const label = { dawn: '🌅 清晨', day: '☀️ 白天', dusk: '🌇 黄昏', night: '🌙 夜晚' }[phase];
    win1.title = `${label} · ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (win2) win2.title = win1.title;
  }

  // ── 持久化 ────────────────────────────────────────────────
  _loadHistories() {
    try {
      const cur = JSON.parse(localStorage.getItem(HIST_KEY) || '{}');
      if (Object.keys(cur).length) return cur;
      const migrated = this._migrateOldLogs(); // 新记录为空时，尝试导入旧版 vo_logs
      if (Object.keys(migrated).length) { localStorage.setItem(HIST_KEY, JSON.stringify(migrated)); return migrated; }
      return cur;
    } catch { return {}; }
  }

  // 把旧版（Phaser 版）的 vo_logs 纯文本记录解析成新版的消息数组
  _migrateOldLogs() {
    const out = {};
    let old;
    try { old = JSON.parse(localStorage.getItem('vo_logs') || '{}'); } catch { return out; }
    for (const id in old) {
      if (typeof old[id] !== 'string') continue;
      const msgs = [];
      for (const line of old[id].split('\n')) {
        if (line.startsWith('🧑')) msgs.push({ role: 'user', text: line.replace(/^🧑[^:：]*[:：]\s*/, '') });
        else if (line.startsWith('🤖')) msgs.push({ role: 'assistant', text: line.replace(/^🤖[^:：]*[:：]\s*/, '') });
        else if (/^[✅⛔📋]/.test(line)) msgs.push({ role: 'assistant', text: line });
        else if (msgs.length && line.trim()) msgs[msgs.length - 1].text += '\n' + line;
      }
      if (msgs.length) out[id] = msgs;
    }
    return out;
  }

  _saveHistories() { try { localStorage.setItem(HIST_KEY, JSON.stringify(this.histories)); } catch {} }
  _loadPlayer() { try { return { x: 300, y: 430, name: 'YOU', accent: '#ff8c42', ...(JSON.parse(localStorage.getItem('vo_office_player')) || {}) }; } catch { return { x: 300, y: 430, name: 'YOU', accent: '#ff8c42' }; } }
  _savePlayer() { try { localStorage.setItem('vo_office_player', JSON.stringify(this.player)); } catch {} }
  _hist(id) { return (this.histories[id] = this.histories[id] || []); }

  // ── WebSocket 接线 ────────────────────────────────────────
  _bindWS() {
    this.ws.addEventListener('agents_list', (e) => this._onAgents(e.detail.agents));
    this.ws.addEventListener('chat_chunk',  (e) => this._onChatChunk(e.detail));
    this.ws.addEventListener('plan_preview', (e) => this._onPlanPreview(e.detail));
    this.ws.addEventListener('agent_status', (e) => this._onAgentStatus(e.detail));
    this.ws.addEventListener('agent_bubble', (e) => this._onAgentBubble(e.detail));
    this.ws.addEventListener('agent_move',   (e) => this._onAgentMove(e.detail));
    this.ws.addEventListener('error',        (e) => this._toast(e.detail.message));
    this.ws.addEventListener('log',          (e) => this._onLog(e.detail));
    this.ws.addEventListener('usage',        (e) => this._onUsage(e.detail.report));
    this.ws.addEventListener('compact_status', (e) => this._onCompactStatus(e.detail));
    this.ws.addEventListener('autocompact',  (e) => {
      this.autoCompactK = Number(e.detail.thresholdK) || 0;
      const s = $('og-autocompact'); if (s) s.value = String(this.autoCompactK);
      this._renderHeader();
    });
    this.ws.addEventListener('weather', (e) => this._onWeather(e.detail.weather));
    this.ws.addEventListener('office_name', (e) => {
      const name = e.detail.name || '小办公室';
      $('og-office-name').textContent = name;
      document.title = `${name} · Virtual Office`;
    });
    this.ws.addEventListener('compact_log', (e) => {
      this.compactLog = e.detail.log || [];
      this._renderHeader();
      if ($('og-compact-log').style.display !== 'none') this._renderCompactLog();
    });

    this.ws.addEventListener('auth_status_result', (e) => {
      const data = e.detail;
      document.getElementsByName('og-active-provider').forEach(r => {
        r.checked = (r.value === data.activeProvider);
      });

      for (const provider of ['claude', 'codex']) {
        const state = data[provider].state || (data[provider].loggedIn ? 'unverified' : 'missing');
        this._renderAuthState(provider, state);
      }
    });
    this.ws.addEventListener('auth_state_changed', (e) => {
      this._renderAuthState(e.detail.provider, e.detail.state);
      this._toast('授权失效：请在「模型与登录」重新授权；使用 API key 时请检查 .env。');
    });
    this.ws.addEventListener('switch_provider_result', (e) => {
      if (e.detail.success) {
        this._toast(`✅ 已成功切换首选引擎为: ${e.detail.provider === 'codex' ? 'Codex' : 'Claude'}`);
        this.ws.send({ type: 'get_auth_status' });
      } else {
        this._toast(`❌ 切换失败: ` + e.detail.error);
      }
    });
    this.ws.addEventListener('logout_result', (e) => {
      if (e.detail.success) {
        this._toast(`✅ 已成功登出 ${e.detail.provider === 'codex' ? 'Codex' : 'Claude'}`);
        this.ws.send({ type: 'get_auth_status' });
      } else {
        this._toast(`❌ 登出失败: ` + e.detail.error);
      }
    });
    this.ws.addEventListener('login_stdout', (e) => {
      const consoleEl = $('og-login-console');
      consoleEl.textContent += e.detail.text;
      consoleEl.scrollTop = consoleEl.scrollHeight;
    });
    this.ws.addEventListener('login_url', (e) => {
      if (!this.loginInProgress) return;
      $('og-login-status').textContent = '👉 请点击下方链接在浏览器中授权：';
      $('og-login-oauth-url').href = e.detail.url;
      $('og-login-link-box').style.display = 'block';
      $('og-login-code-box').style.display = 'flex';
    });
    this.ws.addEventListener('login_close', (e) => {
      this.loginInProgress = false;
      $('og-login-code-box').style.display = 'none';
      $('og-login-link-box').style.display = 'none';
      $('og-login-submit-code').disabled = true;
      $('og-login-verification-code').value = '';
      const consoleEl = $('og-login-console');
      consoleEl.textContent += `\n[System] 登录进程已退出，代码: ${e.detail.code}\n`;
      consoleEl.scrollTop = consoleEl.scrollHeight;
      $('og-login-status').textContent = e.detail.code === 0
        ? '✅ 登录流程已完成，无需再提交验证码。请返回并重试消息。'
        : '❌ 登录流程未完成，请返回后重新连接 / 授权。';
      this.ws.send({ type: 'get_auth_status' });
    });
    this.ws.addEventListener('login_code_result', (e) => {
      const status = e.detail.status;
      if (status === 'submitted') {
        if (this.loginInProgress) $('og-login-status').textContent = '⏳ 验证码已提交，等待授权结果…';
        return;
      }
      if (status === 'invalid') {
        if (this.loginInProgress) {
          $('og-login-submit-code').disabled = false;
          $('og-login-status').textContent = '请粘贴单行验证码后重新提交。';
        }
        return;
      }
      this.loginInProgress = false;
      $('og-login-code-box').style.display = 'none';
      $('og-login-link-box').style.display = 'none';
      $('og-login-submit-code').disabled = true;
      $('og-login-status').textContent = status === 'completed'
        ? '✅ 登录流程已完成，无需再提交验证码。请返回并重试消息。'
        : '登录流程已结束，请返回后重新连接 / 授权。';
      this.ws.send({ type: 'get_auth_status' });
    });
  }

  _renderAuthState(provider, state) {
    const el = $(`og-status-${provider}`);
    const button = $(`og-btn-login-${provider}`);
    if (!el || !button) return;
    el.textContent = state === 'invalid' ? '🔴 授权失效，请重新授权或检查 key'
      : state === 'unverified' ? '🟡 检测到本地凭据，尚未验证授权'
      : '⚪ 未授权，请连接账号或配置 key';
    button.textContent = state === 'invalid' ? '重新授权' : '连接 / 授权';
  }

  _onAgents(agents) {
    this.agents = agents || [];
    this.byId = {};
    this.agents.forEach(a => { this.byId[a.id] = a; });

    // 顺序：PM 永远第一，其余按服务器顺序（数字键 1=PM, 2=第二个…）
    const pm = this.agents.find(a => a.id === 'pm');
    this.order = (pm ? [pm.id] : []).concat(this.agents.filter(a => a.id !== 'pm').map(a => a.id));

    this._buildSlots();

    if (!this.activeId || !this.byId[this.activeId]) this.activeId = this.order[0] || null;
    this._renderHeader();
    this._renderChat();
    if ($('og-team').style.display !== 'none') this._renderTeam();
  }

  // 按顺序克隆角色造型（第 7 个起循环复用 6 个造型），放进 #og-agents
  _buildSlots() {
    const layer = $('og-agents');
    layer.innerHTML = '';
    this.slots = {};
    this.order.forEach((id, i) => {
      const a = this.byId[id];
      const tpl = $('og-char-' + (i % 6));
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute; width:210px; text-align:center;';
      if (tpl) wrap.appendChild(tpl.content.cloneNode(true));
      const bub = wrap.querySelector('.og-bub');
      const ringwrap = wrap.querySelector('.og-ringwrap');
      const ringfg = wrap.querySelector('.og-ringfg');
      const nameEl = wrap.querySelector('.og-name');
      if (nameEl) nameEl.textContent = a ? (a.name || id) : id;
      if (bub) bub.style.display = 'none';        // 默认无气泡
      if (ringwrap) ringwrap.style.display = 'none'; // 默认无进度环
      layer.appendChild(wrap);
      this.slots[id] = { el: wrap, bub, ringwrap, ringfg, anchor: [0, 0] };
    });
    this._positionSlots();
  }

  // 根据地图宽度把角色铺成网格（每行 PER_ROW 个，横向均匀分布）
  _positionSlots() {
    const mapW = ($('og-map') && $('og-map').clientWidth) || 900;
    this.order.forEach((id, i) => {
      const slot = this.slots[id];
      if (!slot) return;
      const row = Math.floor(i / PER_ROW), col = i % PER_ROW;
      const cx = Math.round(mapW * (col + 1) / (PER_ROW + 1));
      const cy = ROW_Y[row] !== undefined ? ROW_Y[row] : (330 + row * 250);
      slot.anchor = [cx, cy];
      slot.el.style.left = (cx - 105) + 'px';
      slot.el.style.top = (cy - 180) + 'px';
    });
  }

  // ── 聊天流 ────────────────────────────────────────────────
  _onChatChunk(d) {
    const id = d.agentId;
    if (d.text) {
      this.pending[id] = false;
      let msg = this.streamMsg[id];
      if (!msg) { msg = { role: 'assistant', text: '', ts: Date.now() }; this._hist(id).push(msg); this.streamMsg[id] = msg; }
      msg.text += d.text;
      if (id === this.activeId) this._renderChat();
    }
    if (d.done) {
      const msg = this.streamMsg[id];
      if (msg) {
        if (id === 'pm') msg.text = msg.text.replace(/\{[\s\S]*?"tasks"[\s\S]*?\]\s*\}/, '').trim();
        if (!msg.text) this._hist(id).pop();
        else if (d.sessionId) {
          msg.sessionId = d.sessionId;
        }
      }
      this.streamMsg[id] = null;
      this.pending[id] = false;
      if (d.sessionId) {
        if (this.byId[id]) this.byId[id].sessionId = d.sessionId;
        // Backfill previous user message sessionId
        const hist = this._hist(id);
        for (let i = hist.length - 1; i >= 0; i--) {
          if (hist[i].role === 'user') {
            if (!hist[i].sessionId) hist[i].sessionId = d.sessionId;
            break;
          }
        }
      }
      this._saveHistories();
      if (id === this.activeId) {
        this._renderChat();
        this._renderHeader();
      }
    }
  }

  _onPlanPreview(d) {
    const mid = d.agentId || 'pm'; // 计划可能来自 PM，也可能来自其他管理者
    const lines = d.plan.tasks.map(t => `  · ${this._name(t.agent)}: ${t.task.slice(0, 50)}`).join('\n');
    this._hist(mid).push({ role: 'assistant', text: `我建议这样拆分（先确认再执行）：\n${lines}`, isPlan: true, planAgentId: mid, ts: Date.now() });
    this.pending[mid] = false;
    this._saveHistories();
    if (this.activeId === mid) this._renderChat();
  }

  _onAgentStatus(d) {
    if (d.status === 'working') { this.pending[d.agentId] = true; this._setStatus(d.agentId, 'working', d.label); }
    else if (d.status === 'done') { this.pending[d.agentId] = false; this._setStatus(d.agentId, 'done'); }
    if (d.agentId === this.activeId) this._renderChat();
  }

  _onAgentBubble(d) { this._setStatus(d.agentId, 'working', (d.text || '').slice(0, 14)); }

  _onAgentMove(d) {
    if (d.agentId === 'pm' && d.toAgentId && d.toAgentId !== 'pm') this._flyCard('pm', d.toAgentId, this._name(d.toAgentId));
  }

  _name(id) { return (this.byId[id] && this.byId[id].name) || id; }

  // ── 桌位状态：气泡 + 进度环 ───────────────────────────────
  _setStatus(agentId, status, label) {
    const slot = this.slots[agentId];
    if (!slot) return;
    const { bub, ringwrap } = slot;
    if (bub) {
      if (status === 'working') { bub.style.display = 'inline-block'; bub.textContent = label || '工作中…'; bub.style.background = '#ffe3b0'; bub.style.color = '#b9791a'; }
      else if (status === 'done') { bub.style.display = 'inline-block'; bub.textContent = '完成 ✓'; bub.style.background = '#cdeedd'; bub.style.color = '#2f8a5b'; }
      else { bub.style.display = 'none'; }
    }
    if (ringwrap) { ringwrap.style.display = status === 'working' ? 'block' : 'none'; ringwrap.style.animation = status === 'working' ? 'spin 1s linear infinite' : 'none'; }
  }

  _flyCard(fromId, toId, label) {
    const layer = $('og-cards');
    const from = this.slots[fromId] && this.slots[fromId].anchor;
    const to = this.slots[toId] && this.slots[toId].anchor;
    if (!layer || !to) return;
    const f = from || [to[0], 120];
    const c = document.createElement('div');
    c.textContent = '📋 ' + label;
    c.style.cssText = `position:absolute; left:${f[0]}px; top:${f[1]}px; transform:translate(-50%,-50%) scale(.5); background:#fff; border:2.5px solid #5a4636; border-radius:10px; padding:4px 9px; font-size:11px; font-weight:600; color:#5a4636; box-shadow:2px 3px 0 #5a4636; transition:all .7s cubic-bezier(.5,-0.2,.35,1.25); z-index:50; white-space:nowrap;`;
    layer.appendChild(c);
    requestAnimationFrame(() => { c.style.left = to[0] + 'px'; c.style.top = to[1] + 'px'; c.style.transform = 'translate(-50%,-50%) scale(1)'; });
    setTimeout(() => { c.style.opacity = '0'; c.style.transform = 'translate(-50%,-50%) scale(.4)'; }, 780);
    setTimeout(() => c.remove(), 1120);
  }

  // ── 聊天面板渲染 ──────────────────────────────────────────
  _renderHeader() {
    const a = this.byId[this.activeId];
    $('og-active-name').textContent = a ? a.name : '选择一位同事';
    $('og-active-role').textContent = a ? (a.role || '') : '走近并按 E 开始对话';
    const av = $('og-active-avatar');
    av.textContent = a ? this._initials(a) : '··';
    av.style.background = (a && a.accent) || '#ffce6b';
    $('og-input').placeholder = a ? `和 ${a.name} 说点什么… (Enter 发送 · Shift+Enter 换行 · Ctrl+Enter 全新会话)` : '和同事说点什么… (Enter 发送 · Shift+Enter 换行 · Ctrl+Enter 全新会话)';

    const sessEl = $('og-active-session');
    if (sessEl) {
      if (a && a.sessionId) {
        sessEl.style.display = 'block';
        const su = this._sessionUsage(a.id, a.sessionId);
        const todayTxt = su && su.today.billable ? ` · 今日 ${this._fmtTok(su.today.billable)}` : '';
        const ce = this._compactEntryFor(a.id, a.sessionId);
        const genTxt = ce ? ` ♻️${ce.gen}` : ''; // 该会话由压缩而来 → 标记第几代
        sessEl.textContent = `Session: ${a.sessionId.slice(0, 8)}${genTxt}${todayTxt}`;
        sessEl.onmouseenter = () => this._showSessionTip(sessEl, a);
        sessEl.onmouseleave = () => this._hideSessionTip();
      } else {
        sessEl.style.display = 'none';
        this._hideSessionTip();
      }
    }
    // 🗜️ 压缩按钮：有会话才显示
    const cbtn = $('og-compact-btn');
    if (cbtn) cbtn.style.display = (a && a.sessionId) ? 'block' : 'none';
    this._renderCompactProgress(a);
  }

  // 当前会话是否由压缩产生（取该 agent 谱系里 newSid 匹配的最新一条）
  _compactEntryFor(agentId, sessionId) {
    if (!sessionId) return null;
    for (let i = this.compactLog.length - 1; i >= 0; i--) {
      const e = this.compactLog[i];
      if (e.agentId === agentId && e.newSid === sessionId) return e;
    }
    return null;
  }

  // 压缩进度条：当前会话累计计费 / 自动压缩阈值（阈值关闭或无会话则隐藏）
  _renderCompactProgress(a) {
    const box = $('og-compact-progress');
    if (!box) return;
    const su = a && a.sessionId ? this._sessionUsage(a.id, a.sessionId) : null;
    if (!a || !a.sessionId || !this.autoCompactK || !su) { box.style.display = 'none'; return; }
    const cur = su.total.billable, limit = this.autoCompactK * 1000;
    const pct = Math.min(100, cur / limit * 100);
    box.style.display = 'flex';
    const fill = $('og-compact-progress-fill');
    fill.style.width = Math.max(3, pct) + '%';
    fill.style.background = pct >= 90 ? '#d9534f' : pct >= 60 ? '#ff8c42' : '#7bc47f';
    $('og-compact-progress-label').textContent = `${this._fmtTok(cur)} / ${this.autoCompactK}k`;
    box.title = `当前会话累计计费 ${this._fmtTok(cur)}，达到 ${this.autoCompactK}k 时自动压缩（${pct.toFixed(0)}%）`;
  }

  _compactActive() {
    const a = this.byId[this.activeId];
    if (!a || !a.sessionId) { this._toast('该同事还没有会话，无需压缩'); return; }
    if (this.pending[a.id]) { this._toast(`${a.name} 正在工作中，等他忙完再压缩`); return; }
    if (!window.confirm(`把 ${a.name} 的当前会话压缩成摘要并开新会话？\n（长历史 → 一段摘要，之后聊天不再背旧账）`)) return;
    this.ws.send({ type: 'compact', agentId: a.id });
  }

  // compact_status: summarizing → seeding → done / error
  _onCompactStatus(d) {
    const id = d.agentId;
    const name = this._name(id);
    const push = (text) => { this._hist(id).push({ role: 'assistant', text, ts: Date.now(), sessionId: null }); };
    if (d.stage === 'summarizing') push(d.auto ? '🗜️ 会话累计用量超过阈值，自动压缩中…（正在总结旧会话）' : '🗜️ 压缩中…（正在总结旧会话）');
    else if (d.stage === 'seeding') push('🗜️ 摘要完成，正在载入全新会话…');
    else if (d.stage === 'done') {
      if (this.byId[id]) this.byId[id].sessionId = d.newSessionId;
      push(`🗜️ 压缩完成！新会话 ${d.newSessionId ? d.newSessionId.slice(0, 8) : '—'}，记忆已载入。\n\n📋 摘要：\n${d.summary || '（无）'}`);
    } else if (d.stage === 'error') push(`🗜️ 压缩失败：${d.message}`);
    this._saveHistories();
    if (this.activeId === id) { this._renderChat(); this._renderHeader(); }
  }

  // 当前会话在用量报表(officeSessions)里的条目：key = agentId::sessionId
  _sessionUsage(agentId, sessionId) {
    const grp = this.usage && this.usage.officeSessions;
    if (!grp || !grp.items) return null;
    return grp.items.find(it => it.key === `${agentId}::${sessionId}`) || null;
  }

  _fmtAgo(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} 秒前`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时 ${m % 60} 分前`;
    return `${Math.floor(h / 24)} 天前`;
  }

  // 悬停 session 徽章时的详情浮层：创建时间/时长、对话数、今日/累计计费、缓存三级分解
  _showSessionTip(anchor, a) {
    this._hideSessionTip();
    const su = this._sessionUsage(a.id, a.sessionId);
    const tip = document.createElement('div');
    tip.id = 'og-session-tip';
    tip.style.cssText = 'position:fixed; z-index:99999; background:#fffce8; border:2.5px solid #5a4636; border-radius:12px; padding:12px 15px; box-shadow:3px 3px 0 #5a4636; font-family:Fredoka,sans-serif; max-width:360px; font-size:13px; color:#5a4636; line-height:1.6;';
    const row = (k, v) => `<div style="display:flex; justify-content:space-between; gap:16px;"><span style="color:#a8825c; font-weight:600;">${k}</span><span style="font-weight:600; text-align:right;">${v}</span></div>`;
    let html = `<div style="font-weight:700; margin-bottom:7px; word-break:break-all; font-size:12px;">📎 ${a.sessionId}</div>`;
    if (su) {
      const t = su.total;
      const fmtDT = (ts) => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
      if (t.minTs && t.minTs !== Infinity) html += row('创建于', `${fmtDT(t.minTs)}（${this._fmtAgo(Date.now() - t.minTs)}）`);
      if (t.maxTs && t.maxTs > 0) html += row('最近活动', this._fmtAgo(Date.now() - t.maxTs));
      html += row('API 消息', `${t.msgs} 条`);
      html += row('今日计费', this._fmtTok(su.today.billable));
      html += row('累计计费', this._fmtTok(t.billable));
      html += this._tierHtml(t);
    } else {
      html += '<div style="color:#a8825c;">该会话暂无用量数据（统计约 2 分钟刷新一次）</div>';
    }
    const ce = this._compactEntryFor(a.id, a.sessionId);
    if (ce) {
      const p = n => String(n).padStart(2, '0');
      const d = new Date(ce.ts);
      html += `<div style="margin-top:7px; padding-top:7px; border-top:2px dashed #f0d9b8; color:#2e7d32; font-weight:600;">♻️ 由压缩而来（第 ${ce.gen} 代）<br>
        <span style="color:#a8825c; font-weight:600;">${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} · 前代会话累计 ${ce.billableBefore != null ? this._fmtTok(ce.billableBefore) : '?'} → 摘要 ${ce.summary ? ce.summary.length : 0} 字</span></div>`;
    }
    tip.innerHTML = html;
    document.body.appendChild(tip);
    const r = anchor.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 12)) + 'px';
    // 默认贴在徽章下方；放不下就翻到上方
    if (r.bottom + 8 + tip.offsetHeight > window.innerHeight) tip.style.top = (r.top - tip.offsetHeight - 8) + 'px';
    else tip.style.top = (r.bottom + 8) + 'px';
  }

  _hideSessionTip() { const t = document.getElementById('og-session-tip'); if (t) t.remove(); }

  // ── 压缩记录面板 ──────────────────────────────────────────
  _openCompactLog() { $('og-compact-log').style.display = 'flex'; this._renderCompactLog(); }

  _renderCompactLog() {
    const list = $('og-compact-log-list');
    const log = [...this.compactLog].reverse(); // 最新在前
    if (!log.length) { list.innerHTML = '<div style="font-size:14px; color:#a8825c;">还没有压缩记录。聊天框顶部的 🗜️ 压缩按钮可手动压缩，或在顶部设置自动压缩阈值。</div>'; return; }
    const p = n => String(n).padStart(2, '0');
    list.innerHTML = log.map(e => {
      const d = new Date(e.ts);
      const when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      const name = this._name(e.agentId);
      const before = e.billableBefore != null ? this._fmtTok(e.billableBefore) : '?';
      return `<div style="margin-bottom:12px; background:#fff; border:2.5px solid #5a4636; border-radius:12px; box-shadow:2px 2px 0 #5a4636; overflow:hidden;">
        <div style="display:flex; align-items:center; gap:10px; padding:10px 14px; flex-wrap:wrap;">
          <span style="font-size:14px; font-weight:700; color:#5a4636;">${name}</span>
          <span style="font-size:12px; font-weight:600; color:#fff; background:${e.auto ? '#d9694a' : '#5fb0b7'}; border:1.5px solid #5a4636; border-radius:6px; padding:1px 7px;">${e.auto ? '自动' : '手动'}</span>
          <span style="font-size:12.5px; color:#a8825c; font-weight:600;">♻️ 第 ${e.gen} 代</span>
          <span style="font-size:12.5px; color:#a8825c;">压缩前累计 <b style="color:#d9694a;">${before}</b></span>
          <span style="flex:1;"></span>
          <span style="font-size:12px; color:#bfa07a;">${when}</span>
        </div>
        <div style="padding:0 14px 4px; font-size:11.5px; color:#bfa07a;">${(e.oldSid || '?').slice(0, 8)} → ${(e.newSid || '?').slice(0, 8)}</div>
        <details style="border-top:2px dashed #f0d9b8;">
          <summary style="cursor:pointer; padding:8px 14px; font-size:12.5px; font-weight:600; color:#5fb0b7;">📋 查看摘要（${e.summary ? e.summary.length : 0} 字）</summary>
          <div style="padding:4px 14px 12px; font-size:12.5px; color:#5a4636; line-height:1.65; white-space:pre-wrap;">${e.summary || '（无）'}</div>
        </details>
      </div>`;
    }).join('');
  }
  _initials(a) { return (a.initials || (a.name || '').slice(0, 2)).toUpperCase(); }

  _formatTime(ts) {
    const date = new Date(ts);
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes}${ampm}`;
  }

  _formatDateSeparator(ts) {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      const options = { weekday: 'long', month: 'long', day: 'numeric' };
      const dateStr = date.toLocaleDateString('en-US', options);
      
      const day = date.getDate();
      let suffix = 'th';
      if (day === 1 || day === 21 || day === 31) suffix = 'st';
      else if (day === 2 || day === 22) suffix = 'nd';
      else if (day === 3 || day === 23) suffix = 'rd';
      
      return `${dateStr}${suffix}`;
    }
  }

  _renderChat() {
    const box = $('og-chatscroll');
    box.innerHTML = '';
    const userB = 'white-space:pre-wrap; word-break:break-word; overflow-wrap:break-word; max-width:100%; background:#ff8c42; color:#fff; border:2.5px solid #5a4636; border-radius:16px 16px 5px 16px; padding:10px 13px; font-size:13.5px; line-height:1.5; box-shadow:2px 3px 0 #5a4636;';
    const botB = 'white-space:pre-wrap; word-break:break-word; overflow-wrap:break-word; max-width:100%; background:#fff; color:#5a4636; border:2.5px solid #5a4636; border-radius:16px 16px 16px 5px; padding:10px 13px; font-size:13.5px; line-height:1.5; box-shadow:2px 3px 0 #5a4636;';
    const hist = this._hist(this.activeId);
    const streaming = this.streamMsg[this.activeId];

    let prevDateStr = null;
    let prevSessionId = undefined;
    let needsSave = false;

    hist.forEach((m) => {
      if (!m.ts) {
        m.ts = Date.now();
        needsSave = true;
      }
      const ts = m.ts;
      const dateStr = new Date(ts).toDateString();
      if (dateStr !== prevDateStr) {
        const sep = document.createElement('div');
        sep.className = 'og-date-separator';
        const pill = document.createElement('span');
        pill.className = 'og-date-pill';
        pill.textContent = this._formatDateSeparator(ts);
        sep.appendChild(pill);
        box.appendChild(sep);
        prevDateStr = dateStr;
        prevSessionId = undefined; // Reset session ID tracking on day change
      }

      const sessId = m.sessionId || null;
      if (sessId !== prevSessionId) {
        const sep = document.createElement('div');
        sep.className = 'og-session-separator';
        const pill = document.createElement('span');
        pill.className = 'og-session-pill';
        pill.textContent = sessId ? `Session: ${sessId.slice(0, 8)}` : 'Session: Initial';
        pill.title = sessId ? `会话 ID: ${sessId}` : '初始会话';
        sep.appendChild(pill);
        box.appendChild(sep);
        prevSessionId = sessId;
      }

      const isUser = m.role === 'user';
      const wrap = document.createElement('div');
      wrap.style.cssText = `display:flex; flex-direction:column; align-self:${isUser ? 'flex-end' : 'flex-start'}; max-width:86%; min-width:0; align-items:${isUser ? 'flex-end' : 'flex-start'};`;

      const bubble = document.createElement('div');
      bubble.className = isUser ? 'og-bubble-user' : 'og-bubble-bot';
      bubble.style.cssText = isUser ? userB : botB;
      
      if (window.marked && typeof window.marked.parse === 'function') {
        bubble.innerHTML = window.marked.parse(m.text || '');
      } else {
        bubble.textContent = m.text;
      }
      
      if (m === streaming) {
        const caret = document.createElement('span');
        caret.textContent = '▍';
        caret.style.cssText = 'display:inline-block; width:7px; animation:caret .8s infinite;';
        bubble.appendChild(caret);
      }
      wrap.appendChild(bubble);

      if (m.files && m.files.length) {
        const fb = document.createElement('div');
        fb.style.cssText = `display:flex; flex-wrap:wrap; gap:5px; margin-top:5px; justify-content:${isUser ? 'flex-end' : 'flex-start'};`;
        m.files.forEach(fn => {
          const chip = document.createElement('span');
          chip.style.cssText = 'display:inline-flex; align-items:center; gap:5px; background:#fde7c8; border:2px solid #5a4636; border-radius:9px; padding:3px 8px; font-size:10.5px; font-weight:600; color:#b9791a;';
          chip.textContent = '▤ ' + fn;
          fb.appendChild(chip);
        });
        wrap.appendChild(fb);
      }

      // Add sending timestamp below message content
      const timeEl = document.createElement('div');
      timeEl.className = 'og-message-time';
      timeEl.textContent = this._formatTime(ts);
      wrap.appendChild(timeEl);

      if (m.isPlan) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:8px; margin-top:9px;';
        const ok = document.createElement('div');
        ok.style.cssText = 'cursor:pointer; background:#ff8c42; color:#fff; border:2.5px solid #5a4636; border-radius:11px; padding:7px 14px; font-size:12px; font-weight:600; box-shadow:2px 2px 0 #5a4636;';
        ok.textContent = '确认执行';
        ok.onclick = () => this._confirmPlan(m);
        const no = document.createElement('div');
        no.style.cssText = 'cursor:pointer; background:#fff; color:#a8825c; border:2.5px solid #5a4636; border-radius:11px; padding:7px 14px; font-size:12px; font-weight:600;';
        no.textContent = '取消';
        no.onclick = () => this._cancelPlan(m);
        row.append(ok, no);
        wrap.appendChild(row);
      }
      box.appendChild(wrap);
    });
    if (needsSave) this._saveHistories();

    if (this.pending[this.activeId] && !streaming) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'align-self:flex-start;';
      const b = document.createElement('div');
      b.style.cssText = botB + ' opacity:.8;';
      b.textContent = '⏳ 处理中…';
      wrap.appendChild(b);
      box.appendChild(wrap);
    }
    box.scrollTop = box.scrollHeight;
  }

  _confirmPlan(m) {
    m.isPlan = false;
    const mid = m.planAgentId || 'pm';
    const mgr = this.byId[mid];
    this._hist(mid).push({ role: 'user', text: '确认，开始执行。', ts: Date.now(), sessionId: mgr ? mgr.sessionId : null });
    this.pending[mid] = true;
    this._saveHistories();
    this._renderChat();
    this.ws.send({ type: 'confirm_plan', agentId: mid });
  }
  _cancelPlan(m) {
    m.isPlan = false;
    const mid = m.planAgentId || 'pm';
    const mgr = this.byId[mid];
    this._hist(mid).push({ role: 'assistant', text: '好的，已取消。', ts: Date.now(), sessionId: mgr ? mgr.sessionId : null });
    this._saveHistories();
    this._renderChat();
  }

  // ── 发送 / 取消 / 上传 ────────────────────────────────────
  // fresh=true（Shift+Enter）：本条不带历史 session，让 agent 用全新会话处理
  _send(fresh = false) {
    const a = this.byId[this.activeId];
    if (!a) { this._toast('先走近一位同事再发消息'); return; }
    const input = $('og-input');
    const text = input.value.trim();
    const files = this.attachments.slice();
    if (!text && !files.length) return;

    const currentSessionId = fresh ? null : (a.sessionId || null);
    this._hist(a.id).push({ role: 'user', text: fresh ? `🆕 ${text}` : text, files: files.map(f => f.name), ts: Date.now(), sessionId: currentSessionId });
    input.value = '';
    this._autoGrow();
    this.attachments = [];
    this._renderPending();
    this.pending[a.id] = true;
    this._saveHistories();
    this._renderChat();
    if (fresh) this._toast('🆕 本条使用全新会话（不带之前的记忆）');

    this.ws.send({ type: 'chat', agentId: a.id, message: text, attachments: files, fresh });
  }

  _cancel() {
    const id = this.activeId;
    if (!id || !this.pending[id]) return;
    this.ws.send({ type: 'cancel', agentId: id });
    const msg = this.streamMsg[id];
    const activeAgent = this.byId[id];
    if (msg) { msg.text = (msg.text + ' …（已取消）').trim(); this.streamMsg[id] = null; }
    else this._hist(id).push({ role: 'assistant', text: '…（已取消）', ts: Date.now(), sessionId: activeAgent ? activeAgent.sessionId : null });
    this.pending[id] = false;
    this._saveHistories();
    this._renderChat();
  }

  async _uploadFiles(fileList) {
    for (const file of fileList) {
      try {
        const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        this.attachments.push({ name: data.name, path: data.path });
        this._renderPending();
      } catch (err) { this._toast('上传失败: ' + err.message); }
    }
  }

  _renderPending() {
    const box = $('og-pending');
    box.innerHTML = '';
    box.style.display = this.attachments.length ? 'flex' : 'none';
    this.attachments.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.style.cssText = 'cursor:pointer; display:inline-flex; align-items:center; gap:6px; background:#fde7c8; border:2px solid #5a4636; border-radius:9px; padding:4px 9px; font-size:11px; font-weight:600; color:#b9791a;';
      chip.textContent = `▤ ${a.name} ✕`;
      chip.onclick = () => { this.attachments.splice(i, 1); this._renderPending(); };
      box.appendChild(chip);
    });
  }

  // ── 模式切换 ──────────────────────────────────────────────
  _setMode(m) { this.mode = m; this._applyModeUI(); this.ws.send({ type: 'set_mode', mode: m }); }
  _applyModeUI() {
    const active = 'padding:6px 13px; border-radius:9px; background:#ff8c42; color:#fff; font-size:13px; font-weight:600; cursor:pointer;';
    const idle = 'padding:6px 13px; border-radius:9px; color:#a8825c; font-size:13px; font-weight:500; cursor:pointer;';
    $('og-mode-auto').style.cssText = this.mode === 'auto' ? active : idle;
    $('og-mode-confirm').style.cssText = this.mode === 'confirm' ? active : idle;
  }

  // ── 团队管理 ──────────────────────────────────────────────
  _openTeam() { this._renderTeam(); $('og-team').style.display = 'flex'; }
  _closeTeam() { $('og-team').style.display = 'none'; }
  // 玩家 YOU 徽章：名字 + 颜色（编辑「我自己」后调用）
  _applyPlayerBadge() {
    const badge = $('og-player-badge');
    if (!badge) return;
    badge.textContent = this.player.name || 'YOU';
    badge.style.background = this.player.accent || '#ff8c42';
  }

  _renderTeam() {
    const list = $('og-team-list');
    list.innerHTML = '';

    // 第一行：我自己（可编辑名字/颜色，不可删除）
    {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:12px; background:#fff8e0; border:2.5px solid #5a4636; border-radius:13px; padding:10px 12px; box-shadow:2px 2px 0 #5a4636;';
      const av = document.createElement('div');
      av.style.cssText = `width:36px; height:36px; border-radius:50%; border:2.5px solid #5a4636; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; color:#fff; flex:none; background:${this.player.accent || '#ff8c42'};`;
      av.textContent = (this.player.name || 'YOU').slice(0, 2).toUpperCase();
      const info = document.createElement('div');
      info.style.cssText = 'flex:1; min-width:0;';
      info.innerHTML = `<div style="font-size:14px; font-weight:700; color:#5a4636;"></div><div style="font-size:11px; color:#a8825c;">👤 我自己 · 办公室永远的牛马，不可删除</div>`;
      info.children[0].textContent = this.player.name || 'YOU';
      const edit = document.createElement('div');
      edit.style.cssText = 'cursor:pointer; background:#fff; border:2px solid #5a4636; border-radius:9px; padding:5px 10px; font-size:11.5px; font-weight:600; color:#5a4636;';
      edit.textContent = '编辑';
      edit.onclick = () => this._openEdit('__self');
      row.append(av, info, edit);
      list.appendChild(row);
    }

    this.agents.forEach(a => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:12px; background:#fff; border:2.5px solid #5a4636; border-radius:13px; padding:10px 12px; box-shadow:2px 2px 0 #5a4636;';
      const av = document.createElement('div');
      av.style.cssText = `width:36px; height:36px; border-radius:50%; border:2.5px solid #5a4636; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; color:#5a4636; flex:none; background:${a.accent || '#ffce6b'};`;
      av.textContent = this._initials(a);
      const info = document.createElement('div');
      info.style.cssText = 'flex:1; min-width:0;';
      info.innerHTML = `<div style="font-size:14px; font-weight:700; color:#5a4636;"></div><div style="font-size:11px; color:#a8825c; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>`;
      info.children[0].textContent = a.name;
      info.children[1].textContent = `${a.role || ''} · ${a.workDir || ''}`;
      const open = document.createElement('div');
      open.style.cssText = 'cursor:pointer; background:#fde7c8; border:2px solid #5a4636; border-radius:9px; padding:5px 10px; font-size:11.5px; font-weight:600; color:#b9791a;';
      open.textContent = '对话';
      open.onclick = () => { this.activeId = a.id; this._renderHeader(); this._renderChat(); this._closeTeam(); };
      const edit = document.createElement('div');
      edit.style.cssText = 'cursor:pointer; background:#fff; border:2px solid #5a4636; border-radius:9px; padding:5px 10px; font-size:11.5px; font-weight:600; color:#5a4636;';
      edit.textContent = '编辑';
      edit.onclick = () => this._openEdit(a.id);
      row.append(av, info, open, edit);
      list.appendChild(row);
    });
  }

  // ── 编辑 / 新增 / 删除 ────────────────────────────────────
  _openEdit(id) {
    this.editingId = id;
    const isSelf = id === '__self';
    // 我自己只有名字+颜色，其余字段（角色/目录/工具/模型/prompt）隐藏
    ['og-f-row-role', 'og-f-row-cwd', 'og-f-row-tools', 'og-f-row-model', 'og-f-row-prompt'].forEach(rid => {
      const el = $(rid); if (el) el.style.display = isSelf ? 'none' : '';
    });
    if (isSelf) {
      $('og-edit-title').textContent = '编辑 · 我自己';
      $('og-f-name').value = this.player.name || 'YOU';
      $('og-f-accent').value = this.player.accent || '#ff8c42';
      $('og-edit-del').style.display = 'none'; // 我自己不可删
      $('og-edit').style.display = 'flex';
      return;
    }
    const a = id ? this.byId[id] : null;
    $('og-edit-title').textContent = a ? `编辑 · ${a.name}` : '新增成员';
    $('og-f-name').value = a ? (a.name || '') : '';
    $('og-f-role').value = a ? (a.role || '') : '';
    $('og-f-accent').value = (a && a.accent) || '#ff8c42';
    $('og-f-cwd').value = a ? (a.workDir || '') : '';
    $('og-f-tools').value = (a && a.tools ? a.tools.join(',') : 'Edit,Read,Bash');
    $('og-f-model').value = (a && a.model) || '';
    $('og-f-codex-model').value = (a && a.codexModel) || '';
    $('og-f-prompt').value = a ? (a.systemPrompt || '') : '';
    $('og-edit-del').style.display = (a && a.id !== 'pm') ? '' : 'none'; // PM 不可删
    $('og-edit').style.display = 'flex';
  }
  _closeEdit() { $('og-edit').style.display = 'none'; this.editingId = null; }

  _saveEdit() {
    // 我自己：只存名字+颜色到本地，不走服务端
    if (this.editingId === '__self') {
      const name = $('og-f-name').value.trim();
      if (!name) { this._toast('名字不能为空'); return; }
      this.player.name = name.slice(0, 12);
      this.player.accent = $('og-f-accent').value;
      this._savePlayer();
      this._applyPlayerBadge();
      this._renderTeam();
      this._toast(`✅ 已更新，${this.player.name} 继续搬砖`);
      this._closeEdit();
      return;
    }
    const name = $('og-f-name').value.trim();
    const role = $('og-f-role').value.trim();
    const accent = $('og-f-accent').value;
    const workDir = $('og-f-cwd').value.trim();
    const tools = $('og-f-tools').value.split(',').map(s => s.trim()).filter(Boolean);
    const model = $('og-f-model').value;
    const codexModel = $('og-f-codex-model').value;
    const systemPrompt = $('og-f-prompt').value.trim();
    if (!name || !role || !workDir) { this._toast('请填写名字、角色和工作目录'); return; }

    let config;
    const orig = this.editingId && this.byId[this.editingId];
    if (orig) {
      config = { ...orig, name, role, accent, workDir, tools: tools.length ? tools : orig.tools, model: model || null, codexModel: codexModel || null, systemPrompt };
    } else {
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-' + Date.now();
      config = { id, name, role, accent, workDir, tools: tools.length ? tools : ['Edit', 'Read', 'Bash'], model: model || null, codexModel: codexModel || null, avatar: null,
        systemPrompt: systemPrompt || `你是 ${role}，负责 ${workDir} 项目。收到任务后先读相关文件再动手，完成后简短汇报。` };
    }
    this.ws.send({ type: 'add_agent', config });
    this._closeEdit();
  }
  _deleteEdit() {
    if (!this.editingId || this.editingId === 'pm' || this.editingId === '__self') return;
    if (!window.confirm(`确定删除 ${this._name(this.editingId)}？`)) return;
    this.ws.send({ type: 'delete_agent', agentId: this.editingId });
    this._closeEdit();
  }
  _addAgent() { this._closeTeam(); this._openEdit(null); }

  _openLogin() {
    $('og-status-claude').textContent = '⏳ 正在检测...';
    $('og-status-codex').textContent = '⏳ 正在检测...';
    this.ws.send({ type: 'get_auth_status' });
    $('og-login-step-1').style.display = 'flex';
    $('og-login-step-2').style.display = 'none';
    $('og-login-console').textContent = '';
    $('og-login-link-box').style.display = 'none';
    $('og-login-code-box').style.display = 'none';
    $('og-login-verification-code').value = '';
    $('og-login').style.display = 'flex';
  }
  _closeLogin() {
    $('og-login').style.display = 'none';
  }

  // ── UI 事件绑定 ───────────────────────────────────────────
  _bindUI() {
    $('og-mode-auto').onclick = () => this._setMode('auto');
    $('og-mode-confirm').onclick = () => this._setMode('confirm');
    $('og-compact-btn').onclick = () => this._compactActive();
    $('og-compact-log-btn').onclick = () => this._openCompactLog();
    // 办公室牌子 → 改名
    $('og-office-sign').onclick = () => {
      const cur = $('og-office-name').textContent;
      const v = window.prompt('给办公室起个新名字（最多 24 字）', cur);
      if (v === null) return;
      const name = v.trim();
      if (!name || name === cur) return;
      this.ws.send({ type: 'set_office_name', name });
    };
    // 天气牌 → 邮编位置设置弹窗
    $('og-board-weather').onclick = () => {
      const w = this.weather || {};
      $('og-weather-zip').value = w.manual && w.zip ? w.zip : '';
      $('og-weather-modal').style.display = 'flex';
      $('og-weather-zip').focus();
    };
    const saveWeatherLoc = () => {
      const zip = $('og-weather-zip').value.trim();
      const country = $('og-weather-country').value;
      this.ws.send({ type: 'set_location', zip, country });
      this._toast(zip ? `📍 正在切换到邮编 ${zip}…` : '📍 正在恢复自动定位…');
      $('og-weather-modal').style.display = 'none';
    };
    $('og-weather-save').onclick = saveWeatherLoc;
    $('og-weather-zip').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveWeatherLoc(); });
    $('og-weather-modal-close').onclick = () => { $('og-weather-modal').style.display = 'none'; };
    $('og-weather-modal').onclick = (e) => { if (e.target === $('og-weather-modal')) $('og-weather-modal').style.display = 'none'; };
    $('og-compact-log-close').onclick = () => { $('og-compact-log').style.display = 'none'; };
    $('og-compact-log').onclick = (e) => { if (e.target === $('og-compact-log')) $('og-compact-log').style.display = 'none'; };
    $('og-autocompact').onchange = (e) => {
      const k = Number(e.target.value) || 0;
      this.ws.send({ type: 'set_autocompact', thresholdK: k });
      this._toast(k ? `🗜️ 自动压缩已开启：会话累计超 ${k}k 自动压缩` : '🗜️ 自动压缩已关闭');
    };
    $('og-login-btn').onclick = () => this._openLogin();
    $('og-login-close').onclick = () => this._closeLogin();

    document.getElementsByName('og-active-provider').forEach(radio => {
      radio.onchange = (e) => {
        const provider = e.target.value;
        this.ws.send({ type: 'switch_provider', provider });
      };
    });

    const startOauth = (provider) => {
      this.loginInProgress = true;
      $('og-login-submit-code').disabled = false;
      $('og-login-verification-code').value = '';
      $('og-login-step-1').style.display = 'none';
      $('og-login-step-2').style.display = 'flex';
      $('og-login-provider-title').textContent = `${provider === 'codex' ? 'Codex' : 'Claude'} OAuth 授权流程`;
      $('og-login-status').textContent = '⏳ 正在启动登录进程...';
      $('og-login-console').textContent = '';
      $('og-login-link-box').style.display = 'none';
      $('og-login-code-box').style.display = 'none';
      this.ws.send({ type: 'start_login', provider });
    };

    $('og-btn-login-claude').onclick = () => startOauth('claude');
    $('og-btn-login-codex').onclick = () => startOauth('codex');
    $('og-btn-logout-claude').onclick = () => {
      this.ws.send({ type: 'logout', provider: 'claude' });
    };
    $('og-btn-logout-codex').onclick = () => {
      this.ws.send({ type: 'logout', provider: 'codex' });
    };

    $('og-login-back-btn').onclick = () => {
      $('og-login-step-1').style.display = 'flex';
      $('og-login-step-2').style.display = 'none';
    };
    $('og-login-submit-code').onclick = () => {
      if (!this.loginInProgress || $('og-login-submit-code').disabled) return;
      const code = $('og-login-verification-code').value.trim();
      if (!code) return;
      $('og-login-submit-code').disabled = true;
      this.ws.send({ type: 'submit_login_code', code });
      $('og-login-verification-code').value = '';
    };

    $('og-team-btn').onclick = () => this._openTeam();
    $('og-upload-btn').onclick = () => $('og-file').click();
    $('og-file').onchange = (e) => { this._uploadFiles(e.target.files); e.target.value = ''; };
    $('og-send').onclick = () => this._send();

    const input = $('og-input');
    input.addEventListener('input', () => this._autoGrow());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this._send(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._send(true); } // Ctrl/⌘+Enter：全新会话发送
      // Shift+Enter 不拦截 → textarea 默认换行
      else if (e.key === 'Escape') { input.blur(); } // Esc 只退出聊天，不取消生成
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (this.pending[this.activeId] && !String(window.getSelection?.() || '')) { e.preventDefault(); this._cancel(); }
      }
    });

    // 墙上用量牌 + 明细
    $('og-board-office').onclick = () => this._openUsage('office');
    $('og-board-iterm').onclick = () => this._openUsage('iterm');
    $('og-usage-close').onclick = () => { $('og-usage').style.display = 'none'; };
    $('og-usage').onclick = (e) => { if (e.target === $('og-usage')) $('og-usage').style.display = 'none'; };

    // 日志台
    $('og-console').style.height = this.consoleH + 'px'; // 恢复记忆的高度
    $('og-console-btn').onclick = () => this._toggleConsole();
    $('og-console-close').onclick = () => this._toggleConsole(false);
    $('og-console-clear').onclick = () => { this.logLines = []; $('og-console-body').innerHTML = ''; };
    this._bindConsoleResize();
    this._toggleConsole(true); // 日志台默认打开

    $('og-team-close').onclick = () => this._closeTeam();
    $('og-team-add').onclick = () => this._addAgent();
    $('og-team').onclick = (e) => { if (e.target === $('og-team')) this._closeTeam(); };
    $('og-edit-close').onclick = () => this._closeEdit();
    $('og-edit-save').onclick = () => this._saveEdit();
    $('og-edit-del').onclick = () => this._deleteEdit();
    $('og-edit').onclick = (e) => { if (e.target === $('og-edit')) this._closeEdit(); };
  }

  _autoGrow() { const el = $('og-input'); el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

  // 数字键瞬移到第 N 个同事旁边
  _teleportTo(id) {
    const slot = this.slots[id];
    if (!slot) return;
    const [ax, ay] = slot.anchor;
    const room = $('og-map');
    let x = ax - 48, y = ay - 16; // 站到角色身体偏下方（中心距锚点 ~80，落在可对话范围内）
    if (room && room.clientWidth) { x = Math.max(6, Math.min(room.clientWidth - 102, x)); y = Math.max(198, Math.min(room.clientHeight - 150, y)); }
    this.player = { ...this.player, x, y };
    const p = $('og-player'); if (p) { p.style.left = x + 'px'; p.style.top = y + 'px'; }
  }

  // ── 日志台 ────────────────────────────────────────────────
  _toggleConsole(force) {
    this.consoleOpen = (force === undefined) ? !this.consoleOpen : force;
    $('og-console').style.display = this.consoleOpen ? 'flex' : 'none';
    const btn = $('og-console-btn');
    btn.style.background = this.consoleOpen ? '#ff8c42' : '#5a4636';
    if (this.consoleOpen) {
      // 打开时把缓存的日志一次性渲染出来（关闭期间只缓存不渲染）
      const body = $('og-console-body');
      body.innerHTML = '';
      this.logLines.forEach(d => body.appendChild(this._logRow(d)));
      this._scrollConsole();
    }
  }

  _onLog(d) {
    const LOG_MAX = 600; // 超出就丢最旧的，避免无限增长
    this.logLines.push(d);
    if (this.logLines.length > LOG_MAX) this.logLines.splice(0, this.logLines.length - LOG_MAX);
    if (!this.consoleOpen) return; // 没打开就只缓存，不渲染

    const body = $('og-console-body');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.appendChild(this._logRow(d));
    while (body.childElementCount > LOG_MAX) body.removeChild(body.firstChild);
    if ($('og-console-autoscroll').checked && atBottom) this._scrollConsole();
  }

  _logRow(d) {
    const t = new Date(d.ts || Date.now());
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const txt = d.text || '';
    // 按内容上色：错误红、完成绿、心跳黄、启动青
    let color = '#d8c4a0';
    if (/stderr|✖|⚠|失败|错误/.test(txt)) color = '#ff8f6b';
    else if (/✔|完成|💬/.test(txt)) color = '#9be29b';
    else if (/⏳|↻/.test(txt)) color = '#ffce6b';
    else if (/▶|pid=/.test(txt)) color = '#7fd4d4';

    const row = document.createElement('div');
    row.style.cssText = 'white-space:pre-wrap; word-break:break-word;';
    const time = document.createElement('span');
    time.style.cssText = 'color:#6f5a3f;';
    time.textContent = `${hh}:${mm}:${ss} `;
    const tag = document.createElement('span');
    tag.style.cssText = 'color:#c9a86a; font-weight:600;';
    tag.textContent = `[${d.agent || '?'}] `;
    const msg = document.createElement('span');
    msg.style.color = color;
    msg.textContent = txt;
    row.append(time, tag, msg);
    return row;
  }

  _scrollConsole() { const b = $('og-console-body'); b.scrollTop = b.scrollHeight; }

  // 拖动上边缘改变日志台高度，松手后记住
  _bindConsoleResize() {
    const handle = $('og-console-resize');
    const el = $('og-console');
    if (!handle || !el) return;
    let startY = 0, startH = 0;
    const clamp = (h) => Math.max(120, Math.min(window.innerHeight - 120, h));
    const onMove = (e) => {
      const h = clamp(startH + (startY - e.clientY)); // 向上拖 → 更高
      el.style.height = h + 'px';
      this.consoleH = h;
      this._scrollConsole();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      this._saveConsoleH();
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = el.getBoundingClientRect().height;
      document.body.style.userSelect = 'none'; // 拖动时别选中页面文字
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _loadConsoleH() { const v = parseInt(localStorage.getItem('vo_console_h'), 10); return (v && v >= 120) ? v : 252; }
  _saveConsoleH() { try { localStorage.setItem('vo_console_h', String(Math.round(this.consoleH))); } catch {} }

  _toast(msg) {
    let t = $('og-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'og-toast';
      t.style.cssText = 'position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#d9694a; color:#fff; border:2.5px solid #5a4636; border-radius:12px; padding:8px 16px; font-family:Fredoka,sans-serif; font-size:13px; font-weight:600; z-index:200; box-shadow:2px 3px 0 #5a4636;';
      document.body.appendChild(t);
    }
    t.textContent = '⚠ ' + msg;
    t.style.display = 'block';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
  }

  // ── 用量牌 + 明细 ─────────────────────────────────────────
  _onUsage(report) {
    if (!report) return;
    this.usage = report;
    this._renderBoards();
    this._renderHeader(); // 刷新聊天框顶部 session 徽章的「今日」用量
    if ($('og-usage').style.display !== 'none') this._renderUsage();
  }

  _fmtTok(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // 办公室排行的 key 是 agentId → 映射成 agent 名/emoji
  _agentLabel(agentId) {
    const a = this.byId[agentId];
    return a ? `${a.emoji || '🤖'} ${a.name}` : agentId;
  }

  // iTerm 排行的 key 是项目目录 → 取项目名（不映射成 agent）
  _projName(key) {
    const m = key.match(/Projects-(.+)$/);
    return m ? m[1] : key.replace(/^-/, '');
  }

  _renderBoards() {
    const office = this.usage && this.usage.office, iterm = this.usage && this.usage.iterm;
    $('og-board-office-total').textContent = this._fmtTok(office ? office.total.billable : 0);
    $('og-board-office-today').textContent = this._fmtTok(office ? office.today.billable : 0);
    $('og-board-iterm-total').textContent = this._fmtTok(iterm ? iterm.total.billable : 0);
    $('og-board-iterm-today').textContent = this._fmtTok(iterm ? iterm.today.billable : 0);
  }

  _openUsage(src) {
    if (!this.usage) { this._toast('用量还在统计中，稍等几秒…'); return; }
    this.usageSource = src;
    this.usageDim = 'member';
    this.usageRank = 'total';
    $('og-usage').style.display = 'flex';
    this._renderUsage();
  }

  // ── token 三级分解（纯输入 1x / 缓存写“拍照” 1.25x / 缓存读“贴照片” 0.1x）──
  // 派生指标：命中率 = 读/(纯输入+写+读)，越高越省；复用倍数 = 读/写，一张“照片”被贴了几次
  _tierStats(b) {
    const inp = b.input || 0, cc = b.cacheCreate || 0, cr = b.cacheRead || 0;
    const denom = inp + cc + cr;
    return {
      inp, cc, cr,
      hit: denom ? (cr / denom * 100) : 0,
      reuse: cc ? (cr / cc) : 0,
    };
  }

  _tierHtml(b, compact = false) {
    const t = this._tierStats(b);
    if (!(t.inp + t.cc + t.cr)) return '';
    const fs = compact ? 11.5 : 12;
    const chip = (bg, fg, label, v, title) =>
      `<span title="${title}" style="display:inline-flex; align-items:center; gap:2px; background:${bg}; border:1.5px solid #5a4636; border-radius:6px; padding:2px 7px; font-size:${fs}px; font-weight:700; color:${fg};">${label} ${this._fmtTok(v)}</span>`;
    const chips = [
      chip('#ffe3e3', '#c0392b', '✍️ 纯输入', t.inp, '没吃到缓存、全价重算的输入（1x）'),
      chip('#fde7c8', '#b9791a', '📷 缓存写', t.cc, '写入缓存（拍照），比全价略贵（1.25x）'),
      chip('#e3f6e3', '#2e7d32', '📄 缓存读', t.cr, '从缓存复用（贴照片），便宜 90%（0.1x）'),
    ].join('');
    const metrics = `<span style="font-size:${fs}px; color:#a8825c; font-weight:600;" title="命中率 = 缓存读 ÷ 全部输入；复用 = 缓存读 ÷ 缓存写（一张照片贴了几次）">命中 ${t.hit.toFixed(0)}% · 复用 ${t.cc ? t.reuse.toFixed(1) + 'x' : '—'}</span>`;
    return `<div style="margin-top:${compact ? 4 : 8}px; display:flex; flex-wrap:wrap; gap:5px; align-items:center; ${compact ? 'padding-left:14px;' : ''}">${chips}${metrics}</div>`;
  }

  _renderUsage() {
    const isOffice = this.usageSource === 'office';
    const actualSourceKey = (isOffice && this.usageDim === 'session') ? 'officeSessions' : this.usageSource;
    const src = this.usage && this.usage[actualSourceKey];
    const label = isOffice ? '🏢 办公室' : '💻 iTerm';
    $('og-usage-title').textContent = `${label} · 用量明细`;
    const stats = $('og-usage-stats'), tabs = $('og-usage-tabs'), rank = $('og-usage-rank');
    stats.innerHTML = ''; tabs.innerHTML = ''; rank.innerHTML = '';
    if (!src) { stats.innerHTML = '<div style="font-size:14px;color:#a8825c;">暂无数据</div>'; $('og-usage-foot').textContent = ''; return; }

    // Dimensions (按成员 / 按会话)
    const dims = $('og-usage-dims');
    dims.innerHTML = '';
    if (isOffice) {
      dims.style.display = 'flex';
      [['member', '按成员'], ['session', '按会话']].forEach(([dim, lbl]) => {
        const on = this.usageDim === dim;
        const t = document.createElement('div');
        t.style.cssText = `cursor:pointer; padding:3px 10px; border-radius:6px; font-size:11.5px; font-weight:600; border:1.8px solid #5a4636; ${on ? 'background:#ff8c42; color:#fff;' : 'background:#fff; color:#a8825c;'}`;
        t.textContent = lbl;
        t.onclick = () => { this.usageDim = dim; this._renderUsage(); };
        dims.appendChild(t);
      });
    } else {
      dims.style.display = 'none';
    }

    [['今日', src.today], ['本周', src.week], ['累计', src.total]].forEach(([name, b]) => {
      const c = document.createElement('div');
      c.style.cssText = 'flex:1; background:#fff; border:2.5px solid #5a4636; border-radius:12px; padding:11px 12px; box-shadow:2px 2px 0 #5a4636; display:flex; flex-direction:column;';
      
      let modelsHtml = '';
      if (b.models && Object.keys(b.models).length) {
        const modelParts = Object.entries(b.models)
          .sort((x, y) => y[1].billable - x[1].billable)
          .map(([model, mb]) => `<span style="display:inline-flex; align-items:center; background:#fde7c8; border:1.5px solid #5a4636; border-radius:6px; padding:2px 7px; font-size:11.5px; font-weight:700; color:#b9791a;">${model}: ${this._fmtTok(mb.billable)}</span>`)
          .join('');
        modelsHtml = `<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:5px;">${modelParts}</div>`;
      }

      c.innerHTML = `<div style="font-size:13px; color:#a8825c; font-weight:600;">${name}</div>
        <div style="font-size:23px; font-weight:700; color:#5a4636; line-height:1.3;">${this._fmtTok(b.billable)}</div>
        <div style="font-size:11px; color:#bfa07a; flex:1;">输出 ${this._fmtTok(b.output)} · ${b.msgs} 条</div>
        ${this._tierHtml(b)}
        ${modelsHtml}`;
      stats.appendChild(c);
    });

    [['today', '今日'], ['week', '本周'], ['total', '累计']].forEach(([k, lbl]) => {
      const on = this.usageRank === k;
      const t = document.createElement('div');
      t.style.cssText = `cursor:pointer; padding:4px 13px; border-radius:8px; font-size:13px; font-weight:600; border:2px solid #5a4636; ${on ? 'background:#ff8c42; color:#fff;' : 'background:#fff; color:#a8825c;'}`;
      t.textContent = lbl;
      t.onclick = () => { this.usageRank = k; this._renderUsage(); };
      tabs.appendChild(t);
    });

    const list = [...(src.items || [])].sort((a, b) => b[this.usageRank].billable - a[this.usageRank].billable)
      .filter(p => p[this.usageRank].billable > 0).slice(0, 8);
    if (!list.length) { rank.innerHTML = '<div style="font-size:13.5px; color:#a8825c; padding:6px 2px;">该时段暂无用量</div>'; }
    const max = list.length ? list[0][this.usageRank].billable : 1;
    list.forEach((p, i) => {
      const v = p[this.usageRank].billable;
      
      let name;
      if (isOffice) {
        if (this.usageDim === 'session') {
          const [agentId, sid] = p.key.split('::');
          const agentName = this._agentLabel(agentId);
          name = `${agentName} (Session: ${sid.slice(0, 8)})`;
        } else {
          name = this._agentLabel(p.key);
        }
      } else {
        name = this._projName(p.key);
      }

      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:14px;';
      
      let agentModelsHtml = '';
      const itemData = p[this.usageRank];
      if (itemData.models && Object.keys(itemData.models).length) {
        const modelParts = Object.entries(itemData.models)
          .sort((x, y) => y[1].billable - x[1].billable)
          .map(([model, mb]) => `<span style="font-size:12.5px; color:#bfa07a; margin-right:11px; font-weight:600;">${model}: ${this._fmtTok(mb.billable)}</span>`)
          .join('');
        
        let timeRangeHtml = '';
        if (this.usageDim === 'session' && itemData.minTs && itemData.maxTs) {
          timeRangeHtml = `<span style="font-size:12.5px; color:#a8825c; font-weight:600; margin-left:auto;">🕒 ${this._formatSessionTime(itemData.minTs, itemData.maxTs)}</span>`;
        }
        agentModelsHtml = `<div style="display:flex; align-items:center; flex-wrap:wrap; margin-top:3px; padding-left:14px;">${modelParts}${timeRangeHtml}</div>`;
      }

      row.innerHTML = `<div style="display:flex; justify-content:space-between; font-size:14.5px; color:#5a4636; font-weight:600; margin-bottom:4px;"><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:400px;">${i + 1}. ${name}</span><span>${this._fmtTok(v)}</span></div>
        <div style="height:10px; background:#fde7c8; border:1.5px solid #5a4636; border-radius:6px; overflow:hidden;"><div style="height:100%; width:${Math.max(4, Math.round(v / max * 100))}%; background:#ff8c42;"></div></div>
        ${this._tierHtml(itemData, true)}
        ${agentModelsHtml}`;
      rank.appendChild(row);
    });

    const when = new Date(this.usage.generatedAt);
    const hh = String(when.getHours()).padStart(2, '0'), mm = String(when.getMinutes()).padStart(2, '0');
    $('og-usage-foot').textContent = `计费 = 纯输入(1x) + 缓存写(1.25x) + 输出（缓存读≈0.1x 不计）· 命中 = 读÷全部输入 · 复用 = 读÷写 · 更新于 ${hh}:${mm}`;
  }

  _formatSessionTime(minTs, maxTs) {
    if (!minTs || !maxTs) return '';
    const d1 = new Date(minTs), d2 = new Date(maxTs);
    const pad = (n) => String(n).padStart(2, '0');
    const date1 = `${pad(d1.getMonth() + 1)}-${pad(d1.getDate())}`;
    const date2 = `${pad(d2.getMonth() + 1)}-${pad(d2.getDate())}`;
    const t1 = `${pad(d1.getHours())}:${pad(d1.getMinutes())}`;
    const t2 = `${pad(d2.getHours())}:${pad(d2.getMinutes())}`;
    if (date1 === date2) {
      return `${date1} ${t1} - ${t2}`;
    } else {
      return `${date1} ${t1} - ${date2} ${t2}`;
    }
  }

  // ── 走动 + 走近判定 ───────────────────────────────────────
  _startLoop() {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
      // Ctrl/⌘+C 取消当前对话框正在跑的任务（即便没聚焦输入框，走动时也能取消）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (this.pending[this.activeId] && !String(window.getSelection?.() || '')) { e.preventDefault(); this._cancel(); }
        return;
      }
      if ($('og-team').style.display !== 'none' || $('og-edit').style.display !== 'none' || $('og-usage').style.display !== 'none') return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) { this.keys[k] = true; e.preventDefault(); }
      else if (k >= '1' && k <= '9') { const id = this.order[parseInt(k, 10) - 1]; if (id) { this._teleportTo(id); e.preventDefault(); } }
      else if (k === 'e' || k === ' ') { if (this.nearId) { this.activeId = this.nearId; this._renderHeader(); this._renderChat(); $('og-input').focus(); } e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });

    const playerEl = $('og-player'), spriteEl = $('og-sprite'), promptEl = $('og-prompt'), promptName = $('og-prompt-name');
    playerEl.style.left = this.player.x + 'px';
    playerEl.style.top = this.player.y + 'px';

    let frames = 0;
    const loop = () => {
      const room = $('og-map');
      let { x, y } = this.player;
      const up = this.keys['arrowup'] || this.keys['w'], dn = this.keys['arrowdown'] || this.keys['s'];
      const lf = this.keys['arrowleft'] || this.keys['a'], rt = this.keys['arrowright'] || this.keys['d'];
      if (up) y -= WALK_SPEED; if (dn) y += WALK_SPEED; if (lf) x -= WALK_SPEED; if (rt) x += WALK_SPEED;
      if (room && room.clientWidth) { x = Math.max(6, Math.min(room.clientWidth - 102, x)); y = Math.max(198, Math.min(room.clientHeight - 150, y)); }
      this.player = { ...this.player, x, y };
      playerEl.style.left = x + 'px';
      playerEl.style.top = y + 'px';
      if (lf) this.facing = -1; else if (rt) this.facing = 1;
      spriteEl.style.transform = 'scaleX(' + this.facing + ')';

      // 走近最近的同事 → 自动切到 TA 的聊天框
      const cx = x + 48, cy = y + 96; let near = null, nd = 1e9;
      for (const id of this.order) {
        const s = this.slots[id]; if (!s) continue;
        const d = Math.hypot(cx - s.anchor[0], cy - s.anchor[1]);
        if (d < nd) { nd = d; near = id; }
      }
      const newNear = nd < NEAR_DIST ? near : null;
      if (newNear !== this.nearId) {
        this.nearId = newNear;
        if (newNear && newNear !== this.activeId) { this.activeId = newNear; this._renderHeader(); this._renderChat(); }
      }
      if (this.nearId) { promptEl.style.opacity = '1'; if (promptName) promptName.textContent = this._name(this.nearId); }
      else promptEl.style.opacity = '0';

      // 门口劝退：走到 EXIT 门下方还想往上（W/↑）→ 弹黑色幽默气泡；走远自动消失
      const door = $('og-door');
      if (door && room) {
        const dr = door.getBoundingClientRect(), rr = room.getBoundingClientRect();
        const dLeft = dr.left - rr.left, dRight = dr.right - rr.left;
        const inZone = cx >= dLeft - 14 && cx <= dRight + 14 && y <= 206;
        if (inZone && up && !this._doorBubbleOn) {
          this._doorBubbleOn = true;
          this._showDoorBubble((dLeft + dRight) / 2);
        } else if (this._doorBubbleOn && (y > 260 || cx < dLeft - 70 || cx > dRight + 70)) {
          this._doorBubbleOn = false;
          this._hideDoorBubble();
        }
      }

      if (++frames % 30 === 0) this._savePlayer();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ── EXIT 门的打工人劝退语 ─────────────────────────────────
  _showDoorBubble(doorCenterX) {
    const LINES = [
      '小小牛马，想去哪儿呢？赶紧回去干活 🐴',
      '门是装饰品，就像你的下班时间。',
      '出去？这事儿 KPI 同意了吗？',
      '外面没有老板，但也没有工资哦。',
      '这扇门只进不出，跟需求池一个道理。',
      '想跑？你的任务还没跑完呢。',
      '门禁卡余额不足：还差 3 个需求才能解锁。',
      '今天的你也是公司最靓的牛马，回去吧。',
      '自由是留给交付完的人的。',
      '早上进来的时候，没想过还能出去吧？',
      '检测到摸鱼企图，已通知 PM 👀',
      'EXIT 的意思是：Effort × Immediately，快去。',
    ];
    let bub = document.getElementById('og-door-bubble');
    if (!bub) {
      bub = document.createElement('div');
      bub.id = 'og-door-bubble';
      // 挂在门的左侧（门贴屏幕右缘，放下方/居中会被裁掉），尾巴朝右指着门
      bub.style.cssText = 'position:absolute; z-index:60; width:225px; background:#fff; border:3px solid #5a4636; border-radius:14px; box-shadow:3px 3px 0 #5a4636; padding:10px 14px; font-size:13.5px; font-weight:600; color:#5a4636; line-height:1.5; transition:opacity .25s; pointer-events:none;';
      const tail = document.createElement('div');
      tail.style.cssText = 'position:absolute; right:-10px; top:50%; transform:translateY(-50%) rotate(45deg); width:14px; height:14px; background:#fff; border-right:3px solid #5a4636; border-top:3px solid #5a4636;';
      bub.appendChild(tail);
      const txt = document.createElement('div');
      txt.id = 'og-door-bubble-text';
      bub.appendChild(txt);
      $('og-map').appendChild(bub);
    }
    document.getElementById('og-door-bubble-text').textContent = LINES[Math.floor(Math.random() * LINES.length)];
    const doorEl = $('og-door'), room = $('og-map');
    if (doorEl && room) {
      const dLeft = doorEl.getBoundingClientRect().left - room.getBoundingClientRect().left;
      bub.style.left = (dLeft - 240) + 'px'; // 门左侧,留出气泡宽度+尾巴
    } else {
      bub.style.left = (doorCenterX - 290) + 'px';
    }
    bub.style.top = '92px'; // 门中部高度
    bub.style.opacity = '1';
    bub.style.display = 'block';
  }

  _hideDoorBubble() {
    const bub = document.getElementById('og-door-bubble');
    if (!bub) return;
    bub.style.opacity = '0';
    setTimeout(() => { if (bub.style.opacity === '0') bub.style.display = 'none'; }, 260);
  }
}

window.__office = new Office();
