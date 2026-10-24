# Ticker Feed Builder manual

Ticker Feed Builder downloads RSS feeds on a schedule and turns each one into numbered text lines and JPG images for TV tickers and playout graphics. It lives in the system tray and runs around the clock. It is a free desktop app for Windows, macOS and Linux from OnAir Garage.

## Install and first launch

Download the installer for your system from the [Releases](https://github.com/djgragra/ticker-feed-builder/releases) page and check it against `SHA256SUMS.txt`:
`Ticker-Feed-Builder-Setup-<V>.exe` (Windows), `Ticker-Feed-Builder-<V>-arm64.dmg` (Mac with Apple silicon), `Ticker-Feed-Builder-<V>-x64.dmg` (Mac with Intel), `Ticker-Feed-Builder-<V>.AppImage` (Linux).
The app is free and has no Apple or Microsoft certificate, so the first launch may show a warning.

- **Windows**: run the installer. If SmartScreen says "Windows protected your PC", click *More info* → *Run anyway*.
- **macOS**: open the disk image and drag the app to Applications. The app is signed ad hoc, which is what an Apple silicon Mac needs to open it. The first start still shows the "unidentified developer" notice: open *System Settings → Privacy & Security*, scroll down and click *Open Anyway* (right-click → Open no longer exists on macOS 15 and later). If a version older than 26.10.12 says the app is "damaged", run this once in Terminal: `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`
- **Linux**: make the AppImage executable (`chmod +x Ticker-Feed-Builder-*.AppImage`) and run it.

The app always opens in English; choose Italiano or Español and the choice is remembered. The theme is dark by default, with light and system available. The app ships **without any feed**: you add your own.

## What it writes

For every feed of every profile the app writes, in the profile's output folder:

| File | Content |
|---|---|
| `<Name>_Title.Txt` | one headline per line |
| `<Name>_Description.Txt` | one description per line, in the same order |
| `<Name>/00001.JPG`, `00002.JPG`… | one JPG per story, in the same order |
| `<Name>_metadata.json` | counters of the last run (optional) |

**Sync guarantee**: story N is line N of both text files and image N. Line breaks and invisible characters inside a text are removed; an empty title or description becomes `-` (configurable); a missing or unreadable image becomes the placeholder image. The default layout reproduces the scripts that fed a ticker from the Windows Task Scheduler; other ticker systems may need other names, encodings or sizes, which is why everything is configurable.

**Safe writes**: each file is written under a temporary name and then renamed; unchanged files are not touched; if a download fails the previous files stay as they were; a missing output folder is reported and never created (an unplugged drive must not become a local folder); numbered images left over from a longer previous run are removed. After writing, the files are read back: as many title and description lines as stories, every image a real JPEG. A failed check, or a file locked by a player, counts as a failed feed.

## Profiles and feeds

A **profile** has one destination: the output folder, its feeds, the check interval, the placeholder image and the output format. Use several profiles if different screens read different folders.

1. Press **+ New profile**, give it a name and press *Create*.
2. In the *Feeds* tab press **+ Add feed**: give the feed a *Name (folder)* and its address. A feed can have user name and password written in the address (`user:password@`), which are masked with an eye button to show them.
3. Press **Test** on the feed: the *Feed preview* shows the stories exactly as they would be written (*As on the ticker*), the title and description lines, and which images would fall back to the placeholder. Nothing is written. *Show the feed as it is* shows it without filters and limits.
4. Choose the output folder, the *Placeholder image* and, in *Schedule & options*, how often to check.
5. Switch the profile to **Active** ("Check this profile on schedule"). **Run now** checks it right away.

The profiles are listed in the left column; drag them, use the ▲▼ buttons or Alt + arrow keys, or press A–Z for alphabetical order. The order is saved and the dashboard follows it.

## Choosing and changing the stories

Per feed, in *Options*:

- **Filters**: keep only stories with certain words, or leave out others (case and accents are ignored; title only, or title and description); *Remove stories with the same title*; *Newest first* (by the date in the feed). Filters work before the item limit. A profile can leave out a story already used by an earlier feed.
- **Merged feeds** (*+ Add merged feed*) put the latest stories of several feeds in one folder, newest first and without duplicates.
- **Text changes**: replace pieces of text (`search → replace with`, one per line, plain text, capital letters count), ALL CAPITALS / lowercase / only the first letter capital, a text before and/or after the title (for example `ANSA – `), and your own title and description limits. They are applied just before the length limits, in this order: replacements, capital letters, text before and after, length limit (with "…" at the end of a word). The test dialog shows the result.
- **Output format** (the *Output format* tab; the defaults reproduce the original scripts): text encoding (UTF-8, UTF-8 with BOM, Windows-1252), line ending, file name templates (`{folder}`), image number start, digits and extension, JPEG quality, an optional resize (fill or fit) and the title and description length limits. WebP and AVIF images are converted to JPEG (this can be switched off per profile).

## Schedules and checks

A profile is checked in one of three ways, chosen in *Schedule & options*:

- **every N minutes** after the previous check;
- **every N minutes on the clock**, counted from midnight (15 = :00 :15 :30 :45; 60 = every full hour);
- **at fixed times** on the days you choose (one time = once a day). At a fixed time every enabled feed is checked whatever its own interval; a time missed while the app was closed is made up once at start-up (if *Start the schedules when the app opens* is on).

**Time windows** (*+ Add window*): a profile can be checked only in certain hours and days (for example 06:00–24:00), and a window can have its own interval. Outside the windows nothing is checked and the files stay as they are. Stagger the profiles so that they do not all start at the same minute.

**How a check works**: the app first asks the server whether the feed changed (`ETag` / `Last-Modified`; an answer of "not modified" means nothing is downloaded). If the server cannot say, the feed is downloaded and its content is compared with the previous copy: the same content means no image download and no file touched. Images are downloaded and files written only when something is new; a failed image is retried at the next check. What each feed looked like is remembered across restarts, so an unchanged feed is not rebuilt and no image is downloaded again.

## Dashboard

The **Dashboard** (its own button above the profile list) shows the date and time, whether the schedules are running or paused (*Pause schedules* / *Resume schedules* at the top), how many feeds are OK and how many have problems, a time-ordered list of the **upcoming checks** with a countdown, the last check and the last file update of each profile and feed, the recent warnings and errors, and for every feed a strip of the **last 24 hours**, one bar per hour (new stories, checked with nothing new, failed, no check), kept across restarts.

## Alerts and summary

In the settings, *Alerts* sends a desktop notification, Telegram and/or email (SMTP) when a feed fails N runs in a row, when an output folder disappears, and on recovery. Telegram and email take several recipients; **the email goes out as one message with everybody in Bcc** (the sender gets no copy unless it is also a recipient), and with a user name the connection must be encrypted. *Send test* checks each channel. Every alert starts with `[Ticker Feed Builder · name of the installation]`.

- **Frozen-feed alert**: an alert when a feed answers but has had no new stories for N hours (per profile or per feed), and again on recovery.
- **Daily summary** at chosen times, on Telegram and/or email.
- Passwords, tokens and feed credentials stay on the computer, encrypted with the system keystore when it is available, and leave it only in a backup you ask for with the box *Include passwords and tokens*.

## Settings

Settings are in tabs: General, Headless mode, Alerts, Updates, Backup and Help & About. The General tab has the start with the computer, the keep-awake option, *Start the schedules when the app opens*, the name of this installation, language and theme.

**Backup**: *Export* saves profiles, feeds, formats and settings as `ticker-feed-builder-backup-YYYY-MM-DD.json`. The box *Include passwords and tokens* is off by default; ticked, the SMTP password, the Telegram token and the feed credentials are written in plain text (a red warning says so) and the file is created readable only by you. *Import* replaces everything, or adds only the profiles this computer lacks, and keeps a password already on the computer when the mail server and user are the same; the app lists what must be typed again.

**Help & About** shows the version, the system, the licence, the credits and the links, *Copy info for support* (version, system, language, installation name, last update check and error: never addresses, passwords or file names) and *Open logs folder* (daily logs, 7 days, up to 5 MB each). The tip card has a jar and a button: both open the support page of the website in the language of the app; nothing is asked inside the app. The window size and place are remembered.

## Updates

The app looks for a new version at start and then every 24 hours (you can switch it off). A banner offers *Download and install*, *Remind me later* (24 hours) and *Skip this version*, with a progress bar and *Cancel*. The file is checked against `SHA256SUMS.txt`. *Close and install* is refused while a profile is running, saves a safety copy of the settings first (the last 3 are kept) and then starts the installer (Windows), opens the disk image (macOS) or shows the AppImage (Linux). After the update a *What's new* window appears once. Nothing installs without a click.

## Headless mode

For a server, or a machine that must update the ticker after a restart before anyone signs in, the same engine runs without a window (`src/cli.js`): the schedules, filters, alerts and daily summary work, desktop notifications do not. In *Settings → Headless mode* the app shows the exact command for this computer. It reads the settings file written by *Export settings*, which contains no secrets, so the Telegram token and the SMTP password are given as environment variables. With `--once` it makes one run and exits with 0 (all feeds fine), 1 (some problem) or 2 (settings unusable).

## Feeds and publishers' terms

A feed that is free to download is not necessarily free to broadcast. Publishers usually offer RSS for personal reading; showing their headlines publicly on TV, screens or websites normally needs an agreement with the publisher. That responsibility is yours: this is not legal advice. Read the current terms of the publisher before relying on a feed.

## Limits

- Images are decoded without native modules. A very large AVIF can take a few seconds; an image that cannot be read gets the placeholder.
- Images on private network addresses (localhost, 10.x, 172.16–31.x, 192.168.x…) are ignored for feeds on the public internet.
- *Skip certificate check* keeps the connection encrypted but does not verify the server: it is off by default and meant only for feeds you trust.
- The computer must stay on and awake. The app asks the system not to sleep (option), but cannot stop a forced sleep or shutdown.
- Whether a server supports conditional requests depends on the server; stories are taken in the order of the feed.

## Troubleshooting

| Problem | What to do |
|---|---|
| macOS: "the app is damaged / cannot be opened" | Open *System Settings → Privacy & Security → Open Anyway*; for a version older than 26.10.12, run in Terminal `xattr -cr "/Applications/Ticker Feed Builder.app" && codesign --force --deep -s - "/Applications/Ticker Feed Builder.app"`. |
| Windows: "Windows protected your PC" | *More info* → *Run anyway*. |
| Linux: the AppImage does not start | Make it executable (`chmod +x`) and install FUSE (`libfuse2`) if your system needs it. |
| "output folder missing" | The folder or drive is not there (an unplugged disk): reconnect it. The app never creates it. |
| A feed fails with a certificate error | The publisher's certificate is broken. If you trust the feed, switch on *Skip certificate check* for it. |
| The text files and the images do not match | They always match when written by the app; check that nothing else writes in the folder. |
| No alert arrives | Use *Send test* in the alert settings and read the error message. |
| The update download failed with "checksum mismatch" | The file was deleted automatically. Try again, or download the installer by hand from the releases page. |

## Contacts

Graziano Melzi · OnAir Garage — `https://onairgarage.com` — `hello@onairgarage.com`. Tool page: `https://onairgarage.com/tools/ticker-feed-builder/`. Source code and releases: `https://github.com/djgragra/ticker-feed-builder`. Licence: MIT © 2026 Graziano Melzi.
