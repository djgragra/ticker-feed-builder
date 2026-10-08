// Alerts when a feed (or a whole output folder) keeps failing, and when it recovers.
// Channels: desktop notification and Telegram (Bot API). Nothing is hard-coded: the token and the chat IDs
// come from the user's settings. Email is not offered: it would need an SMTP server and a password.
import { msg } from './messages.js';

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

// check(key, ok, ...) is called after every run for every feed (key "feed:<id>") and every output folder
// (key "dir:<profileId>"). It alerts once when failures reach the threshold and once on recovery.
export function createAlerter({ getSettings, notifyDesktop = () => {}, log = () => {}, deps = {}, delays = [0, 10_000, 60_000], setTimer = setTimeout }) {
  const tg = deps.sendTelegram || sendTelegram;
  const state = new Map(); // key -> { fails, alerted }

  function send(text) {
    const s = getSettings();
    if (s.notifications.desktop) notifyDesktop(text);
    if (!s.notifications.telegram.enabled) return;
    // Telegram with retries (the network that broke the feed may be down for a while)
    const attempt = (n) =>
      tg(getSettings().notifications.telegram, text, getSettings().language).then(
        () => log('info', 'alert sent to Telegram'),
        (err) => {
          log('warn', `Telegram attempt ${n + 1} failed: ${err.message}`);
          if (n + 1 < delays.length) setTimer(() => attempt(n + 1), delays[n + 1]);
        }
      );
    attempt(0);
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
