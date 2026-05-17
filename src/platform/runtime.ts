import { Capacitor } from "@capacitor/core";

export function isAndroidRuntime() {
  return Capacitor.getPlatform() === "android";
}

export function isNativeRuntime() {
  return Capacitor.isNativePlatform();
}
