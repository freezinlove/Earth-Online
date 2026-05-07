import { Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";
import {
  buildGlobalDomain,
  buildGlobalTicks,
  buildPlaceSegments,
  buildTripDomain,
  buildTripTicks,
  buildTripSegments,
  formatCompactDateRange,
  percentInDomain,
  segmentBounds,
  type TimelineLevel,
  type TimeIncisionSegment,
  type TimeIncisionTick,
} from "@/features/timeline/timelineModel";

function TimeSegment({
  segment,
  left,
  width,
  onClick,
}: {
  segment: TimeIncisionSegment;
  left: number;
  width: number;
  onClick: () => void;
}) {
  return (
    <button
      className="time-incision-segment"
      data-active={segment.active || undefined}
      data-kind={segment.kind}
      style={{ left: `${left}%`, width: `${width}%` }}
      type="button"
      aria-label={`${segment.label} ${formatCompactDateRange(segment.start, segment.end)}`}
      title={formatCompactDateRange(segment.start, segment.end)}
      onClick={onClick}
    />
  );
}

function TimeTick({ tick, left }: { tick: TimeIncisionTick; left: number }) {
  return (
    <span className="time-incision-tick" data-kind={tick.kind} style={{ left: `${left}%` }} aria-hidden="true">
      {tick.label ? <span>{tick.label}</span> : null}
    </span>
  );
}

export function TimelineDock() {
  const [level, setLevel] = useState<TimelineLevel>("global");
  const [primedTripId, setPrimedTripId] = useState<string>();
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPlaceId = useAppStore((state) => state.selectedPlaceId);
  const segments = useAppStore((state) => state.timelineSegments);
  const trips = useAppStore((state) => state.trips);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const clearPlaceSelection = useAppStore((state) => state.clearPlaceSelection);
  const setGlobeViewIntent = useAppStore((state) => state.setGlobeViewIntent);

  const selectedTrip = trips.find((trip) => trip.id === selectedTripId);
  const tripPlaces = useMemo(() => placeNodes.filter((place) => place.tripId === selectedTripId), [placeNodes, selectedTripId]);
  const domain = useMemo(() => (level === "global" ? buildGlobalDomain(trips) : buildTripDomain(selectedTrip)), [level, selectedTrip, trips]);
  const visibleSegments = useMemo(
    () => (level === "global" ? buildTripSegments(segments, selectedTripId) : buildPlaceSegments(tripPlaces, selectedPlaceId)),
    [level, segments, selectedPlaceId, selectedTripId, tripPlaces],
  );
  const ticks = useMemo(() => (level === "global" ? buildGlobalTicks(domain) : buildTripTicks(domain)), [domain, level]);

  const focusTrip = (tripId: string) => {
    const places = placeNodes.filter((place) => place.tripId === tripId).sort((a, b) => a.timeRange.start.localeCompare(b.timeRange.start));
    const focusPoint = places.length
      ? {
          lat: places.reduce((sum, place) => sum + place.center.lat, 0) / places.length,
          lng: places.reduce((sum, place) => sum + place.center.lng, 0) / places.length,
        }
      : undefined;

    if (level === "global" && primedTripId === tripId) {
      setLevel("trip");
      setPrimedTripId(undefined);
      const entryPlace = places[0];
      if (entryPlace) setGlobeViewIntent({ source: "timeline-trip-entry", point: entryPlace.center, distance: "mid" });
      return;
    }

    selectTrip(tripId);
    setPrimedTripId(tripId);
    if (focusPoint) setGlobeViewIntent({ source: "timeline-trip", point: focusPoint, distance: "far" });
  };

  const focusPlace = (placeId: string) => {
    const place = placeNodes.find((item) => item.id === placeId);
    if (!place) return;
    selectPlace(place.id);
    setPrimedTripId(undefined);
    setGlobeViewIntent({ source: "timeline-place", point: place.center, distance: "near" });
  };

  const backToGlobal = () => {
    clearPlaceSelection();
    setLevel("global");
    setPrimedTripId(undefined);
    setGlobeViewIntent({ source: "timeline-global" });
  };

  return (
    <section className="time-incision-shell" aria-label="旅行时间刻痕">
      <div className="time-incision-rail" aria-hidden="true" />
      <div className="time-incision-ticks">
        {ticks.map((tick) => (
          <TimeTick key={tick.id} tick={tick} left={percentInDomain(tick.value, domain)} />
        ))}
      </div>
      <div className="time-incision-track">
        {visibleSegments.map((segment) => {
          const bounds = segmentBounds(segment, domain);
          return (
            <TimeSegment
              key={segment.id}
              segment={segment}
              left={bounds.left}
              width={bounds.width}
              onClick={() => (segment.kind === "trip" ? focusTrip(segment.relatedId) : focusPlace(segment.relatedId))}
            />
          );
        })}
      </div>
      {level === "trip" ? (
        <button className="time-incision-back" type="button" aria-label="返回全局时间刻痕" title="返回" onClick={backToGlobal}>
          <Undo2 size={16} strokeWidth={1.7} />
        </button>
      ) : null}
    </section>
  );
}
