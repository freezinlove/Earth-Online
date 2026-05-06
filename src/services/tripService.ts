import { buildTimelineSegments, photos, placeNodes, routes, trips } from "@/data/sampleTravelData";
import type { ID } from "@/domain/models";

export const TripService = {
  listTrips() {
    return trips;
  },
  getTrip(tripId: ID) {
    return trips.find((trip) => trip.id === tripId) ?? trips[0];
  },
  getTripPhotos(tripId: ID) {
    return photos.filter((photo) => photo.tripId === tripId);
  },
  getTripPlaces(tripId: ID) {
    return placeNodes.filter((place) => place.tripId === tripId);
  },
  getTripRoute(tripId: ID) {
    return routes.find((route) => route.tripId === tripId);
  },
  getTimelineSegments() {
    return buildTimelineSegments(trips);
  },
};
