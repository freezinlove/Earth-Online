import { projectState } from "../domain/state-projector.mjs";
import { cosine } from "../domain/vectors.mjs";

const weights = {
  title: 1,
  geo: 0.9,
  vector: 0.85,
  tags: 0.75,
  caption: 0.65,
};

function normalizeText(value) {
  return String(value ?? "").toLowerCase();
}

function textMatchScore(value, terms) {
  if (!terms.length) return 1;
  const text = normalizeText(value);
  if (!text) return 0;
  return terms.filter((term) => text.includes(term)).length / terms.length;
}

function weightedMatchScore(matches) {
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

function reasonFor(matches, document) {
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

export function createSearchService({ readState, readVectorIndex, embedSearchQuery, rootDir, secretProvider }) {
  async function search(params) {
    const q = params.get("q") ?? "";
    const state = await readState();
    const projection = projectState(state);
    const vectorIndex = await readVectorIndex();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const queryVector = await embedSearchQuery(q, { rootDir, allowCloud: true, secretProvider });
    const tripId = params.get("tripId") || undefined;
    const placeId = params.get("placeId") || undefined;
    const date = params.get("date") || undefined;
    const tag = params.get("tag")?.toLowerCase() || undefined;
    const results = projection.searchDocuments
      .filter((document) => !tripId || document.tripId === tripId)
      .filter((document) => !placeId || document.placeNodeId === placeId)
      .filter((document) => !date || document.capturedAt?.slice(0, 10) === date)
      .filter((document) => !tag || document.tags?.some((item) => normalizeText(item).includes(tag)))
      .map((document) => {
        const vectorScore = vectorIndex[document.photoId] ? (cosine(queryVector, vectorIndex[document.photoId]) + 1) / 2 : 0;
        const matches = {
          title: textMatchScore(document.titleText, terms),
          geo: textMatchScore([...(document.geoKeywords ?? []), ...(document.locationNames ?? [])].join(" "), terms),
          vector: vectorScore,
          tags: textMatchScore(document.tagText ?? document.tags?.join(" "), terms),
          caption: textMatchScore(document.captionText, terms),
        };
        const score = terms.length ? weightedMatchScore(matches) : 1;
        return {
          id: `result-${document.photoId}`,
          photoId: document.photoId,
          tripId: document.tripId,
          reason: reasonFor(matches, document),
          score,
        };
      })
      .filter((item) => item.score > 0.25 || !q.trim())
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
    return { results };
  }

  return { search };
}
