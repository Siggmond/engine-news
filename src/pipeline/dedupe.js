function normalizeValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(items = []) {
  const seen = new Set();

  return items.filter((item) => {
    const normalizedUrl = normalizeValue(item?.url);
    const normalizedTitle = normalizeValue(item?.title);
    const dedupeKeys = [
      normalizedUrl ? `url:${normalizedUrl}` : "",
      normalizedTitle ? `title:${normalizedTitle}` : ""
    ].filter(Boolean);

    if (dedupeKeys.length === 0) {
      return false;
    }

    const isDuplicate = dedupeKeys.some((key) => seen.has(key));

    if (isDuplicate) {
      return false;
    }

    dedupeKeys.forEach((key) => seen.add(key));
    return true;
  });
}

module.exports = {
  dedupe
};
