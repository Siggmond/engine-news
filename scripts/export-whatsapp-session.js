#!/usr/bin/env node

require("dotenv").config();

const path = require("path");

const { exportSessionToEnv } = require("../src/whatsappSession");

const sessionDir =
  process.env.WHATSAPP_SESSION_DIR ||
  path.join(process.cwd(), "data", "whatsapp-session");

async function main() {
  const result = await exportSessionToEnv(sessionDir);

  console.log(`# Exported ${result.fileCount} WhatsApp session files from ${sessionDir}`);
  console.log("# Paste this value into Railway as WHATSAPP_SESSION_B64");
  console.log(result.encoded);
}

main().catch((error) => {
  console.error(`[Export] ${error.message}`);
  process.exitCode = 1;
});
