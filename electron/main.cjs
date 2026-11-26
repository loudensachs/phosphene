// Phosphene desktop shell.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, session } = require('electron');
const { Readable } = require('node:stream');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.setName('Phosphene');
// scripted test runs get their own profile so they can never touch the recovery file, recents or settings of a real session
if (process.env.PHOSPHENE_SHOT) app.setPath('userData', require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'phosphene-test-')));
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'WebGPU');
// keep the render loop at full rate when the window is occluded (output window on another display)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const DEV = !!process.env.PHOSPHENE_DEV;

// media:// streams local video/image files with range support so large clips never load into memory
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }]);
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
function serveMedia() {
  protocol.handle('media', async req => {
    try {
      const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const st = await fs.promises.stat(p);
      let start = 0, end = st.size - 1, status = 200;
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
      if (m) { if (m[1]) start = +m[1]; if (m[2]) end = Math.min(+m[2], st.size - 1); status = 206; }
      const headers = { 'Content-Type': MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), { status, headers });
    } catch (e) { return new Response(String(e), { status: 404 }); }
  });
}
let win = null;
let allowClose = false;
let pendingOpen = null;   // a .phos file opened from Finder before the window was ready

function create() {
  win = new BrowserWindow({
    width: 1680, height: 1020, minWidth: 1100, minHeight: 640,
    backgroundColor: '#0c0c0d', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 9 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  // closing asks the editor first so unsaved work can be saved; the editor answers with 'closeNow'
  win.on('close', e => {
    if (allowClose || process.env.PHOSPHENE_SHOT || win.webContents.isCrashed()) return;
    e.preventDefault();
    win.webContents.send('closeRequest');
  });
  win.on('closed', () => { win = null; });
  if (DEV) win.loadURL('http://localhost:5173'); else win.loadFile(path.join(process.env.PHOSPHENE_DIST || path.join(__dirname, '..', 'dist'), 'index.html'));
  // child windows (the fullscreen output) share the renderer process so they can present from the same GPU device
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { backgroundColor: '#000000', autoHideMenuBar: true, title: 'Phosphene Output', webPreferences: { backgroundThrottling: false } },
  }));

  // dev aid: PHOSPHENE_SHOT=/path.png [PHOSPHENE_EVAL=js] [PHOSPHENE_SHOT_DELAY=ms] captures the window then quits
  const shot = process.env.PHOSPHENE_SHOT;
  if (shot) {
    setTimeout(() => app.quit(), +(process.env.PHOSPHENE_SHOT_TIMEOUT || 240000));
    win.webContents.once('did-finish-load', async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      await wait(1500);
      try {
        if (process.env.PHOSPHENE_EVAL) await win.webContents.executeJavaScript(process.env.PHOSPHENE_EVAL, true);
        await wait(+(process.env.PHOSPHENE_SHOT_DELAY || 1500));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
      } catch (e) { console.error('shot failed', e); }
      app.quit();
    });
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.error('[renderer]', msg); });
  }
}

const filt = f => (f && f.length ? f : [{ name: 'All Files', extensions: ['*'] }]);
ipcMain.handle('pickFile', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filt(filters) });
  if (r.canceled || !r.filePaths[0]) return null;
  const b = await fs.promises.readFile(r.filePaths[0]);
  return { path: r.filePaths[0], data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
});
ipcMain.handle('pickPaths', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: filt(filters) });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('openDialog', async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filt(filters) });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle('saveDialog', async (_e, name, filters) => {
  if (process.env.PHOSPHENE_SHOT && process.env.PHOSPHENE_SAVE) return process.env.PHOSPHENE_SAVE;   // scripted runs name their output up front
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: filt(filters) });
  return r.canceled ? null : r.filePath ?? null;
});
ipcMain.on('closeNow', () => { allowClose = true; win?.close(); });
ipcMain.handle('confirmSave', async (_e, name) => {
  if (process.env.PHOSPHENE_SHOT) return 'discard';   // scripted runs never block on a dialog
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
    message: `Do you want to save the changes you made to “${name}”?`, detail: "Your changes will be lost if you don't save them.",
  });
  return ['save', 'discard', 'cancel'][r.response];
});
ipcMain.handle('ask', async (_e, o) => process.env.PHOSPHENE_SHOT ? o.buttons.length - 1 : (await dialog.showMessageBox(win, { type: o.type || 'question', buttons: o.buttons, defaultId: 0, cancelId: o.buttons.length - 1, message: o.message, detail: o.detail })).response);
ipcMain.on('docState', (_e, st) => {
  if (!win) return;
  win.setTitle(`${st.name}${st.dirty ? ' — Edited' : ''}`);
  if (process.platform === 'darwin') { win.setDocumentEdited(!!st.dirty); win.setRepresentedFilename(st.path || ''); }
});
ipcMain.on('recent', (_e, p) => { try { app.addRecentDocument(p); } catch {} });
ipcMain.on('clearRecent', () => { try { app.clearRecentDocuments(); } catch {} });

// ---- the macOS menu bar mirrors the in-app menus (the window sends their contents whenever they change) ----
// Shortcuts the page already handles are shown and registered; the page's preventDefault stops a double run.
// Single keys (H, D, B, ⌫) are shown only, so they never steal typing.
function accel(hint) {
  if (!hint || !/⌘/.test(hint)) return null;
  const key = hint.replace(/[⌘⇧⌥⌃]/g, '').replace('↩', 'Return').replace('⌫', 'Backspace');
  if (!key) return null;
  return (hint.includes('⇧') ? 'Shift+' : '') + (hint.includes('⌥') ? 'Alt+' : '') + 'CmdOrCtrl+' + key;
}
function buildMenu(spec) {
  const send = id => { const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]; w?.webContents.send('menu:run', id); };
  const item = it => {
    if (it.sep) return { type: 'separator' };
    if (it.sub) return { label: it.label, enabled: !it.disabled, submenu: it.sub.length ? it.sub.map(item) : [{ label: 'None', enabled: false }] };
    const a = accel(it.hint);
    const m = { label: it.label, enabled: !it.disabled, click: () => send(it.id) };
    if (a) m.accelerator = a;
    else if (it.hint === '●') { m.type = 'checkbox'; m.checked = true; }
    return m;
  };
  const tpl = [];
  if (process.platform === 'darwin') tpl.push({ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
  for (const [name, items] of Object.entries(spec)) tpl.push({ label: name, submenu: items.map(item) });
  tpl.push({ role: 'windowMenu' });
  tpl.push({ role: 'help', submenu: [{ label: 'Search Operators', accelerator: 'Tab', registerAccelerator: false, click: () => send('help:search') }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
  // dev aid: PHOSPHENE_MENU_DUMP=/path.json writes what the menu bar holds
  if (process.env.PHOSPHENE_MENU_DUMP) { const dump = m => m.items.map(i => i.type === 'separator' ? '—' : { label: i.label, accel: i.accelerator || undefined, enabled: i.enabled, sub: i.submenu ? dump(i.submenu) : undefined }); require('fs').writeFileSync(process.env.PHOSPHENE_MENU_DUMP, JSON.stringify(dump(Menu.getApplicationMenu()), null, 1)); }
}
let lastMenu = '';
ipcMain.on('menu:set', (_e, spec) => { const k = JSON.stringify(spec); if (k === lastMenu) return; lastMenu = k; try { buildMenu(spec); } catch (err) { console.error('[menu]', err); } });
ipcMain.handle('userPath', (_e, name) => path.join(app.getPath('userData'), name));
ipcMain.handle('exists', (_e, p) => fs.existsSync(p));
ipcMain.handle('unlink', async (_e, p) => { try { await fs.promises.unlink(p); } catch {} });
ipcMain.handle('takePendingOpen', () => { const p = pendingOpen; pendingOpen = null; return p; });
// double-clicking a .phos file in Finder
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win && !win.webContents.isLoading()) { win.webContents.send('openFile', p); if (win.isMinimized()) win.restore(); win.focus(); } else pendingOpen = p;
});
const tempDirs = [];
ipcMain.handle('tempPath', (_e, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphene-')); tempDirs.push(d); return path.join(d, name); });
// export caches and audio mixdowns are large; do not leave them behind
app.on('will-quit', () => { for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));

app.whenReady().then(() => {
  // cameras, audio inputs and MIDI controllers are core to a live visual tool
  const ok = new Set(['media', 'midi', 'midiSysex', 'fullscreen', 'window-management']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ok.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ok.has(perm));
  serveMedia(); create();
});
app.on('window-all-closed', () => app.quit());
