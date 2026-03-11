# Lebanon News Engine

Automated Node.js engine that:

- Manages RSS feeds from a web dashboard
- Scans feeds every 10 minutes
- Filters Lebanon-war related news
- Translates non-Arabic content to Arabic
- Sends formatted alerts to a WhatsApp group
- Prevents duplicate posts

## Tech Stack

- Node.js
- Express.js
- whatsapp-web.js
- rss-parser
- node-cron
- dotenv
- Simple HTML/CSS dashboard

## Project Structure

```text
/src
  server.js
  whatsapp.js
  rssEngine.js
  translator.js
  storage.js
  filter.js

/public
  index.html
  style.css

/data
  feeds.json
  posted.json

.env
package.json
README.md
```

## Environment Variables

Create or edit `.env`:

```env
PORT=3000
GROUP_NAME=نور الولاية
LIBRETRANSLATE_URL=https://libretranslate.de/translate
# PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

## Run Locally

```bash
npm install
node src/server.js
```

Then open:

`http://localhost:3000`

## WhatsApp Setup

1. Start the server.
2. A QR code will print in the terminal.
3. Scan it from WhatsApp (`Linked Devices`).
4. Keep the account in a group named exactly as `GROUP_NAME`.

Session is persisted with `LocalAuth`, so future restarts do not need QR unless session expires.

## Dashboard Features

- Add RSS feed URL
- View active feeds
- Delete feeds
- Basic validation (empty/invalid/duplicate URLs blocked)

## Engine Flow

1. Read feeds from `data/feeds.json`
2. Parse feed items via `rss-parser`
3. Filter by Lebanon keywords
4. Skip if link exists in `data/posted.json`
5. Translate non-Arabic title/summary to Arabic
6. Send to WhatsApp group in this format:

```text
🚨 عاجل - لبنان
━━━━━━━━━━━━

{العنوان}

{الملخص}

🔗 المصدر: {site}
```

## Replit Instructions

1. Create a new Replit Node.js project.
2. Upload this project or clone your repo into Replit.
3. Add `.env` values in Replit Secrets:
   - `PORT=3000`
   - `GROUP_NAME=نور الولاية`
   - `LIBRETRANSLATE_URL=https://libretranslate.de/translate`
4. Run:

```bash
npm install
node src/server.js
```

5. Open the Replit web preview to use the dashboard.

Notes for Replit:

- Keep the repl running so cron jobs continue.
- WhatsApp Web login requires scanning QR from terminal output.
- If Chromium startup fails in your Replit environment, use a Replit template that supports headless browser automation.
- If you see "Could not find Chrome", install it with:

```bash
npx puppeteer browsers install chrome
```
