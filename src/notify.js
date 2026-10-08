// Alerts when a feed (or a whole output folder) keeps failing, and when it recovers.
// Channels: desktop notification and Telegram (Bot API). Nothing is hard-coded: the token and the chat IDs
// come from the user's settings. Email is not offered: it would need an SMTP server and a password.
import { msg } from './messages.js';
import { EMAIL_RE } from './settings.js';

const PREFIX = '[Ticker Feed Builder]';
const clip = (s) => (s.length > 4000 ? s.slice(0, 3997) + '…' : s);

export async function sendTelegram(cfg, text, lang = 'en', fetchFn = globalThis.fetch) {
  if (!cfg?.enabled) return;
  const recipients = (cfg.recipients || []).filter((r) => String(r?.chatId || '').trim());
  if (!cfg.botToken || !recipients.length) throw new Error(msg(lang, 'tgIncomplete'));
  const body = clip(text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`); // the bot may be shared: say who writes
  const failures = [];
  for (const r of recipients) {
    try {
      const res = await fetchFn(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(r.chatId).trim(), text: body }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    } catch (err) {
      // one bad recipient must not stop the others; the token must never reach a log line
      failures.push(`${r.note ? r.note + ' ' : ''}(${r.chatId}): ${String(err.message).split(cfg.botToken).join('***')}`);
    }
  }
  if (failures.length) throw new Error(msg(lang, 'tgFailed') + failures.join(' | '));
}

export async function sendEmail(cfg, subject, text, lang = 'en', transportFactory = null) {
  if (!cfg?.enabled) return;
  const to = (cfg.recipients || []).filter((a) => EMAIL_RE.test(String(a)));
  if (!cfg.host || !to.length || !(cfg.from || cfg.user)) throw new Error(msg(lang, 'emailIncomplete'));
  // loaded on first use: keeps start-up light and lets tests run with a fake transport
  const create = transportFactory || (await import('nodemailer')).default.createTransport;
  const transporter = create({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure, // true = TLS from the start (usually port 465); false = STARTTLS
    requireTLS: !cfg.secure && !!cfg.user, // never send the password in clear text
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000
  });
  try {
    // one message, all recipients in Bcc: they do not see each other's addresses
    const info = await transporter.sendMail({ from: cfg.from || cfg.user, to: cfg.from || cfg.user, bcc: to, subject, text });
    const rejected = info?.rejected || [];
    if (rejected.length) throw new Error(`${rejected.join(', ')}: rejected by the server`);
  } catch (err) {
    // never show the password; very short ones are not masked or the text would be unreadable
    const text = cfg.pass && cfg.pass.length >= 4 ? String(err.message).split(cfg.pass).join('***') : String(err.message);
    throw new Error(msg(lang, 'emailFailed') + text);
  } finally {
    transporter.close?.();
  }
}

// check(key, ok, ...) is called after every run for every feed (key "feed:<id>") and every output folder
// (key "dir:<profileId>"). It alerts once when failures reach the threshold and once on recovery.
export function createAlerter({ getSettings, notifyDesktop = () => {}, log = () => {}, deps = {}, delays = [0, 10_000, 60_000], setTimer = setTimeout }) {
  const tg = deps.sendTelegram || sendTelegram;
  const mail = deps.sendEmail || sendEmail;
  const state = new Map(); // key -> { fails, alerted }

  // Telegram and email with retries (the network that broke the feed may be down for a while)
  function withRetry(name, fn) {
    const attempt = (n) =>
      fn().then(
        () => log('info', `alert sent by ${name}`),
        (err) => {
          log('warn', `${name} attempt ${n + 1} failed: ${err.message}`);
          if (n + 1 < delays.length) setTimer(() => attempt(n + 1), delays[n + 1]);
        }
      );
    attempt(0);
  }

  function send(text) {
    const s = getSettings();
    if (s.notifications.desktop) notifyDesktop(text);
    const subject = `${PREFIX} ${text.split(/[.:]/)[0].slice(0, 90)}`;
    if (s.notifications.telegram?.enabled) withRetry('Telegram', () => tg(getSettings().notifications.telegram, text, getSettings().language));
    if (s.notifications.email?.enabled) withRetry('email', () => mail(getSettings().notifications.email, subject, text, getSettings().language));
  }

  function check(key, ok, { downText, upText }) {
    const s = state.get(key) || { fails: 0, alerted: false };
    if (ok) {
      if (s.alerted) send(upText());
      state.set(key, { fails: 0, alerted: false });
      return;
    }
    s.fails++;
    const threshold = key.startsWith('dir:') ? 1 : getSettings().notifications.failThreshold; // a missing folder is never transient noise
    if (!s.alerted && s.fails >= threshold) {
      s.alerted = true;
      send(downText(s.fails));
    }
    state.set(key, s);
  }

  return {
    check,
    forget(prefix) { for (const k of state.keys()) if (k.startsWith(prefix)) state.delete(k); },
    reset: () => state.clear()
  };
}
