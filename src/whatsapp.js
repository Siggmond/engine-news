const { EventEmitter } = require("events");
const fs = require("fs");
const axios = require("axios");
const QRCode = require("qrcode");
const { importSessionFromEnv } = require("./whatsappSession");

const SESSION_ROOT = process.env.WHATSAPP_SESSION_DIR || "./data/whatsapp-session";
const RECONNECT_DELAY_MS = 5000;
const STREAM_METHOD_NOT_ALLOWED_STATUS = 405;
const AUTH_MODE_AUTO = "auto";
const AUTH_MODE_PAIRING = "pairing";
const AUTH_MODE_QR = "qr";
const PAIRING_REQUEST_DELAY_MS = 1000;
const PAIRING_CODE_HOLD_MS = 65000;
const PRELOGIN_DISCONNECTS_BEFORE_QR_FALLBACK = 3;

let baileysModulePromise = null;

if (!fs.existsSync(SESSION_ROOT)) {
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
}

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
  const rawValue = String(
    process.env.WA_LOGIN_MODE || process.env.WHATSAPP_AUTH_MODE || AUTH_MODE_PAIRING
  )
    .trim()
    .toLowerCase();

  if (rawValue === "pairing_code" || rawValue === AUTH_MODE_PAIRING) {
    return AUTH_MODE_PAIRING;
  }

  if (rawValue === AUTH_MODE_QR) {
    return AUTH_MODE_QR;
  }

  return AUTH_MODE_PAIRING;
}

function parseWaWebVersion(value) {
  if (!value) {
    return null;
  }

  const parts = String(value)
    .trim()
    .split(".")
    .map((part) => Number(part));

  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    return null;
  }

  return parts;
}

async function resolveWaWebVersion(fetchLatestWaWebVersion) {
  const configuredVersion = parseWaWebVersion(process.env.WHATSAPP_WEB_VERSION);

  if (configuredVersion) {
    console.log(
      `[WhatsApp] Using configured WA Web version ${configuredVersion.join(".")}`
    );
    return configuredVersion;
  }

  if (typeof fetchLatestWaWebVersion !== "function") {
    return null;
  }

  try {
    const result = await fetchLatestWaWebVersion({ timeout: 10000 });

    if (Array.isArray(result?.version) && result.version.length === 3) {
      console.log(
        `[WhatsApp] Using WA Web version ${result.version.join(".")}${result.isLatest ? "" : " (fallback)"}`
      );
      return result.version;
    }
  } catch (error) {
    console.warn(
      `[WhatsApp] Failed to fetch latest WA Web version: ${error.message}`
    );
  }

  return null;
}

async function resetSessionDir() {
  await fs.promises.rm(SESSION_ROOT, { recursive: true, force: true });
  await fs.promises.mkdir(SESSION_ROOT, { recursive: true });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWhatsAppBot(groupName) {
  let sock = null;
  let isReady = false;
  let groupId = null;
  let reconnectTimer = null;
  let startPromise = null;
  let resolveStart = null;
  let rejectStart = null;
  const loginMode = getConfiguredAuthMode();
  const usePairing = loginMode === AUTH_MODE_PAIRING;
  const phoneNumber = sanitizePhoneNumber(process.env.WHATSAPP_NUMBER);
  let preferQrLogin = !usePairing;
  let preLoginDisconnectCount = 0;
  let lastLoggedPairingCode = null;
  let status = {
    state: "starting",
    connected: false,
    authMode: loginMode,
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

  function scheduleReconnect(delayMs = RECONNECT_DELAY_MS) {
    if (reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;

      initialize().catch((error) => {
        console.error(`[WhatsApp] Initialization failed: ${error.message}`);
        scheduleReconnect();
      });
    }, delayMs);
  }

  function logPairingCode(code) {
    if (!code || lastLoggedPairingCode === code) {
      return;
    }

    lastLoggedPairingCode = code;

    console.log("");
    console.log("================================");
    console.log(`WHATSAPP PAIRING CODE: ${code}`);
    console.log("================================");
    console.log("Enter this code in WhatsApp:");
    console.log("WhatsApp -> Linked Devices -> Link with phone number");
    console.log("Wait at least 1 minute before requesting a new code.");
    console.log("");
  }

  function shouldUseQr() {
    if (!usePairing) {
      return true;
    }

    if (!phoneNumber) {
      return true;
    }

    return preferQrLogin;
  }

  function shouldRequestPairingCode() {
    return usePairing && Boolean(phoneNumber) && !preferQrLogin;
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

  function setPairingCodeStatus(code) {
    if (!code) {
      return;
    }

    logPairingCode(code);

    updateStatus({
      state: "pairing_code",
      connected: false,
      pairingCode: code,
      qr: null,
      message:
        "Enter this code in WhatsApp > Linked Devices > Link with phone number.",
      lastError: null
    });
  }

  async function requestPairingCode(activeSocket) {
    if (!activeSocket || !usePairing || shouldUseQr()) {
      return;
    }

    if (!phoneNumber) {
      const error = new Error(
        "WHATSAPP_NUMBER must be set when WA_LOGIN_MODE=pairing."
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

    if (activeSocket.authState.creds.pairingCode) {
      pairingState = {
        socket: activeSocket,
        requested: true,
        promise: null
      };
      setPairingCodeStatus(activeSocket.authState.creds.pairingCode);
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
          await activeSocket.waitForSocketOpen();
          await wait(PAIRING_REQUEST_DELAY_MS);

          if (sock !== activeSocket || activeSocket.authState.creds.registered) {
            return;
          }

          const code = await activeSocket.requestPairingCode(phoneNumber);

          if (sock !== activeSocket || activeSocket.authState.creds.registered) {
            return;
          }

          console.log("WHATSAPP PAIRING CODE:", code);
          codeIssued = true;
          setPairingCodeStatus(code);
        } catch (error) {
          if (sock !== activeSocket) {
            return;
          }

          console.error(`[WhatsApp] Failed to request pairing code: ${error.message}`);

          const savedPairingCode = activeSocket.authState.creds.pairingCode;

          if (savedPairingCode) {
            setPairingCodeStatus(savedPairingCode);
            return;
          }

          updateStatus({
            state: "waiting",
            connected: false,
            pairingCode: null,
            message: "Pairing code request failed. Reconnecting...",
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
      DisconnectReason,
      fetchLatestWaWebVersion,
      useMultiFileAuthState
    } = await loadBaileys();

    await fs.promises.mkdir(SESSION_ROOT, { recursive: true });
    try {
      const importResult = await importSessionFromEnv(SESSION_ROOT);

      if (importResult.imported) {
        console.log(
          `[WhatsApp] Imported ${importResult.fileCount} session files from WHATSAPP_SESSION_B64`
        );
      }
    } catch (error) {
      console.error(`[WhatsApp] Failed to import session from env: ${error.message}`);
    }

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

    if (usePairing && !state.creds.registered && state.creds.pairingCode) {
      setPairingCodeStatus(state.creds.pairingCode);
    }

    const waVersion = await resolveWaWebVersion(fetchLatestWaWebVersion);

    const activeSocket = makeWASocket({
      auth: state,
      browser: ["Chrome", "Windows", "10"],
      defaultQueryTimeoutMs: undefined,
      logger: createSilentLogger(),
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      syncFullHistory: false,
      ...(waVersion ? { version: waVersion } : {})
    });

    sock = activeSocket;

    sock.ev.on("connection.update", async ({ qr, connection }) => {
      if (!qr) {
        if (connection === "open" || connection === "close") {
          global.whatsappQR = null;
        }
        return;
      }

      if (loginMode !== AUTH_MODE_QR && !shouldUseQr()) {
        return;
      }

      try {
        const qrData = await QRCode.toDataURL(qr);
        global.whatsappQR = qrData;
        console.log(
          loginMode === AUTH_MODE_QR ? "QR LOGIN READY AT /qr" : "QR LOGIN READY: /qr"
        );
      } catch (error) {
        console.error(`[WhatsApp] Failed to render QR link: ${error.message}`);
      }
    });

    const persistCreds = async () => {
      try {
        await saveCreds();
      } catch (error) {
        console.error(`[WhatsApp] Failed to save session: ${error.message}`);
      }
    };

    sock.ev.on("creds.update", persistCreds);
    sock.ev.on("creds.update", () => {
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
      const savedPairingCode = activeSocket.authState.creds.pairingCode;

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
        } else if (usePairing && savedPairingCode) {
          setPairingCodeStatus(savedPairingCode);
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
        preLoginDisconnectCount = 0;
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
        global.whatsappQR = null;

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
      const pendingPairingCode =
        usePairing &&
        !activeSocket.authState.creds.registered &&
        activeSocket.authState.creds.pairingCode
          ? activeSocket.authState.creds.pairingCode
          : null;
      const isPreLoginDisconnect = !activeSocket.authState.creds.registered;

      global.whatsappQR = null;
      if (isPreLoginDisconnect) {
        preLoginDisconnectCount += 1;
      }

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

      if (
        isPreLoginDisconnect &&
        !pendingPairingCode &&
        !preferQrLogin &&
        loginMode !== AUTH_MODE_PAIRING &&
        preLoginDisconnectCount >= PRELOGIN_DISCONNECTS_BEFORE_QR_FALLBACK
      ) {
        preferQrLogin = true;
        console.warn(
          "[WhatsApp] Pairing code flow is unstable on this host; switching to QR fallback."
        );
      }

      if (statusCode === DisconnectReason.loggedOut) {
        if (!activeSocket.authState.creds.registered) {
          console.warn(
            "[WhatsApp] Pre-login session disconnected; reconnecting without resetting the pending pairing state."
          );
          if (pendingPairingCode) {
            console.warn(
              "[WhatsApp] Preserving the current pairing code for about 1 minute before retrying."
            );
          }
          updateStatus({
            state: pendingPairingCode ? "pairing_code" : "reconnecting",
            connected: false,
            pairingCode: pendingPairingCode,
            qr: null,
            message: pendingPairingCode
              ? "Pairing code generated. Enter it in WhatsApp and wait at least 1 minute before requesting a new code."
              : preferQrLogin
                ? "Pairing code flow failed repeatedly. Reconnecting with QR fallback..."
                : "WhatsApp login session disconnected before pairing. Reconnecting...",
            lastError: errorMessage
          });
          scheduleReconnect(
            pendingPairingCode ? PAIRING_CODE_HOLD_MS : RECONNECT_DELAY_MS
          );
          return;
        }

        console.warn("[WhatsApp] Session logged out; resetting session and reconnecting.");
        preferQrLogin = !usePairing;
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
