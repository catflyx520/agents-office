import { getLanguage } from './i18n.js';

// Handles and File objects stay in this browser. Choosing a folder sends no files.
export function setupBrowserFolders(office) {
  const $ = id => document.getElementById(id);
  const text = (zh, en) => getLanguage() === 'zh' ? zh : en;
  const metadataKey = 'office_browser_projects';
  const projects = new Map(), announced = new Map(), pendingSaves = new Map();
  let enabled = false, live = false, epoch = 0, draft = null, draftTouched = false, pickerOwner = null;
  let database;
  const db = () => database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('office-browser-projects', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function stored(id, value, remove = false) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('folders', value || remove ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('folders');
      const request = remove ? store.delete(id) : value ? store.put(value, id) : store.get(id);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  function saveMetadata() {
    localStorage.setItem(metadataKey, JSON.stringify(Object.fromEntries([...projects].map(([id, project]) => [id, { name: project.name, key: project.key }]))));
  }
  async function permissions(project) {
    if (!project.handle) return;
    const read = await project.handle.queryPermission({ mode: 'read' });
    const write = await project.handle.queryPermission({ mode: 'readwrite' });
    project.connected = read === 'granted' || write === 'granted'; project.writable = write === 'granted';
  }
  const ready = (async () => {
    let saved; try { saved = JSON.parse(localStorage.getItem(metadataKey) || '{}'); } catch { return; }
    for (const [id, value] of Object.entries(saved)) {
      if (!value || typeof value.name !== 'string') continue;
      const project = { name: value.name, key: typeof value.key === 'string' ? value.key : crypto.randomUUID(), connected: false, writable: false };
      if (projects.has(id)) continue;
      projects.set(id, project);
      try { project.handle = await stored(id); await permissions(project); } catch { /* The user can select the folder again. */ }
    }
  })();
  const current = () => draft;
  function render() {
    if (!enabled || office.editingId === '__self') return;
    const project = current();
    $('og-f-row-cwd').style.display = '';
    $('og-f-cwd').readOnly = true;
    $('og-f-cwd').placeholder = text('请选择你电脑上的项目文件夹', 'Choose a project folder on your computer');
    $('og-f-cwd').value = project?.name || '';
    $('og-f-tools').placeholder = 'List,Read,Write,Edit';
    $('og-folder-pick').hidden = false;
    $('og-folder-pick').textContent = project?.handle && !project.writable
      ? text('授权访问', 'Allow access') : project ? text('更换文件夹', 'Change folder') : text('选择文件夹', 'Choose folder');
    $('og-folder-clear').hidden = !project;
    $('og-folder-clear').textContent = text('取消选择', 'Remove');
    $('og-folder-note').hidden = false;
    $('og-folder-note').textContent = !project
      ? text('请点击「选择文件夹」，选择你电脑上的 Project Folder 并授权，然后保存成员设置。授权后 AI 可读取项目；获得读写权限且启用 Write/Edit 后可修改文件。不会上传整个文件夹，也不会作为服务器路径使用。', 'Click Choose folder, select a Project Folder on your computer, grant access, then Save the teammate. AI can then read the project; read/write access with Write/Edit enabled allows file changes. Choosing a folder does not upload it or set a server directory.')
      : !project.connected
        ? text('此文件夹尚未获得访问授权或授权已失效。请点击「授权访问」，或重新选择文件夹并授权，然后保存成员设置。授权后即可读取项目；获得读写权限且启用 Write/Edit 后可修改文件。', 'Folder access has not been granted or has expired. Click Allow access or reselect and authorize the folder, then Save the teammate. Read access enables reading; read/write access with Write/Edit enabled allows file changes.')
        : project.writable
          ? text('本地目录已授权读写，保存成员设置后生效。AI 按需操作文件，文件内容经后端转交 AI，不在服务器保存项目副本；此模式不能运行本地终端命令。', 'Local read/write access granted; save the teammate to apply. Requested file contents pass through the backend to AI without a server project copy. Local terminal commands are unavailable.')
          : text('当前为只读访问。此浏览器无法直接写回所选目录，刷新后可能需要重新选择。', 'Read-only access. This browser cannot write back to this folder; you may need to reselect it after refresh.');
  }
  function announce(id, project, force = false) {
    if (!enabled || !office.byId[id]) return;
    const message = { type: 'set_browser_project', agentId: id, name: project?.name || '',
      projectId: project?.key || '', connected: !!project?.connected, writable: !!project?.writable };
    const signature = JSON.stringify(message);
    if (!force && announced.get(id) === signature) return;
    if (office.ws.send(message)) announced.set(id, signature);
  }
  function sync() {
    if (!enabled) return;
    for (const agent of office.agents) announce(agent.id, projects.get(agent.id));
    render();
  }
  async function remember(id, project) {
    projects.set(id, project);
    try { saveMetadata(); } catch { office._toast(text('浏览器无法记住文件夹名称；刷新后需重新选择。', 'The browser could not remember this folder name. Reselect after refresh.')); }
    if (project.handle) {
      try { await stored(id, project.handle); }
      catch { office._toast(text('已选择文件夹，但浏览器未能记住授权；刷新后需重新选择。', 'Folder selected, but this browser could not remember it. Reselect after refresh.')); }
    } else { try { await stored(id, null, true); } catch { /* A read-only selection remains in this tab. */ } }
  }
  async function choose() {
    const id = office.editingId, previous = current();
    try {
      if (previous?.handle && !previous.writable) {
        await previous.handle.requestPermission({ mode: 'readwrite' });
        await permissions(previous); draftTouched = true; render(); return;
      }
      if (!window.showDirectoryPicker) { pickerOwner = id; $('og-folder-files').click(); return; }
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const project = { name: handle.name, key: crypto.randomUUID(), handle, connected: true, writable: true };
      if (office.editingId !== id) return;
      draft = project; draftTouched = true;
      render();
    } catch (error) { if (error.name !== 'AbortError') office._toast(text('无法访问文件夹，请检查浏览器授权。', 'Could not access the folder. Check browser permissions.')); }
  }
  $('og-folder-pick').onclick = choose;
  $('og-folder-files').onchange = async event => {
    const selected = [...event.target.files]; event.target.value = '';
    if (!selected.length || office.editingId !== pickerOwner) return;
    const name = selected[0].webkitRelativePath.split('/')[0];
    const files = new Map(selected.map(file => [file.webkitRelativePath.slice(name.length + 1), file]));
    const project = { name, key: crypto.randomUUID(), files, connected: true, writable: false };
    draft = project; draftTouched = true;
    render();
  };
  $('og-folder-clear').onclick = () => { draft = null; draftTouched = true; render(); };
  const originalEdit = office._openEdit.bind(office);
  office._openEdit = id => {
    draftTouched = false; draft = projects.has(id) ? { ...projects.get(id) } : null;
    originalEdit(id); render(); ready.then(() => {
      if (office.editingId !== id) return;
      if (!draftTouched) draft = projects.has(id) ? { ...projects.get(id) } : null;
      render();
    });
  };
  office.ws.addEventListener('hosted_state', event => {
    enabled = event.detail.browserWorkspace === true; live = event.detail.experience === 'live';
    if (event.detail.reset) announced.clear();
    if (!live) epoch += 1;
    ready.then(sync);
  });
  office.ws.addEventListener('agents_list', event => {
    for (const agent of event.detail.agents) {
      const saved = pendingSaves.get(agent.id);
      if (!saved || agent.browserProjectId !== (saved.project?.key || '')
        || agent.projectConnected !== !!saved.project?.connected || agent.projectWritable !== !!saved.project?.writable) continue;
      pendingSaves.delete(agent.id);
      if (projects.get(agent.id)?.key !== saved.project?.key) epoch += 1;
      if (saved.project) remember(agent.id, saved.project).catch(() => office._toast(text('浏览器无法保存文件夹设置。', 'The browser could not save folder settings.')));
      else {
        projects.delete(agent.id);
        try { saveMetadata(); } catch { /* The current tab still drops access. */ }
        stored(agent.id, null, true).catch(() => {});
      }
      announced.delete(agent.id);
    }
    ready.then(sync);
  });
  office.ws.addEventListener('error', () => pendingSaves.clear());
  office.ws.addEventListener('disconnected', () => { live = false; epoch += 1; announced.clear(); pendingSaves.clear(); });
  office.ws.addEventListener('browser_tools_cancelled', () => { epoch += 1; });
  window.addEventListener('office-language', render);
  office.browserFolders = { get enabled() { return enabled; },
    apply(config) {
      const project = current();
      config.workDir = project?.name || ''; config.browserProject = !!project;
      config.browserProjectId = project?.key || '';
      config.projectConnected = !!project?.connected; config.projectWritable = !!project?.writable;
      pendingSaves.set(config.id, { project });
    },
  };

  function segments(value, allowRoot = false) {
    if (typeof value !== 'string' || /^(?:[a-z]:|[\\/])/i.test(value)) throw new Error('Use a relative path inside the selected folder.');
    const parts = value.replaceAll('\\', '/').split('/');
    if (parts.some(part => part === '..' || part.includes('\0'))) throw new Error('Paths cannot leave the selected folder.');
    const clean = parts.filter(part => part && part !== '.');
    if (!allowRoot && !clean.length) throw new Error('A file path is required.');
    return clean;
  }
  async function directory(root, parts, create = false, active = () => {}) {
    let folder = root;
    for (const part of parts) { active(); folder = await folder.getDirectoryHandle(part, { create }); }
    return folder;
  }
  async function fileHandle(project, parts, create = false, active = () => {}) {
    const folder = await directory(project.handle, parts.slice(0, -1), create, active);
    active();
    return folder.getFileHandle(parts.at(-1), { create });
  }
  office.ws.addEventListener('browser_tool_call', async event => {
    const message = event.detail, run = epoch, project = projects.get(message.agentId);
    const active = () => {
      if (!enabled || !live || run !== epoch || projects.get(message.agentId) !== project) throw new Error('File operation cancelled.');
      if (project?.key !== message.projectId) throw new Error('The selected project folder has changed.');
      if (!project?.connected) throw new Error(text('请到「团队 → 编辑这位成员」选择 Project Folder 并授权，或重新授权已选文件夹，然后保存并重试。授权后即可读取项目；获得读写权限且启用 Write/Edit 后可修改文件。', 'Go to Team → Edit this teammate, choose and authorize a Project Folder or restore access to the selected folder, then Save and retry. Read access enables reading; read/write access with Write/Edit enabled allows file changes.'));
    };
    try {
      await ready; active();
      const args = message.arguments || {}, parts = segments(args.path || '', message.name === 'list_files');
      let result;
      if (message.name === 'list_files') {
        if (project.handle) {
          const folder = await directory(project.handle, parts); result = [];
          for await (const [name, handle] of folder.entries()) result.push({ name, kind: handle.kind });
        } else {
          const prefix = parts.length ? parts.join('/') + '/' : '', entries = new Map();
          for (const path of project.files.keys()) if (path.startsWith(prefix)) {
            const rest = path.slice(prefix.length), name = rest.split('/')[0];
            entries.set(name, { name, kind: rest.includes('/') ? 'directory' : 'file' });
          }
          result = [...entries.values()];
        }
      } else if (message.name === 'read_file') {
        const file = project.handle ? await (await fileHandle(project, parts)).getFile() : project.files.get(parts.join('/'));
        if (!file) throw new Error('File not found in the selected folder.');
        const content = await file.text();
        if (content.includes('\0')) throw new Error('This operation reads text files, not binary files.');
        const lines = content.split('\n'), offset = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1;
        const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : 200;
        result = { path: parts.join('/'), totalLines: lines.length, offset,
          text: lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n') };
      } else if (message.name === 'write_file' || message.name === 'edit_file') {
        if (!project.handle || !project.writable) throw new Error('This folder has read-only access. Grant read/write permission first.');
        let content = args.content;
        if (message.name === 'write_file' && typeof content !== 'string') throw new Error('File content must be text.');
        const handle = await fileHandle(project, parts, message.name === 'write_file', active);
        if (message.name === 'edit_file') {
          if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('An exact oldText and newText are required.');
          const original = await (await handle.getFile()).text(), matches = original.split(args.oldText).length - 1;
          if (!matches || (matches > 1 && !args.replaceAll)) throw new Error('Text match is missing or ambiguous. Read the file and provide a unique match.');
          content = args.replaceAll ? original.replaceAll(args.oldText, args.newText) : original.replace(args.oldText, args.newText);
        }
        if (typeof content !== 'string') throw new Error('File content must be text.');
        active();
        const writer = await handle.createWritable();
        try { active(); await writer.write(content); active(); await writer.close(); }
        catch (error) { await writer.abort().catch(() => {}); throw error; }
        result = { path: parts.join('/'), saved: true };
      } else throw new Error('Unknown file operation.');
      active();
      const response = { type: 'browser_tool_result', requestId: message.requestId, ok: true, result };
      if (new TextEncoder().encode(JSON.stringify(response)).length > 2 * 1024 * 1024) throw new Error('File result is too large. Read fewer lines per request.');
      office.ws.send(response);
    } catch (error) { office.ws.send({ type: 'browser_tool_result', requestId: message.requestId, ok: false, error: error.message }); }
  });
}
