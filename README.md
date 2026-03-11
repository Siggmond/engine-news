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
GROQ_API_KEY=your_groq_api_key
WHATSAPP_SESSION_DIR=/app/data/whatsapp-session
```

`WHATSAPP_NUMBER` must be the WhatsApp account number in international format without `+` or spaces.

## Run Locally

```bash
npm install
node src/server.js
```

Then open `http://localhost:3000`.

## WhatsApp Setup

1. Start the server.
2. A pairing code will print in the terminal logs.
3. In WhatsApp, open `Linked Devices`.
4. Choose `Link with phone number`.
5. Enter the printed pairing code.
6. Keep the account in a group named exactly as `GROUP_NAME`.

Session data is stored under `WHATSAPP_SESSION_DIR`, so future restarts do not need a new pairing code unless the session expires.

## Railway Deployment

- Mount the Railway volume at `/app/data`.
- Set `WHATSAPP_NUMBER` in Railway to the WhatsApp account number, for example `961XXXXXXXX`.
- The WhatsApp session files are persisted at `/app/data/whatsapp-session`.
- On first login, the app prints a pairing code in the Railway logs instead of a QR link.

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
