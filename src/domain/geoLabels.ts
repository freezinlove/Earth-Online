import type { GlobeMarker, LocalizedNames, PlaceNode, TimelineSegment } from "@/domain/models";
import { enPlaceNameOverride, hasHan, zhPlaceNameOverride } from "@/domain/placeNameOverrides";
import type { Locale } from "@/store/appStore";

const REGION_CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SS SE SG SH SI SJ SK SL SM SN SO SR ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK CS AN".split(
    " ",
  );

const zhRegionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const enRegionNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryZhByAlias = new Map<string, string>();
const countryEnByZh = new Map<string, string>();

function regionName(displayNames: Intl.DisplayNames, code: string) {
  try {
    return displayNames.of(code) || code;
  } catch {
    return code;
  }
}

function registerCountryAlias(alias: string | undefined, zh: string) {
  const key = normalizedCountryAlias(alias);
  if (key) countryZhByAlias.set(key, zh);
}

for (const code of REGION_CODES) {
  const zh = regionName(zhRegionNames, code);
  const en = regionName(enRegionNames, code);
  countryEnByZh.set(zh, en);
  registerCountryAlias(code, zh);
  registerCountryAlias(zh, zh);
  registerCountryAlias(en, zh);
}

for (const alias of ["Hong Kong", "Hongkong", "Hong Kong SAR", "Hong Kong SAR China", "HK", "中国香港", "中国香港特别行政区", "香港", "Macao", "Macau", "Macao SAR", "Macao SAR China", "MO", "中国澳门", "中国澳门特别行政区", "澳门"]) {
  registerCountryAlias(alias, "中国");
}

const manualCountryAliases: Array<[string, string]> = [
  ["PRC", "中国"],
  ["People's Republic of China", "中国"],
  ["Czech Republic", "捷克"],
  ["UK", "英国"],
  ["Great Britain", "英国"],
  ["United States of America", "美国"],
  ["USA", "美国"],
  ["Republic of Korea", "韩国"],
  ["Korea, Republic of", "韩国"],
  ["North Korea", "朝鲜"],
  ["Russian Federation", "俄罗斯"],
  ["The Netherlands", "荷兰"],
  ["Holland", "荷兰"],
  ["Ivory Coast", "科特迪瓦"],
  ["Cote d'Ivoire", "科特迪瓦"],
  ["Côte d'Ivoire", "科特迪瓦"],
];
for (const [alias, zh] of manualCountryAliases) registerCountryAlias(alias, zh);

function normalizedCountryAlias(value?: string) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

export function localizedName(names: LocalizedNames | undefined, fallback: string | undefined, locale: Locale) {
  const preferred = names?.[locale];
  if (locale === "zh" && preferred && !hasHan(preferred)) return zhPlaceNameOverride(preferred) ?? preferred;
  if (locale === "en" && preferred && hasHan(preferred)) {
    const mapped = enPlaceNameOverride(preferred) ?? enPlaceNameOverride(names?.zh) ?? enPlaceNameOverride(fallback);
    if (mapped) return mapped;
  } else if (preferred) {
    return preferred;
  }
  if (locale === "zh") {
    const candidates = [names?.local, fallback, names?.en];
    const translated = candidates.map(zhPlaceNameOverride).find(Boolean);
    if (translated) return translated;
    return candidates.find((value) => value && hasHan(value)) ?? candidates.find(Boolean) ?? "未标地点";
  }
  const mapped = enPlaceNameOverride(names?.zh) ?? enPlaceNameOverride(fallback) ?? enPlaceNameOverride(names?.local);
  if (mapped) return mapped;
  return [names?.local, fallback, names?.zh].find((value) => value && !hasHan(value)) ?? "Unmarked place";
}

export function placeLabel(place: Pick<PlaceNode, "name" | "names"> | undefined, locale: Locale) {
  return localizedName(place?.names, place?.name, locale);
}

export function countryLabel(names: LocalizedNames | undefined, fallback: string | undefined, locale: Locale) {
  const zhMapped = countryZhByAlias.get(normalizedCountryAlias(names?.zh)) ?? countryZhByAlias.get(normalizedCountryAlias(fallback)) ?? countryZhByAlias.get(normalizedCountryAlias(names?.en)) ?? countryZhByAlias.get(normalizedCountryAlias(names?.local));
  if (zhMapped) return locale === "en" ? countryEnByZh.get(zhMapped) ?? zhMapped : zhMapped;

  if (locale === "en") {
    const preferred = names?.en;
    if (preferred && !hasHan(preferred)) return preferred;
    const mapped = countryEnByZh.get(names?.zh ?? fallback ?? "");
    if (mapped) return mapped;
  }
  return localizedName(names, fallback, locale);
}

export function markerLabel(marker: Pick<GlobeMarker, "label" | "labelNames">, locale: Locale) {
  return localizedName(marker.labelNames, marker.label, locale);
}

export function timelineSegmentLabel(segment: Pick<TimelineSegment, "label" | "labelNames">, locale: Locale) {
  return localizedName(segment.labelNames, segment.label, locale);
}

export function timelineSegmentShortLabel(segment: Pick<TimelineSegment, "shortLabel" | "shortLabelNames" | "label" | "labelNames">, locale: Locale) {
  return localizedName(segment.shortLabelNames ?? segment.labelNames, segment.shortLabel ?? segment.label, locale);
}
