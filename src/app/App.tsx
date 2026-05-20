import { MainLayout } from "@/app/layout/MainLayout";
import { ArchiveDrawer } from "@/features/archive/ArchiveDrawer";
import { TripDetailPanel } from "@/features/archive/TripDetailPanel";
import { EarthStage } from "@/features/earth/EarthStage";
import { UploadPhotosPanel } from "@/features/import/UploadPhotosPanel";
import { OnboardingGuide } from "@/features/onboarding/OnboardingGuide";
import { SearchPanel } from "@/features/search/SearchPanel";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { TimelineDock } from "@/features/timeline/TimelineDock";
import { installAndroidBackDispatcher } from "@/platform/androidBack";
import { useAppStore } from "@/store/appStore";
import { useEffect, useRef, useState } from "react";

const archiveExitDuration = 520;
const tripDetailExitDuration = 420;
const settingsExitDuration = 420;
const searchExitDuration = 420;
const uploadExitDuration = 520;

export function App() {
  const activePanel = useAppStore((state) => state.activePanel);
  const loadState = useAppStore((state) => state.loadState);
  const [shouldRenderArchive, setShouldRenderArchive] = useState(activePanel === "archive");
  const [isArchiveClosing, setIsArchiveClosing] = useState(false);
  const [shouldRenderTripDetail, setShouldRenderTripDetail] = useState(activePanel === "tripDetail");
  const [isTripDetailClosing, setIsTripDetailClosing] = useState(false);
  const [shouldRenderSettings, setShouldRenderSettings] = useState(activePanel === "settings");
  const [isSettingsClosing, setIsSettingsClosing] = useState(false);
  const [shouldRenderSearch, setShouldRenderSearch] = useState(activePanel === "search");
  const [isSearchClosing, setIsSearchClosing] = useState(false);
  const [shouldRenderUpload, setShouldRenderUpload] = useState(activePanel === "upload");
  const [isUploadClosing, setIsUploadClosing] = useState(false);
  const archiveExitTimer = useRef<number | undefined>(undefined);
  const tripDetailExitTimer = useRef<number | undefined>(undefined);
  const settingsExitTimer = useRef<number | undefined>(undefined);
  const searchExitTimer = useRef<number | undefined>(undefined);
  const uploadExitTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    return installAndroidBackDispatcher(() => {
      const state = useAppStore.getState();

      if (state.manualPlacePick?.isPicking) {
        state.cancelManualPlacePickPoint();
        return true;
      }

      if (state.activePanel !== "globe") {
        state.setActivePanel("globe");
        return true;
      }

      return false;
    });
  }, []);

  useEffect(() => {
    window.clearTimeout(archiveExitTimer.current);

    if (activePanel === "archive") {
      setShouldRenderArchive(true);
      setIsArchiveClosing(false);
      return;
    }

    if (shouldRenderArchive) {
      setIsArchiveClosing(true);
      archiveExitTimer.current = window.setTimeout(() => {
        setShouldRenderArchive(false);
        setIsArchiveClosing(false);
      }, archiveExitDuration);
    }

    return () => window.clearTimeout(archiveExitTimer.current);
  }, [activePanel, shouldRenderArchive]);

  useEffect(() => {
    window.clearTimeout(settingsExitTimer.current);

    if (activePanel === "settings") {
      setShouldRenderSettings(true);
      setIsSettingsClosing(false);
      return;
    }

    if (shouldRenderSettings) {
      setIsSettingsClosing(true);
      settingsExitTimer.current = window.setTimeout(() => {
        setShouldRenderSettings(false);
        setIsSettingsClosing(false);
      }, settingsExitDuration);
    }

    return () => window.clearTimeout(settingsExitTimer.current);
  }, [activePanel, shouldRenderSettings]);

  useEffect(() => {
    window.clearTimeout(searchExitTimer.current);

    if (activePanel === "search") {
      setShouldRenderSearch(true);
      setIsSearchClosing(false);
      return;
    }

    if (shouldRenderSearch) {
      setIsSearchClosing(true);
      searchExitTimer.current = window.setTimeout(() => {
        setShouldRenderSearch(false);
        setIsSearchClosing(false);
      }, searchExitDuration);
    }

    return () => window.clearTimeout(searchExitTimer.current);
  }, [activePanel, shouldRenderSearch]);

  useEffect(() => {
    window.clearTimeout(tripDetailExitTimer.current);

    if (activePanel === "tripDetail") {
      setShouldRenderTripDetail(true);
      setIsTripDetailClosing(false);
      return;
    }

    if (shouldRenderTripDetail) {
      setIsTripDetailClosing(true);
      tripDetailExitTimer.current = window.setTimeout(() => {
        setShouldRenderTripDetail(false);
        setIsTripDetailClosing(false);
      }, tripDetailExitDuration);
    }

    return () => window.clearTimeout(tripDetailExitTimer.current);
  }, [activePanel, shouldRenderTripDetail]);

  useEffect(() => {
    window.clearTimeout(uploadExitTimer.current);

    if (activePanel === "upload") {
      setShouldRenderUpload(true);
      setIsUploadClosing(false);
      return;
    }

    if (shouldRenderUpload) {
      setIsUploadClosing(true);
      uploadExitTimer.current = window.setTimeout(() => {
        setShouldRenderUpload(false);
        setIsUploadClosing(false);
      }, uploadExitDuration);
    }

    return () => window.clearTimeout(uploadExitTimer.current);
  }, [activePanel, shouldRenderUpload]);

  return (
    <>
      <MainLayout>
        <EarthStage />
        <TimelineDock />
        {shouldRenderArchive ? <ArchiveDrawer isClosing={isArchiveClosing} /> : null}
        {shouldRenderTripDetail ? <TripDetailPanel isClosing={isTripDetailClosing} /> : null}
        {shouldRenderUpload ? <UploadPhotosPanel isClosing={isUploadClosing} /> : null}
        {shouldRenderSearch ? <SearchPanel isClosing={isSearchClosing} /> : null}
        {shouldRenderSettings ? <SettingsPanel isClosing={isSettingsClosing} /> : null}
      </MainLayout>
      <OnboardingGuide />
    </>
  );
}
