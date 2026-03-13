let hasWarnedMissingDependency = false;
let hasWarnedMissingConfig = false;

function parseChannels(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildPublicMessageUrl(channel, entity, messageId) {
  const username = String(entity?.username || "").trim().replace(/^@/, "");

  if (username) {
    return `https://t.me/${username}/${messageId}`;
  }

  const channelHandle = String(channel || "")
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "");

  if (channelHandle && !channelHandle.includes("/")) {
    return `https://t.me/${channelHandle}/${messageId}`;
  }

  return "";
}

function toIsoDate(dateValue) {
  if (!dateValue) {
    return null;
  }

  if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
    return dateValue.toISOString();
  }

  if (typeof dateValue === "number") {
    return new Date(dateValue * 1000).toISOString();
  }

  const parsed = Date.parse(dateValue);

  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeTelegramMessage(channel, entity, message) {
  const rawText = String(message?.message || "").trim();
  const text = rawText.replace(/\s+/g, " ").trim();

  if (!text) {
    return null;
  }

  const title = rawText
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean)
    ?.slice(0, 180)
    || text.slice(0, 180);
  const url = buildPublicMessageUrl(channel, entity, message.id);

  return {
    id: url || `telegram:${channel}:${message.id}`,
    title,
    url,
    description: text === title ? "" : text,
    publishedAt: toIsoDate(message.date),
    source: {
      type: "telegram",
      title: entity?.title || entity?.username || channel
    }
  };
}

async function loadGramJs() {
  try {
    const { TelegramClient } = require("telegram");
    const { StringSession } = require("telegram/sessions");

    return { TelegramClient, StringSession };
  } catch (error) {
    if (!hasWarnedMissingDependency) {
      console.warn(
        "[Telegram] gramjs dependency is missing. Run `npm install telegram` to enable Telegram ingestion."
      );
      hasWarnedMissingDependency = true;
    }

    return null;
  }
}

async function fetchTelegramNews() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  const stringSession = String(process.env.TELEGRAM_SESSION || "").trim();
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const channels = parseChannels(process.env.TELEGRAM_CHANNELS);
  const limit = Number(process.env.TELEGRAM_FETCH_LIMIT || 10);

  if (!apiId || !apiHash || channels.length === 0 || (!stringSession && !botToken)) {
    if (!hasWarnedMissingConfig) {
      console.warn(
        "[Telegram] TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_CHANNELS, and TELEGRAM_SESSION or TELEGRAM_BOT_TOKEN are required. Skipping Telegram source."
      );
      hasWarnedMissingConfig = true;
    }

    return [];
  }

  const gramjs = await loadGramJs();

  if (!gramjs) {
    return [];
  }

  const { TelegramClient, StringSession } = gramjs;
  const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
    connectionRetries: 3
  });

  try {
    if (stringSession) {
      await client.connect();
    } else {
      await client.start({
        botAuthToken: botToken
      });
    }

    const items = [];

    for (const channel of channels) {
      const entity = await client.getEntity(channel);

      for await (const message of client.iterMessages(entity, { limit })) {
        const item = normalizeTelegramMessage(channel, entity, message);

        if (item) {
          items.push(item);
        }
      }
    }

    return items;
  } catch (error) {
    console.error(`[Telegram] Failed to fetch channel messages: ${error.message}`);
    return [];
  } finally {
    await client.disconnect().catch(() => {});
  }
}

module.exports = {
  fetchTelegramNews
};
