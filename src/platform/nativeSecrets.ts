import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeSecretsAvailability = {
  available: boolean;
  error?: string;
};

type NativeSecretsReadResult = {
  secrets?: unknown;
};

type NativeSecretsWriteResult = {
  ok: boolean;
};

type EarthSecretsPlugin = {
  isAvailable(): Promise<NativeSecretsAvailability>;
  readSecrets(): Promise<NativeSecretsReadResult>;
  writeSecrets(options: { secrets: unknown }): Promise<NativeSecretsWriteResult>;
};

const EarthSecrets = registerPlugin<EarthSecretsPlugin>("EarthSecrets");

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function isNativeSecretsAvailable() {
  if (!isAndroidNative()) return false;
  try {
    const result = await EarthSecrets.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

export async function readNativeSecrets<T>() {
  if (!isAndroidNative()) return undefined;
  const result = await EarthSecrets.readSecrets();
  return result.secrets as T | undefined;
}

export async function writeNativeSecrets(secrets: unknown) {
  if (!isAndroidNative()) return false;
  const result = await EarthSecrets.writeSecrets({ secrets });
  return result.ok === true;
}
