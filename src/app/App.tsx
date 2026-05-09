import { MainLayout } from "@/app/layout/MainLayout";
import { ArchiveDrawer } from "@/features/archive/ArchiveDrawer";
import { TripDetailPanel } from "@/features/archive/TripDetailPanel";
import { EarthStage } from "@/features/earth/EarthStage";
import { UploadPhotosPanel } from "@/features/import/UploadPhotosPanel";
import { ManualEditorPanel } from "@/features/manual/ManualEditorPanel";
import { SearchPanel } from "@/features/search/SearchPanel";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { TimelineDock } from "@/features/timeline/TimelineDock";
import { useAppStore } from "@/store/appStore";
import { useEffect, useRef, useState } from "react";

const archiveExitDuration = 520;
const tripDetailExitDuration = 420;
const settingsExitDuration = 420;

export function App() {
  const activePanel = useAppStore((state) => state.activePanel);
  const loadState = useAppStore((state) => state.loadState);
  const [shouldRenderArchive, setShouldRenderArchive] = useState(activePanel === "archive");
  const [isArchiveClosing, setIsArchiveClosing] = useState(false);
  const [shouldRenderTripDetail, setShouldRenderTripDetail] = useState(activePanel === "tripDetail");
  const [isTripDetailClosing, setIsTripDetailClosing] = useState(false);
  const [shouldRenderSettings, setShouldRenderSettings] = useState(activePanel === "settings");
  const [isSettingsClosing, setIsSettingsClosing] = useState(false);
  const archiveExitTimer = useRef<number | undefined>(undefined);
  const tripDetailExitTimer = useRef<number | undefined>(undefined);
  const settingsExitTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void loadState();
  }, [loadState]);

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

  return (
    <MainLayout>
      <EarthStage />
      <TimelineDock />
      {shouldRenderArchive ? <ArchiveDrawer isClosing={isArchiveClosing} /> : null}
      {shouldRenderTripDetail ? <TripDetailPanel isClosing={isTripDetailClosing} /> : null}
      {activePanel === "upload" ? <UploadPhotosPanel /> : null}
      {activePanel === "search" ? <SearchPanel /> : null}
      {shouldRenderSettings ? <SettingsPanel isClosing={isSettingsClosing} /> : null}
      {activePanel === "manual" ? <ManualEditorPanel /> : null}
    </MainLayout>
  );
}
