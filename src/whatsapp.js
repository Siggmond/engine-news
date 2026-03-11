const { Client, LocalAuth } = require("whatsapp-web.js");
const { EventEmitter } = require("events");

function createWhatsAppBot(groupName) {
  let client = null;
  let isReady = false;
  let groupId = null;
  let reconnectTimer = null;

  const events = new EventEmitter();

  async function resolveGroup() {
    if (!client || !isReady) return null;

    try {
      const chats = await client.getChats();

      const targetGroup = chats.find(
        (chat) => chat.isGroup && chat.name === groupName
      );

      if (!targetGroup) {
        console.error(`[WhatsApp] Group not found: ${groupName}`);
        groupId = null;
        return null;
      }

      groupId = targetGroup.id._serialized;
      return groupId;
    } catch (error) {
      console.error(`[WhatsApp] Failed to resolve group: ${error.message}`);
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
        if (client) {
          await client.destroy();
        }
      } catch {}

      initialize();
    }, 5000);
  }

  function initialize() {
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;

    const puppeteerConfig = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ]
    };

    if (executablePath) {
      puppeteerConfig.executablePath = executablePath;
    }

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "lebanon-news-engine"
      }),
      puppeteer: puppeteerConfig
    });

    client.on("qr", (qr) => {
      console.log("\n📱 WhatsApp Login Required");
      console.log("Open this link in your browser and scan the QR:\n");

      const qrUrl =
        "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" +
        encodeURIComponent(qr);

      console.log(qrUrl);
      console.log("\n");
    });

    client.on("ready", async () => {
      isReady = true;

      console.log("✅ WhatsApp connected");

      await resolveGroup();

      events.emit("ready");
    });

    client.on("auth_failure", (message) => {
      isReady = false;
      groupId = null;

      console.error(`[WhatsApp] Auth failure: ${message}`);

      scheduleReconnect();
    });

    client.on("disconnected", (reason) => {
      isReady = false;
      groupId = null;

      console.warn(`[WhatsApp] Disconnected: ${reason}`);

      scheduleReconnect();
    });

    client.initialize().catch((error) => {
      isReady = false;
      groupId = null;

      console.error(`[WhatsApp] Initialization failed: ${error.message}`);

      scheduleReconnect();
    });
  }

  async function sendToGroup(message) {
    if (!client || !isReady) {
      console.warn("[WhatsApp] Client not ready, skipping send.");
      return false;
    }

    if (!groupId) {
      await resolveGroup();
    }

    if (!groupId) {
      console.warn(`[WhatsApp] Group "${groupName}" is unavailable.`);
      return false;
    }

    try {
      await client.sendMessage(groupId, message);
      return true;
    } catch (error) {
      console.error(`[WhatsApp] Failed to send message: ${error.message}`);
      return false;
    }
  }

  return {
    start: initialize,
    on: (eventName, handler) => events.on(eventName, handler),
    sendToGroup
  };
}

module.exports = {
  createWhatsAppBot
};
