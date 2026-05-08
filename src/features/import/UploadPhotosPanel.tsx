import { CheckCircle2, FolderOpen, HardDrive, ImagePlus, Images, LoaderCircle, Settings2, Sparkles, UploadCloud, X } from "lucide-react";
import type { DragEvent } from "react";
import { useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";

export function UploadPhotosPanel() {
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const aiCloudEnabled = useAppStore((state) => state.aiCloudEnabled);
  const setAiCloudEnabled = useAppStore((state) => state.setAiCloudEnabled);
  const importFiles = useAppStore((state) => state.importFiles);
  const importAppleTestPhotos = useAppStore((state) => state.importAppleTestPhotos);
  const importBatches = useAppStore((state) => state.importBatches);
  const pendingItems = useAppStore((state) => state.pendingItems);
  const isImporting = useAppStore((state) => state.isImporting);
  const importProgress = useAppStore((state) => state.importProgress);
  const error = useAppStore((state) => state.error);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const latestBatch = importBatches[importBatches.length - 1];
  const latestPendingCount = latestBatch ? pendingItems.filter((item) => latestBatch.pendingItemIds.includes(item.id) && item.status === "open").length : 0;
  const progressPercent = importProgress ? Math.max(8, Math.round((importProgress.done / Math.max(1, importProgress.total)) * 100)) : 0;
  const hasLatestPending = Boolean(latestBatch && latestBatch.status === "pending_confirmation");

  const startImport = (files: FileList | File[]) => {
    const nextFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    setSelectedCount(nextFiles.length);
    if (nextFiles.length > 0) void importFiles(nextFiles);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isImporting) return;
    startImport(event.dataTransfer.files);
  };

  return (
    <section className="photo-import-panel fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="photo-import-heading mb-8 flex items-start justify-between gap-6 md:mb-12">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Photo Import</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold leading-tight text-primary md:text-6xl">导入图片</h2>
          </div>
          <button
            className="photo-import-close"
            aria-label="关闭导入图片"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="photo-import-grid">
          <article
            className="photo-import-dropzone"
            data-dragging={isDragging || undefined}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsDragging(false);
            }}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                const files = event.target.files;
                if (files) startImport(files);
              }}
            />
            <input
              ref={folderInputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              multiple
              {...({ webkitdirectory: "" } as Record<string, string>)}
              onChange={(event) => {
                const files = event.target.files;
                if (files) startImport(files);
              }}
            />

            <div className="photo-import-drop-copy">
              <div className="photo-import-glyph">
                {isImporting ? <LoaderCircle className="animate-spin" size={28} /> : <ImagePlus size={29} />}
              </div>
              <p className="photo-import-kicker">Local Photo Intake</p>
              <h3>把照片放进档案袋</h3>
              <p>
                读取照片、复制到本机应用目录、解析 EXIF 时间/GPS，并生成待确认的旅行与地点建议。
              </p>
            </div>

            <div className="photo-import-actions">
              <button className="photo-import-primary-action" type="button" onClick={() => inputRef.current?.click()} disabled={isImporting}>
                <FolderOpen size={17} /> {isImporting ? "导入中" : "选择照片"}
              </button>
              <button className="photo-import-secondary-action" type="button" onClick={() => folderInputRef.current?.click()} disabled={isImporting}>
                <Images size={16} /> 选择文件夹
              </button>
              <button className="photo-import-secondary-action" type="button" onClick={() => void importAppleTestPhotos()} disabled={isImporting}>
                <HardDrive size={16} /> Apple 测试集
              </button>
            </div>

            <div className="photo-import-progress" data-active={Boolean(importProgress) || undefined}>
              <div className="photo-import-progress-bar">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              <p>
                {importProgress
                  ? `${importProgress.phase === "reading" ? "正在读取与复制" : "正在解析 EXIF 与 AI 标签"} · ${importProgress.done}/${importProgress.total}`
                  : selectedCount > 0
                    ? `已选择 ${selectedCount} 张，等待后端处理`
                    : "支持多选、文件夹与拖拽导入"}
              </p>
            </div>

            {error ? <p className="photo-import-error">{error}</p> : null}
          </article>

          <aside className="photo-import-side">
            <section className="photo-import-control-group">
              <div className="photo-import-section-title">
                <Settings2 size={17} />
                <span>导入前设置</span>
              </div>
              <button className="photo-import-toggle-row" type="button" onClick={() => setAiCloudEnabled(!aiCloudEnabled)} aria-pressed={aiCloudEnabled}>
                <span>
                  <strong>AI 图片理解</strong>
                  <small>{aiCloudEnabled ? "使用本地保存的 Qwen Key 生成标签与描述" : "只读取照片与 EXIF，不调用云端模型"}</small>
                </span>
                <span className="photo-import-switch" data-active={aiCloudEnabled || undefined}>
                  <span />
                </span>
              </button>
              <div className="photo-import-policy-list">
                <span><CheckCircle2 size={15} /> 重复照片自动跳过</span>
                <span><CheckCircle2 size={15} /> GPS 缺失进入待确认</span>
                <span><CheckCircle2 size={15} /> 每次导入独立成批</span>
              </div>
            </section>

            <section className="photo-import-control-group">
              <div className="photo-import-section-title">
                <UploadCloud size={17} />
                <span>最近导入</span>
              </div>
              {latestBatch ? (
                <>
                  <div className="photo-import-batch-line">
                    <span>{latestBatch.totalCount}</span>
                    <p>{latestBatch.summary}</p>
                  </div>
                  <div className="photo-import-batch-meta">
                    <span>{latestBatch.status}</span>
                    <span>{latestPendingCount} 项待确认</span>
                    {latestBatch.duplicateCount ? <span>跳过 {latestBatch.duplicateCount} 张重复</span> : null}
                  </div>
                  <button className="photo-import-next-action" type="button" onClick={() => setActivePanel("import")} disabled={!hasLatestPending}>
                    <Sparkles size={16} /> {hasLatestPending ? "前往导入确认" : "暂无待确认批次"}
                  </button>
                </>
              ) : (
                <p className="photo-import-empty-note">还没有导入批次。选择照片后，这里会显示最近一次处理结果和确认入口。</p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}
