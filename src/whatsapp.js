const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

function createWhatsAppBot(groupName) {
  let sock = null;
  let groupId = null;

  const events = new EventEmitter();
  const sessionPath = path.join(process.cwd(), "data", "baileys-session");

  let pairingRequested = false;
  let reconnectTimer = null;

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
      browser: ["Ubuntu", "Chrome", "120.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        if (!pairingRequested && !sock.authState.creds.registered) {
          pairingRequested = true;

          const phone = process.env.WHATSAPP_NUMBER;

          setTimeout(async () => {
            try {
              const code = await sock.requestPairingCode(phone);

              console.log("\n==============================");
              console.log(" WhatsApp PAIRING CODE");
              console.log("==============================\n");
              console.log(code);
              console.log("\nEnter this code in WhatsApp → Linked Devices\n");
            } catch (err) {
              console.log("[WhatsApp] Pairing failed:", err.message);
            }
          }, 5000); // wait 5 seconds for socket readiness
        }
      }

      if (connection === "open") {
        console.log("[WhatsApp] Connected successfully");

        await resolveGroup();

        events.emit("ready");
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log("[WhatsApp] Connection closed");

        if (shouldReconnect) {
          if (reconnectTimer) return;

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            pairingRequested = false;
            console.log("[WhatsApp] Reconnecting...");
            start();
          }, 8000); // wait before reconnect
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
