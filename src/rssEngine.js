const Parser = require("rss-parser");
const cron = require("node-cron");

const { hasPosted, addPosted, getFeeds } = require("./storage");
const { stripHtmlTags, summarizeText, translateToArabic } = require("./translator");

const parser = new Parser({
  timeout: 15000
});

function formatMessage(title, summary) {
  return `🕊 نور الولاية NEWS
━━━━━━━━━━━━

${title}

${summary}`;
}

/* Detect Arabic text so we don't translate it again */
function isArabic(text) {
  return /[\u0600-\u06FF]/.test(text);
}

/* Remove Telegram placeholder items like [Video] [Photo] */
function isPlaceholder(title) {

  if (!title) return false;

  const t = title.toLowerCase().trim();

  return (
    t === "[video]" ||
    t === "[photo]" ||
    t === "[gif]" ||
    t === "[document]"
  );
}

function extractMedia(item) {

  if (item.enclosure?.url) return item.enclosure.url;

  if (item["media:content"]?.url) return item["media:content"].url;

  if (item["media:thumbnail"]?.url) return item["media:thumbnail"].url;

  if (item.image?.url) return item.image.url;

  return null;
}

function isInvalidPost(article) {

  if (!article.title && !article.description) return true;

  const text = `${article.title} ${article.description}`.trim();

  if (text.length < 10) return true;

  if (text.startsWith("http")) return true;

  return false;
}

async function processArticle(bot, article, mediaUrl) {

  if (!article.link) return;

  if (hasPosted(article.link)) {
    console.log(`Duplicate skipped: ${article.link}`);
    return;
  }

  if (isPlaceholder(article.title)) {
    console.log("[RSS] Ignored Telegram placeholder");
    return;
  }

  if (isInvalidPost(article)) {
    console.log("[RSS] Ignored invalid / short post");
    return;
  }

  console.log(`New article found: ${article.title}`);

  const cleanTitle = stripHtmlTags(article.title || "خبر عاجل");

  const cleanSummary = stripHtmlTags(
    article.description || article.contentSnippet || ""
  );

  let arabicTitle = cleanTitle;
  let arabicSummary = cleanSummary;

  /* Only translate if the text is NOT Arabic */
  if (!isArabic(cleanTitle)) {
    arabicTitle = await translateToArabic(cleanTitle);
  }

  if (!isArabic(cleanSummary)) {
    arabicSummary = await translateToArabic(
      summarizeText(cleanSummary, 3)
    );
  }

  const message = formatMessage(
    arabicTitle || cleanTitle,
    arabicSummary || ""
  );

  let sent = false;

  if (mediaUrl) {
    sent = await bot.sendMediaToGroup(mediaUrl, message);
  } else {
    sent = await bot.sendToGroup(message);
  }

  if (sent) {
    addPosted(article.link);
    console.log("Article sent to group");
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

        const mediaUrl = extractMedia(item);

        const article = {
          title: item.title || "",
          description:
            item.contentSnippet ||
            item.summary ||
            item.content ||
            item.description ||
            "",
          link: item.link || item.guid || "",
          contentSnippet: item.contentSnippet || ""
        };

        await processArticle(bot, article, mediaUrl);

      }

    } catch (error) {

      console.error(`[RSS] Failed to parse feed ${feedUrl}: ${error.message}`);

    }
  }
}

function startRssEngine(bot) {

  console.log("[RSS] Scheduler active: runs every 1 minute");

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
  scanFeeds
};
