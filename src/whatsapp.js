const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const SESSION_ROOT =
  process.env.WHATSAPP_SESSION_DIR ||
  path.join(process.cwd(), "data", "whatsapp-session");
const RECONNECT_DELAY_MS = 5000;
const STREAM_METHOD_NOT_ALLOWED_STATUS = 405;
const AUTH_MODE_AUTO = "auto";
const AUTH_MODE_PAIRING = "pairing";
const AUTH_MODE_QR = "qr";

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

function getConfiguredAuthMode() {
  const rawValue = String(process.env.WHATSAPP_AUTH_MODE || AUTH_MODE_AUTO)
    .trim()
    .toLowerCase();

  if (rawValue === "pairing_code" || rawValue === AUTH_MODE_PAIRING) {
    return AUTH_MODE_PAIRING;
  }

  if (rawValue === AUTH_MODE_QR) {
    return AUTH_MODE_QR;
  }

  return AUTH_MODE_AUTO;
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
  let startPromise = null;
  let resolveStart = null;
  let rejectStart = null;
  const authMode = getConfiguredAuthMode();
  const phoneNumber = sanitizePhoneNumber(process.env.WHATSAPP_NUMBER);
  let preferQrLogin =
    authMode === AUTH_MODE_QR ||
    (!phoneNumber && authMode !== AUTH_MODE_PAIRING);
  let status = {
    state: "starting",
    connected: false,
    authMode,
    phoneNumberConfigured: Boolean(phoneNumber),
    pairingCode: null,
    qr: null,
    message: "Starting WhatsApp connection...",
    lastError: null,
    updatedAt: new Date().toISOString()
  };
  let pairingState = {
    socket: null,
    requested: false,
    promise: null
  };

  const events = new EventEmitter();

  function getStatus() {
    return { ...status };
  }

  function updateStatus(patch) {
    status = {
      ...status,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    events.emit("status", getStatus());
  }

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

  function resetPairingState(activeSocket = null) {
    if (activeSocket && pairingState.socket !== activeSocket) {
      return;
    }

    pairingState = {
      socket: null,
      requested: false,
      promise: null
    };
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

  function shouldUseQr() {
    if (authMode === AUTH_MODE_QR) {
      return true;
    }

    if (!phoneNumber && authMode !== AUTH_MODE_PAIRING) {
      return true;
    }

    return preferQrLogin;
  }

  function shouldRequestPairingCode() {
    return authMode !== AUTH_MODE_QR && Boolean(phoneNumber) && !preferQrLogin;
  }

  function setWaitingStatus() {
    if (shouldUseQr()) {
      updateStatus({
        state: "waiting",
        connected: false,
        pairingCode: null,
        message: phoneNumber
          ? "Waiting for WhatsApp QR code..."
          : "WHATSAPP_NUMBER is not set. Waiting for WhatsApp QR code..."
      });
      return;
    }

    updateStatus({
      state: "waiting",
      connected: false,
      pairingCode: null,
      qr: null,
      message: "Requesting WhatsApp pairing code...",
      lastError: null
    });
  }

  async function requestPairingCode(activeSocket) {
    if (!activeSocket || shouldUseQr()) {
      return;
    }

    if (!phoneNumber) {
      const error = new Error(
        "WHATSAPP_NUMBER must be set when WHATSAPP_AUTH_MODE=pairing."
      );

      console.error(`[WhatsApp] ${error.message}`);
      updateStatus({
        state: "error",
        connected: false,
        pairingCode: null,
        qr: null,
        message: error.message,
        lastError: error.message
      });
      failStart(error);
      return;
    }

    if (pairingState.socket === activeSocket && pairingState.requested) {
      return pairingState.promise;
    }

    let codeIssued = false;

    pairingState = {
      socket: activeSocket,
      requested: true,
      promise: (async () => {
        try {
          setWaitingStatus();

          const code = await activeSocket.requestPairingCode(phoneNumber);

          if (sock !== activeSocket || activeSocket.authState.creds.registered) {
            return;
          }

          codeIssued = true;
          updateStatus({
            state: "pairing_code",
            connected: false,
            pairingCode: code,
            qr: null,
            message:
              "Enter this code in WhatsApp > Linked Devices > Link with phone number.",
            lastError: null
          });

          console.log("");
          console.log("================================");
          console.log("WHATSAPP PAIRING CODE:");
          console.log(code);
          console.log("================================");
          console.log("Enter this code in WhatsApp:");
          console.log("WhatsApp -> Linked Devices -> Link with phone number");
          console.log("");
        } catch (error) {
          if (sock !== activeSocket) {
            return;
          }

          preferQrLogin = true;
          console.error(`[WhatsApp] Failed to request pairing code: ${error.message}`);
          updateStatus({
            state: "waiting",
            connected: false,
            pairingCode: null,
            message: "Pairing code failed. Waiting for QR fallback...",
            lastError: error.message
          });
        } finally {
          if (pairingState.socket === activeSocket) {
            pairingState.promise = null;

            if (!codeIssued && !activeSocket.authState.creds.registered) {
              pairingState.requested = false;
            }
          }
        }
      })()
    };

    return pairingState.promise;
  }

  async function initialize() {
    const {
      default: makeWASocket,
      Browsers,
      DisconnectReason,
      useMultiFileAuthState
    } = await loadBaileys();

    await fs.promises.mkdir(SESSION_ROOT, { recursive: true });
    resetPairingState();
    updateStatus({
      state: "starting",
      connected: false,
      pairingCode: null,
      qr: null,
      message: "Starting WhatsApp connection...",
      lastError: null
    });

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

    activeSocket.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (error) {
        console.error(`[WhatsApp] Failed to save session: ${error.message}`);
      }

      if (sock !== activeSocket || !activeSocket.authState.creds.registered) {
        return;
      }

      resetPairingState(activeSocket);
      updateStatus({
        state: "authorizing",
        connected: false,
        pairingCode: null,
        qr: null,
        message: "WhatsApp login accepted. Finishing connection...",
        lastError: null
      });
    });

    activeSocket.ev.on("connection.update", async (update) => {
      if (sock !== activeSocket) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (!activeSocket.authState.creds.registered) {
        if (qr && shouldUseQr()) {
          updateStatus({
            state: "qr",
            connected: false,
            qr,
            pairingCode: null,
            message: "Scan this QR code in WhatsApp > Linked Devices > Link a device.",
            lastError: null
          });
        } else if (connection === "connecting" && !status.qr) {
          setWaitingStatus();
        }

        if (shouldRequestPairingCode() && (connection === "connecting" || qr)) {
          await requestPairingCode(activeSocket);
        }
      }

      if (connection === "open") {
        isReady = true;
        clearReconnectTimer();
        resetPairingState(activeSocket);
        updateStatus({
          state: "connected",
          connected: true,
          pairingCode: null,
          qr: null,
          message: "Connected to WhatsApp.",
          lastError: null
        });

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
      resetPairingState(activeSocket);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || null;

      if (statusCode === DisconnectReason.restartRequired) {
        console.log("[WhatsApp] Restart required; reconnecting...");
        updateStatus({
          state: "reconnecting",
          connected: false,
          pairingCode: null,
          qr: null,
          message: "WhatsApp restart required. Reconnecting...",
          lastError: errorMessage
        });
        clearReconnectTimer();
        initialize().catch((error) => {
          console.error(`[WhatsApp] Initialization failed: ${error.message}`);
          scheduleReconnect();
        });
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.warn("[WhatsApp] Session logged out; resetting session and reconnecting.");
        preferQrLogin =
          authMode === AUTH_MODE_QR ||
          (!phoneNumber && authMode !== AUTH_MODE_PAIRING);
        updateStatus({
          state: "reconnecting",
          connected: false,
          pairingCode: null,
          qr: null,
          message: "WhatsApp session logged out. Resetting session and reconnecting...",
          lastError: errorMessage
        });

        try {
          await resetSessionDir();
        } catch (error) {
          console.error(`[WhatsApp] Failed to reset session: ${error.message}`);
        }

        scheduleReconnect();
        return;
      }

      if (
        statusCode === STREAM_METHOD_NOT_ALLOWED_STATUS &&
        !activeSocket.authState.creds.registered
      ) {
        preferQrLogin = true;
        console.warn(
          "[WhatsApp] Pairing session rejected; resetting session and reconnecting with QR fallback."
        );
        updateStatus({
          state: "reconnecting",
          connected: false,
          pairingCode: null,
          qr: null,
          message: "Pairing code login was rejected. Switching to QR fallback...",
          lastError: errorMessage || "Pairing session rejected"
        });

        try {
          await resetSessionDir();
        } catch (error) {
          console.error(`[WhatsApp] Failed to reset session: ${error.message}`);
        }

        scheduleReconnect();
        return;
      }

      console.warn(`[WhatsApp] Disconnected: ${statusCode || "unknown"}`);
      updateStatus({
        state: "reconnecting",
        connected: false,
        pairingCode: null,
        qr: null,
        message: `Disconnected${statusCode ? ` (${statusCode})` : ""}. Reconnecting...`,
        lastError: errorMessage
      });
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
    getStatus,
    sendToGroup,
    sendMediaToGroup
  };
}

module.exports = {
  createWhatsAppBot
};
