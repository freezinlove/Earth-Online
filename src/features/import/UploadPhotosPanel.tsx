import { FolderOpen, HardDrive, ImagePlus, Images, X } from "lucide-react";
import { useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";

export function UploadPhotosPanel() {
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const importFiles = useAppStore((state) => state.importFiles);
  const importAppleTestPhotos = useAppStore((state) => state.importAppleTestPhotos);
  const isImporting = useAppStore((state) => state.isImporting);
  const importProgress = useAppStore((state) => state.importProgress);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Photo Import</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold text-primary md:text-5xl">导入图片</h2>
          </div>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
            aria-label="关闭导入图片"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="safe-panel rounded-[28px] p-6 md:p-8">
            <div className="grid min-h-[340px] place-items-center rounded-[24px] bg-surface-container-low/70 px-6 py-12 text-center">
              <div>
                <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-primary-fixed text-primary">
                  <ImagePlus size={28} />
                </div>
                <h3 className="mt-6 font-serif text-3xl font-semibold text-on-surface">选择本地照片</h3>
                <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-on-surface-variant">
                  MVP 会把照片发送到本地 Node 服务，复制到应用管理目录，读取 EXIF 时间/GPS，生成 Trip、地点节点、Qwen 标签、待确认事项，并进入确认或回撤流程。
                </p>
                <input
                  ref={inputRef}
                  className="sr-only"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    const files = event.target.files;
                    setSelectedCount(files?.length ?? 0);
                    if (files && files.length > 0) void importFiles(files);
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
                    setSelectedCount(files?.length ?? 0);
                    if (files && files.length > 0) void importFiles(files);
                  }}
                />
                <button
                  className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-primary-container"
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={isImporting}
                >
                  <FolderOpen size={17} /> {isImporting ? "导入中" : "选择照片"}
                </button>
                <div className="mt-3 flex flex-wrap justify-center gap-3">
                  <button
                    className="inline-flex items-center gap-2 rounded-full bg-white/75 px-5 py-2.5 text-sm font-semibold text-primary shadow-soft transition hover:bg-primary-fixed disabled:opacity-50"
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    disabled={isImporting}
                  >
                    <Images size={16} /> 选择文件夹
                  </button>
                  <button
                    className="inline-flex items-center gap-2 rounded-full bg-secondary-container/80 px-5 py-2.5 text-sm font-semibold text-secondary shadow-soft transition hover:bg-secondary-container disabled:opacity-50"
                    type="button"
                    onClick={() => void importAppleTestPhotos()}
                    disabled={isImporting}
                  >
                    <HardDrive size={16} /> 导入 Apple 测试集
                  </button>
                </div>
                {selectedCount > 0 ? <p className="mt-3 text-xs font-semibold text-outline">已选择 {selectedCount} 张，本地后端正在复制、解析并生成导入建议。</p> : null}
                {importProgress ? (
                  <div className="mx-auto mt-5 max-w-sm">
                    <div className="h-2 overflow-hidden rounded-full bg-white/80">
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${Math.max(8, Math.round((importProgress.done / Math.max(1, importProgress.total)) * 100))}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs font-semibold text-outline">
                      {importProgress.phase === "reading" ? "正在生成缩略图" : "后端正在解析 EXIF 与 AI 标签"} · {importProgress.done}/{importProgress.total}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <aside className="ai-narrative-block rounded-[28px] p-6 md:p-8">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-tertiary-fixed text-tertiary">
              <HardDrive size={20} />
            </div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.3em] text-outline">Local First</p>
            <h3 className="mt-3 font-serif text-3xl font-semibold text-primary">可确认、可回滚</h3>
            <p className="mt-4 text-base leading-8 text-on-surface-variant">
              每次导入都会形成独立 Import Batch。系统只给出归档建议：创建新 Trip、追加已有 Trip、拆分多段旅行或暂不归档，都需要用户确认。
            </p>
          </aside>
        </div>
      </div>
    </section>
  );
}
