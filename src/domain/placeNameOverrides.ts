const zhByNormalizedName: Record<string, string> = {
  bokn: "博肯",
  haugesund: "海于格松",
  jorpeland: "约尔珀兰",
  "jørpeland": "约尔珀兰",
  lodingen: "洛丁恩",
  "lødingen": "洛丁恩",
  oslo: "奥斯陆",
  stavanger: "斯塔万格",
  svolvaer: "斯沃尔韦尔",
  "svolvær": "斯沃尔韦尔",
};

function normalizedText(value?: string) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function hasHan(value?: string) {
  return /[\u4e00-\u9fff]/u.test(value ?? "");
}

export function zhPlaceNameOverride(value?: string) {
  const direct = String(value ?? "").toLowerCase().trim();
  return zhByNormalizedName[direct] ?? zhByNormalizedName[normalizedText(value)];
}
