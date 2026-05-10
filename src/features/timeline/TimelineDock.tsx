import { Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { placeFocusIntent } from "@/domain/globeIntent";
import { useI18n } from "@/i18n/useI18n";
import { useAppStore } from "@/store/appStore";
import {
  buildGlobalDomain,
  buildGlobalTicks,
  buildProjectedPlaceSegments,
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
  const [isPopping, setIsPopping] = useState(false);
  const popTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(popTimer.current), []);

  const handleClick = () => {
    window.clearTimeout(popTimer.current);
    setIsPopping(false);
    window.requestAnimationFrame(() => {
      setIsPopping(true);
      popTimer.current = window.setTimeout(() => setIsPopping(false), 320);
    });

    onClick();
  };

  return (
    <button
      className={`time-incision-segment${isPopping ? " time-incision-segment-pop" : ""}`}
      data-active={segment.active || undefined}
      data-kind={segment.kind}
      style={{ left: `${left}%`, width: `${width}%` }}
      type="button"
      aria-label={segment.shortLabel ? `${segment.shortLabel} ${formatCompactDateRange(segment.start, segment.end)}` : formatCompactDateRange(segment.start, segment.end)}
      title={formatCompactDateRange(segment.start, segment.end)}
      onClick={handleClick}
    >
      {segment.shortLabel ? <span>{segment.shortLabel}</span> : null}
    </button>
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
  const { t } = useI18n();
  const activePanel = useAppStore((state) => state.activePanel);
  const [level, setLevel] = useState<TimelineLevel>("global");
  const [primedTripId, setPrimedTripId] = useState<string>();
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPlaceId = useAppStore((state) => state.selectedPlaceId);
  const locale = useAppStore((state) => state.locale);
  const segments = useAppStore((state) => state.timelineSegments);
  const trips = useAppStore((state) => state.trips);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const focusPlaceOnGlobe = useAppStore((state) => state.focusPlaceOnGlobe);
  const clearPlaceSelection = useAppStore((state) => state.clearPlaceSelection);
  const setGlobeViewIntent = useAppStore((state) => state.setGlobeViewIntent);
  const homeState = activePanel === "globe" ? "active" : "covered";

  const selectedTrip = trips.find((trip) => trip.id === selectedTripId);
  const domain = useMemo(() => (level === "global" ? buildGlobalDomain(trips) : buildTripDomain(selectedTrip)), [level, selectedTrip, trips]);
  const visibleSegments = useMemo(
    () =>
      level === "global"
        ? buildTripSegments(segments, selectedTripId, locale)
        : buildProjectedPlaceSegments(
            segments.filter((segment) => placeNodes.some((place) => place.tripId === selectedTripId && place.id === segment.relatedId)),
            selectedPlaceId,
            locale,
          ),
    [level, segments, selectedPlaceId, selectedTripId, placeNodes, locale],
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
    setPrimedTripId(undefined);
    focusPlaceOnGlobe(place.id, placeFocusIntent(place));
  };

  const backToGlobal = () => {
    clearPlaceSelection();
    setLevel("global");
    setPrimedTripId(undefined);
    setGlobeViewIntent({ source: "timeline-global" });
  };

  return (
    <section className="time-incision-shell" data-home-state={homeState} aria-label={t("timeline")}>
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
        <button className="time-incision-back" type="button" aria-label={t("backToGlobalTimeline")} title={t("back")} onClick={backToGlobal}>
          <Undo2 size={16} strokeWidth={1.7} />
        </button>
      ) : null}
    </section>
  );
}
