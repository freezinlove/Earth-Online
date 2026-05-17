export const searchWeights = {
  title: 1,
  geo: 0.9,
  vector: 0.85,
  tags: 0.75,
  caption: 0.65,
};

export function normalizeSearchText(value) {
  return String(value ?? "").toLowerCase();
}

export function searchTerms(query) {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

export function textMatchScore(value, terms) {
  if (!terms.length) return 1;
  const text = normalizeSearchText(value);
  if (!text) return 0;
  return terms.filter((term) => text.includes(term)).length / terms.length;
}

export function weightedMatchScore(matches, weights = searchWeights) {
  const weightedScores = [
    matches.title * weights.title,
    matches.geo * weights.geo,
    matches.vector * weights.vector,
    matches.tags * weights.tags,
    matches.caption * weights.caption,
  ];
  const best = Math.max(...weightedScores);
  const support = weightedScores
    .filter((score) => score > 0 && score < best)
    .reduce((sum, score) => sum + score * 0.08, 0);
  return Math.min(1, best + support);
}

export function searchReasonFor(matches, document, weights = searchWeights) {
  const entries = [
    { key: "title", label: "照片标题", score: matches.title * weights.title },
    {
      key: "geo",
      label: (document.geoKeywords ?? document.locationNames ?? []).slice(0, 3).join(" / ") || "国家/地点",
      score: matches.geo * weights.geo,
    },
    { key: "vector", label: "向量相似记忆", score: matches.vector * weights.vector },
    { key: "tags", label: (document.tags ?? []).slice(0, 3).join(" / ") || "标签", score: matches.tags * weights.tags },
    { key: "caption", label: "图片理解文字", score: matches.caption * weights.caption },
  ].sort((left, right) => right.score - left.score);
  const best = entries.find((entry) => entry.score > 0);
  return best ? `命中 ${best.label}。` : "搜索结果。";
}

export function documentPassesSearchFilters(document, filters = {}, photo) {
  if (filters.tripId && document.tripId !== filters.tripId) return false;
  if (filters.placeId && document.placeNodeId !== filters.placeId) return false;
  if (filters.date && document.capturedAt?.slice(0, 10) !== filters.date) return false;
  if (filters.tag && !document.tags?.some((item) => normalizeSearchText(item).includes(normalizeSearchText(filters.tag)))) return false;
  if (filters.fileName && !normalizeSearchText(photo?.fileName).includes(normalizeSearchText(filters.fileName))) return false;
  return true;
}

export function scoreSearchDocument(document, terms, { vectorScore = 0 } = {}) {
  const matches = {
    title: textMatchScore(document.titleText, terms),
    geo: textMatchScore([...(document.geoKeywords ?? []), ...(document.locationNames ?? [])].join(" "), terms),
    vector: vectorScore,
    tags: textMatchScore(document.tagText ?? document.tags?.join(" "), terms),
    caption: textMatchScore(document.captionText, terms),
  };
  const score = terms.length ? weightedMatchScore(matches) : 1;
  return { matches, score };
}

export function buildSearchResults({
  documents = [],
  photos = [],
  query = "",
  filters = {},
  vectorScoreForDocument,
  limit = 24,
} = {}) {
  const terms = searchTerms(query);
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  const trimmedQuery = String(query ?? "").trim();
  const results = documents
    .filter((document) => documentPassesSearchFilters(document, filters, photosById.get(document.photoId)))
    .map((document) => {
      const photo = photosById.get(document.photoId);
      const vectorScore = vectorScoreForDocument?.(document, photo) ?? 0;
      const { matches, score } = scoreSearchDocument(document, terms, { vectorScore });
      return {
        id: `result-${document.photoId}`,
        photoId: document.photoId,
        tripId: document.tripId,
        reason: searchReasonFor(matches, document),
        score,
      };
    })
    .filter((item) => item.score > 0.25 || !trimmedQuery)
    .sort((left, right) => right.score - left.score);
  return limit ? results.slice(0, limit) : results;
}
