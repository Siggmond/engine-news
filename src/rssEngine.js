const cron = require("node-cron");

const { addPosted } = require("./storage");
const { getProcessedNews } = require("./engine/newsPipeline");

async function scanFeeds(bot) {
  const newsItems = await getProcessedNews();

  if (newsItems.length === 0) {
    console.log("[NewsPipeline] No new items ready for delivery.");
    return;
  }

  for (const item of newsItems) {
    const sent = await bot.sendToGroup(item.text);

    if (sent && item.postedKey) {
      addPosted(item.postedKey);
      console.log(`[NewsPipeline] Sent item: ${item.postedKey}`);
    }
  }
}

function startRssEngine(bot) {
  console.log("[NewsPipeline] Scheduler active: runs every 1 minute");

  cron.schedule("* * * * *", () => {
    scanFeeds(bot).catch((error) => {
      console.error(`[NewsPipeline] Scan error: ${error.message}`);
    });
  });

  scanFeeds(bot).catch((error) => {
    console.error(`[NewsPipeline] Initial scan error: ${error.message}`);
  });
}

module.exports = {
  startRssEngine,
  scanFeeds
};
