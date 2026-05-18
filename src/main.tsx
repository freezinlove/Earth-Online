import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { isAndroidRuntime } from "@/platform/runtime";
import "@/styles/globals.css";

if (isAndroidRuntime()) {
  document.documentElement.dataset.nativePlatform = "android";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
