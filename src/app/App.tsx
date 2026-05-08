import { MainLayout } from "@/app/layout/MainLayout";
import { ArchiveDrawer } from "@/features/archive/ArchiveDrawer";
import { TripDetailPanel } from "@/features/archive/TripDetailPanel";
import { EarthStage } from "@/features/earth/EarthStage";
import { ImportPanel } from "@/features/import/ImportPanel";
import { UploadPhotosPanel } from "@/features/import/UploadPhotosPanel";
import { ManualEditorPanel } from "@/features/manual/ManualEditorPanel";
import { SearchPanel } from "@/features/search/SearchPanel";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { TimelineDock } from "@/features/timeline/TimelineDock";
import { useAppStore } from "@/store/appStore";
import { useEffect, useRef, useState } from "react";

const archiveExitDuration = 520;

export function App() {
  const activePanel = useAppStore((state) => state.activePanel);
  const loadState = useAppStore((state) => state.loadState);
  const [shouldRenderArchive, setShouldRenderArchive] = useState(activePanel === "archive");
  const [isArchiveClosing, setIsArchiveClosing] = useState(false);
  const archiveExitTimer = useRef<number | undefined>(undefined);
  const isArchiveExitBlocking = shouldRenderArchive && activePanel !== "archive";

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

  return (
    <MainLayout>
      <EarthStage />
      <TimelineDock />
      {shouldRenderArchive ? <ArchiveDrawer isClosing={isArchiveClosing} /> : null}
      {!isArchiveExitBlocking && activePanel === "tripDetail" ? <TripDetailPanel /> : null}
      {!isArchiveExitBlocking && activePanel === "import" ? <ImportPanel /> : null}
      {!isArchiveExitBlocking && activePanel === "upload" ? <UploadPhotosPanel /> : null}
      {!isArchiveExitBlocking && activePanel === "search" ? <SearchPanel /> : null}
      {!isArchiveExitBlocking && activePanel === "settings" ? <SettingsPanel /> : null}
      {!isArchiveExitBlocking && activePanel === "manual" ? <ManualEditorPanel /> : null}
    </MainLayout>
  );
}
