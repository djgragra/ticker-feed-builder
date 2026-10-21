# Changelog

## 26.10.12 — 2026-10-21

- **Fix: macOS on Apple Silicon said the app was "damaged".** The Apple Silicon build had a signature that was no longer valid (macOS: "code has no resources but signature indicates they must be present"), and recent macOS versions refuse such an app instead of offering to open it. The app is now signed ad hoc during the build (no Apple account is needed) and the build checks the signature of the app inside each disk image. The first start still shows the usual "unidentified developer" notice: *System Settings → Privacy & Security → Open Anyway*. If you already downloaded an earlier version and it will not open, run once in Terminal: `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`. Thanks to Rob, who reported it.
- **Text changes, per feed** (feed Options): replace pieces of text (one rule per line, `search → replace with`, plain text, capital letters count, an empty replacement deletes), make the text ALL CAPITALS, all lowercase or only the first letter capital, add a text before and/or after the title (for example `ANSA – `), and give the feed its own title and description limits (0 = the profile's). They are applied just before the length limits, in this order: replacements, capital letters, text before / after the title, length limit (cut at the end of a word, with "…"). The test dialog shows the result; "Show the feed as it is" shows the stories before the changes. Everything is off until you fill it in; filters and duplicates still look at the original text. No patterns (regular expressions) on purpose.
- **The tip jar picture is a button too**, like the pill under it (Settings → Help & About): same link, in the language of the app.
- Tests: 82 (new: text changes, settings, files and preview, the ad-hoc signature hook, the tip jar picture), and the end-to-end run on the real app now covers the text changes.

## 26.10.11 — 2026-10-17

- **Alert emails no longer go to the sender too**: the message used to be addressed to the sender (the "From" address, or the SMTP user when "From" is empty) with the recipients in Bcc, so that mailbox received a copy of every alert even when it was not in the recipients list. The visible "To" is now empty (undisclosed recipients) and the SMTP envelope holds the recipients only. If the sender is also a recipient it gets the message once.
- **Guided update, shared module version 2**: an installer download that is cancelled, cut off, stalled or whose last step fails no longer leaves a `.part` file in the Downloads folder (the file is closed before it is deleted, which Windows requires); `.part` files left by an earlier run are removed when the app starts and before a new download.
- **Tip jar box** in Settings → Help & About: a small box with the jar and one line, with a link that opens the tip page of onairgarage.com in your language. No pop-ups, no reminders, nothing in the main window.
- Dependencies: Electron 44.9.0 and Nodemailer 10.1.2 (minor and patch updates).
- Tests: 71 (new ones for the email envelope, the download cleanup and the tip jar box).

## 26.10.10 — 2026-10-13

- **Guided update, the same in every OnAir Garage app**: when a new version is out, a banner offers **Download and install**, **Remind me later** (24 hours) and **Skip this version**; a progress bar with a Cancel button; the installer is checked against the published SHA-256 sums. **Close and install** is refused while a profile is running (with a *Try again*), saves a **safety copy** of the settings first (the last 3 are kept) and, on Windows, closes the app, starts the installer and opens the app again at the end; on macOS it opens the disk image, on Linux it shows the AppImage. After the update a **What's new** window shows once and a notice says "Updated to X". Settings → Updates shows the same states, the last check and **Check now**. Nothing is installed without a click.
- **Backup like the other apps**: the box **Include passwords and tokens** (off by default, with a red warning when ticked) decides whether the SMTP password, the Telegram token and feed credentials (`user:password@` in an address) are written, in plain text, in the file. **Import** can replace everything or add only the profiles this computer does not have, and lists what must be typed again; a password already on this computer is kept when the file points to the same mail server and user. File name `ticker-feed-builder-backup-YYYY-MM-DD.json`; older settings files still import. Feed addresses with credentials are now also encrypted at rest with the system keystore.
- **Not older than** (feed options): stories older than a limit in hours or days are left out, and a story without a date is kept or left out as you choose. The feed is downloaded at every check while this is on, so a story that grows too old leaves the files even if the feed does not change.
- **Signature of the OnAir Garage apps**: show / hide buttons on the SMTP password, the Telegram token and feed addresses with credentials; the **name of the installation** (Settings, General; default the computer name) at the start of every alert, as `[Ticker Feed Builder · name]`; a **Help & About** tab with credits, links, **Copy info for support** (no addresses, passwords or file names) and **Open logs folder**; Settings in tabs in the standard order (General, Headless mode, Alerts, Updates, Backup, Help & About); daily logs of at most 5 MB each, 7 days kept by default; the window size and place are remembered.
- `CLAUDE.md` is now part of the repository and points to the standard the app is built under.
- Tests: 61 (new ones for the secrets list, the backup, the guided update with a fake GitHub, the safety copy, the changelog in the package, the installation name, the log rotation and the maximum age, also on an unchanged feed).

## 26.10.9 — 2026-10-10

- **New logo**: the RSS signal turning into a ticker band, in the OnAir Garage orange. Drawn as SVG (`assets/logo.svg`, `assets/tray.svg`); the app icon (Windows, macOS, Linux), the tray icon and a single-colour menu-bar icon for macOS are generated from it with `dev/make-icons.mjs` (no longer needs a Mac).
- **New look**: header with the logo and a status pill; profiles in the left column as cards that say in words (OK, Partial, Problem, Running, Off) and show the last file update; dashboard tiles with icons, a progress bar to the next check and, for every feed, a strip with the last 24 hours, one bar per hour (new stories, checked with nothing new, failed, no check), saved with the rest of the state so it survives a restart; feed table with a coloured initial, status pills and icon buttons; the feed preview now also shows the headlines scrolling like on the ticker; a welcome screen with the logo when there is no profile; softer corners, light shadows, small transitions (off when the system asks for less motion), better contrast in the light theme. No change in what the app does with feeds and files.
- **Alerts like the other OnAir Garage apps**: Telegram and email can now also tell you, once for each new release published on GitHub (Settings, Updates; checked every 6 hours, also with the window closed; on by default, only when a channel is on, easy to switch off). The notification rules are now written in the shared app standard. The code comment of `src/notify.js` no longer says that email is not offered.
- **Schedule of a profile in three ways**: every N minutes (as before), every N minutes **on the clock** (15 = :00 :15 :30 :45; counted from midnight), or at **fixed times** on the days you choose (one time = once a day, several allowed). At a fixed time every enabled feed is checked; a time missed while the app was closed is made up once at start-up (when the schedules start at launch). Time windows still apply. Old settings keep working unchanged ("every N minutes").
- **Stagger the profiles** (Settings, off by default): profiles with the same interval are spread evenly inside it instead of all starting together after a restart (two profiles every 5 minutes: 2 min 30 s apart), in the order of the profile list; with checks on the clock the shift applies at every check.
- Screenshots in the README and on the site renewed.
- Tests: 43 (new ones for the version alert, the hourly history and its restart, the three schedules, the missed-time make-up, the stagger, the same keys in English/Italian/Spanish and the icon files).

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
