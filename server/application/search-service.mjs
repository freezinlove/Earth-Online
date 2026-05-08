import { projectState } from "../domain/state-projector.mjs";
import { cosine } from "../domain/vectors.mjs";

export function createSearchService({ readState, readVectorIndex, embedSearchQuery, rootDir }) {
  async function search(params) {
    const q = params.get("q") ?? "";
    const state = await readState();
    const projection = projectState(state);
    const vectorIndex = await readVectorIndex();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const queryVector = await embedSearchQuery(q, { rootDir, allowCloud: true });
    const tripId = params.get("tripId") || undefined;
    const placeId = params.get("placeId") || undefined;
    const date = params.get("date") || undefined;
    const tag = params.get("tag")?.toLowerCase() || undefined;
    const fileName = params.get("fileName")?.toLowerCase() || undefined;
    const photoById = new Map(state.photos.map((photo) => [photo.id, photo]));
    const results = projection.searchDocuments
      .filter((document) => !tripId || document.tripId === tripId)
      .filter((document) => !placeId || document.placeNodeId === placeId)
      .filter((document) => !date || document.capturedAt?.slice(0, 10) === date)
      .filter((document) => !tag || document.tags?.some((item) => item.toLowerCase().includes(tag)))
      .filter((document) => !fileName || photoById.get(document.photoId)?.fileName.toLowerCase().includes(fileName))
      .map((document) => {
        const photo = photoById.get(document.photoId);
        const text = document.text.toLowerCase();
        const termScore = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 1;
        const vectorScore = vectorIndex[document.photoId] ? (cosine(queryVector, vectorIndex[document.photoId]) + 1) / 2 : 0;
        const score = 0.6 * vectorScore + 0.4 * termScore;
        return {
          id: `result-${document.photoId}`,
          photoId: document.photoId,
          tripId: document.tripId,
          reason:
            termScore > 0
              ? `命中 ${(document.locationNames.length ? document.locationNames : photo?.tags ?? []).slice(0, 3).join(" / ")}，可跳转到地球和时间轴。`
              : `Qwen 向量索引返回相近旅行记忆。`,
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
