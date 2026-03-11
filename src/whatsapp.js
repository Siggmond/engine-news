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

async function copySessionDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  await fs.promises.mkdir(targetDir, { recursive: true });

  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (isChromiumLockFile(entry.name)) {
      continue;
    }

    await fs.promises.cp(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      {
        recursive: true,
        force: true,
        filter: (sourcePath) => {
          return !isChromiumLockFile(path.basename(sourcePath));
        }
      }
    );
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
    await copySessionDirectory(this.sessionDir, userDataDir);

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

    const stagingDir = `${this.sessionDir}-staging`;

    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    await copySessionDirectory(this.runtimeUserDataDir, stagingDir);
    await removeChromiumLockFiles(stagingDir);

    await fs.promises.mkdir(this.dataPath, { recursive: true });
    await fs.promises.rm(this.sessionDir, { recursive: true, force: true });

    if (fs.existsSync(stagingDir)) {
      await fs.promises.rename(stagingDir, this.sessionDir);
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
      console.log("\nWhatsApp login required\n");

      const qrUrl =
        "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" +
        encodeURIComponent(qr);

      console.log("Open this link and scan with WhatsApp:\n");
      console.log(qrUrl);
      console.log("\n");
    });

    client.on("ready", async () => {
      isReady = true;

      console.log("[WhatsApp] Connected");

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
