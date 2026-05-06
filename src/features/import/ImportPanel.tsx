import { Check, GitMerge, RotateCcw, UploadCloud, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";

export function ImportPanel() {
  const batches = useAppStore((state) => state.importBatches);
  const latest = batches[batches.length - 1];
  const allPendingItems = useAppStore((state) => state.pendingItems);
  const confirmLatestImport = useAppStore((state) => state.confirmLatestImport);
  const rollbackLatestImport = useAppStore((state) => state.rollbackLatestImport);
  const mergeLatestImportTrips = useAppStore((state) => state.mergeLatestImportTrips);
  const acknowledgePendingItem = useAppStore((state) => state.acknowledgePendingItem);
  const setActivePanel = useAppStore((state) => state.setActivePanel);

  if (!latest) return null;
  const pendingItems = allPendingItems.filter((item) => latest.pendingItemIds.includes(item.id));

  return (
    <section className="safe-panel fixed inset-x-4 top-24 z-[80] mx-auto max-h-[calc(100vh-7rem)] max-w-[720px] overflow-y-auto rounded-[28px] p-6 md:top-28">
      <button
        className="absolute right-5 top-5 grid h-9 w-9 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
        aria-label="关闭导入确认"
        onClick={() => setActivePanel("globe")}
        type="button"
      >
        <X size={17} />
      </button>

      <div className="flex items-start gap-4 pr-11">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary-fixed text-primary">
          <UploadCloud size={22} />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-outline">Import Batch</p>
          <h2 className="mt-2 font-serif text-3xl font-semibold text-primary">导入确认</h2>
          <p className="mt-3 text-sm leading-6 text-on-surface-variant">{latest.summary}</p>
          <p className="mt-2 text-xs font-semibold text-outline">状态：{latest.status}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl bg-surface-container-low p-4">
          <p className="text-2xl font-semibold text-primary">{latest.totalCount}</p>
          <p className="text-xs text-on-surface-variant">本次导入</p>
        </div>
        <div className="rounded-2xl bg-surface-container-low p-4">
          <p className="text-2xl font-semibold text-secondary">{latest.successCount}</p>
          <p className="text-xs text-on-surface-variant">已归档建议</p>
        </div>
        <div className="rounded-2xl bg-surface-container-low p-4">
          <p className="text-2xl font-semibold text-tertiary">{latest.failedCount}</p>
          <p className="text-xs text-on-surface-variant">待补信息</p>
        </div>
      </div>
      {latest.duplicateCount ? (
        <p className="mt-3 rounded-2xl bg-white/60 px-4 py-3 text-xs font-semibold text-outline">
          已自动跳过 {latest.duplicateCount} 张重复照片，原有档案不会被重复写入。
        </p>
      ) : null}
      {latest.aiStats ? (
        <div className="mt-3 rounded-2xl bg-white/60 px-4 py-3 text-xs leading-5 text-outline">
          <span className="font-semibold text-primary">AI 调用痕迹：</span>
          Qwen 图片理解 {latest.aiStats.qwenCount} 张，降级 {latest.aiStats.fallbackCount} 张；
          embedding 写入 {latest.aiStats.embeddingCount} 条，其中 Qwen embedding {latest.aiStats.qwenEmbeddingCount} 条。
        </div>
      ) : null}

      {pendingItems.length > 0 ? (
        <div className="mt-5 space-y-3">
          {pendingItems.map((item) => (
            <div key={item.id} className="rounded-2xl bg-white/55 p-4">
              <p className="text-sm font-semibold text-on-surface">{item.suggestion}</p>
              <p className="mt-2 text-xs leading-5 text-on-surface-variant">{item.reason}</p>
              <div className="mt-3 flex gap-2">
                <button className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white" onClick={() => acknowledgePendingItem(item.id, true)} type="button">
                  确认建议
                </button>
                <button className="rounded-full bg-white/75 px-3 py-1.5 text-xs font-semibold text-primary" onClick={() => acknowledgePendingItem(item.id, false)} type="button">
                  暂不处理
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white shadow-soft disabled:opacity-50"
          onClick={confirmLatestImport}
          disabled={latest.status !== "pending_confirmation"}
          type="button"
        >
          <Check size={17} /> 确认保留
        </button>
        <button
          className="inline-flex items-center gap-2 rounded-full bg-surface-container-low px-5 py-3 text-sm font-semibold text-primary disabled:opacity-50"
          onClick={rollbackLatestImport}
          disabled={latest.status !== "pending_confirmation"}
          type="button"
        >
          <RotateCcw size={17} /> 回撤本次导入
        </button>
        {latest.createdTripIds.length > 1 ? (
          <button
            className="inline-flex items-center gap-2 rounded-full bg-secondary-container/80 px-5 py-3 text-sm font-semibold text-secondary disabled:opacity-50"
            onClick={mergeLatestImportTrips}
            disabled={latest.status !== "pending_confirmation"}
            type="button"
          >
            <GitMerge size={17} /> 合并为一个旅行
          </button>
        ) : null}
      </div>
    </section>
  );
}
