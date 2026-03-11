const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
const POSTED_FILE = path.join(DATA_DIR, "posted.json");

function ensureArrayFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf8");
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      fs.writeFileSync(filePath, "[]", "utf8");
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      fs.writeFileSync(filePath, "[]", "utf8");
    }
  } catch {
    fs.writeFileSync(filePath, "[]", "utf8");
  }
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  ensureArrayFile(FEEDS_FILE);
  ensureArrayFile(POSTED_FILE);
}

function readArray(filePath) {
  ensureArrayFile(filePath);

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeArray(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeUrl(url) {
  return (url || "").trim();
}

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getFeeds() {
  return readArray(FEEDS_FILE);
}

function addFeed(feedUrl) {
  const normalizedUrl = normalizeUrl(feedUrl);
  if (!normalizedUrl) {
    throw new Error("RSS Feed URL is required.");
  }

  if (!isValidHttpUrl(normalizedUrl)) {
    throw new Error("RSS Feed URL must be a valid http(s) URL.");
  }

  const feeds = getFeeds();
  const exists = feeds.some(
    (storedUrl) => storedUrl.toLowerCase() === normalizedUrl.toLowerCase()
  );

  if (exists) {
    throw new Error("Feed already exists.");
  }

  feeds.push(normalizedUrl);
  writeArray(FEEDS_FILE, feeds);
  return feeds;
}

function deleteFeed(feedUrl) {
  const normalizedUrl = normalizeUrl(feedUrl);
  const feeds = getFeeds();
  const remainingFeeds = feeds.filter(
    (storedUrl) => storedUrl.toLowerCase() !== normalizedUrl.toLowerCase()
  );

  if (remainingFeeds.length === feeds.length) {
    return { deleted: false, feeds };
  }

  writeArray(FEEDS_FILE, remainingFeeds);
  return { deleted: true, feeds: remainingFeeds };
}

function getPostedLinks() {
  return readArray(POSTED_FILE);
}

function hasPosted(link) {
  if (!link) return false;
  const posted = getPostedLinks();
  return posted.includes(link);
}

function addPosted(link) {
  const normalizedLink = normalizeUrl(link);
  if (!normalizedLink) return;

  const posted = getPostedLinks();
  if (posted.includes(normalizedLink)) return;

  posted.push(normalizedLink);
  writeArray(POSTED_FILE, posted);
}

module.exports = {
  ensureDataFiles,
  FEEDS_FILE,
  POSTED_FILE,
  getFeeds,
  addFeed,
  deleteFeed,
  getPostedLinks,
  hasPosted,
  addPosted,
};
