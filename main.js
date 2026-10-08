import { app, BrowserWindow, Menu, Tray, ipcMain, dialog, nativeImage, nativeTheme, shell, Notification, safeStorage, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './src/runtime.js';
import { createLogger } from './src/logger.js';
import { sendTelegram, sendEmail } from './src/notify.js';
import { createStore, exportable, newProfile, sanitizeSettings, sanitizeProfile, sanitizeUrl } from './src/settings.js';
import { msg } from './src/messages.js';
import { sanitizeFormat } from './src/format.js';
import { checkForUpdate, downloadInstaller } from './src/updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTERNAL_OK = /^https:\/\/(onairgarage\.com|github\.com\/djgragra)(\/|$)/;
const SEAL = 'enc:v1:';
const startedHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let tray = null;
let quitting = false;
let keepAwakeId = null;
let lastUpdateInfo = null;

// ---- storage, log, engine ---------------------------------------------------------------------

// The Telegram token is encrypted with the operating system keystore when it is available.
const seal = (v) => {
  try {
    return safeStorage.isEncryptionAvailable() ? SEAL + safeStorage.encryptString(v).toString('base64') : v;
  } catch {
    return v;
  }
};
const open = (v) => {
  if (!v.startsWith(SEAL)) return v;
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(SEAL.length), 'base64'));
  } catch {
    return '';
  }
};

let store, logger, runtime, engine, scheduler;
const send = (channel, ...args) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
};
const settings = () => store.get();
const fullStatus = () => (runtime ? runtime.fullStatus() : { active: false, profiles: {} });

function init() {
  store = createStore({ file: path.join(app.getPath('userData'), 'settings.json'), seal, open });
  logger = createLogger({
    dir: path.join(app.getPath('userData'), 'logs'),
    retentionDays: settings().general.logRetentionDays,
    onEntry: (e) => send('log:entry', e)
  });
  logger.prune();
  runtime = createRuntime({
    getSettings: settings,
    log: (level, m) => logger.log(level, m),
    stateFile: path.join(app.getPath('userData'), 'state.json'),
    builtinPlaceholder: () => fsp.readFile(path.join(__dirname, 'assets', 'placeholder.jpg')),
    notifyDesktop: (text) => {
      if (Notification.isSupported()) new Notification({ title: 'Ticker Feed Builder', body: text }).show();
    },
    onStatus: (s) => {
      send('status:update', s);
      refreshTray();
    }
  });
  engine = runtime.engine;
  scheduler = runtime.scheduler;
}

// ---- window, tray, menu -----------------------------------------------------------------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    show,
    title: 'Ticker Feed Builder',
    backgroundColor: BG[settings().theme === 'light' ? 'light' : 'dark'],
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_OK.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // closing the window keeps the schedules running: the app lives in the tray
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!settings().closeHintShown) {
      store.update({ closeHintShown: true });
      if (Notification.isSupported()) new Notification({ title: 'Ticker Feed Builder', body: msg(settings().language, 'closeHint') }).show();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function trayImage() {
  const dir = path.join(__dirname, 'assets');
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(dir, 'tray.png'));
}

function summary() {
  let ok = 0, bad = 0;
  const st = fullStatus().profiles;
  for (const p of settings().profiles) {
    for (const f of p.feeds.filter((x) => x.enabled)) {
      const r = st[p.id]?.feeds?.[f.id];
      if (r) (r.ok ? ok++ : bad++);
    }
  }
  return { ok, bad };
}

function refreshTray() {
  if (!tray) return;
  const { ok, bad } = summary();
  const l = settings().language;
  const active = runtime.scheduler.isActive();
  tray.setToolTip(`Ticker Feed Builder — ${active ? '' : msg(l, 'paused') + ' — '}${ok} OK${bad ? `, ${bad} ${msg(l, 'withProblems')}` : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: msg(l, 'open'), click: showWindow },
      { label: msg(l, 'runAll'), click: () => settings().profiles.forEach((p) => scheduler.runNow(p.id)) },
      { label: active ? msg(l, 'pause') : msg(l, 'resume'), click: () => setPaused(active) },
      { type: 'separator' },
      { label: msg(l, 'quit'), click: () => { quitting = true; app.quit(); } }
    ])
  );
}

function setPaused(paused) {
  if (paused) runtime.stop();
  else runtime.start({ immediately: true });
  refreshTray();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), { role: 'editMenu' }, { role: 'windowMenu' }]));
}

const BG = { dark: '#0d0f12', light: '#f3f4f6' };
function applyTheme() {
  const th = settings().theme;
  nativeTheme.themeSource = th === 'auto' ? 'system' : th;
  const dark = th === 'auto' ? nativeTheme.shouldUseDarkColors : th === 'dark';
  mainWindow?.setBackgroundColor(dark ? BG.dark : BG.light);
}
nativeTheme.on('updated', () => settings().theme === 'auto' && applyTheme());

function applySystemSettings() {
  const g = settings().general;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: g.startOnBoot, args: ['--hidden'] });
  if (g.keepAwake && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!g.keepAwake && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
  logger.setRetention(g.logRetentionDays);
}

app.whenReady().then(() => {
  init();
  buildMenu();
  applyTheme();
  const g = settings().general;
  createWindow({ show: !(startedHidden || g.startMinimized) });
  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  applySystemSettings();
  runtime.loadState();
  if (g.runOnLaunch) runtime.start();
  else {
    runtime.start({ immediately: false }); // the timer of the daily summary runs anyway
    runtime.stop();
  }
  refreshTray();
  setInterval(() => logger.prune(), 6 * 3600_000).unref();
  app.on('activate', showWindow);
});
app.on('second-instance', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  runtime?.dispose();
  store?.flush();
});

// ---- IPC: settings, profiles --------------------------------------------------------------------

const afterSettingsChange = () => {
  applySystemSettings();
  applyTheme();
  runtime.refresh();
  refreshTray();
  send('settings:changed', settings());
};

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, logsDir: path.join(app.getPath('userData'), 'logs') }));
ipcMain.handle('settings:get', () => settings());
ipcMain.handle('settings:update', (_e, patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return settings();
  delete patch.profiles; // profiles go through profile:save
  const next = store.update(patch);
  afterSettingsChange();
  return next;
});

ipcMain.handle('profile:save', (_e, profile) => {
  if (!profile || typeof profile !== 'object') return null;
  const saved = store.saveProfile(profile);
  runtime.refresh();
  return saved;
});

ipcMain.handle('profile:create', (_e, name) => {
  const p = store.saveProfile(newProfile(String(name || '').slice(0, 60) || 'Profile'));
  runtime.refresh();
  return p;
});

ipcMain.handle('profile:delete', (_e, id) => {
  store.deleteProfile(String(id));
  runtime.refresh();
  return true;
});

ipcMain.handle('profile:reorder', (_e, ids) => store.reorderProfiles(ids));
ipcMain.handle('profile:run', (_e, id) => scheduler.runNow(String(id)));
ipcMain.handle('profile:open-output', async (_e, id) => {
  const p = settings().profiles.find((x) => x.id === id);
  if (!p?.outputDir) return 'no-folder';
  return (await shell.openPath(p.outputDir)) || 'ok';
});

ipcMain.handle('scheduler:status', () => fullStatus());
ipcMain.handle('scheduler:set-paused', (_e, paused) => {
  setPaused(!!paused);
  return fullStatus();
});

ipcMain.handle('feed:test', async (_e, feed, profileId, raw) => {
  const base = settings().profiles.find((p) => p.id === profileId) || null;
  if (!feed || typeof feed !== 'object') return { ok: false, error: 'invalid feed' };
  // the page may hold edits that are not saved yet: use them, checked like any saved feed
  const merged = sanitizeProfile({ ...(base || {}), feeds: [...(base?.feeds || []).filter((f) => f.id !== feed.id), feed] });
  const clean = merged.feeds.find((f) => f.id === feed.id) || merged.feeds.at(-1);
  if (clean.type !== 'merge' && !clean.url) return { ok: false, error: 'invalid URL' };
  try {
    return { ok: true, ...(await engine.previewFeed(clean, 8, base ? { ...merged, id: base.id } : null, { raw: !!raw })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('placeholder:preview', async (_e, file) => {
  try {
    return await engine.placeholderThumb({ placeholderPath: String(file || ''), format: sanitizeFormat({}) });
  } catch {
    return null;
  }
});

ipcMain.handle('pick:folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick:image', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff'] }] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('settings:export', async () => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: 'ticker-feed-builder-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  await fsp.writeFile(r.filePath, JSON.stringify({ app: 'ticker-feed-builder', version: 1, settings: exportable(settings()) }, null, 2), 'utf8');
  return { ok: true, file: r.filePath };
});

ipcMain.handle('settings:import', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled) return { ok: false };
  try {
    const stat = await fsp.stat(r.filePaths[0]);
    if (stat.size > 2_000_000) throw new Error('file too large');
    const raw = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
    if (raw?.app !== 'ticker-feed-builder' || typeof raw.settings !== 'object') throw new Error('not a Ticker Feed Builder settings file');
    const incoming = sanitizeSettings(raw.settings);
    incoming.notifications.telegram.botToken = settings().notifications.telegram.botToken; // secrets never travel in the file
    incoming.notifications.email.pass = settings().notifications.email.pass;
    store.replace(incoming);
    afterSettingsChange();
    return { ok: true, settings: settings() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- IPC: logs, Telegram, updates ---------------------------------------------------------------

ipcMain.handle('logs:get', () => logger.entries());
ipcMain.handle('logs:open-folder', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));

ipcMain.handle('telegram:test', async (_e, cfg) => {
  const lang = settings().language;
  try {
    const c = {
      enabled: true,
      botToken: String(cfg?.botToken || settings().notifications.telegram.botToken),
      recipients: Array.isArray(cfg?.recipients) ? cfg.recipients.slice(0, 20).map((r) => ({ chatId: String(r?.chatId ?? ''), note: String(r?.note ?? '') })) : settings().notifications.telegram.recipients
    };
    await sendTelegram(c, msg(lang, 'test'), lang);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('email:test', async (_e, cfg) => {
  const lang = settings().language;
  try {
    const cur = settings().notifications.email;
    const c = { ...cur, ...(cfg && typeof cfg === 'object' ? cfg : {}), enabled: true };
    if (!cfg?.pass) c.pass = cur.pass; // the password is not echoed to the page
    c.recipients = Array.isArray(c.recipients) ? c.recipients.slice(0, 20).map(String) : cur.recipients;
    await sendEmail(c, `${'[Ticker Feed Builder]'} ${msg(lang, 'test').slice(0, 60)}`, msg(lang, 'test'), lang);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('digest:send', () => runtime.digestNow());

ipcMain.handle('cli:info', () => ({
  exe: process.execPath,
  script: path.join(app.getAppPath(), 'src', 'cli.js'),
  settingsFile: path.join(app.getPath('userData'), 'settings.json'),
  dataDir: path.join(app.getPath('userData'), 'headless'),
  platform: process.platform
}));

ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && EXTERNAL_OK.test(url)) shell.openExternal(url);
});

ipcMain.handle('update:check', async () => {
  const info = await checkForUpdate();
  lastUpdateInfo = info.ok ? info : null;
  return { ...info, installer: info.installer ? { name: info.installer.name, size: info.installer.size } : null };
});

ipcMain.handle('update:download', async () => {
  if (!lastUpdateInfo?.available) return { ok: false, error: 'no-update' };
  try {
    const file = await downloadInstaller(lastUpdateInfo, app.getPath('downloads'), (received, total) => send('update:progress', received, total));
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:reveal', (_e, file) => {
  if (typeof file === 'string' && path.dirname(file) === app.getPath('downloads')) shell.showItemInFolder(file);
});
