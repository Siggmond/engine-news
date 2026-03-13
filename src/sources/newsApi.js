const axios = require("axios");

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const NEWS_API_QUERY = process.env.NEWS_API_QUERY || "lebanon";
const NEWS_API_LANGUAGE = process.env.NEWS_API_LANGUAGE || "ar";
const NEWS_API_PAGE_SIZE = Number(process.env.NEWS_API_PAGE_SIZE || 20);

let hasWarnedMissingKey = false;

function normalizeArticle(article = {}) {
  const title = String(article.title || "").trim();
  const url = String(article.url || "").trim();

  if (!title || !url) {
    return null;
  }

  return {
    id: url,
    title,
    url,
    description: String(article.description || article.content || "").trim(),
    publishedAt: article.publishedAt || null,
    source: {
      type: "news_api",
      title: article.source?.name || "News API"
    }
  };
}

async function fetchNews() {
  if (!NEWS_API_KEY) {
    if (!hasWarnedMissingKey) {
      console.warn("[NewsAPI] NEWS_API_KEY is not configured. Skipping News API source.");
      hasWarnedMissingKey = true;
    }

    return [];
  }

  const response = await axios.get("https://newsapi.org/v2/everything", {
    timeout: 15000,
    params: {
      q: NEWS_API_QUERY,
      language: NEWS_API_LANGUAGE,
      sortBy: "publishedAt",
      pageSize: NEWS_API_PAGE_SIZE,
      apiKey: NEWS_API_KEY
    }
  });

  return (response.data?.articles || [])
    .map(normalizeArticle)
    .filter(Boolean);
}

module.exports = {
  fetchNews
};
