const axios = require("axios");

const GROQ_API_KEY = process.env.GROQ_API_KEY;

function stripHtmlTags(text) {
  if (!text) return "";
  return text.replace(/<[^>]*>?/gm, "");
}

function summarizeText(text, maxSentences = 3) {
  if (!text) return "";

  const cleaned = stripHtmlTags(text);
  const sentences = cleaned.split(/[.!?]/).filter(Boolean);

  return sentences.slice(0, maxSentences).join(". ") + ".";
}

async function translateToArabic(text) {
  try {

    if (!text || text.trim() === "") return "";

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content:
              "You are a translator. Only translate the text to Arabic. Do not explain anything. Do not add extra sentences. Return only the translated text."
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.2,
        max_tokens: 200
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const translated =
      response.data.choices[0].message.content.trim();

    console.log("[Translator] Translated with Groq");

    return translated;

  } catch (error) {

    if (error.response) {
      console.log("[Translator] Groq error:", error.response.data);
    } else {
      console.log("[Translator] AI translation failed:", error.message);
    }

    return text;
  }
}

module.exports = {
  stripHtmlTags,
  summarizeText,
  translateToArabic
};