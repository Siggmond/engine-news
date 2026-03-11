const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const SESSION_ROOT =
  process.env.WHATSAPP_SESSION_DIR ||
  path.join(process.cwd(), "data", "whatsapp-session");
const RECONNECT_DELAY_MS = 5000;

let baileysModulePromise = null;

function loadBaileys() {
  if (!baileysModulePromise) {
    baileysModulePromise = import("@whiskeysockets/baileys");
  }

  return baileysModulePromise;
}

function createSilentLogger() {
  const logger = {
    level: "silent",
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    }
  };

  return logger;
}

function sanitizePhoneNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

async function resetSessionDir() {
  await fs.promises.rm(SESSION_ROOT, { recursive: true, force: true });
  await fs.promises.mkdir(SESSION_ROOT, { recursive: true });
}

function createWhatsAppBot(groupName) {
  let sock = null;
  let isReady = false;
  let groupId = null;
  let reconnectTimer = null;
  let pairingRequested = false;
  let startPromise = null;
  let resolveStart = null;
  let rejectStart = null;

  const events = new EventEmitter();

  async function resolveGroup(activeSocket = sock) {
    if (!activeSocket || !isReady) return null;

    try {
      const groups = await activeSocket.groupFetchAllParticipating();

      const targetGroup = Object.entries(groups || {}).find(([, metadata]) => {
        return metadata?.subject === groupName || metadata?.name === groupName;
      });

      if (!targetGroup) {
        console.error(`[WhatsApp] Group not found: ${groupName}`);
        groupId = null;
        return null;
      }

      groupId = targetGroup[0];

      return groupId;
    } catch (error) {
      console.error(`[WhatsApp] Failed to resolve group: ${error.message}`);
      groupId = null;
      return null;
    }
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function failStart(error) {
    if (!rejectStart) {
      return;
    }

    rejectStart(error);
    rejectStart = null;
    resolveStart = null;
  }

  function resolveStartIfNeeded() {
    if (!resolveStart) {
      return;
    }

    resolveStart();
    resolveStart = null;
    rejectStart = null;
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;

      initialize().catch((error) => {
        console.error(`[WhatsApp] Initialization failed: ${error.message}`);
        scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  async function printPairingCode(activeSocket) {
    if (!activeSocket || activeSocket.authState.creds.registered) {
      return;
    }

    const phoneNumber = sanitizePhoneNumber(process.env.WHATSAPP_NUMBER);

    if (!phoneNumber) {
      const error = new Error(
        "WHATSAPP_NUMBER must be set, for example: 961XXXXXXXX"
      );

      console.error(`[WhatsApp] ${error.message}`);
      failStart(error);
      return;
    }

    pairingRequested = true;

    try {
      const code = await activeSocket.requestPairingCode(phoneNumber);

      console.log("");
      console.log("================================");
      console.log("WHATSAPP PAIRING CODE:");
      console.log(code);
      console.log("================================");
      console.log("Enter this code in WhatsApp:");
      console.log("WhatsApp -> Linked Devices -> Link with phone number");
      console.log("");
    } catch (error) {
      pairingRequested = false;
      console.error(`[WhatsApp] Failed to request pairing code: ${error.message}`);
      scheduleReconnect();
    }
  }

  async function initialize() {
    const {
      default: makeWASocket,
      Browsers,
      DisconnectReason,
      useMultiFileAuthState
    } = await loadBaileys();

    await fs.promises.mkdir(SESSION_ROOT, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_ROOT);

    const activeSocket = makeWASocket({
      auth: state,
      browser: Browsers.macOS("Chrome"),
      defaultQueryTimeoutMs: undefined,
      logger: createSilentLogger(),
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      syncFullHistory: false
    });

    sock = activeSocket;

    activeSocket.ev.on("creds.update", saveCreds);

    activeSocket.ev.on("connection.update", async (update) => {
      if (sock !== activeSocket) {
        return;
      }

      const { connection, lastDisconnect } = update;

      if (
        !activeSocket.authState.creds.registered &&
        !pairingRequested &&
        connection === "connecting"
      ) {
        await printPairingCode(activeSocket);
      }

      if (connection === "open") {
        isReady = true;
        pairingRequested = false;
        clearReconnectTimer();

        console.log("[WhatsApp] Connected");

        await resolveGroup(activeSocket);

        events.emit("ready");
        resolveStartIfNeeded();
        return;
      }

      if (connection !== "close") {
        return;
      }

      isReady = false;
      groupId = null;
      pairingRequested = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.restartRequired) {
        console.log("[WhatsApp] Restart required; reconnecting...");
        clearReconnectTimer();
        initialize().catch((error) => {
          console.error(`[WhatsApp] Initialization failed: ${error.message}`);
          scheduleReconnect();
        });
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.warn("[WhatsApp] Session logged out; requesting a fresh pairing code.");

        try {
          await resetSessionDir();
        } catch (error) {
          console.error(`[WhatsApp] Failed to reset session: ${error.message}`);
        }

        scheduleReconnect();
        return;
      }

      console.warn(`[WhatsApp] Disconnected: ${statusCode || "unknown"}`);
      scheduleReconnect();
    });
  }

  async function sendToGroup(message) {
    if (!sock || !isReady) return false;

    if (!groupId) await resolveGroup();

    if (!groupId) return false;

    try {
      await sock.sendMessage(groupId, { text: message });
      return true;
    } catch (error) {
      console.error(`[WhatsApp] Failed to send message: ${error.message}`);
      return false;
    }
  }

  async function sendMediaToGroup(url, caption) {
    if (!sock || !isReady) return false;

    if (!groupId) await resolveGroup();

    if (!groupId) return false;

    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000
      });

      await sock.sendMessage(groupId, {
        image: Buffer.from(response.data),
        caption
      });

      return true;
    } catch (error) {
      console.error(`[WhatsApp] Media send failed: ${error.message}`);
      return false;
    }
  }

  function start() {
    if (startPromise) {
      return startPromise;
    }

    startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    initialize().catch((error) => {
      console.error(`[WhatsApp] Initialization failed: ${error.message}`);
      scheduleReconnect();
    });

    return startPromise;
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
