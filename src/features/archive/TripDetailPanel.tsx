import { ArrowLeft, CalendarDays, Image, MapPin, PencilLine, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { capturedDateLabel, capturedTimeLabel } from "@/domain/datetime";
import { placeFocusIntent } from "@/domain/globeIntent";
import { countryLabel, photoAltText, photoLabel, placeLabel, tripLabel } from "@/domain/labels";
import { getHighResolutionSource, photoDisplaySource, photoThumbnailSource } from "@/domain/photoSources";
import { useI18n } from "@/i18n/useI18n";
import type { LocalizedNames, Photo, PlaceNode } from "@/domain/models";
import { ManualPlaceResolutionPanel, type ManualPlaceMode, type ManualPlaceResolutionAction } from "@/features/places/ManualPlaceResolutionModal";
import { registerAndroidBackHandler } from "@/platform/androidBack";
import { useAppStore } from "@/store/appStore";

type DayGroup = {
  country: string;
  countryNames?: LocalizedNames;
  day: string;
  photos: Photo[];
  places: PlaceNode[];
};

type CountryGroup = {
  country: string;
  countryNames?: LocalizedNames;
  days: DayGroup[];
};

function formatDay(day: string) {
  return day === "待补时间" ? day : day.replace(/-/g, ".");
}

function placeKey(group?: Pick<DayGroup, "places">) {
  const ids = group?.places.map((place) => place.id).sort() ?? [];
  return ids.length ? ids.join("|") : undefined;
}

export function TripDetailPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { locale, t } = useI18n();
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const trips = useAppStore((state) => state.trips);
  const allPhotos = useAppStore((state) => state.photos);
  const allPlaces = useAppStore((state) => state.placeNodes);
  const dossierGroups = useAppStore((state) => state.dossierGroups);
  const activePanel = useAppStore((state) => state.activePanel);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const updateTripTitle = useAppStore((state) => state.updateTripTitle);
  const updatePhotoUserEdits = useAppStore((state) => state.updatePhotoUserEdits);
  const bindPhotoToPlace = useAppStore((state) => state.bindPhotoToPlace);
  const createPlaceForPhoto = useAppStore((state) => state.createPlaceForPhoto);
  const selectPhoto = useAppStore((state) => state.selectPhoto);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const setGlobeViewIntent = useAppStore((state) => state.setGlobeViewIntent);
  const deletePhoto = useAppStore((state) => state.deletePhoto);
  const manualPlacePick = useAppStore((state) => state.manualPlacePick);
  const openManualPlacePick = useAppStore((state) => state.openManualPlacePick);
  const closeManualPlacePick = useAppStore((state) => state.closeManualPlacePick);
  const startManualPlacePick = useAppStore((state) => state.startManualPlacePick);
  const trip = trips.find((item) => item.id === selectedTripId);
  const [title, setTitle] = useState(tripLabel(trip));
  const [editingPhotoId, setEditingPhotoId] = useState<string>();
  const [openPhotoId, setOpenPhotoId] = useState<string>();
  const [manualPhotoId, setManualPhotoId] = useState<string>();
  const [manualPhotoBusy, setManualPhotoBusy] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => (typeof window === "undefined" ? false : window.matchMedia("(max-width: 767px)").matches));
  const photos = useMemo(
    () => allPhotos.filter((photo) => photo.tripId === selectedTripId).sort((left, right) => (left.capturedAt ?? "").localeCompare(right.capturedAt ?? "")),
    [allPhotos, selectedTripId],
  );
  const places = useMemo(() => allPlaces.filter((place) => place.tripId === selectedTripId), [allPlaces, selectedTripId]);
  const dossier = dossierGroups.find((group) => group.tripId === selectedTripId);
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);
  const manualPhotoIdFromPick = manualPlacePick?.pendingId.startsWith("photo:") ? manualPlacePick.pendingId.slice("photo:".length) : undefined;
  const activeManualPhotoId = manualPhotoId ?? manualPhotoIdFromPick;
  const openPhoto = (openPhotoId ?? activeManualPhotoId) ? photos.find((photo) => photo.id === (openPhotoId ?? activeManualPhotoId)) : undefined;
  const openPhotoPlace = openPhoto?.placeNodeId ? placeById.get(openPhoto.placeNodeId) : undefined;
  const activeManualPhoto = activeManualPhotoId ? photos.find((photo) => photo.id === activeManualPhotoId) : undefined;
  const activeManualSessionId = activeManualPhoto ? `photo:${activeManualPhoto.id}` : undefined;
  const countryGroups = useMemo<CountryGroup[]>(() => {
    return (dossier?.countries ?? []).map((countryGroup) => ({
      country: countryGroup.country,
      countryNames: countryGroup.countryNames,
      days: countryGroup.days.map((day) => ({
        country: day.country,
        countryNames: day.countryNames,
        day: day.day,
        photos: day.photoIds.map((id) => photoById.get(id)).filter((photo): photo is Photo => Boolean(photo)),
        places: day.placeIds.map((id) => placeById.get(id)).filter((place): place is PlaceNode => Boolean(place)),
      })),
    }));
  }, [dossier?.countries, photoById, placeById]);

  useEffect(() => {
    setTitle(tripLabel(trip));
  }, [trip]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const focusPlaceOnGlobe = (place: PlaceNode) => {
    selectPlace(place.id);
    setGlobeViewIntent(placeFocusIntent(place));
  };
  const closePhotoDetail = useCallback(() => {
    setOpenPhotoId(undefined);
    setEditingPhotoId(undefined);
    setManualPhotoId(undefined);
    closeManualPlacePick();
  }, [closeManualPlacePick]);
  const closeManualPhotoMove = useCallback(() => {
    if (activeManualPhotoId) setOpenPhotoId(activeManualPhotoId);
    setManualPhotoId(undefined);
    closeManualPlacePick();
  }, [activeManualPhotoId, closeManualPlacePick]);
  const openManualPhotoMove = (photo: Photo) => {
    const sessionId = `photo:${photo.id}`;
    setOpenPhotoId(photo.id);
    setManualPhotoId(photo.id);
    openManualPlacePick(sessionId, photo.userEdits?.title ?? photo.title ?? photo.fileName, "tripDetail");
  };
  const submitManualPhotoMove = async (body: ManualPlaceResolutionAction) => {
    if (!activeManualPhoto || body.action === "archive_unlocated") return;
    setManualPhotoBusy(true);
    try {
      if (body.action === "bind_existing_place") {
        await bindPhotoToPlace(activeManualPhoto.id, body.placeId, "tripDetail");
      } else {
        await createPlaceForPhoto(activeManualPhoto.id, { name: body.name, lat: body.lat, lng: body.lng }, "tripDetail");
      }
      setManualPhotoId(undefined);
    } finally {
      setManualPhotoBusy(false);
    }
  };

  useEffect(() => {
    return registerAndroidBackHandler(() => {
      if (activePanel !== "tripDetail") return false;
      if (openPhoto) {
        closePhotoDetail();
        return true;
      }

      setActivePanel("archive");
      return true;
    });
  }, [activePanel, closePhotoDetail, openPhoto, setActivePanel]);

  if (!trip) return null;

  const heroPhoto = isMobileViewport ? photoThumbnailSource(photos[0]) || getHighResolutionSource(trip.coverUrl, 960) : photoDisplaySource(photos[0]) || getHighResolutionSource(trip.coverUrl, 1800);

  return (
    <section className="trip-dossier fixed inset-0 z-[70] overflow-y-auto bg-background/94 backdrop-blur-2xl" data-state={isClosing ? "closing" : "open"}>
      <TripDossierBackButton isClosing={isClosing} onBack={() => setActivePanel("archive")} />

      <header className="trip-dossier-hero">
        <img src={heroPhoto} alt={tripLabel(trip)} className="trip-dossier-hero-image" decoding="async" />
        <div className="trip-dossier-hero-copy">
          <label className="mt-4 block max-w-4xl">
            <span className="sr-only">{t("archive")}</span>
            <textarea
              className="trip-dossier-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => updateTripTitle(trip.id, title)}
              rows={2}
            />
          </label>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold text-white/78">
            <span className="inline-flex items-center gap-2"><CalendarDays size={15} /> {trip.dateRange.start} - {trip.dateRange.end}</span>
            <span className="inline-flex items-center gap-2"><Image size={15} /> {photos.length} {t("photoCount")}</span>
            <span className="inline-flex items-center gap-2"><MapPin size={15} /> {places.length} {t("placeCount")}</span>
          </div>
        </div>
      </header>

      <main className="trip-dossier-body mx-auto max-w-[1760px] px-5 pb-20 pt-8 md:px-10">
        <div className="trip-timeline">
          {countryGroups.map((countryGroup, countryIndex) => (
            <section key={`${countryGroup.country}-${countryIndex}`} className="trip-country-section">
              <div className="trip-country-column">
                <span>{countryLabel(countryGroup.countryNames, countryGroup.country, locale)}</span>
              </div>

              <div className="trip-country-days">
                {countryGroup.days.map((group, groupIndex) => {
                  const repeatsPreviousPlace = Boolean(placeKey(group) && placeKey(group) === placeKey(countryGroup.days[groupIndex - 1]));
                  return (
                    <section
                      key={`${group.day}-${group.places.map((place) => place.id).join("-") || group.photos.map((photo) => photo.id).join("-")}`}
                      className={`trip-day-section${repeatsPreviousPlace ? " trip-day-section-continuation" : ""}`}
                      style={{ "--trip-day-delay": `${(countryIndex + groupIndex) * 90}ms` } as CSSProperties}
                    >
                      <div className="trip-route-column">
                        {repeatsPreviousPlace ? (
                          <span className="trip-route-continuation" aria-hidden="true" />
                        ) : (
                          <>
                            <span className="trip-route-dot" />
                            {group.places.length ? (
                              <div className="trip-route-labels">
                                {group.places.map((place) => (
                                  <button className="trip-route-label" key={place.id} onClick={() => focusPlaceOnGlobe(place)} title={placeLabel(place, locale)} type="button">
                                    {placeLabel(place, locale)}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="trip-route-label">{t("unmarkedPlace")}</span>
                            )}
                          </>
                        )}
                      </div>

                      <div className="trip-day-content">
                        <div className="trip-day-marker">
                          <h3>{formatDay(group.day)}</h3>
                          <div className="h-px flex-1 bg-outline-variant/70" />
                        </div>

                        <div className="trip-photo-flow">
                          {group.photos.map((photo, index) => {
                            return (
                              <article key={photo.id} className={index === 0 ? "trip-photo-piece trip-photo-piece-featured" : "trip-photo-piece"}>
                                <div className="trip-photo-frame">
                                  <button className="trip-photo-open" onClick={() => setOpenPhotoId(photo.id)} type="button">
                                    <img src={photoThumbnailSource(photo)} alt={photoAltText(photo)} decoding="async" loading="lazy" />
                                    <span className="trip-photo-caption">
                                      <strong>{photoLabel(photo)}</strong>
                                      <em>{capturedTimeLabel(photo.capturedAt) || photo.fileName}</em>
                                    </span>
                                  </button>
                                  <button
                                    className="trip-photo-remove"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void deletePhoto(photo.id);
                                    }}
                                    title={t("removePhoto")}
                                    type="button"
                                    aria-label={`${t("clear")} ${photoLabel(photo)}`}
                                  >
                                    <X size={21} />
                                  </button>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </main>

      {openPhoto ? (
        <PhotoDetailModal
          photo={openPhoto}
          place={openPhotoPlace}
          editing={editingPhotoId === openPhotoId}
          onClose={closePhotoDetail}
          onLocate={(photo) => {
            const place = photo.placeNodeId ? placeById.get(photo.placeNodeId) : undefined;
            if (place) {
              focusPlaceOnGlobe(place);
            } else {
              selectPhoto(photo.id);
              setActivePanel("globe");
            }
            setOpenPhotoId(undefined);
          }}
          onToggleEdit={(photoId) => setEditingPhotoId(editingPhotoId === photoId ? undefined : photoId)}
          onManualPlace={openManualPhotoMove}
          manual={
            activeManualPhoto && activeManualSessionId && activeManualPhoto.id === openPhoto.id
              ? {
                  busy: manualPhotoBusy,
                  createLabel: t("manualCreatePlace"),
                  bindLabel: t("moveToOtherPlace"),
                  initialMode: manualPlacePick?.pendingId === activeManualSessionId ? manualPlacePick.mode : undefined,
                  initialName: manualPlacePick?.pendingId === activeManualSessionId ? manualPlacePick.name : undefined,
                  pickedPoint:
                    manualPlacePick?.pendingId === activeManualSessionId && manualPlacePick.point
                      ? { ...manualPlacePick.point, nearestLabel: manualPlacePick.nearestLabel }
                      : undefined,
                  places: allPlaces,
                  sessionId: activeManualSessionId,
                  title: t("moveToOtherPlace"),
                  onClose: closeManualPhotoMove,
                  onPickPoint: (sessionId, name, nameDirty) => startManualPlacePick(sessionId, name, nameDirty, "tripDetail"),
                  onSubmit: (body) => void submitManualPhotoMove(body),
                }
              : undefined
          }
          onPatchUserEdits={(photoId, edits) => {
            void updatePhotoUserEdits(photoId, edits);
          }}
        />
      ) : null}
    </section>
  );
}

function TripDossierBackButton({ isClosing, onBack }: { isClosing: boolean; onBack: () => void }) {
  const { t } = useI18n();
  return createPortal(
    <div className="trip-dossier-actions" data-state={isClosing ? "closing" : "open"}>
      <button className="trip-dossier-link" aria-label={t("back")} onClick={onBack} title={t("back")} type="button">
        <ArrowLeft size={30} />
      </button>
    </div>,
    document.body,
  );
}

function PhotoDetailModal({
  photo,
  place,
  editing,
  onClose,
  onLocate,
  onToggleEdit,
  onManualPlace,
  manual,
  onPatchUserEdits,
}: {
  photo: Photo;
  place?: PlaceNode;
  editing: boolean;
  onClose: () => void;
  onLocate: (photo: Photo) => void;
  onToggleEdit: (photoId: string) => void;
  onManualPlace: (photo: Photo) => void;
  manual?: {
    busy: boolean;
    bindLabel: string;
    createLabel: string;
    initialMode?: ManualPlaceMode;
    initialName?: string;
    pickedPoint?: { lat: number; lng: number; nearestLabel?: string };
    places: PlaceNode[];
    sessionId: string;
    title: string;
    onClose: () => void;
    onPickPoint: (sessionId: string, name: string, nameDirty: boolean) => void;
    onSubmit: (body: ManualPlaceResolutionAction) => void;
  };
  onPatchUserEdits: (photoId: string, edits: { title?: string; caption?: string; tags?: string[] }) => void;
}) {
  const { t } = useI18n();
  const [titleDraft, setTitleDraft] = useState("");
  const [captionDraft, setCaptionDraft] = useState("");
  const [tagDrafts, setTagDrafts] = useState<string[]>([]);
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<number>();
  const displayedTitle = photo.userEdits?.title ?? photo.title ?? photo.fileName;
  const displayedCaption = photo.userEdits?.caption ?? photo.aiCaption;
  const displayedTags = photo.userEdits?.tags ?? photo.tags;

  useEffect(() => {
    setTitleDraft(displayedTitle);
    setCaptionDraft(displayedCaption);
    setTagDrafts(displayedTags);
    setAddingTag(false);
    setNewTag("");
  }, [displayedCaption, displayedTags, displayedTitle, photo.id]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  const resizeTitleElement = (input?: HTMLTextAreaElement | null) => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  };

  const resizeTitleInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      resizeTitleElement(titleInputRef.current);
    });
  }, []);

  useEffect(() => {
    if (editing) resizeTitleInput();
  }, [editing, resizeTitleInput, titleDraft]);

  const queueSave = (next: { title?: string; caption?: string; tags?: string[] }) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => onPatchUserEdits(photo.id, next), 420);
  };

  const updateTitle = (value: string) => {
    setTitleDraft(value);
    queueSave({ title: value, caption: captionDraft, tags: tagDrafts });
    resizeTitleInput();
  };

  const updateCaption = (value: string) => {
    setCaptionDraft(value);
    queueSave({ title: titleDraft, caption: value, tags: tagDrafts });
  };

  const updateTags = (tags: string[]) => {
    const cleanTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
    setTagDrafts(cleanTags);
    queueSave({ title: titleDraft, caption: captionDraft, tags: cleanTags });
  };

  const commitNewTag = () => {
    const clean = newTag.trim();
    if (clean) updateTags([...tagDrafts, clean]);
    setNewTag("");
    setAddingTag(false);
  };

  return createPortal(
    <div className="trip-photo-modal" onMouseDown={onClose}>
      <article
        className="trip-photo-modal-shell"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="trip-photo-modal-media">
          <img src={photoDisplaySource(photo)} alt={photoAltText(photo)} decoding="async" />
        </div>
        {manual ? (
          <ManualPlaceResolutionPanel
            sessionId={manual.sessionId}
            photos={[photo]}
            places={manual.places}
            busy={manual.busy}
            title={manual.title}
            bindLabel={manual.bindLabel}
            createLabel={manual.createLabel}
            includeArchive={false}
            initialName={manual.initialName}
            initialMode={manual.initialMode}
            pickedPoint={manual.pickedPoint}
            panelClassName="trip-photo-modal-copy trip-photo-manual-copy manual-pending-copy"
            showCloseButton={false}
            onClose={manual.onClose}
            onPickPoint={manual.onPickPoint}
            onSubmit={manual.onSubmit}
          />
        ) : (
          <div className="trip-photo-modal-copy">
            <div className="trip-photo-modal-heading">
              <div>
                <p>{capturedDateLabel(photo.capturedAt)}</p>
                {editing ? (
                  <textarea
                    ref={titleInputRef}
                    className="trip-photo-modal-title-input"
                    value={titleDraft}
                    onChange={(event) => updateTitle(event.target.value)}
                    onInput={(event) => resizeTitleElement(event.currentTarget)}
                    aria-label="Photo title"
                    rows={1}
                  />
                ) : (
                  <h3>{displayedTitle}</h3>
                )}
              </div>
              <button className="trip-photo-modal-close" onClick={onClose} type="button" aria-label={t("closePhotoPreview")}>
                <X size={17} />
              </button>
            </div>

            {editing ? (
              <textarea
                className="trip-photo-modal-caption-input"
                value={captionDraft}
                onChange={(event) => updateCaption(event.target.value)}
                aria-label="Photo description"
                rows={5}
              />
            ) : (
              <p className="trip-photo-modal-caption">{displayedCaption}</p>
            )}
            <div className={`trip-photo-modal-tags${editing ? " trip-photo-modal-tags-editing" : ""}`}>
              {(editing ? tagDrafts : displayedTags).map((tag) => (
                <span key={tag} className="trip-photo-modal-tag">
                  {tag}
                  {editing ? (
                    <button type="button" aria-label={`Remove ${tag}`} onClick={() => updateTags(tagDrafts.filter((item) => item !== tag))}>
                      <X size={10} />
                    </button>
                  ) : null}
                </span>
              ))}
              {editing ? (
                addingTag ? (
                  <input
                    className="trip-photo-modal-tag-input"
                    autoFocus
                    value={newTag}
                    onChange={(event) => setNewTag(event.target.value)}
                    onBlur={commitNewTag}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitNewTag();
                      }
                      if (event.key === "Escape") {
                        setAddingTag(false);
                        setNewTag("");
                      }
                    }}
                    aria-label="New tag"
                  />
                ) : (
                  <button className="trip-photo-modal-add-tag" type="button" onClick={() => setAddingTag(true)} aria-label="Add tag">
                    <Plus size={13} />
                  </button>
                )
              ) : null}
              {photo.pendingReason ? <span>{t("pending")}</span> : null}
            </div>

            <div className="trip-photo-modal-actions">
              <button onClick={() => onLocate(photo)} type="button" aria-label={t("locate")} title={place ? placeLabel(place) : t("locate")}>
                <MapPin size={19} />
              </button>
              <button onClick={() => onToggleEdit(photo.id)} type="button" aria-label={t("edit")} title={t("edit")} data-active={editing || undefined}>
                <PencilLine size={19} />
              </button>
              <button onClick={() => onManualPlace(photo)} type="button" aria-label={t("moveToOtherPlace")} title={t("moveToOtherPlace")}>
                <Plus size={18} />
              </button>
            </div>
          </div>
        )}
      </article>
    </div>,
    document.body,
  );
}
