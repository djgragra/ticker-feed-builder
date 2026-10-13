import { app, BrowserWindow, Menu, Tray, ipcMain, dialog, nativeImage, nativeTheme, screen, shell, Notification, safeStorage, powerSaveBlocker, net } from 'electron';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './src/runtime.js';
import { createLogger } from './src/logger.js';
import { sendTelegram, sendEmail, alertPrefix, installationName } from './src/notify.js';
import { createStore, newProfile, sanitizeProfile } from './src/settings.js';
import { buildExport, prepareImport, backupFileName } from './src/backup.js';
import { msg } from './src/messages.js';
import { sanitizeFormat } from './src/format.js';
import { checkForUpdate, downloadInstaller, bannerState, remindLaterState, skipVersionState, makeSafetyCopy, installPlan, whatsNew, startupKind } from './src/updater.js';

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
let downloadAbort = null;
let downloadedFile = null;
let downloadedFor = null;
let hadSettingsFile = false;

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

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function init() {
  hadSettingsFile = fs.existsSync(settingsFile());
  store = createStore({ file: settingsFile(), seal, open });
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
      if (Notification.isSupported()) new Notification({ title: alertTitle(), body: text }).show();
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

// "Ticker Feed Builder · Studio 2": the alerts say which installation speaks
const alertTitle = () => alertPrefix(settings()).slice(1, -1);

// the saved window is used only if it still lies on a screen that exists (a monitor may have been unplugged)
function savedBounds() {
  const w = settings().window;
  if (!w) return {};
  const out = { width: Math.max(860, w.width), height: Math.max(560, w.height) };
  if (w.x !== null && w.y !== null) {
    const visible = screen.getAllDisplays().some((d) => w.x + 80 > d.bounds.x && w.x < d.bounds.x + d.bounds.width - 80 && w.y >= d.bounds.y && w.y < d.bounds.y + d.bounds.height - 80);
    if (visible) { out.x = w.x; out.y = w.y; }
  }
  return out;
}

let boundsTimer = null;
function rememberWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return;
  const b = mainWindow.getNormalBounds(); // the place and size it has when not maximized
  store.update({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() } });
}
const rememberWindowSoon = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(rememberWindow, 600); };

function createWindow({ show = true } = {}) {
  const saved = savedBounds();
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    ...saved,
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
  if (settings().window?.maximized) mainWindow.maximize();
  mainWindow.on('resize', rememberWindowSoon);
  mainWindow.on('move', rememberWindowSoon);
  mainWindow.on('maximize', rememberWindowSoon);
  mainWindow.on('unmaximize', rememberWindowSoon);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // closing the window keeps the schedules running: the app lives in the tray
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    rememberWindow();
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
  announceStartup();
  setInterval(() => logger.prune(), 6 * 3600_000).unref();
  setTimeout(() => updateAlertTick().catch(() => {}), 60_000).unref();
  setInterval(() => updateAlertTick().catch(() => {}), 6 * 3600_000).unref();
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

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  logsDir: path.join(app.getPath('userData'), 'logs'),
  arch: process.arch,
  computerName: os.hostname(),
  packaged: app.isPackaged
}));

// Help & About: what to send to whoever helps. Never settings values, addresses, tokens, recipients or file names the user chose.
function supportInfo() {
  const u = settings().updateState.lastCheck;
  const lastError = logger.entries().filter((e) => e.level === 'error').at(-1);
  const home = os.homedir();
  const tidy = (s) => String(s || '').split(home).join('~');
  return [
    `Ticker Feed Builder ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · Node ${process.versions.node}`,
    `System: ${process.platform} ${os.release()} ${process.arch}`,
    `Language: ${settings().language} · Theme: ${settings().theme}`,
    `Installation: ${installationName(settings())}`,
    `Profiles: ${settings().profiles.length} · Feeds: ${settings().profiles.reduce((n, p) => n + p.feeds.length, 0)}`,
    `Last update check: ${u ? `${new Date(u.at).toISOString()} (${u.ok ? 'ok' : tidy(u.error || 'failed')})` : 'never'}`,
    `Last error: ${lastError ? `${new Date(lastError.t).toISOString()} ${tidy(lastError.message).slice(0, 160)}` : 'none'}`
  ].join('\n');
}
ipcMain.handle('app:support-info', () => supportInfo());
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

// ---- backup and restore (apps/COMMON-FEATURES.md, section 3) ---------------------------------------------

ipcMain.handle('backup:export', async (_e, includeSecrets) => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: backupFileName(), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    const file = buildExport(settings(), { includeSecrets: !!includeSecrets });
    // a file with secrets is for the owner only: mode 0600 (on Windows the mode is ignored)
    await fsp.writeFile(r.filePath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: file.includesSecrets ? 0o600 : 0o644 });
    if (file.includesSecrets) await fsp.chmod(r.filePath, 0o600).catch(() => {});
    return { ok: true, file: r.filePath, includesSecrets: file.includesSecrets, emptied: file.emptiedSecrets?.length || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:import', async (_e, mode) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled) return { ok: false };
  try {
    const stat = await fsp.stat(r.filePaths[0]);
    if (stat.size > 2_000_000) return { ok: false, error: 'too-big' };
    const plan = prepareImport(await fsp.readFile(r.filePaths[0], 'utf8'), settings(), { mode: mode === 'add' ? 'add' : 'replace' });
    if (!plan.ok) return plan;
    store.replace(plan.settings);
    afterSettingsChange();
    return { ok: true, settings: settings(), missing: plan.missing, added: plan.added, mode: plan.mode };
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
    await sendTelegram(c, msg(lang, 'test'), lang, undefined, alertPrefix(settings()));
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
    await sendEmail(c, `${alertPrefix(settings())} ${msg(lang, 'test').slice(0, 60)}`, `${alertPrefix(settings())} ${msg(lang, 'test')}`, lang);
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

// Telegram / email notice of a new version: the main process checks on its own, so it also works while the window is closed
async function updateAlertTick() {
  const s = settings();
  if (!s.general.checkUpdates || !s.notifications.updateAlert) return;
  const info = await checkForUpdate({ current: app.getVersion(), fetchFn: net.fetch });
  if (info.ok && info.available) runtime.announceUpdate({ latest: info.latest, current: info.current, url: info.url });
}

// ---- guided update (apps/COMMON-FEATURES.md, section 4) ------------------------------------------------------

// what the page may know: the installer's name and size, never a URL
const publicInfo = (info) => info && { ...info, installer: info.installer ? { name: info.installer.name, size: info.installer.size } : null, sumsUrl: undefined };
const updateView = (info) => ({ info: publicInfo(info), banner: bannerState(info, settings().updateState), lastCheck: settings().updateState.lastCheck, downloaded: downloadedFile && info?.available ? path.basename(downloadedFile) : null });
const setUpdateState = (patch) => store.update({ updateState: { ...settings().updateState, ...patch } });

ipcMain.handle('update:check', async () => {
  const info = await checkForUpdate({ current: app.getVersion(), fetchFn: net.fetch });
  lastUpdateInfo = info.ok ? info : null;
  if (downloadedFor && (!info.ok || info.latest !== downloadedFor)) { downloadedFile = null; downloadedFor = null; } // a newer release came out: download again
  setUpdateState({ lastCheck: { at: Date.now(), ok: !!info.ok, error: info.ok ? '' : String(info.error || '') } });
  return updateView(info);
});

ipcMain.handle('update:download', async () => {
  if (!lastUpdateInfo?.available) return { ok: false, error: 'no-update' };
  if (downloadAbort) return { ok: false, error: 'busy' };
  downloadAbort = new AbortController();
  try {
    downloadedFile = await downloadInstaller({
      info: lastUpdateInfo,
      dir: app.getPath('downloads'),
      fetchFn: net.fetch,
      current: app.getVersion(),
      signal: downloadAbort.signal,
      onProgress: (received, total) => send('update:progress', received, total)
    });
    downloadedFor = lastUpdateInfo.latest;
    logger.log('info', `update ${lastUpdateInfo.latest} downloaded and verified (SHA-256)`);
    return { ok: true, file: path.basename(downloadedFile) };
  } catch (err) {
    downloadedFile = null;
    downloadedFor = null;
    const cancelled = downloadAbort?.signal.aborted;
    if (!cancelled) logger.log('warn', `update download failed: ${err.message}`);
    return { ok: false, error: cancelled ? 'cancelled' : err.message };
  } finally {
    downloadAbort = null;
  }
});
ipcMain.handle('update:cancel', () => { downloadAbort?.abort(); return true; });

ipcMain.handle('update:remind', () => { setUpdateState(remindLaterState(settings().updateState)); return updateView(lastUpdateInfo); });
ipcMain.handle('update:skip', () => { setUpdateState(skipVersionState(settings().updateState, lastUpdateInfo?.latest)); return updateView(lastUpdateInfo); });

// "Close and install": refused while a profile is running; a safety copy of the settings first
ipcMain.handle('update:install', () => {
  if (!downloadedFile || !fs.existsSync(downloadedFile)) return { ok: false, error: 'no-file' };
  const busy = settings().profiles.filter((p) => scheduler.isRunning(p.id)).map((p) => p.name);
  if (busy.length) return { ok: false, error: 'busy', busy };
  store.flush();
  try {
    makeSafetyCopy({ file: settingsFile(), dir: path.join(app.getPath('userData'), 'backups'), version: lastUpdateInfo?.current || app.getVersion() });
  } catch (err) {
    return { ok: false, error: `safety copy: ${err.message}` };
  }
  const plan = installPlan(process.platform, downloadedFile);
  logger.log('info', `installing update ${lastUpdateInfo?.latest || ''} (${plan.kind})`);
  if (plan.kind === 'run-installer') {
    spawn(plan.file, [], { detached: true, stdio: 'ignore' }).unref();
    quitting = true;
    setTimeout(() => app.quit(), 300);
  } else if (plan.kind === 'open-image') shell.openPath(plan.file);
  else shell.showItemInFolder(plan.file);
  return { ok: true, kind: plan.kind, hint: plan.hint || null, quit: plan.quit };
});

ipcMain.handle('update:reveal', () => {
  if (downloadedFile && fs.existsSync(downloadedFile)) shell.showItemInFolder(downloadedFile);
});

// After a start of a newer version: a notice, and the window with what changed (once)
let startKind = 'same';
function announceStartup() {
  startKind = startupKind(settings().lastSeenVersion, app.getVersion(), hadSettingsFile);
  if (startKind === 'first') store.update({ lastSeenVersion: app.getVersion() });
  else if (startKind === 'updated' && Notification.isSupported()) new Notification({ title: alertTitle(), body: msg(settings().language, 'updatedTo', app.getVersion()) }).show();
}
ipcMain.handle('whatsnew:get', () => {
  if (startKind !== 'updated') return null;
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch { /* not packaged */ }
  return whatsNew(text, app.getVersion()) || { version: app.getVersion(), date: '', bullets: [] };
});
ipcMain.handle('whatsnew:seen', () => { startKind = 'same'; store.update({ lastSeenVersion: app.getVersion() }); return true; });
