import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeRepositoryAvailability = {
  available: boolean;
  path?: string;
  error?: string;
};

type NativeWriteResult = {
  ok: boolean;
};

type NativeVectorIndexResult = {
  index?: Record<string, number[]>;
};

type NativeImportJobResult = {
  job?: unknown;
};

type EarthRepositoryPlugin = {
  isAvailable(): Promise<NativeRepositoryAvailability>;
  readState(): Promise<unknown>;
  writeState(options: { state: unknown }): Promise<NativeWriteResult>;
  getImportJob(options: { id: string }): Promise<NativeImportJobResult>;
  saveImportJob(options: { job: unknown }): Promise<NativeWriteResult>;
  readVectorIndex(): Promise<NativeVectorIndexResult>;
  writeVectorIndex(options: { index: Record<string, number[]> }): Promise<NativeWriteResult>;
  deleteVectors(options: { photoIds: string[] }): Promise<NativeWriteResult>;
};

const EarthRepository = registerPlugin<EarthRepositoryPlugin>("EarthRepository");

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function isNativeRepositoryAvailable() {
  if (!isAndroidNative()) return false;
  try {
    const result = await EarthRepository.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

export async function readNativeState<T>() {
  if (!isAndroidNative()) return undefined;
  return (await EarthRepository.readState()) as T;
}

export async function writeNativeState(state: unknown) {
  if (!isAndroidNative()) return false;
  const result = await EarthRepository.writeState({ state });
  return result.ok === true;
}

export async function readNativeImportJob<T>(id: string) {
  if (!isAndroidNative() || !id) return undefined;
  const result = await EarthRepository.getImportJob({ id });
  return result.job as T | undefined;
}

export async function writeNativeImportJob(job: unknown) {
  if (!isAndroidNative()) return false;
  const result = await EarthRepository.saveImportJob({ job });
  return result.ok === true;
}

export async function readNativeVectorIndex() {
  if (!isAndroidNative()) return {};
  const result = await EarthRepository.readVectorIndex();
  return result.index ?? {};
}

export async function writeNativeVectorIndex(index: Record<string, number[]>) {
  if (!isAndroidNative()) return false;
  const result = await EarthRepository.writeVectorIndex({ index });
  return result.ok === true;
}

export async function deleteNativeVectors(photoIds: string[]) {
  if (!isAndroidNative() || !photoIds.length) return false;
  const result = await EarthRepository.deleteVectors({ photoIds });
  return result.ok === true;
}
