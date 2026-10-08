#!/usr/bin/env node
// Headless mode: the same engine, schedules, alerts and daily summary as the app, with no window and no tray.
// For a server without a screen, or a machine that must update the ticker after a restart before anyone logs in.
//
//   node src/cli.js --settings settings.json [--data ./tfb-data] [--once] [--no-state]
//
// Secrets never travel in the settings file: set TFB_TELEGRAM_TOKEN and TFB_SMTP_PASS in the environment.
// The packaged app can run it too, without installing Node:
//   ELECTRON_RUN_AS_NODE=1 "Ticker Feed Builder.exe" "<resources>/app.asar/src/cli.js" --settings ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './runtime.js';
import { createLogger } from './logger.js';
import { sanitizeSettings } from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { settings: 'settings.json', data: './tfb-data', once: false, state: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--settings') a.settings = argv[++i];
    else if (k === '--data') a.data = argv[++i];
    else if (k === '--once') a.once = true;
    else if (k === '--no-state') a.state = false;
    else if (k === '--help' || k === '-h') a.help = true;
    else { console.error(`Unknown option: ${k}`); a.help = true; a.bad = true; }
  }
  return a;
}

const HELP = `Ticker Feed Builder, headless mode

  --settings <file>   settings exported from the app ("Export settings") or the app's own settings.json (default: settings.json)
  --data <dir>        where logs and the remembered state go (default: ./tfb-data)
  --once              run every profile once and exit (0 = all feeds fine, 1 = some problem, 2 = settings unusable)
  --no-state          do not remember anything between runs
  --help

Secrets (environment): TFB_TELEGRAM_TOKEN, TFB_SMTP_PASS. The settings file is checked again every 30 seconds:
export new settings over it and they are picked up without a restart.`;

// Reads the file the app exports ({ app, settings }) or the app's own store ({ version, settings }); sealed secrets are dropped.
export function loadSettingsFile(file, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = sanitizeSettings(raw.settings ?? raw);
  const sealed = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
  if (sealed(s.notifications.telegram.botToken)) s.notifications.telegram.botToken = '';
  if (sealed(s.notifications.email.pass)) s.notifications.email.pass = '';
  if (env.TFB_TELEGRAM_TOKEN) s.notifications.telegram.botToken = env.TFB_TELEGRAM_TOKEN;
  if (env.TFB_SMTP_PASS) s.notifications.email.pass = env.TFB_SMTP_PASS;
  s.notifications.desktop = false; // no desktop here
  return s;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return args.bad ? 2 : 0; }
  let settings;
  try {
    settings = loadSettingsFile(args.settings, env);
  } catch (err) {
    console.error(`Cannot read the settings file "${args.settings}": ${err.message}`);
    return 2;
  }
  const logger = createLogger({
    dir: path.join(args.data, 'logs'),
    retentionDays: settings.general.logRetentionDays,
    onEntry: (e) => console.log(`${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.message}`)
  });
  logger.prune();
  const runtime = createRuntime({
    getSettings: () => settings,
    log: (level, m) => logger.log(level, m),
    stateFile: args.state ? path.join(args.data, 'state.json') : null,
    builtinPlaceholder: () => fs.promises.readFile(path.join(here, '..', 'assets', 'placeholder.jpg'))
  });
  if (!settings.profiles.length) logger.log('warn', 'the settings contain no profile: nothing to do');
  runtime.loadState();

  if (args.once) {
    const st = await runtime.runAll({ force: false });
    await logger.flush();
    runtime.dispose();
    const results = Object.values(st.profiles).flatMap((p) => Object.values(p.feeds || {}));
    return results.length && results.every((r) => r.ok) ? 0 : 1;
  }

  // settings reloaded when the file changes (checked every 30 s, no watcher: it works on network shares too)
  let mtime = fs.statSync(args.settings).mtimeMs;
  const reload = setInterval(() => {
    try {
      const m = fs.statSync(args.settings).mtimeMs;
      if (m === mtime) return;
      mtime = m;
      settings = loadSettingsFile(args.settings, env);
      runtime.refresh();
      logger.log('info', 'settings reloaded');
    } catch (err) {
      logger.log('warn', `settings not reloaded: ${err.message}`);
    }
  }, 30_000);

  runtime.start();
  logger.log('info', `headless mode running (${settings.profiles.length} profiles). Ctrl+C to stop.`);
  return new Promise((resolve) => {
    const stop = async () => {
      clearInterval(reload);
      runtime.dispose();
      await logger.flush();
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
