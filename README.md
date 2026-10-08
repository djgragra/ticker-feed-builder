# Ticker Feed Builder

Downloads RSS feeds on a schedule and turns each one into numbered text lines and JPG images for TV tickers and playout graphics. Free desktop app (Electron) from [OnAir Garage](https://onairgarage.com).

- Tool page: https://onairgarage.com/tools/ticker-feed-builder/
- Author: Graziano Melzi · OnAir Garage — hello@onairgarage.com
- License: MIT (see `LICENSE`)
- Systems: Windows (installer), macOS (dmg, Apple silicon and Intel), Linux (AppImage, x64). Built for all three; **only macOS has been run so far** (see Validation).

## What it does

It replaces the `rss_ticker_downloader.py` scripts that fed NeMedia Morpheus from Windows Task Scheduler. The app lives in the tray, runs 24/7 and, for every feed of every profile, writes:

| File | Content |
|---|---|
| `<Name>_Title.Txt` | one headline per line |
| `<Name>_Description.Txt` | one description per line, same order |
| `<Name>/00001.JPG, 00002.JPG…` | one JPG per story, same order |
| `<Name>_metadata.json` | counters of the last run (optional) |

- **Profiles**: one destination each (output folder, feeds, interval, placeholder image, format). Use several if different screens read different folders.
- **Sync guarantee**: story N is line N of both text files and image N. Line breaks and invisible characters inside a text are removed; an empty title/description becomes `-` (configurable); a missing or unreadable image becomes the placeholder image.
- **Safe writes**: each file is written under a temporary name and renamed; unchanged files are not touched; if a download fails the previous files stay as they were; a missing output folder is reported and never created (an unplugged drive must not become a local folder); numbered images left over from a longer previous run are removed.
- **Configurable format** (the defaults reproduce the original scripts): text encoding (UTF-8, UTF-8 with BOM, Windows-1252), line ending, file name templates (`{folder}`), image number start/digits/extension, JPEG quality, optional resize (fill or fit), title/description length limits.
- **Checks**: each profile has a check interval (default 5 min) and each feed can have its own. A check first asks the server whether the feed changed (`ETag` / `Last-Modified`; answer 304 = nothing is downloaded). If the server cannot say, the feed is downloaded and its content compared with the previous copy (same content = no image download, no file touched). Images are downloaded and files written only when something is new; a failed image is retried at the next check, and a deleted output file or an edited setting triggers a rebuild. "Run now" always rebuilds everything.
- **Dashboard**: all profiles at a glance (schedule state, feeds OK / with problems, next check, last file update, per feed last check and last update, recent warnings and errors).
- **Alerts**: desktop notification and/or Telegram when a feed fails N runs in a row, when an output folder disappears, and on recovery. No email: it would need an SMTP server and a stored password.
- Feed test with preview (nothing is written), live log with daily log files, settings export/import (the Telegram token is never exported), update check against the public GitHub releases with a download verified against `SHA256SUMS.txt`, start with the computer, keep-awake option.
- Languages: English (default, the app always opens in English), Italiano, Español; the choice is remembered. Dark theme only (On-Air tool).

The default layout is the one the original scripts produced for NeMedia Morpheus. **It has not been checked against NeMedia documentation** (none was read); other ticker systems may need other names, encodings or sizes, which is why everything is configurable.

## Formulas and sources

No measurements or standards-based formulas. The external rules used:

| Value / rule | Source | Status |
|---|---|---|
| RSS 2.0 item fields (`title`, `description`, `enclosure`), Atom `entry`, Media RSS `media:content` / `media:thumbnail` | feed formats as found in the feeds themselves (Adnkronos, ANSA); no specification was read for this release | **recommended** (practice, not verified against the specifications) |
| Characters not allowed in a file name, reserved names (`CON`, `PRN`, `NUL`, `COM1`…) | Microsoft Learn, *Naming Files, Paths, and Namespaces* — same rules as in File Renamer | **official** (read in the File Renamer project, not re-read for this release) |
| Default output layout and file names | original scripts v3.2 supplied by the author | reference implementation |
| Telegram `sendMessage` | Telegram Bot API | **not re-read for this release** |

## Assumptions and limits

- Images are decoded with a pure-JavaScript library (jimp): JPEG, PNG, GIF, BMP and TIFF work; WebP and AVIF do not (the story gets the placeholder). A native library would cover more formats but complicates building for three systems.
- Images on private network addresses (localhost, 10.x, 172.16–31.x, 192.168.x…) are ignored for feeds on the public internet; DNS names that resolve to private addresses are not detected.
- "Skip certificate check" keeps the connection encrypted but does not verify the server; it is off by default and is switched on in the starter set only for the Adnkronos feeds, as the original scripts did.
- The computer must stay on and awake. The app asks the system not to sleep (option), but cannot stop a forced sleep or shutdown.
- Whether a server supports conditional requests depends on the server; without it every check downloads the feed XML (small) but still skips images and writes when the content is identical. Stories are taken in the order of the feed; there is no de-duplication across feeds.

## Validation and references

Results as of October 2026.

| Reference | What it validates | Result | How to re-run |
|---|---|---|---|
| Automated tests (16) | text cleaning, RSS/Atom parsing, line/image sync, empty values, orphan removal, unchanged files, change detection (304, same content, failed-image retry, deleted output, per-feed interval), failure keeps old files, missing folder not created, private image addresses, scheduler, alerts | pass | `npm test` |
| Original Python script v3.2 on 8 live feeds (2026-10-08, macOS) | same titles and descriptions as the original for the same feeds | 14 of 16 text files byte-identical; the other 2 differ only because the feeds changed between the two runs (stories shifted by one); one title carried an invisible BOM character in the original, which the app removes | run both on the same feeds and compare (`cmp`) |
| Same run | number of images per feed | equal for all 8 feeds | same |
| End-to-end on the real Electron app (macOS) | create profile, run, files on disk, status in the UI, language switch, no console errors | pass | `node dev/e2e-electron.mjs [screenshotDir]` |

**Not validated**: playback in NeMedia Morpheus or any other ticker system; Windows (paths, drives, file locking by a player, installer); Linux; runs lasting days; Telegram delivery against the real service (unit-tested with a fake only); Windows-1252 output beyond a unit test. This is not a certified tool.

## Sources to re-check

| Document | Version read |
|---|---|
| RSS 2.0 specification, Atom (RFC 4287), Media RSS | not read for this release |
| Telegram Bot API | not read for this release |
| NeMedia Morpheus manual (expected file layout) | not read |

## Run locally

```bash
npm install
npm start          # the app
npm test           # unit tests (Node 20+)
node dev/e2e-electron.mjs   # end-to-end on the real app
npm run dist:mac   # or dist:win / dist:linux
```

## Structure

- `main.js`, `preload.cjs` — Electron main process and bridge.
- `src/` — the engine, independent of Electron: `engine.js` (download → convert → write), `feed.js`, `text.js`, `image.js`, `output.js`, `format.js`, `http.js`, `scheduler.js`, `notify.js`, `settings.js`, `logger.js`, `updater.js`.
- `renderer/` — the interface (strict CSP, no inline scripts or styles, no CDN, system fonts).
- `dev/` — tests, end-to-end script, icon and placeholder generators.

Versions are `YY.M.N` (e.g. `26.10.1`), tags `vYY.M.N`.

## Credits

[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) (MIT), [jimp](https://github.com/jimp-dev/jimp) (MIT), [iconv-lite](https://github.com/ashtuchkin/iconv-lite) (MIT), [Electron](https://www.electronjs.org/) (MIT). No fonts are bundled.
