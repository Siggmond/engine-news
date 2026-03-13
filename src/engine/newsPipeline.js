const { fetchNews } = require("../sources/newsApi");
const { fetchTelegramNews } = require("../sources/telegram");
const { dedupe } = require("../pipeline/dedupe");
const { summarize } = require("../pipeline/summarize");
const { isLebanonAirstrike } = require("../filter");
const { hasPosted } = require("../storage");

const MAX_NEWS_ITEMS = Number(process.env.NEWS_PIPELINE_LIMIT || 5);

function toIsoTimestamp(value) {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return 0;
  }

  return timestamp;
}

function getPostedKey(item = {}) {
  return String(item.id || item.url || item.title || "").trim();
}

function formatSourceLine(item = {}) {
  const sourceName = String(item.source?.title || "").trim();

  if (item.url) {
    return sourceName
      ? `${sourceName}\n${item.url}`
      : item.url;
  }

  return sourceName;
}

function formatMessage(item, summary) {
  const sourceLine = formatSourceLine(item);
  const messageParts = ["🚨 خبر عاجل", "", summary || item.title];

  if (sourceLine) {
    messageParts.push("", "المصدر:", sourceLine);
  }

  return messageParts.join("\n");
}

async function collectSourceItems() {
  const sourceResults = await Promise.allSettled([fetchNews(), fetchTelegramNews()]);
  const items = [];

  sourceResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);
      return;
    }

    const sourceName = index === 0 ? "NewsAPI" : "Telegram";
    console.error(`[NewsPipeline] ${sourceName} source failed: ${result.reason?.message || result.reason}`);
  });

  return items;
}

async function getProcessedNews() {
  const allNews = await collectSourceItems();

  const filtered = allNews.filter((item) => isLebanonAirstrike(item));
  const unique = dedupe(filtered)
    .filter((item) => !hasPosted(getPostedKey(item)))
    .sort((left, right) => toIsoTimestamp(right.publishedAt) - toIsoTimestamp(left.publishedAt));

  const results = [];

  for (const item of unique.slice(0, MAX_NEWS_ITEMS)) {
    const summaryInput = [item.title, item.description].filter(Boolean).join("\n\n");
    const summary = await summarize(summaryInput);

    results.push({
      postedKey: getPostedKey(item),
      text: formatMessage(item, summary)
    });
  }

  return results;
}

module.exports = {
  getProcessedNews
};
