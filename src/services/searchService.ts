import { photos, trips } from "@/data/sampleTravelData";

export const SearchService = {
  searchMemories(query: string) {
    const normalized = query.trim().toLowerCase();
    return photos
      .map((photo) => {
        const trip = trips.find((item) => item.id === photo.tripId);
        const text = [photo.fileName, photo.aiCaption, photo.tags.join(" "), trip?.title, trip?.cities.join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return {
          id: `result-${photo.id}`,
          photoId: photo.id,
          tripId: photo.tripId,
          reason: `命中 ${photo.tags.slice(0, 3).join(" / ")}。`,
          score: normalized ? Number(text.includes(normalized)) : 1,
        };
      })
      .filter((result) => result.score > 0 || !normalized);
  },
};
