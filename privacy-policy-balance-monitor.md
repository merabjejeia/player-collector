# Privacy Policy — Balance Monitor

**Last updated: July 2026**

## Overview

Balance Monitor does not collect, share, or sell any personal data. All processing happens locally in your browser.

## Data stored locally

The following data is stored on your device using Chrome's built-in storage API and never leaves your browser:

- Telegram bot token and chat ID (provided by you)
- Balance thresholds and watchlist configuration
- Check interval and stagnation monitoring settings
- Last check timestamp and alert history (to prevent duplicate notifications)

## Data accessed

The extension reads the "External Accounts" balance table from **lixog.com** using your existing browser session. This data is processed in memory and used only to compare against your configured thresholds. It is not transmitted to any server other than the Telegram Bot API when an alert is triggered.

## Third-party services

The only third-party service contacted is the **Telegram Bot API** (api.telegram.org), and only when you have configured a bot token and a balance threshold is breached. Messages are sent directly from your browser to Telegram — the extension developer has no access to your bot token, chat ID, or message content.

## No tracking

The extension contains no analytics, no tracking pixels, no crash reporting, and no telemetry of any kind.

## Contact

jejeiamerab@gmail.com
