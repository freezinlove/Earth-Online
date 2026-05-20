import { isAndroidRuntime } from "@/platform/runtime";

type AndroidBackHandler = () => boolean;

const handlers: AndroidBackHandler[] = [];

declare global {
  interface Window {
    __earthOnlineHandleAndroidBack?: () => boolean;
  }
}

export function registerAndroidBackHandler(handler: AndroidBackHandler) {
  handlers.push(handler);

  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  };
}

export function installAndroidBackDispatcher(fallback: AndroidBackHandler) {
  if (!isAndroidRuntime() || typeof window === "undefined") return () => undefined;

  window.__earthOnlineHandleAndroidBack = () => {
    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      if (handlers[index]?.()) return true;
    }

    return fallback();
  };

  return () => {
    if (window.__earthOnlineHandleAndroidBack) delete window.__earthOnlineHandleAndroidBack;
  };
}
