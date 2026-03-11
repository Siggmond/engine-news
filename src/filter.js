const LEBANON_KEYWORDS = [
  "lebanon",
  "beirut",
  "south lebanon",
  "hezbollah",
  "لبنان",
  "بيروت",
  "الجنوب",
  "الضاحية",
  "صور",
  "النبطية",
  "بنت جبيل"
];

const STRIKE_KEYWORDS = [
  "airstrike",
  "air strike",
  "missile",
  "rocket",
  "bombing",
  "strike",
  "raid",
  "غارة",
  "غارات",
  "قصف",
  "صاروخ",
  "استهداف"
];

function isLebanonAirstrike(article = {}) {

  const sourceText =
    typeof article.source === "string"
      ? article.source
      : article.source?.title || "";

  const text = [
    article.title,
    article.description,
    article.contentSnippet,
    sourceText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  /* ------------------------------------------------ */
  /* 1️⃣ Allow ALL posts from BintJbeil Telegram feed */
  /* ------------------------------------------------ */

  if (text.includes("bintjbeil")) {
    console.log("[Filter] BintJbeil news allowed");
    return true;
  }

  /* ------------------------------------------------ */
  /* 2️⃣ Normal airstrike filter for other sources    */
  /* ------------------------------------------------ */

  const hasLebanonKeyword = LEBANON_KEYWORDS.some((keyword) =>
    text.includes(keyword)
  );

  const hasStrikeKeyword = STRIKE_KEYWORDS.some((keyword) =>
    text.includes(keyword)
  );

  if (hasLebanonKeyword && hasStrikeKeyword) {
    console.log("[Filter] Lebanon airstrike detected");
    return true;
  }

  console.log("[Filter] Ignored non-airstrike news");
  return false;
}

module.exports = {
  LEBANON_KEYWORDS,
  STRIKE_KEYWORDS,
  isLebanonAirstrike,
};