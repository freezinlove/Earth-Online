import { Check, Database, Globe2, Palette, Shield, X } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "@/store/appStore";

const preferences = [
  { icon: Database, title: "本地优先", text: "照片、旅行档案与向量索引已经写入本地应用管理目录，UI 只通过服务层访问。" },
  { icon: Globe2, title: "地球视图", text: "启动后回到上次查看的旅行位置与时间轴段落。" },
  { icon: Palette, title: "温暖纸面", text: "使用低对比度纸张背景和柔和浮层，减少长时间浏览疲劳。" },
];

export function SettingsPanel() {
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const aiCloudEnabled = useAppStore((state) => state.aiCloudEnabled);
  const setAiCloudEnabled = useAppStore((state) => state.setAiCloudEnabled);
  const [restoreView, setRestoreView] = useState(true);

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Local Preferences</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold text-primary md:text-5xl">本地设置</h2>
          </div>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
            aria-label="关闭设置"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="safe-panel rounded-[28px] p-6 md:p-8">
            <h3 className="font-serif text-2xl font-semibold text-on-surface">偏好</h3>
            <div className="mt-6 space-y-4">
              <label className="flex items-center justify-between gap-4 rounded-[20px] bg-white/48 p-4">
                <span>
                  <span className="block text-sm font-semibold text-on-surface">云端 AI 分析</span>
                  <span className="mt-1 block text-xs leading-5 text-on-surface-variant">当前 Provider 为 Qwen。关闭时使用本地 Mock，不上传真实照片。</span>
                </span>
                <input className="h-5 w-5 accent-primary" checked={aiCloudEnabled} onChange={(event) => setAiCloudEnabled(event.target.checked)} type="checkbox" />
              </label>
              <label className="flex items-center justify-between gap-4 rounded-[20px] bg-white/48 p-4">
                <span>
                  <span className="block text-sm font-semibold text-on-surface">恢复上次视图</span>
                  <span className="mt-1 block text-xs leading-5 text-on-surface-variant">打开应用时回到最近一次时间轴位置。</span>
                </span>
                <input className="h-5 w-5 accent-primary" checked={restoreView} onChange={(event) => setRestoreView(event.target.checked)} type="checkbox" />
              </label>
            </div>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-secondary-container/70 px-4 py-2 text-sm font-semibold text-secondary">
              <Shield size={16} /> 本地单用户 MVP
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {preferences.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title} className="rounded-[24px] bg-white/62 p-5 shadow-soft">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-primary-fixed text-primary">
                    <Icon size={18} />
                  </div>
                  <h3 className="mt-5 font-serif text-xl font-semibold text-on-surface">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-on-surface-variant">{item.text}</p>
                </article>
              );
            })}
          </div>
        </div>

        <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-secondary-container/70 px-4 py-2 text-sm font-semibold text-secondary">
          <Check size={16} /> 当前 AI Provider：Qwen Adapter（Mock 可降级）
        </div>
      </div>
    </section>
  );
}
