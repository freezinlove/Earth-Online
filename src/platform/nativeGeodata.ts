import { Capacitor, registerPlugin } from "@capacitor/core";
import type { GeoPoint, LocationCandidate } from "@/domain/models";

type NativeGeodataAvailability = {
  available: boolean;
  path?: string;
  error?: string;
};

type NativeGeocodeResult = {
  candidates: LocationCandidate[];
};

type NativeCapitalResult = {
  point?: GeoPoint;
};

export type NativeGeonameRow = {
  geoname_id?: string | number;
  name?: string;
  ascii_name?: string;
  lat?: number;
  lng?: number;
  country_code?: string;
  country_name?: string;
  country_name_zh?: string;
  country_name_en?: string;
  admin1_name?: string;
  admin2_name?: string;
  feature_code?: string;
  feature_label?: string;
  name_zh?: string;
  name_en?: string;
  population?: number;
};

type NativeRowsResult = {
  rows: NativeGeonameRow[];
};

type EarthGeodataPlugin = {
  isAvailable(): Promise<NativeGeodataAvailability>;
  reverseGeocode(options: { lat: number; lng: number; preferCity?: boolean }): Promise<NativeGeocodeResult>;
  forwardGeocode(options: { name?: string; city?: string; country?: string }): Promise<NativeGeocodeResult>;
  countryCapitalPoint(options: { country: string }): Promise<NativeCapitalResult>;
  nearbyRows(options: { lat: number; lng: number; radiusKm?: number }): Promise<NativeRowsResult>;
  forwardRows(options: { queries: string[] }): Promise<NativeRowsResult>;
  capitalRows(): Promise<NativeRowsResult>;
};

const EarthGeodata = registerPlugin<EarthGeodataPlugin>("EarthGeodata");

export async function isNativeGeodataAvailable() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return false;
  try {
    const result = await EarthGeodata.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

export async function reverseNativeGeocode(point: GeoPoint, preferCity = true) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  const result = await EarthGeodata.reverseGeocode({ lat: point.lat, lng: point.lng, preferCity });
  return Array.isArray(result.candidates) ? result.candidates : [];
}

export async function nearbyNativeGeonameRows(point: GeoPoint, radiusKm = 80) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  const result = await EarthGeodata.nearbyRows({ lat: point.lat, lng: point.lng, radiusKm });
  return Array.isArray(result.rows) ? result.rows : [];
}

export async function forwardNativeGeocode(query: { name?: string; city?: string; country?: string }) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  const result = await EarthGeodata.forwardGeocode(query);
  return Array.isArray(result.candidates) ? result.candidates : [];
}

export async function forwardNativeGeonameRows(queries: string[]) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  const result = await EarthGeodata.forwardRows({ queries });
  return Array.isArray(result.rows) ? result.rows : [];
}

export async function nativeCountryCapitalPoint(country: string) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return undefined;
  const result = await EarthGeodata.countryCapitalPoint({ country });
  return result.point;
}

export async function nativeCountryCapitalRows() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return [];
  const result = await EarthGeodata.capitalRows();
  return Array.isArray(result.rows) ? result.rows : [];
}
