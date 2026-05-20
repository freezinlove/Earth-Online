import { Check, ChevronDown, LoaderCircle, MapPin, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { photoAltText, placeLabel } from "@/domain/labels";
import { useI18n } from "@/i18n/useI18n";
import type { Photo, PlaceNode } from "@/domain/models";

export type ManualPlaceMode = "bind" | "new" | "archive";

export type ManualPlaceResolutionAction =
  | { action: "bind_existing_place"; placeId: string }
  | { action: "create_manual_place"; name: string; lat: number; lng: number }
  | { action: "archive_unlocated" };

type ManualPlaceResolutionPanelProps = {
  sessionId: string;
  photos: Photo[];
  places: PlaceNode[];
  busy: boolean;
  title?: string;
  bindLabel?: string;
  createLabel?: string;
  includeArchive?: boolean;
  initialName?: string;
  initialMode?: ManualPlaceMode;
  pickedPoint?: { lat: number; lng: number; nearestLabel?: string };
  panelClassName?: string;
  showCloseButton?: boolean;
  onClose: () => void;
  onPickPoint: (sessionId: string, name: string, nameDirty: boolean) => void;
  onSubmit: (body: ManualPlaceResolutionAction) => void;
};

export function ManualPlaceResolutionPanel({
  sessionId,
  photos,
  places,
  busy,
  title,
  bindLabel,
  createLabel,
  includeArchive = true,
  initialName,
  initialMode,
  pickedPoint,
  panelClassName = "manual-pending-copy",
  showCloseButton = true,
  onClose,
  onPickPoint,
  onSubmit,
}: ManualPlaceResolutionPanelProps) {
  const { locale, t } = useI18n();
  const primaryPhoto = photos[0];
  const tripId = primaryPhoto?.tripId;
  const tripPlaces = useMemo(() => places.filter((place) => place.tripId === tripId), [places, tripId]);
  const fallbackMode = tripPlaces.length ? "bind" : "new";
  const [mode, setMode] = useState<ManualPlaceMode>(fallbackMode);
  const [placeId, setPlaceId] = useState(tripPlaces[0]?.id ?? "");
  const [name, setName] = useState(initialName ?? primaryPhoto?.title ?? primaryPhoto?.fileName ?? "");
  const [nameDirty, setNameDirty] = useState(false);
  const [placeMenuOpen, setPlaceMenuOpen] = useState(false);
  const selectedPlace = tripPlaces.find((place) => place.id === placeId);

  useEffect(() => {
    const nextMode = includeArchive ? (initialMode ?? fallbackMode) : initialMode === "new" ? "new" : fallbackMode;
    setPlaceId(tripPlaces[0]?.id ?? "");
    setName(initialName ?? primaryPhoto?.title ?? primaryPhoto?.fileName ?? "");
    setNameDirty(false);
    setMode(nextMode);
    setPlaceMenuOpen(false);
  }, [fallbackMode, includeArchive, initialMode, initialName, primaryPhoto?.fileName, primaryPhoto?.title, tripPlaces]);

  const submit = () => {
    if (mode === "bind") {
      if (placeId) onSubmit({ action: "bind_existing_place", placeId });
      return;
    }
    if (mode === "new") {
      if (!pickedPoint) return;
      onSubmit({ action: "create_manual_place", name, lat: pickedPoint.lat, lng: pickedPoint.lng });
      return;
    }
    if (includeArchive) onSubmit({ action: "archive_unlocated" });
  };

  return (
    <div className={panelClassName}>
      <div className="manual-pending-heading">
        <h3>{title ?? t("manualResolve")}</h3>
        {showCloseButton ? (
          <button className="manual-pending-close" onClick={onClose} type="button" aria-label={t("closePreview")}>
            <X size={18} />
          </button>
        ) : null}
      </div>

      <div className="manual-pending-tabs">
        <button
          type="button"
          data-active={mode === "bind" || undefined}
          onClick={() => {
            setMode("bind");
            setPlaceMenuOpen(false);
          }}
          disabled={!tripPlaces.length}
        >
          {bindLabel ?? t("manualMergeExisting")}
        </button>
        <button
          type="button"
          data-active={mode === "new" || undefined}
          onClick={() => {
            setMode("new");
            setPlaceMenuOpen(false);
          }}
        >
          {createLabel ?? t("manualCreatePlace")}
        </button>
        {includeArchive ? (
          <button
            type="button"
            data-active={mode === "archive" || undefined}
            onClick={() => {
              setMode("archive");
              setPlaceMenuOpen(false);
            }}
          >
            {t("manualArchiveOnly")}
          </button>
        ) : null}
      </div>

      {mode === "bind" ? (
        <div className="manual-pending-field">
          <span>{t("places")}</span>
          <div className="manual-place-menu" data-open={placeMenuOpen ? "true" : "false"}>
            <button
              aria-expanded={placeMenuOpen}
              aria-label={t("places")}
              className="manual-place-menu-trigger"
              disabled={!tripPlaces.length}
              onClick={() => setPlaceMenuOpen((open) => !open)}
              type="button"
            >
              <span>{selectedPlace ? placeLabel(selectedPlace, locale) : t("places")}</span>
              <ChevronDown size={16} />
            </button>
            {placeMenuOpen ? (
              <div className="manual-place-menu-popover" role="listbox">
                {tripPlaces.map((place) => (
                  <button
                    aria-selected={place.id === placeId}
                    className={place.id === placeId ? "is-selected" : ""}
                    key={place.id}
                    onClick={() => {
                      setPlaceId(place.id);
                      setPlaceMenuOpen(false);
                    }}
                    role="option"
                    type="button"
                  >
                    <span>{placeLabel(place, locale)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {mode === "new" ? (
        <div className="manual-pending-grid manual-pending-grid-pick">
          <label className="manual-pending-field">
            <span>{t("placeName")}</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameDirty(true);
              }}
            />
          </label>
          <div className="manual-pending-field">
            <span>{t("mapPoint")}</span>
            <button className="manual-pending-pick-button" type="button" onClick={() => onPickPoint(sessionId, name, nameDirty)}>
              <MapPin size={15} />
              {pickedPoint ? t("reselectOnGlobe") : t("pickOnGlobe")}
            </button>
          </div>
          <div className="manual-pending-picked">
            <span>{pickedPoint ? t("nearestPlace") : t("noMapPointPicked")}</span>
            <strong>{pickedPoint ? pickedPoint.nearestLabel ?? t("noGeodataPlaceFound") : t("noMapPointPicked")}</strong>
          </div>
        </div>
      ) : null}

      {mode === "archive" ? <p className="manual-pending-note">{t("manualArchiveOnlyNote")}</p> : null}

      <div className="manual-pending-actions">
        <button type="button" onClick={onClose}>
          {t("cancel")}
        </button>
        <button type="button" onClick={submit} disabled={busy || (mode === "bind" && !placeId) || (mode === "new" && !pickedPoint)}>
          {busy ? <LoaderCircle className="animate-spin" size={15} /> : <Check size={15} />}
          {t("save")}
        </button>
      </div>
    </div>
  );
}

export function ManualPlaceResolutionModal(props: ManualPlaceResolutionPanelProps) {
  const primaryPhoto = props.photos[0];

  return (
    <div className="manual-pending-modal" role="dialog" aria-modal="true" onMouseDown={props.onClose}>
      <section className="manual-pending-shell" onMouseDown={(event) => event.stopPropagation()}>
        <div className="manual-pending-media">
          {primaryPhoto ? <img src={primaryPhoto.storageUrl ?? primaryPhoto.thumbnailUrl} alt={photoAltText(primaryPhoto)} /> : null}
        </div>
        <ManualPlaceResolutionPanel {...props} />
      </section>
    </div>
  );
}
