const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { EventEmitter } = require("events");
const axios = require("axios");
const mime = require("mime-types");
const fs = require("fs");
const path = require("path");

function createWhatsAppBot(groupName) {
  let client = null;
  let isReady = false;
  let groupId = null;
  let reconnectTimer = null;

  const events = new EventEmitter();

  // --- Remove chromium lock files to avoid Railway crash ---
  function cleanChromiumLocks() {
    const base = path.join(process.cwd(), "data");

    if (!fs.existsSync(base)) return;

    function walk(dir) {
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        return;
      }

      for (const file of files) {
        const full = path.join(dir, file);

        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(full);
          continue;
        }

        if (
          file.includes("LOCK") ||
          file.includes("lock") ||
          file.includes("Singleton") ||
          file.includes("SingletonLock") ||
          file.includes("SingletonCookie")
        ) {
          try {
            fs.rmSync(full, { force: true });
            console.log("[WhatsApp] Removed chromium lock:", full);
          } catch {}
        }
      }
    }

    walk(base);
  }

  async function resolveGroup() {
    if (!client || !isReady) return null;

    try {
      const chats = await client.getChats();

      const group = chats.find(
        (chat) => chat.isGroup && chat.name === groupName
      );

      if (!group) {
        console.error(`[WhatsApp] Group not found: ${groupName}`);
        groupId = null;
        return null;
      }

      groupId = group.id._serialized;
      return groupId;
    } catch (error) {
      console.error("[WhatsApp] Failed to resolve group:", error.message);
      groupId = null;
      return null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      console.log("[WhatsApp] Reconnecting...");

      try {
        if (client) await client.destroy();
      } catch {}

      initialize();
    }, 5000);
  }

  function initialize() {
    // clean chromium lock files before launch
    cleanChromiumLocks();

    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;

    const puppeteerConfig = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-software-rasterizer",
      ],
    };

    if (executablePath) {
      puppeteerConfig.executablePath = executablePath;
    }

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "lebanon-news-engine",
        dataPath: path.join(process.cwd(), "data"),
      }),
      puppeteer: puppeteerConfig,
    });

    client.on("qr", (qr) => {
      console.log("\n📱 WhatsApp Login Required\n");

      const link =
        "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" +
        encodeURIComponent(qr);

      console.log("Open this link and scan with WhatsApp:\n");
      console.log(link);
      console.log("");
    });

    client.on("ready", async () => {
      isReady = true;
      console.log("✅ WhatsApp connected");

      await resolveGroup();
      events.emit("ready");
    });

    client.on("auth_failure", (msg) => {
      isReady = false;
      groupId = null;
      console.error("[WhatsApp] Auth failure:", msg);
      scheduleReconnect();
    });

    client.on("disconnected", (reason) => {
      isReady = false;
      groupId = null;
      console.warn("[WhatsApp] Disconnected:", reason);
      scheduleReconnect();
    });

    client.initialize().catch((err) => {
      isReady = false;
      groupId = null;
      console.error("[WhatsApp] Initialization failed:", err.message);
      scheduleReconnect();
    });
  }

  async function sendToGroup(message) {
    if (!client || !isReady) return false;

    if (!groupId) await resolveGroup();
    if (!groupId) return false;

    try {
      await client.sendMessage(groupId, message);
      return true;
    } catch (err) {
      console.error("[WhatsApp] Send failed:", err.message);
      return false;
    }
  }

  async function sendMediaToGroup(url, caption) {
    if (!client || !isReady) return false;

    if (!groupId) await resolveGroup();
    if (!groupId) return false;

    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000,
      });

      const mimeType = mime.lookup(url) || "image/jpeg";

      const media = new MessageMedia(
        mimeType,
        Buffer.from(res.data).toString("base64")
      );

      await client.sendMessage(groupId, media, { caption });

      return true;
    } catch (err) {
      console.error("[WhatsApp] Media send failed:", err.message);
      return false;
    }
  }

  return {
    start: initialize,
    on: (event, fn) => events.on(event, fn),
    sendToGroup,
    sendMediaToGroup,
  };
}

module.exports = {
  createWhatsAppBot,
};
