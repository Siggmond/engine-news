const axios = require("axios");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_SUMMARY_MODEL = process.env.GROQ_SUMMARY_MODEL || "llama3-70b-8192";

function stripHtmlTags(text) {
  return String(text || "").replace(/<[^>]*>?/gm, " ");
}

function fallbackSummary(text) {
  const normalizedText = stripHtmlTags(text).replace(/\s+/g, " ").trim();

  if (!normalizedText) {
    return "";
  }

  const sentences = normalizedText
    .split(/(?<=[.!?؟])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.slice(0, 2).join(" ");
}

async function summarize(text) {
  const normalizedText = stripHtmlTags(text).replace(/\s+/g, " ").trim();

  if (!normalizedText) {
    return "";
  }

  if (!GROQ_API_KEY) {
    return fallbackSummary(normalizedText);
  }

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: GROQ_SUMMARY_MODEL,
        messages: [
          {
            role: "system",
            content: "لخّص الخبر في جملتين قصيرتين باللغة العربية فقط."
          },
          {
            role: "user",
            content: normalizedText.slice(0, 5000)
          }
        ],
        temperature: 0.2,
        max_tokens: 180
      },
      {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return String(response.data?.choices?.[0]?.message?.content || "").trim()
      || fallbackSummary(normalizedText);
  } catch (error) {
    console.error(`[Summarize] Groq request failed: ${error.message}`);
    return fallbackSummary(normalizedText);
  }
}

module.exports = {
  summarize
};
