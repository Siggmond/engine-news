const Parser = require("rss-parser");
const cron = require("node-cron");
const { hasPosted, addPosted, getFeeds } = require("./storage");
const { isLebanonAirstrike } = require("./filter");
const {
  stripHtmlTags,
  summarizeText,
  translateToArabic,
} = require("./translator");

const parser = new Parser({
  timeout: 15000,
});

function extractSourceName(feed, item, feedUrl) {
  if (typeof item.source === "string" && item.source.trim()) {
    return item.source.trim();
  }

  if (item.source && typeof item.source.title === "string") {
    return item.source.title.trim();
  }

  if (feed && feed.title) {
    return feed.title;
  }

  try {
    return new URL(feedUrl).hostname;
  } catch {
    return "Unknown source";
  }
}

function formatMessage(title, summary, source) {
  return `🕊 نور الولاية NEWS
━━━━━━━━━━━━

${title}

${summary}

🔗 المصدر: ${source}`;
}

async function processArticle(bot, article) {

  if (!article.link) return;

  if (hasPosted(article.link)) {
    console.log(`Duplicate skipped: ${article.link}`);
    return;
  }

  console.log(`New article found: ${article.title || article.link}`);

  const cleanTitle = stripHtmlTags(article.title || "خبر عاجل");

  const cleanSummary = summarizeText(
    article.description || article.contentSnippet || "",
    3
  );

  const arabicTitle = await translateToArabic(cleanTitle);
  const arabicSummary = await translateToArabic(cleanSummary);

  const translatedArticle = {
    title: arabicTitle,
    description: arabicSummary,
    source: article.source,
  };

  if (!isLebanonAirstrike(translatedArticle)) return;

  const source = stripHtmlTags(article.source || "Unknown source");

  const message = formatMessage(
    arabicTitle || cleanTitle,
    arabicSummary || cleanSummary || "لا يوجد ملخص متاح.",
    source
  );

  const sent = await bot.sendToGroup(message);

  if (sent) {
    addPosted(article.link);
    console.log(`Article sent to group: ${article.link}`);
  }
}

async function scanFeeds(bot) {
  const feeds = getFeeds();

  if (feeds.length === 0) {
    console.log("[RSS] No feeds configured.");
    return;
  }

  for (const feedUrl of feeds) {
    try {

      const feed = await parser.parseURL(feedUrl);
      const items = Array.isArray(feed.items) ? feed.items : [];

      for (const item of items) {

        const article = {
          title: item.title || "",
          description:
            item.contentSnippet ||
            item.summary ||
            item.content ||
            item.description ||
            "",
          link: item.link || item.guid || "",
          source: extractSourceName(feed, item, feedUrl),
          contentSnippet: item.contentSnippet || "",
        };

        await processArticle(bot, article);

      }

    } catch (error) {

      console.error(`[RSS] Failed to parse feed ${feedUrl}: ${error.message}`);

    }
  }
}

function startRssEngine(bot) {

  console.log("[RSS] Scheduler active: runs every 1 minutes");

  cron.schedule("* * * * *", () => {

    scanFeeds(bot).catch((error) => {
      console.error(`[RSS] Scan error: ${error.message}`);
    });

  });

  scanFeeds(bot).catch((error) => {
    console.error(`[RSS] Initial scan error: ${error.message}`);
  });
}

module.exports = {
  startRssEngine,
  scanFeeds,
};