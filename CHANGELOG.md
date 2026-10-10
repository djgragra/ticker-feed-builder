# Changelog

## 26.10.9 — 2026-10-10

- **New logo**: the RSS signal turning into a ticker band, in the OnAir Garage orange. Drawn as SVG (`assets/logo.svg`, `assets/tray.svg`); the app icon (Windows, macOS, Linux), the tray icon and a single-colour menu-bar icon for macOS are generated from it with `dev/make-icons.mjs` (no longer needs a Mac).
- **New look**: header with the logo and a status pill; profiles in the left column as cards that say in words (OK, Partial, Problem, Running, Off) and show the last file update; dashboard tiles with icons, a progress bar to the next check and, for every feed, a strip with its last 24 checks (new stories, no change, failed; since the app started); feed table with a coloured initial, status pills and icon buttons; the feed preview now also shows the headlines scrolling like on the ticker; a welcome screen with the logo when there is no profile; softer corners, light shadows, small transitions (off when the system asks for less motion), better contrast in the light theme. No change in what the app does with feeds and files.
- **Alerts like the other OnAir Garage apps**: Telegram and email can now also tell you, once for each new release published on GitHub (Settings, Updates; checked every 6 hours, also with the window closed; on by default, only when a channel is on, easy to switch off). The notification rules are now written in the shared app standard. The code comment of `src/notify.js` no longer says that email is not offered.
- Tests: 35 (new ones for the version alert, the checks history, the same keys in English/Italian/Spanish and the icon files).

## 26.10.8 — 2026-10-08

- Release build: the test for the stale-feed alert and the daily summary waited a fixed 120 ms after every run and failed on a slow build machine (it blocked the 26.10.7 release). It now waits for the run to really finish. No change to the app: the 26.10.7 interface changes (email and Telegram settings) are in this release.

## 26.10.7 — 2026-10-08

- Email and Telegram settings laid out like in the other OnAir Garage apps: SMTP fields in a grid (server, port, user, password, from, several recipients separated by commas), Telegram recipients as rows (chat ID + note, add / remove), and a "Send test" button with its result next to it for each channel.

## 26.10.6 — 2026-10-08

- Starter feed set removed; the app starts empty. A new profile has no feed and asks you to add the first one (only feeds you are entitled to use: see "Feeds and publishers' terms" in the help and the README).
- "Skip certificate check" is off by default for every feed.

## 26.10.5 — 2026-10-08

- **Filters and order** per feed: required / excluded words (case and accents ignored, title only or title + description), same-title duplicates, newest first. Filters work before the item limit. A profile can also leave out a story already used by an earlier feed.
- **Merged feeds**: the latest stories of several feeds in one folder, newest first, no duplicates.
- **Preview** shows the stories exactly as they would be written (file names, title and description lines, image), optionally the raw feed.
- **Time windows** per profile (days and hours, optional own interval per window).
- **Frozen-feed alert** (no new stories for N hours, per profile or feed) and **daily summary** on Telegram / email.
- **File check** after writing (line counts, real JPEG images) and clear messages for files locked by a player.
- **Memory between restarts**: no rebuild and no image download after a restart for an unchanged feed.
- **WebP and AVIF** images are now converted (WebAssembly decoders), switchable per profile.
- **Headless mode** (`src/cli.js`, also runnable by the installed app without Node.js) for servers or machines that must work before anyone logs in.
- All of these can be switched off or left empty; new options are in the new "Schedule & options" tab, the feed Options dialog and Settings.

## 26.10.4 — 2026-10-08

- Email alerts (SMTP): server, port, TLS/STARTTLS, user, password, sender and **several recipients** (one message, all in Bcc). Telegram already took several chat IDs. Test button for each channel. With a user name the connection must be encrypted; the password is stored encrypted with the system keystore when available and never exported.
- The Dashboard is now a separate button above the profile list, not an item of it.
- Profile order: drag, ▲▼ buttons or Alt + arrows; "A–Z" button for alphabetical order. The order is saved and the dashboard follows it.
- Dashboard: current date and time, a time-ordered list of the next checks (what and when, with countdown), and date + time in the last-check and last-update columns.
- Light and dark theme (dark by default), or follow the system; selector in the top bar, choice saved.

## 26.10.3 — 2026-10-08

- Publishers' terms: a visible note under the feed list and in the new-profile dialog, and a new help section "Feeds and publishers' terms" with what the ANSA and Adnkronos RSS pages say (read on 2026-10-08): free to download does not mean free to broadcast; public display needs an agreement with the publisher.

## 26.10.2 — 2026-10-08

- Change detection: a check now asks the server whether the feed changed (ETag / Last-Modified) and compares the content with the previous run; images are downloaded and files written only when something is new. A failed image is retried at the next check; a deleted output file or edited setting triggers a rebuild. "Run now" always rebuilds everything. The `_metadata.json` file is rewritten only when something changed.
- Scheduling: the check interval is now labelled and explained in the profile; each feed can have its own interval.
- Dashboard: overview of all profiles and feeds (state, last check, last update, next check, recent problems). It is the start page.
- The test preview and the profile page show the real placeholder image (also for items whose image could not be downloaded).

## 26.10.1 — 2026-10-08

First release. Replaces the three `rss_ticker_downloader.py` scripts (v3.2) with one desktop app.

- Profiles: each with its own output folder, feed list, refresh interval, placeholder image and output format (several copies of the old script, one per destination, become several profiles).
- Same default output as the original scripts for NeMedia Morpheus: `<Folder>_Title.Txt`, `<Folder>_Description.Txt`, `<Folder>/00001.JPG…`, `<Folder>_metadata.json`.
- Built-in scheduler and tray icon (no Windows Task Scheduler), start with the computer, keep-awake option.
- Output format is configurable: text encoding, line ending, file name templates, image numbering and extension, JPEG quality, optional resize (cover / contain), title and description length limits.
- Fixes compared with the scripts: line breaks and invisible characters inside titles can no longer shift the lines; a failed image save can no longer shift the images; files are written atomically and only when they changed; orphan images from a longer previous run are removed; the certificate check is on by default and can be switched off per feed; images on private network addresses are ignored for public feeds.
- Alerts (desktop notification and Telegram) when a feed fails several runs in a row, when an output folder disappears, and on recovery.
- Feed test with preview, live log, settings export/import (without the Telegram token), update check against GitHub releases.
- Languages: English (default), Italiano, Español. Dark theme.
