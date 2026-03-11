# Lebanon News Engine

Automated Node.js engine that:

- Manages RSS feeds from a web dashboard
- Scans feeds every minute
- Filters Lebanon-war related news
- Translates non-Arabic content to Arabic
- Sends formatted alerts to a WhatsApp group
- Prevents duplicate posts

## Tech Stack

- Node.js
- Express.js
- Baileys
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
GROUP_NAME=Your WhatsApp Group
WHATSAPP_NUMBER=961XXXXXXXX
WHATSAPP_AUTH_MODE=auto
WHATSAPP_WEB_VERSION=
WHATSAPP_SESSION_B64=
GROQ_API_KEY=your_groq_api_key
WHATSAPP_SESSION_DIR=/app/data/whatsapp-session
```

`WHATSAPP_NUMBER` must be the WhatsApp account number in international format without `+` or spaces.
`WHATSAPP_AUTH_MODE` supports `auto`, `pairing`, or `qr`. `auto` tries a pairing code first, then falls back to QR if WhatsApp rejects pair-code login.
`WHATSAPP_WEB_VERSION` is optional and should be in the form `2.3000.1234567890` if you need to pin a specific WhatsApp Web revision.
`WHATSAPP_SESSION_B64` is optional and lets you import a locally paired WhatsApp session into Railway.

## Run Locally

```bash
npm install
node src/server.js
```

Then open `http://localhost:3000`.

## WhatsApp Setup

1. Start the server.
2. Open the dashboard.
3. If pair-code login is accepted, the pairing code appears in the dashboard and terminal logs.
4. If WhatsApp rejects pair-code login, the dashboard switches to a QR fallback automatically.
5. In WhatsApp, open `Linked Devices`.
6. Choose `Link with phone number` for a pairing code, or `Link a device` for QR fallback.
7. Keep the account in a group named exactly as `GROUP_NAME`.

Session data is stored under `WHATSAPP_SESSION_DIR`, so future restarts do not need a new pairing code unless the session expires.

## Railway Deployment

- Mount the Railway volume at `/app/data`.
- Set `WHATSAPP_NUMBER` in Railway to the WhatsApp account number, for example `961XXXXXXXX`.
- Leave `WHATSAPP_AUTH_MODE=auto` unless you want to force QR login.
- Leave `WHATSAPP_WEB_VERSION` empty by default. Set it only if you need to pin a working WhatsApp Web revision.
- If first-time login is unstable on Railway, pair locally once and paste the exported session into `WHATSAPP_SESSION_B64`.
- The WhatsApp session files are persisted at `/app/data/whatsapp-session`.
- On first login, the dashboard shows the current WhatsApp auth state and exposes either a pairing code or a QR fallback.

## Local Pairing For Railway

1. On your own machine, run the app locally.
2. Set `WHATSAPP_AUTH_MODE=qr` locally.
3. Complete the WhatsApp login locally.
4. Run:

```bash
npm run export:whatsapp-session
```

5. Copy the printed value into Railway as `WHATSAPP_SESSION_B64`.
6. Redeploy Railway.

After that, Railway should reuse the imported session instead of doing first-time pairing on the server.

## Dashboard Features

- Add RSS feed URL
- View active feeds
- Delete feeds
- Basic validation for empty, invalid, and duplicate URLs

## Engine Flow

1. Read feeds from `data/feeds.json`.
2. Parse feed items via `rss-parser`.
3. Filter by Lebanon keywords.
4. Skip if the link already exists in `data/posted.json`.
5. Translate non-Arabic title and summary to Arabic.
6. Send the formatted result to the configured WhatsApp group.

## Replit Instructions

1. Create a new Replit Node.js project.
2. Upload this project or clone the repo into Replit.
3. Add these secrets:
   - `PORT=3000`
   - `GROUP_NAME=Your WhatsApp Group`
   - `WHATSAPP_NUMBER=961XXXXXXXX`
   - `GROQ_API_KEY=your_groq_api_key`
4. Run:

```bash
npm install
node src/server.js
```

5. Open the Replit web preview to use the dashboard.

Notes for Replit:

- Keep the repl running so cron jobs continue.
- The first login requires entering the pairing code shown in the terminal.
