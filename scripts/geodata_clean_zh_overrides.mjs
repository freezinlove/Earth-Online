import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const geodataDir = path.join(rootDir, "external", "geodata");
const overridesPath = path.join(geodataDir, "zh-name-overrides.json");

const manualNamesByGeonameId = {
  209000: "莫巴",
  361478: "巴达里",
  562820: "菲利",
  567990: "奇斯托波尔",
  970566: "奈杰尔",
  982899: "利希滕堡",
  1180809: "达杜",
  1262995: "米尔扎普尔-温迪亚恰尔",
  1264773: "洛尼",
  1271942: "法鲁卡巴德-法泰赫加尔",
  1644932: "恩德",
  1699833: "梅塞德斯",
  1717926: "卡塔曼",
  1725115: "比尼扬",
  1854530: "大井",
  2145936: "塔格拉农",
  2190224: "黑斯廷斯",
  2555882: "贝尼恩扎尔",
  2855598: "潘科",
  2947022: "博根豪森",
  3429980: "皮拉尔",
  3520235: "里奥贝尔德",
  3617708: "马塔加尔帕",
  3655131: "拉利伯塔德",
  3981984: "特帕蒂特兰",
  4258313: "格林伍德",
  485630: "斯维布洛沃",
  491280: "索科尔",
  500019: "雷巴茨科耶",
  517161: "新切廖穆什基",
  518879: "新吉列耶沃",
  4890701: "埃奇沃特",
  4899911: "林肯公园",
  4911600: "斯科基",
  4912013: "南岸",
  4913723: "廷利帕克",
  5101170: "米德尔敦",
  5105608: "尤宁",
  5107464: "阿斯托里亚",
  5110077: "布伦特伍德",
  5112375: "奇克托瓦加",
  5114418: "赛普拉斯希尔斯",
  5115985: "东纽约",
  5117549: "福德姆",
  5122331: "艾恩德科伊特",
  532535: "柳布利诺",
  567311: "达奇诺耶",
  576432: "比比列沃",
  5130572: "帕克切斯特",
  5143056: "韦克菲尔德",
  5143307: "华盛顿高地",
  5143620: "西奥尔巴尼",
  5386039: "兰乔佩尼亚斯基托斯",
  5425043: "海兰兹牧场",
  6544491: "萨拉曼卡",
  6544494: "马德里中心区",
  7302861: "阿肖克讷格尔-卡利扬加尔",
  3445968: "图库鲁维",
  6138791: "圣米歇尔",
  7521912: "孔索拉桑",
  8504959: "芬兰斯基",
};

const traditionalMap = {
  區: "区",
  縣: "县",
  鄉: "乡",
  鎮: "镇",
  市: "市",
  臺: "台",
  灣: "湾",
  紐: "纽",
  國: "国",
  爾: "尔",
  亞: "亚",
  馬: "马",
  達: "达",
  蘭: "兰",
  羅: "罗",
  魯: "鲁",
  貝: "贝",
  賈: "贾",
  傑: "杰",
  剛: "刚",
  薩: "萨",
  聖: "圣",
  東: "东",
  廣: "广",
  門: "门",
  倫: "伦",
  維: "维",
  納: "纳",
  爾: "尔",
  費: "费",
  布: "布",
  龐: "庞",
  開: "开",
  羅: "罗",
  奧: "奥",
  齊: "齐",
  諾: "诺",
  葉: "叶",
  克: "克",
  義: "义",
  遜: "逊",
  爾: "尔",
  斯: "斯",
  濟: "济",
  約: "约",
  華: "华",
  頓: "顿",
  園: "园",
  車: "车",
  鐵: "铁",
  農: "农",
  懸: "悬",
  場: "场",
  頭: "头",
  貢: "贡",
  烏: "乌",
  蘇: "苏",
  賽: "赛",
  劍: "剑",
  聯: "联",
  維: "维",
  沃: "沃",
  裡: "里",
  裏: "里",
  麥: "麦",
  迪: "迪",
  遷: "迁",
  瑪: "玛",
  祿: "禄",
  龍: "龙",
  樂: "乐",
  庫: "库",
  萬: "万",
  韋: "韦",
  圖: "图",
  諾: "诺",
  曉: "晓",
  緬: "缅",
  贊: "赞",
  喬: "乔",
  澤: "泽",
  蔔: "卜",
  賓: "宾",
  瓊: "琼",
  札: "札",
  麗: "丽",
  茲: "兹",
  紹: "绍",
  溫: "温",
  貴: "贵",
  盧: "卢",
  盡: "尽",
  貝: "贝",
  內: "内",
  濱: "滨",
  畢: "毕",
  盧: "卢",
  爾: "尔",
  魯: "鲁",
  盧: "卢",
};

function toSimplified(value) {
  return Array.from(value)
    .map((char) => traditionalMap[char] ?? char)
    .join("");
}

function stripDisambiguation(value) {
  return value
    .replace(/\s*[（(][^()（）]*(?:国家|城市|市辖区|市轄區|州|省|县|縣|区|區|郡|镇|鎮|村|乡|鄉|居民点|居民點|曼哈顿|曼哈頓|布鲁克林|布魯克林|皇后区|皇后區|芝加哥|马德里|馬德里|莫斯科|德国|德國|印度|菲律宾|菲律賓|巴基斯坦|埃及|厄瓜多尔|厄瓜多爾|刚果|剛果|南非|新西兰|紐西蘭)[^()（）]*[）)]/g, "")
    .replace(/\s*[（(]\d{3,4}年[）)]/g, "");
}

function cleanName(value) {
  return toSimplified(stripDisambiguation(String(value ?? "")))
    .replace(/Tinley公园/g, "廷利帕克")
    .replace(/\s+/g, "")
    .trim();
}

const data = JSON.parse(await fs.readFile(overridesPath, "utf8"));
const namesByGeonameId = data.namesByGeonameId && typeof data.namesByGeonameId === "object" ? data.namesByGeonameId : {};
const sourceByGeonameId = data.sourceByGeonameId && typeof data.sourceByGeonameId === "object" ? data.sourceByGeonameId : {};
const cleanupByGeonameId = data.cleanupByGeonameId && typeof data.cleanupByGeonameId === "object" ? data.cleanupByGeonameId : {};

const changed = [];
for (const [id, current] of Object.entries(namesByGeonameId)) {
  const next = manualNamesByGeonameId[id] ?? cleanName(current);
  if (!next || next === current) continue;
  namesByGeonameId[id] = next;
  sourceByGeonameId[id] = manualNamesByGeonameId[id] ? "manual-cleanup" : (sourceByGeonameId[id] ?? "wikidata-cleaned");
  cleanupByGeonameId[id] = current;
  changed.push({ id, before: current, after: next });
}

await fs.writeFile(
  overridesPath,
  `${JSON.stringify(
    {
      ...data,
      source: data.source,
      namesByGeonameId: Object.fromEntries(Object.entries(namesByGeonameId).sort(([left], [right]) => Number(left) - Number(right))),
      wikidataEntityByGeonameId: data.wikidataEntityByGeonameId,
      sourceByGeonameId: Object.fromEntries(Object.entries(sourceByGeonameId).sort(([left], [right]) => Number(left) - Number(right))),
      cleanupByGeonameId: Object.fromEntries(Object.entries(cleanupByGeonameId).sort(([left], [right]) => Number(left) - Number(right))),
    },
    null,
    2,
  )}\n`,
);

console.log(`Cleaned ${changed.length} Chinese place-name overrides.`);
console.log(changed.slice(0, 80).map((item) => `${item.id}: ${item.before} -> ${item.after}`).join("\n"));
