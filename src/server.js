require("dotenv").config();

const path = require("path");
const express = require("express");

const {
  ensureDataFiles,
  getFeeds,
  addFeed,
  deleteFeed
} = require("./storage");

const { createWhatsAppBot } = require("./whatsapp");
const { startRssEngine } = require("./rssEngine");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const GROUP_NAME = process.env.GROUP_NAME || "Your WhatsApp Group";
let whatsappClient = null;
global.whatsappQR = global.whatsappQR || null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));


// =====================
// API
// =====================

app.get("/api/feeds", (req, res) => {
  res.json({ feeds: getFeeds() });
});

app.post("/api/feeds", (req, res) => {
  try {
    const url = req.body?.url;

    const feeds = addFeed(url);

    console.log(`Feed added: ${url}`);

    res.status(201).json({ feeds });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/feeds", (req, res) => {
  const url = req.body?.url;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: "RSS Feed URL is required." });
  }

  const result = deleteFeed(url);

  if (result.deleted) {
    console.log(`Feed deleted: ${url}`);
  }

  res.json(result);
});

app.get("/api/whatsapp-status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(
    whatsappClient?.getStatus?.() || {
      state: "starting",
      connected: false,
      authMode: "auto",
      phoneNumberConfigured: Boolean(process.env.WHATSAPP_NUMBER),
      pairingCode: null,
      qr: null,
      message: "Starting WhatsApp connection...",
      lastError: null,
      updatedAt: new Date().toISOString()
    }
  );
});

app.get("/qr", (req, res) => {
  if (!global.whatsappQR) {
    return res.send("QR not generated yet");
  }

  res.type("html").send(`
    <html>
      <body style="text-align:center;font-family:sans-serif">
        <h2>Scan with WhatsApp</h2>
        <img src="${global.whatsappQR}" />
      </body>
    </html>
  `);
});


// =====================
// Frontend
// =====================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});


// =====================
// Start App
// =====================

function listen() {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Dashboard running on port ${PORT}`);
      resolve(server);
    });

    server.on("error", reject);
  });
}

async function main() {
  ensureDataFiles();

  await listen();

  whatsappClient = createWhatsAppBot(GROUP_NAME);
  let rssStarted = false;

  whatsappClient.on("ready", () => {
    console.log("WhatsApp ready");

    if (!rssStarted) {
      rssStarted = true;
      startRssEngine(whatsappClient);
    }
  });

  await whatsappClient.start();

  console.log("WhatsApp engine running");
}

main().catch((error) => {
  console.error(`[Server] Startup error: ${error.message}`);
});
