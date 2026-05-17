const REGION_CONTINENT_ENTRIES =
  "AD:EU AE:AS AF:AS AG:NA AI:NA AL:EU AM:AS AO:AF AQ:AN AR:SA AS:OC AT:EU AU:OC AW:NA AX:EU AZ:AS BA:EU BB:NA BD:AS BE:EU BF:AF BG:EU BH:AS BI:AF BJ:AF BL:NA BM:NA BN:AS BO:SA BQ:NA BR:SA BS:NA BT:AS BV:AN BW:AF BY:EU BZ:NA CA:NA CC:AS CD:AF CF:AF CG:AF CH:EU CI:AF CK:OC CL:SA CM:AF CN:AS CO:SA CR:NA CU:NA CV:AF CW:NA CX:OC CY:EU CZ:EU DE:EU DJ:AF DK:EU DM:NA DO:NA DZ:AF EC:SA EE:EU EG:AF EH:AF ER:AF ES:EU ET:AF FI:EU FJ:OC FK:SA FM:OC FO:EU FR:EU GA:AF GB:EU GD:NA GE:AS GF:SA GG:EU GH:AF GI:EU GL:NA GM:AF GN:AF GP:NA GQ:AF GR:EU GS:AN GT:NA GU:OC GW:AF GY:SA HK:AS HM:AN HN:NA HR:EU HT:NA HU:EU ID:AS IE:EU IL:AS IM:EU IN:AS IO:AS IQ:AS IR:AS IS:EU IT:EU JE:EU JM:NA JO:AS JP:AS KE:AF KG:AS KH:AS KI:OC KM:AF KN:NA KP:AS KR:AS XK:EU KW:AS KY:NA KZ:AS LA:AS LB:AS LC:NA LI:EU LK:AS LR:AF LS:AF LT:EU LU:EU LV:EU LY:AF MA:AF MC:EU MD:EU ME:EU MF:NA MG:AF MH:OC MK:EU ML:AF MM:AS MN:AS MO:AS MP:OC MQ:NA MR:AF MS:NA MT:EU MU:AF MV:AS MW:AF MX:NA MY:AS MZ:AF NA:AF NC:OC NE:AF NF:OC NG:AF NI:NA NL:EU NO:EU NP:AS NR:OC NU:OC NZ:OC OM:AS PA:NA PE:SA PF:OC PG:OC PH:AS PK:AS PL:EU PM:NA PN:OC PR:NA PS:AS PT:EU PW:OC PY:SA QA:AS RE:AF RO:EU RS:EU RU:EU RW:AF SA:AS SB:OC SC:AF SD:AF SS:AF SE:EU SG:AS SH:AF SI:EU SJ:EU SK:EU SL:AF SM:EU SN:AF SO:AF SR:SA ST:AF SV:NA SX:NA SY:AS SZ:AF TC:NA TD:AF TF:AN TG:AF TH:AS TJ:AS TK:OC TL:OC TM:AS TN:AF TO:OC TR:AS TT:NA TV:OC TW:AS TZ:AF UA:EU UG:AF UM:OC US:NA UY:SA UZ:AS VA:EU VC:NA VE:SA VG:NA VI:NA VN:AS VU:OC WF:OC WS:OC YE:AS YT:AF ZA:AF ZM:AF ZW:AF CS:EU AN:NA";

const CONTINENT_BY_GEONAMES_CODE = {
  AF: "africa",
  AN: "antarctica",
  AS: "asia",
  EU: "europe",
  NA: "north-america",
  OC: "oceania",
  SA: "south-america",
};

const CONTINENT_LABELS = {
  africa: { zh: "非洲多城", en: "Africa multi-city" },
  antarctica: { zh: "南极洲多城", en: "Antarctica multi-city" },
  asia: { zh: "亚洲多城", en: "Asia multi-city" },
  europe: { zh: "欧洲多城", en: "Europe multi-city" },
  "north-america": { zh: "北美多城", en: "North America multi-city" },
  oceania: { zh: "大洋洲多城", en: "Oceania multi-city" },
  "south-america": { zh: "南美多城", en: "South America multi-city" },
};

const REGION_COUNTRY_OVERRIDES = {
  HK: {
    countryCode: "CN",
    aliases: ["Hong Kong", "Hongkong", "Hong Kong SAR", "Hong Kong SAR China", "HK", "中国香港", "中国香港特别行政区", "香港"],
  },
  MO: {
    countryCode: "CN",
    aliases: ["Macao", "Macau", "Macao SAR", "Macao SAR China", "MO", "中国澳门", "中国澳门特别行政区", "澳门"],
  },
  TW: {
    countryCode: "CN",
    aliases: ["Taiwan", "Taiwan Province of China", "TW", "Republic of China", "ROC", "中国台湾", "台湾", "臺灣", "台灣"],
  },
};

const MANUAL_COUNTRY_ALIASES = {
  CN: ["PRC", "People's Republic of China", "Mainland China"],
  CZ: ["Czech Republic"],
  GB: ["Great Britain", "Britain", "UK"],
  US: ["United States of America", "USA"],
  KR: ["Korea, Republic of", "Republic of Korea"],
  KP: ["Korea, Democratic People's Republic of", "DPRK", "North Korea"],
  RU: ["Russian Federation"],
  IR: ["Iran, Islamic Republic of"],
  LA: ["Laos", "Lao PDR", "Lao People's Democratic Republic"],
  MD: ["Moldova, Republic of"],
  SY: ["Syria", "Syrian Arab Republic"],
  TZ: ["Tanzania, United Republic of"],
  VE: ["Venezuela, Bolivarian Republic of"],
  BO: ["Bolivia, Plurinational State of"],
  BN: ["Brunei", "Brunei Darussalam"],
  CI: ["Ivory Coast", "Cote d'Ivoire", "Côte d'Ivoire"],
  CD: ["DR Congo", "Democratic Republic of the Congo", "Congo Kinshasa", "Congo-Kinshasa"],
  CG: ["Republic of the Congo", "Congo Brazzaville", "Congo-Brazzaville"],
  CV: ["Cape Verde"],
  SZ: ["Swaziland"],
  MK: ["North Macedonia", "Macedonia"],
  PS: ["Palestine", "State of Palestine"],
  VN: ["Viet Nam"],
  TR: ["Turkey", "Türkiye"],
  NL: ["The Netherlands", "Holland"],
  AE: ["UAE"],
};

const zhRegionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const enRegionNames = new Intl.DisplayNames(["en"], { type: "region" });

function regionName(displayNames, code, fallback) {
  try {
    return displayNames.of(code) || fallback || code;
  } catch {
    return fallback || code;
  }
}

function buildCountryRecords() {
  const byCode = new Map();
  const entries = REGION_CONTINENT_ENTRIES.split(/\s+/)
    .filter(Boolean)
    .map((entry) => {
      const [code, continentCode] = entry.split(":");
      return { code, continent: CONTINENT_BY_GEONAMES_CODE[continentCode] };
    });
  const continentByCode = new Map(entries.map((entry) => [entry.code, entry.continent]));

  for (const { code, continent } of entries) {
    const override = REGION_COUNTRY_OVERRIDES[code];
    const countryCode = override?.countryCode ?? code;
    const record =
      byCode.get(countryCode) ??
      {
        code: countryCode,
        zh: regionName(zhRegionNames, countryCode),
        en: regionName(enRegionNames, countryCode),
        continent: continentByCode.get(countryCode) ?? continent,
        aliases: [],
      };

    record.aliases.push(
      code,
      regionName(zhRegionNames, code),
      regionName(enRegionNames, code),
      ...(override?.aliases ?? []),
      ...(MANUAL_COUNTRY_ALIASES[code] ?? []),
      ...(MANUAL_COUNTRY_ALIASES[countryCode] ?? []),
    );
    byCode.set(countryCode, record);
  }

  return Array.from(byCode.values()).map((record) => ({
    ...record,
    aliases: Array.from(new Set(record.aliases.filter(Boolean))),
  }));
}

const COUNTRY_RECORDS = buildCountryRecords();
const recordsByAlias = new Map();
for (const record of COUNTRY_RECORDS) {
  for (const alias of [record.code, record.zh, record.en, ...record.aliases]) {
    const key = countryAliasKey(alias);
    if (key) recordsByAlias.set(key, record);
  }
}

export function normalizedCountryText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function countryAliasKey(value) {
  return normalizedCountryText(value).replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

export function countryAliasKeys(value) {
  const record = countryRecord(value);
  if (!record) {
    const key = countryAliasKey(value);
    return key ? [key] : [];
  }
  return [record.code, record.zh, record.en, ...record.aliases].map(countryAliasKey).filter(Boolean);
}

export function countryRecord(value) {
  return recordsByAlias.get(countryAliasKey(value));
}

export function normalizeCountryName(value) {
  const record = countryRecord(value);
  if (record) return record.zh;
  const clean = String(value ?? "").trim();
  return clean || undefined;
}

export function normalizeCountryNames(names, fallback) {
  const record = countryRecord(names?.zh) ?? countryRecord(names?.en) ?? countryRecord(names?.local) ?? countryRecord(fallback);
  if (record) {
    return {
      zh: record.zh,
      en: record.en,
      local: record.zh,
    };
  }

  const cleanFallback = normalizeCountryName(fallback);
  if (!cleanFallback) return undefined;
  return {
    zh: names?.zh ?? cleanFallback,
    en: names?.en ?? cleanFallback,
    local: names?.local ?? cleanFallback,
  };
}

export function normalizeCountryDescription(country, names) {
  const countryName = normalizeCountryName(country ?? names?.zh ?? names?.en ?? names?.local);
  return {
    country: countryName,
    countryNames: normalizeCountryNames(names, countryName),
  };
}

export function uniqueNormalizedCountries(values) {
  const countries = [];
  const seen = new Set();
  for (const value of values) {
    const country = normalizeCountryName(value);
    if (!country || country === "待确认") continue;
    const key = countryAliasKey(country);
    if (seen.has(key)) continue;
    seen.add(key);
    countries.push(country);
  }
  return countries;
}

export function countryContinent(value) {
  return countryRecord(value)?.continent;
}

export function multiCityCountryLabel(countries, locale = "zh") {
  const normalized = uniqueNormalizedCountries(countries);
  const language = locale === "en" ? "en" : "zh";
  if (normalized.length === 1) {
    const record = countryRecord(normalized[0]);
    const country = record?.[language] ?? normalized[0];
    return language === "en" ? `${country} multi-city` : `${country}多城`;
  }

  const continents = Array.from(new Set(normalized.map(countryContinent).filter(Boolean)));
  if (continents.length === 1 && CONTINENT_LABELS[continents[0]]) return CONTINENT_LABELS[continents[0]][language];
  return language === "en" ? "Multi-country multi-city" : "多国多城";
}
