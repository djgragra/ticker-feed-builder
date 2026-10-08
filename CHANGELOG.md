# Changelog

## 26.10.1 — 2026-10-08

First release. Replaces the three `rss_ticker_downloader.py` scripts (v3.2) with one desktop app.

- Profiles: each with its own output folder, feed list, refresh interval, placeholder image and output format (the three old script copies GR / GRNEWS / root become three profiles).
- Same default output as the original scripts for NeMedia Morpheus: `<Folder>_Title.Txt`, `<Folder>_Description.Txt`, `<Folder>/00001.JPG…`, `<Folder>_metadata.json`.
- Built-in scheduler and tray icon (no Windows Task Scheduler), start with the computer, keep-awake option.
- Output format is configurable: text encoding, line ending, file name templates, image numbering and extension, JPEG quality, optional resize (cover / contain), title and description length limits.
- Fixes compared with the scripts: line breaks and invisible characters inside titles can no longer shift the lines; a failed image save can no longer shift the images; files are written atomically and only when they changed; orphan images from a longer previous run are removed; the certificate check is on by default and can be switched off per feed; images on private network addresses are ignored for public feeds.
- Alerts (desktop notification and Telegram) when a feed fails several runs in a row, when an output folder disappears, and on recovery.
- Feed test with preview, live log, settings export/import (without the Telegram token), update check against GitHub releases.
- Languages: English (default), Italiano, Español. Dark theme.
