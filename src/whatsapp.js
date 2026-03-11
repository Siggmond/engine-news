const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const QRCode = require("qrcode");

function createWhatsAppBot(groupName) {

  let sock = null;
  let groupId = null;

  const events = new EventEmitter();
  const sessionPath = path.join(process.cwd(), "data", "baileys-session");

  async function resolveGroup() {

    if (!sock) return;

    try {

      const groups = await sock.groupFetchAllParticipating();

      for (const id in groups) {

        if (groups[id].subject === groupName) {

          groupId = id;

          console.log("[WhatsApp] Group resolved:", groupName);

          return;

        }

      }

      console.log("[WhatsApp] Group not found:", groupName);

    } catch (err) {

      console.log("[WhatsApp] Failed resolving group:", err.message);

    }

  }

  async function start() {

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    sock = makeWASocket({

      auth: state,

      browser: ["Ubuntu", "Chrome", "120.0.0"],

      printQRInTerminal: false

    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

      const { connection, qr, lastDisconnect } = update;

      if (qr) {

        console.log("\n==============================");
        console.log("WhatsApp LOGIN REQUIRED");
        console.log("==============================\n");

        const qrLink =
          "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" +
          encodeURIComponent(qr);

        console.log("Open this link and scan with WhatsApp:\n");
        console.log(qrLink);
        console.log("");

      }

      if (connection === "open") {

        console.log("WhatsApp connected");

        await resolveGroup();

        events.emit("ready");

      }

      if (connection === "close") {

        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log("[WhatsApp] Connection closed");

        if (shouldReconnect) {

          console.log("[WhatsApp] Reconnecting...");

          start();

        }

      }

    });

  }

  async function sendToGroup(message) {

    if (!sock || !groupId) return false;

    try {

      await sock.sendMessage(groupId, { text: message });

      return true;

    } catch (err) {

      console.log("[WhatsApp] Send failed:", err.message);

      return false;

    }

  }

  async function sendMediaToGroup(url, caption) {

    if (!sock || !groupId) return false;

    try {

      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000
      });

      const buffer = Buffer.from(response.data);

      await sock.sendMessage(groupId, {
        image: buffer,
        caption: caption
      });

      return true;

    } catch (err) {

      console.log("[WhatsApp] Media send failed:", err.message);

      return false;

    }

  }

  return {

    start,

    on: (eventName, handler) => events.on(eventName, handler),

    sendToGroup,

    sendMediaToGroup

  };

}

module.exports = {
  createWhatsAppBot
};
