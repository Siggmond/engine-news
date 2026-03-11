const { Client, MessageMedia } = require("whatsapp-web.js");
const BaseAuthStrategy = require("whatsapp-web.js/src/authStrategies/BaseAuthStrategy");
const { EventEmitter } = require("events");
const fs = require("fs");
const axios = require("axios");
const mime = require("mime-types");
const path = require("path");

const CLIENT_ID = "lebanon-news-engine";
const SESSION_ROOT =
  process.env.WHATSAPP_SESSION_DIR ||
  path.join(process.cwd(), "data", "whatsapp-session");
const CHROMIUM_LOCK_FILES = new Set([
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "lockfile"
]);
const PERSISTED_PROFILE_PATHS = [
  path.join("Default", "IndexedDB"),
  path.join("Default", "Local Storage"),
  path.join("Default", "Session Storage"),
  path.join("Default", "Network")
];
const EXCLUDED_PROFILE_DIRS = new Set([
  "Code Cache",
  "Cache",
  "GPUCache",
  "Service Worker",
  "GrShaderCache",
  "ShaderCache"
]);
let qrPrinted = false;

function isChromiumLockFile(fileName) {
  return (
    CHROMIUM_LOCK_FILES.has(fileName) ||
    fileName.startsWith(".org.chromium.Chromium.")
  );
}

async function removeChromiumLockFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return 0;
  }

  let removed = 0;
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (isChromiumLockFile(entry.name)) {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
      removed += 1;
      continue;
    }

    if (entry.isDirectory()) {
      removed += await removeChromiumLockFiles(entryPath);
    }
  }

  return removed;
}

function shouldExcludePersistedPath(relativePath) {
  if (!relativePath || relativePath === ".") {
    return false;
  }

  return relativePath
    .split(path.sep)
    .some(
      (segment) =>
        EXCLUDED_PROFILE_DIRS.has(segment) || isChromiumLockFile(segment)
    );
}

async function copyPersistedSessionData(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  for (const relativePath of PERSISTED_PROFILE_PATHS) {
    const sourcePath = path.join(sourceDir, relativePath);

    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const targetPath = path.join(targetDir, relativePath);

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      filter: (currentSourcePath) => {
        const nestedRelativePath = path.relative(sourceDir, currentSourcePath);
        return !shouldExcludePersistedPath(nestedRelativePath);
      }
    });
  }
}

class RailwaySessionAuth extends BaseAuthStrategy {
  constructor(options = {}) {
    super();

    const clientId = options.clientId || CLIENT_ID;

    this.clientId = clientId;
    this.dataPath = path.resolve(options.dataPath || SESSION_ROOT);
    this.sessionDir = path.join(this.dataPath, `session-${clientId}`);
    this.syncIntervalMs = Number(options.syncIntervalMs) || 60000;
    this.runtimeUserDataDir = null;
    this.syncTimer = null;
    this.syncPromise = null;
  }

  async beforeBrowserInitialized() {
    // LocalAuth hard-wires Chromium to a persistent profile, which is what
    // causes Railway restarts to trip over stale lock files.
    const userDataDir = "/tmp/chrome-" + Date.now();
    const puppeteerConfig = this.client.options.puppeteer || {};

    await fs.promises.mkdir(this.dataPath, { recursive: true });

    const removedLocks = await removeChromiumLockFiles(this.dataPath);
    if (removedLocks > 0) {
      console.log(
        `[WhatsApp] Removed ${removedLocks} stale Chromium lock file(s) from ${this.dataPath}`
      );
    }

    await fs.promises.rm(userDataDir, { recursive: true, force: true });
    await fs.promises.mkdir(userDataDir, { recursive: true });
    await copyPersistedSessionData(this.sessionDir, userDataDir);

    this.runtimeUserDataDir = userDataDir;

    console.log(`[WhatsApp] Session storage: ${this.sessionDir}`);
    console.log(`[WhatsApp] Runtime Chromium profile: ${userDataDir}`);

    this.client.options.puppeteer = {
      ...puppeteerConfig,
      userDataDir
    };
  }

  async afterAuthReady() {
    this.startSyncLoop();
    await this.persistSession();
  }

  async destroy() {
    await this.shutdown();
  }

  async disconnect() {
    await this.shutdown();
  }

  async logout() {
    await this.shutdown();
    await fs.promises.rm(this.sessionDir, {
      recursive: true,
      force: true
    });
  }

  startSyncLoop() {
    if (this.syncTimer) {
      return;
    }

    this.syncTimer = setInterval(() => {
      this.persistSession().catch((error) => {
        console.error(`[WhatsApp] Session sync failed: ${error.message}`);
      });
    }, this.syncIntervalMs);

    if (typeof this.syncTimer.unref === "function") {
      this.syncTimer.unref();
    }
  }

  async persistSession() {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.doPersistSession().finally(() => {
      this.syncPromise = null;
    });

    return this.syncPromise;
  }

  async doPersistSession() {
    if (!this.runtimeUserDataDir || !fs.existsSync(this.runtimeUserDataDir)) {
      return;
    }

    const stagingDir = path.join(
      path.dirname(this.runtimeUserDataDir),
      `whatsapp-session-${this.clientId}-staging`
    );

    try {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
      await copyPersistedSessionData(this.runtimeUserDataDir, stagingDir);
      await removeChromiumLockFiles(stagingDir);

      fs.rmSync(this.dataPath, { recursive: true, force: true });
      await fs.promises.mkdir(this.dataPath, { recursive: true });

      if (fs.existsSync(stagingDir)) {
        await copyPersistedSessionData(stagingDir, this.sessionDir);
      }
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
    }
  }

  async shutdown() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    try {
      await this.persistSession();
    } catch (error) {
      console.error(
        `[WhatsApp] Session sync failed during shutdown: ${error.message}`
      );
    }

    if (!this.runtimeUserDataDir) {
      return;
    }

    await removeChromiumLockFiles(this.runtimeUserDataDir);
    await fs.promises.rm(this.runtimeUserDataDir, {
      recursive: true,
      force: true
    });

    this.runtimeUserDataDir = null;
  }
}

function createWhatsAppBot(groupName) {
  let client = null;
  let isReady = false;
  let groupId = null;
  let reconnectTimer = null;
  let waitingForQrScan = false;
  let startPromise = null;
  let resolveStart = null;

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

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (waitingForQrScan || reconnectTimer) {
      return;
    }

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      qrPrinted = false;

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
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
        "--disable-extensions"
      ]
    };

    if (executablePath) {
      puppeteerConfig.executablePath = executablePath;
    }

    client = new Client({
      authStrategy: new RailwaySessionAuth({
        clientId: CLIENT_ID,
        dataPath: SESSION_ROOT
      }),
      puppeteer: puppeteerConfig
    });

    client.on("qr", (qr) => {
      waitingForQrScan = true;
      clearReconnectTimer();

      if (qr && !qrPrinted) {
        qrPrinted = true;

        const qrUrl =
          "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" +
          encodeURIComponent(qr);

        console.log("\n==============================");
        console.log("WhatsApp login required");
        console.log("Open this link and scan:");
        console.log(qrUrl);
        console.log("==============================\n");
      }
    });

    client.on("ready", async () => {
      isReady = true;
      waitingForQrScan = false;
      qrPrinted = false;
      clearReconnectTimer();

      console.log("[WhatsApp] Connected");

      await resolveGroup();

      events.emit("ready");

      if (resolveStart) {
        resolveStart();
        resolveStart = null;
      }
    });

    client.on("auth_failure", (message) => {
      isReady = false;
      groupId = null;
      waitingForQrScan = false;
      qrPrinted = false;

      console.error(`[WhatsApp] Auth failure: ${message}`);
    });

    client.on("disconnected", (reason) => {
      isReady = false;
      groupId = null;

      console.warn(`[WhatsApp] Disconnected: ${reason}`);

      if (waitingForQrScan || reason === "LOGOUT") {
        return;
      }

      qrPrinted = false;
      scheduleReconnect();
    });

    client.initialize().catch((error) => {
      isReady = false;
      groupId = null;

      console.error(`[WhatsApp] Initialization failed: ${error.message}`);

      if (waitingForQrScan) {
        return;
      }

      qrPrinted = false;
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
        responseType: "arraybuffer",
        timeout: 20000
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

  function start() {
    if (startPromise) {
      return startPromise;
    }

    startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });

    initialize();

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
