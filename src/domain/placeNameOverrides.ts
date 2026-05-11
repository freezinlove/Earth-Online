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

const enByZhName: Record<string, string> = {
  中国: "China",
  捷克: "Czechia",
  奥地利: "Austria",
  德国: "Germany",
  匈牙利: "Hungary",
  挪威: "Norway",
  瑞士: "Switzerland",
  日本: "Japan",
  法国: "France",
  意大利: "Italy",
  英国: "United Kingdom",
  美国: "United States",
  瑞典: "Sweden",
  布拉格: "Prague",
  维也纳: "Vienna",
  哈尔施塔特: "Hallstatt",
  萨尔茨堡: "Salzburg",
  柏林: "Berlin",
  慕尼黑: "Munich",
  苏黎世: "Zurich",
  奥斯陆: "Oslo",
  斯塔万格: "Stavanger",
  约尔珀兰: "Jorpeland",
  博肯: "Bokn",
  海于格松: "Haugesund",
  洛丁恩: "Lodingen",
  苏特兰: "Sortland",
  斯沃尔韦尔: "Svolvær",
  罗弗敦群岛: "Lofoten Islands",
  阿尔贝蒂娜博物馆: "Albertina Museum",
  维也纳国家歌剧院: "Vienna State Opera",
  柏林Tiergarten车站: "Berlin Tiergarten Station",
  峡湾边的宁静午后: "Quiet Afternoon by the Fjord",
  罗弗敦群岛的海岸小镇: "Coastal Village in the Lofoten Islands",
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

export function enPlaceNameOverride(value?: string) {
  return enByZhName[String(value ?? "").trim()];
}
