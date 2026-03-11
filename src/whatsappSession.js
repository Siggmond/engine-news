const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SESSION_IMPORT_MARKER_FILE = ".session-import.sha256";

function getSessionImportMarkerPath(sessionDir) {
  return path.join(sessionDir, SESSION_IMPORT_MARKER_FILE);
}

async function ensureDir(sessionDir) {
  await fs.promises.mkdir(sessionDir, { recursive: true });
}

async function listSessionFiles(sessionDir) {
  const entries = await fs.promises.readdir(sessionDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name !== SESSION_IMPORT_MARKER_FILE)
    .map((entry) => entry.name);
}

async function hasSessionFiles(sessionDir) {
  try {
    const files = await listSessionFiles(sessionDir);
    return files.length > 0;
  } catch {
    return false;
  }
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function parseSessionPayload(encodedPayload) {
  const rawBuffer = Buffer.from(String(encodedPayload || "").trim(), "base64");

  if (!rawBuffer.length) {
    throw new Error("WHATSAPP_SESSION_B64 is empty.");
  }

  const buffersToTry = [];

  try {
    buffersToTry.push(zlib.gunzipSync(rawBuffer));
  } catch {
    // Fall back to plain base64 JSON.
  }

  buffersToTry.push(rawBuffer);

  for (const buffer of buffersToTry) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      const files = parsed?.files && typeof parsed.files === "object"
        ? parsed.files
        : parsed;

      if (!files || typeof files !== "object" || Array.isArray(files)) {
        continue;
      }

      return files;
    } catch {
      // Try the next candidate format.
    }
  }

  throw new Error(
    "WHATSAPP_SESSION_B64 must be a base64 JSON payload created by the export script."
  );
}

function validateSessionFileName(fileName) {
  if (!fileName || typeof fileName !== "string") {
    return false;
  }

  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    return false;
  }

  return true;
}

async function importSessionFromEnv(sessionDir) {
  const encodedPayload = process.env.WHATSAPP_SESSION_B64;

  if (!encodedPayload || !String(encodedPayload).trim()) {
    return { imported: false, reason: "missing" };
  }

  const payloadHash = hashPayload(encodedPayload);
  const markerPath = getSessionImportMarkerPath(sessionDir);

  await ensureDir(sessionDir);

  try {
    const existingHash = await fs.promises.readFile(markerPath, "utf8");
    const sessionExists = await hasSessionFiles(sessionDir);

    if (existingHash.trim() === payloadHash && sessionExists) {
      return { imported: false, reason: "unchanged" };
    }
  } catch {
    // No marker yet, continue with import.
  }

  const files = parseSessionPayload(encodedPayload);
  const fileEntries = Object.entries(files).filter(([, value]) => typeof value === "string");

  if (!fileEntries.length) {
    throw new Error("WHATSAPP_SESSION_B64 does not contain any session files.");
  }

  await fs.promises.rm(sessionDir, { recursive: true, force: true });
  await ensureDir(sessionDir);

  for (const [fileName, fileContents] of fileEntries) {
    if (!validateSessionFileName(fileName)) {
      throw new Error(`Invalid session file name in WHATSAPP_SESSION_B64: ${fileName}`);
    }

    await fs.promises.writeFile(path.join(sessionDir, fileName), fileContents, "utf8");
  }

  await fs.promises.writeFile(markerPath, payloadHash, "utf8");

  return {
    imported: true,
    fileCount: fileEntries.length
  };
}

async function exportSessionToEnv(sessionDir) {
  const files = {};
  const fileNames = await listSessionFiles(sessionDir);

  if (!fileNames.length) {
    throw new Error(`No session files found in ${sessionDir}`);
  }

  for (const fileName of fileNames) {
    files[fileName] = await fs.promises.readFile(
      path.join(sessionDir, fileName),
      "utf8"
    );
  }

  const payload = JSON.stringify({
    version: 1,
    files
  });

  return {
    fileCount: fileNames.length,
    encoded: zlib.gzipSync(Buffer.from(payload, "utf8")).toString("base64")
  };
}

module.exports = {
  exportSessionToEnv,
  importSessionFromEnv
};
