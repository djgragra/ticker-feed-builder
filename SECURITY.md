# Security policy

## Supported versions

Only the latest release of ticker-feed-builder is supported. The app checks for new versions and offers them in its own update banner.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Write to **hello@onairgarage.com** with the version, your system, and the steps to reproduce it. You will get an answer, and a fix goes into the next release.

Never send passwords, tokens or keys: they are not needed to describe a problem.

## What the app does and does not do

The list of the addresses the app contacts is in the README. The installers are not signed (the README explains the first-launch warnings); each release publishes `SHA256SUMS.txt` and the app checks it before offering to install an update.
