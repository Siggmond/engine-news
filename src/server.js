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
const GROUP_NAME = process.env.GROUP_NAME || "نور الولاية";

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


// =====================
// Frontend
// =====================

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});


// =====================
// Start App
// =====================

function start() {

  ensureDataFiles();

  // start dashboard immediately (Railway requirement)
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Dashboard running on port ${PORT}`);
  });

  const whatsappClient = createWhatsAppBot(GROUP_NAME);

  let rssStarted = false;

  whatsappClient.on("ready", () => {

    console.log("WhatsApp ready");

    if (!rssStarted) {
      rssStarted = true;
      startRssEngine(whatsappClient);
    }

  });

  whatsappClient.start();
}

start();
