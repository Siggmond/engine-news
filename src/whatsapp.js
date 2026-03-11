const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { EventEmitter } = require("events");
const axios = require("axios");
const mime = require("mime-types");

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
        chat => chat.isGroup && chat.name === groupName
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

        if (client) await client.destroy();

      } catch {}

      initialize();

    }, 5000);
  }

  function initialize() {

    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_PATH;

    const puppeteerConfig = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process"
      ]
    };

    if (executablePath) {
      puppeteerConfig.executablePath = executablePath;
    }

    client = new Client({

      authStrategy: new LocalAuth({
        clientId: "lebanon-news-engine",
        dataPath: "./data/whatsapp-session"
      }),

      puppeteer: puppeteerConfig

    });

    client.on("qr", qr => {

      console.log("\n📱 WhatsApp Login Required\n");

      const qrUrl =
        "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" +
        encodeURIComponent(qr);

      console.log("Open this link and scan with WhatsApp:\n");

      console.log(qrUrl);

      console.log("\n");

    });

    client.on("ready", async () => {

      isReady = true;

      console.log("✅ WhatsApp connected");

      await resolveGroup();

      events.emit("ready");

    });

    client.on("auth_failure", message => {

      isReady = false;

      groupId = null;

      console.error(`[WhatsApp] Auth failure: ${message}`);

      scheduleReconnect();

    });

    client.on("disconnected", reason => {

      isReady = false;

      groupId = null;

      console.warn(`[WhatsApp] Disconnected: ${reason}`);

      scheduleReconnect();

    });

    client.initialize().catch(error => {

      isReady = false;

      groupId = null;

      console.error(`[WhatsApp] Initialization failed: ${error.message}`);

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

    } catch (error) {

      console.error(`[WhatsApp] Failed to send message: ${error.message}`);

      return false;
    }
  }

  async function sendMediaToGroup(url, caption) {

    if (!client || !isReady) return false;

    if (!groupId) await resolveGroup();

    if (!groupId) return false;

    try {

      const response = await axios.get(url, {
        responseType: "arraybuffer"
      });

      const mimeType = mime.lookup(url) || "image/jpeg";

      const media = new MessageMedia(
        mimeType,
        Buffer.from(response.data).toString("base64")
      );

      await client.sendMessage(groupId, media, { caption });

      return true;

    } catch (error) {

      console.error(`[WhatsApp] Media send failed: ${error.message}`);

      return false;
    }
  }

  return {
    start: initialize,
    on: (eventName, handler) => events.on(eventName, handler),
    sendToGroup,
    sendMediaToGroup
  };
}

module.exports = {
  createWhatsAppBot
};
