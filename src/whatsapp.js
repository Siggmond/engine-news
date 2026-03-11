const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

function createWhatsAppBot(groupName) {

  let sock = null;
  let groupId = null;
  let pairingPrinted = false;

  const events = new EventEmitter();
  const sessionPath = path.join(process.cwd(), "data", "baileys-session");

  async function resolveGroup() {

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
      browser: ["Ubuntu", "Chrome", "120.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

      const { connection, lastDisconnect } = update;

      if (connection === "open") {

        console.log("WhatsApp connected");

        if (!sock.authState.creds.registered && !pairingPrinted) {

          pairingPrinted = true;

          const phone = process.env.WHATSAPP_NUMBER;

          try {

            const code = await sock.requestPairingCode(phone);

            console.log("");
            console.log("================================");
            console.log("WhatsApp PAIRING CODE:");
            console.log(code);
            console.log("Enter it in WhatsApp → Linked Devices");
            console.log("================================");
            console.log("");

          } catch (err) {

            console.log("Pairing code failed:", err.message);

          }

        }

        await resolveGroup();

        events.emit("ready");

      }

      if (connection === "close") {

        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log("[WhatsApp] Connection closed");

        if (shouldReconnect) {

          console.log("[WhatsApp] Reconnecting in 10s...");

          setTimeout(() => {
            start();
          }, 10000);

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
