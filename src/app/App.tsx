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
import { useEffect } from "react";

export function App() {
  const activePanel = useAppStore((state) => state.activePanel);
  const loadState = useAppStore((state) => state.loadState);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  return (
    <MainLayout>
      <EarthStage />
      <TimelineDock />
      {activePanel === "archive" ? <ArchiveDrawer /> : null}
      {activePanel === "tripDetail" ? <TripDetailPanel /> : null}
      {activePanel === "import" ? <ImportPanel /> : null}
      {activePanel === "upload" ? <UploadPhotosPanel /> : null}
      {activePanel === "search" ? <SearchPanel /> : null}
      {activePanel === "settings" ? <SettingsPanel /> : null}
      {activePanel === "manual" ? <ManualEditorPanel /> : null}
    </MainLayout>
  );
}
