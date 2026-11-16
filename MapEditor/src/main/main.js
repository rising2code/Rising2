// Electron main process: owns the window and all file-system access.
// The renderer asks for files through the small API in preload.js.

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// Several copies of the editor may run at once (e.g. to copy objects between two levels).
// settings.json stays shared in userData, but Chromium's caches would fight over one folder,
// so each running copy gets its own temporary cache folder, removed when it quits.
const sessionDir = path.join(require('os').tmpdir(), 'rising2-map-editor', String(process.pid));
app.setPath('sessionData', sessionDir);
app.on('quit', () => { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* still in use */ } });
// folders left behind by copies that are no longer running (files can be locked at quit)
try {
  const base = path.dirname(sessionDir);
  for (const d of fs.readdirSync(base)) {
    const pid = Number(d);
    if (!pid || pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  }
} catch { /* no folder yet */ }

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    backgroundColor: '#1e1f22',
    title: 'Rising Eagle Map Editor',
    // custom title bar: the page's top toolbar is the title bar; Windows still draws the
    // minimise / maximise / close buttons on top of it (right 140 px, 40 px high)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#26282c', symbolColor: '#d8dade', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // The page blocks unloading while there are unsaved edits (beforeunload). Electron does not
  // show a prompt for that by itself, it just cancels the close, so ask here.
  win.webContents.on('will-prevent-unload', (event) => {
    if (process.argv.includes('--automation')) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close the editor and lose them? Use "Save .n2…" or "Export level…" first to keep them.',
    });
    if (choice === 0) event.preventDefault(); // preventDefault here means "let it close"
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
  const auto = process.argv.indexOf('--automation');
  if (auto >= 0) runAutomation(win, process.argv[auto + 1]);
}

// Test hook: `electron . --automation steps.json` runs [{js, shot, wait}] steps in the window,
// prints console output and saves screenshots, then quits. Used for automated checks.
function runAutomation(win, file) {
  const wc = win.webContents;
  wc.setBackgroundThrottling(false); // keep animation frames running when the window is not in front
  wc.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
  wc.once('did-finish-load', async () => {
    const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const s of steps) {
      try {
        if (s.js) {
          const r = await wc.executeJavaScript(`(async () => { ${s.js} })()`, true);
          if (r !== undefined) console.log('[step]', typeof r === 'string' ? r : JSON.stringify(r));
        }
        if (s.wait) await sleep(s.wait);
        if (s.shot) {
          win.show();
          wc.invalidate();
          await sleep(300);
          let img = await wc.capturePage(undefined, { stayAwake: true });
          if (img.isEmpty()) {
            // some desktops return nothing for a window in the background: fall back to the 3D canvas
            const url = await wc.executeJavaScript('app.viewport.snapshotDataUrl()', true);
            img = require('electron').nativeImage.createFromDataURL(url);
          }
          fs.writeFileSync(s.shot, img.toPNG());
          console.log('[shot]', s.shot);
        }
      } catch (e) {
        console.log('[step error]', e.message);
      }
    }
    app.quit();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));

handle('dialog:openFolder', async (opts = {}) => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'], ...opts });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:openFile', async (opts = {}) => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], ...opts });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:saveFile', async (opts = {}) => {
  const r = await dialog.showSaveDialog(opts);
  return r.canceled ? null : r.filePath;
});
handle('dialog:confirm', async (message, detail = '') => {
  const r = await dialog.showMessageBox({ type: 'question', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1, message, detail });
  return r.response === 0;
});

handle('fs:exists', (p) => fs.existsSync(p));
handle('fs:readText', (p, enc = 'latin1') => fsp.readFile(p, enc));
handle('fs:readBinary', async (p) => new Uint8Array(await fsp.readFile(p)));
handle('fs:writeFile', async (p, data) => {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data));
  return true;
});
handle('fs:list', async (dir) => {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents.map((e) => ({ name: e.name, dir: e.isDirectory() }));
});
handle('fs:listRecursive', async (dir, exts) => {
  const out = [];
  const walk = async (d) => {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!exts || exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  await walk(dir);
  return out;
});
// `exclude`: paths relative to src (any case, \ or /) that are not copied
handle('fs:copyDir', async (src, dst, exclude = []) => {
  const skip = new Set(exclude.map((p) => p.replace(/\//g, '\\').toLowerCase()));
  let skipped = 0, skippedBytes = 0;
  await fsp.cp(src, dst, {
    recursive: true,
    force: true,
    filter: (p) => {
      // Electron hands long-path forms here ("\\?\E:\..."): compare without that prefix
      const rel = path.relative(src.replace(/^\\\\\?\\/, ''), p.replace(/^\\\\\?\\/, ''));
      if (!skip.has(rel.toLowerCase())) return true;
      skipped++;
      try { skippedBytes += fs.statSync(p).size; } catch { /* gone */ }
      return false;
    },
  });
  return { skipped, skippedBytes };
});
handle('fs:remove', async (p) => {
  await fsp.rm(p, { force: true });
  return true;
});
handle('path:appDir', () => app.getAppPath());
handle('app:args', () => process.argv);
// the Windows clipboard, shared by every editor window and every running copy of the editor
handle('clipboard:read', () => clipboard.readText());
handle('clipboard:write', (text) => { clipboard.writeText(text); return true; });
handle('shell:open', (p) => shell.openPath(p));

// Bots' navigation map: built by Recast in a worker thread (nav-worker.mjs); progress is sent
// to the window as 'nav:progress' events. A new build stops the previous one.
let navWorker = null;
ipcMain.handle('nav:build', (event, input) => new Promise((resolve, reject) => {
  const { Worker } = require('worker_threads');
  if (navWorker) navWorker.terminate();
  const w = (navWorker = new Worker(path.join(__dirname, 'nav-worker.mjs'), { workerData: input }));
  w.on('message', (m) => {
    if (m.progress) { if (!event.sender.isDestroyed()) event.sender.send('nav:progress', m.progress); return; }
    if (navWorker === w) navWorker = null;
    w.terminate();
    if (m.error) reject(new Error(m.error)); else resolve(m.result);
  });
  w.on('error', (e) => { if (navWorker === w) navWorker = null; reject(e); });
  w.on('exit', (code) => { if (navWorker === w) { navWorker = null; reject(new Error('Navigation build stopped (' + code + ')')); } });
}));

handle('settings:load', async () => {
  try { return JSON.parse(await fsp.readFile(settingsFile(), 'utf8')); } catch { return {}; }
});
handle('settings:save', async (s) => {
  await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(s, null, 2));
  return true;
});
