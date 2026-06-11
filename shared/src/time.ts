import type { TimeConfidence } from "./types.js";

export interface ParsedTimeResult {
  parsedPostTime: string;
  timeConfidence: TimeConfidence;
  minutesAgo?: number;
  statusNote?: string;
}

const minutePatterns = [
  /^(\d+)\s*m(?:in|ins|inute|inutes)?$/i,
  /^(\d+)\s*minutes?$/i,
  /^(\d+)\s*mins?$/i,
  /^(\d+)\s*分(?:钟)?(?:前)?$/i
];

const hourPatterns = [
  /^(\d+)\s*h(?:r|rs|our|ours)?$/i,
  /^(\d+)\s*hours?$/i,
  /^(\d+)\s*小?时(?:前)?$/i
];

const dayPatterns = [
  /^(\d+)\s*d(?:ay|ays)?$/i,
  /^(\d+)\s*days?$/i,
  /^(\d+)\s*天前?$/i
];

const weekPatterns = [
  /^(\d+)\s*w(?:eek|eeks)?$/i,
  /^(\d+)\s*weeks?$/i,
  /^(\d+)\s*周前?$/i
];

const monthTokenPattern = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const monthNamePattern = new RegExp(monthTokenPattern, "i");
const englishWeekdayPattern = /^(Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Tues(?:day)?|Wed(?:nesday)?|Thu(?:rsday)?|Thur(?:sday)?|Fri(?:day)?|Sat(?:urday)?)$/i;
const chineseWeekdayMap = new Map([
  ["周日", 0],
  ["周天", 0],
  ["星期日", 0],
  ["星期天", 0],
  ["周一", 1],
  ["星期一", 1],
  ["周二", 2],
  ["星期二", 2],
  ["周三", 3],
  ["星期三", 3],
  ["周四", 4],
  ["星期四", 4],
  ["周五", 5],
  ["星期五", 5],
  ["周六", 6],
  ["星期六", 6]
]);
const monthMap = new Map<string, number>([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11]
]);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function unknownTime(): ParsedTimeResult {
  return {
    parsedPostTime: "时间未识别",
    timeConfidence: "unknown",
    statusNote: "时间未识别，需要人工确认"
  };
}

export function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function formatLocalDateTime(date: Date): string {
  return `${formatDateKey(date)} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

function minusMinutes(now: Date, minutes: number): ParsedTimeResult {
  const parsed = new Date(now.getTime() - minutes * 60_000);
  return {
    parsedPostTime: formatLocalDateTime(parsed),
    timeConfidence: "high",
    minutesAgo: minutes
  };
}

function matchNumbered(text: string, patterns: RegExp[], multiplier: number, now: Date): ParsedTimeResult | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return minusMinutes(now, Number(match[1]) * multiplier);
    }
  }
  return null;
}

function normalizeAbsoluteTimeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*[·|]\s*/g, " ")
    .replace(/\bEdited\b/gi, " ")
    .replace(/\b([AP])\.?M\.?\b/gi, "$1M")
    .trim();
}

function adjustHour(hour: number, meridiem?: string): number {
  if (!meridiem) return hour;
  const token = meridiem.toLowerCase();
  if (token === "pm" && hour < 12) return hour + 12;
  if (token === "am" && hour === 12) return 0;
  if (["下午", "晚上"].includes(meridiem) && hour < 12) return hour + 12;
  if (meridiem === "中午" && hour < 11) return hour + 12;
  if (["上午", "早上"].includes(meridiem) && hour === 12) return 0;
  return hour;
}

function coerceRecentDate(date: Date, now: Date, hasExplicitYear: boolean): Date {
  if (hasExplicitYear) return date;
  if (date.getTime() - now.getTime() > 36 * 60 * 60 * 1000) {
    date.setFullYear(date.getFullYear() - 1);
  }
  return date;
}

function toParsedResult(parsed: Date, now: Date, confidence: TimeConfidence): ParsedTimeResult {
  const diffMinutes = Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 60_000));
  return {
    parsedPostTime: formatLocalDateTime(parsed),
    timeConfidence: confidence,
    minutesAgo: diffMinutes
  };
}

function parseEnglishMonthTime(text: string, now: Date): ParsedTimeResult | null {
  const match = normalizeAbsoluteTimeText(text).match(
    new RegExp(`^${monthTokenPattern}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?(?:\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*([AP]M))?$`, "i")
  );
  if (!match) return null;
  const monthIndex = monthMap.get(match[1].toLowerCase());
  if (monthIndex === undefined) return null;
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : now.getFullYear();
  const hour = adjustHour(match[4] ? Number(match[4]) : 0, match[6] || undefined);
  const minute = match[5] ? Number(match[5]) : 0;
  const parsed = new Date(year, monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(parsed.getTime())) return null;
  return toParsedResult(coerceRecentDate(parsed, now, Boolean(match[3])), now, "medium");
}

function parseEnglishDayMonthTime(text: string, now: Date): ParsedTimeResult | null {
  const match = normalizeAbsoluteTimeText(text).match(
    new RegExp(`^(\\d{1,2})\\s+${monthTokenPattern}(?:,\\s*(\\d{4}))?(?:\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*([AP]M))?$`, "i")
  );
  if (!match) return null;
  const day = Number(match[1]);
  const monthIndex = monthMap.get(match[2].toLowerCase());
  if (monthIndex === undefined) return null;
  const year = match[3] ? Number(match[3]) : now.getFullYear();
  const hour = adjustHour(match[4] ? Number(match[4]) : 0, match[6] || undefined);
  const minute = match[5] ? Number(match[5]) : 0;
  const parsed = new Date(year, monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(parsed.getTime())) return null;
  return toParsedResult(coerceRecentDate(parsed, now, Boolean(match[3])), now, "medium");
}

function parseChineseAbsoluteTime(text: string, now: Date): ParsedTimeResult | null {
  const match = normalizeAbsoluteTimeText(text).match(
    /^(?:(\d{4})年\s*)?(\d{1,2})月(\d{1,2})日(?:\s*(上午|下午|中午|晚上|早上)?\s*(\d{1,2})(?:[:：](\d{2}))?)?$/
  );
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : now.getFullYear();
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = adjustHour(match[5] ? Number(match[5]) : 0, match[4] || undefined);
  const minute = match[6] ? Number(match[6]) : 0;
  const parsed = new Date(year, monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(parsed.getTime())) return null;
  return toParsedResult(coerceRecentDate(parsed, now, Boolean(match[1])), now, "medium");
}

function weekdayIndex(text: string, now: Date): number | null {
  const normalized = text.trim();
  if (normalized === "今天" || /^today$/i.test(normalized)) return now.getDay();
  if (normalized === "昨天" || /^yesterday$/i.test(normalized)) return (now.getDay() + 6) % 7;
  const chinese = chineseWeekdayMap.get(normalized);
  if (chinese !== undefined) return chinese;
  if (!englishWeekdayPattern.test(normalized)) return null;
  const key = normalized.slice(0, 3).toLowerCase();
  return new Map([
    ["sun", 0],
    ["mon", 1],
    ["tue", 2],
    ["wed", 3],
    ["thu", 4],
    ["fri", 5],
    ["sat", 6]
  ]).get(key) ?? null;
}

function parseWeekdayTime(text: string, now: Date): ParsedTimeResult | null {
  const normalized = normalizeAbsoluteTimeText(text);
  const match = normalized.match(
    /^(Today|Yesterday|Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Tues(?:day)?|Wed(?:nesday)?|Thu(?:rsday)?|Thur(?:sday)?|Fri(?:day)?|Sat(?:urday)?|今天|昨天|周[一二三四五六日天]|星期[一二三四五六日天])(?:\s+(?:at\s+)?)?(?:(上午|下午|中午|晚上|早上)?\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)?)?$/i
  );
  if (!match) return null;
  const targetWeekday = weekdayIndex(match[1], now);
  if (targetWeekday === null) return null;
  const parsed = new Date(now);
  parsed.setMilliseconds(0);
  parsed.setSeconds(0);
  const hour = adjustHour(match[3] ? Number(match[3]) : 0, match[5] || match[2] || undefined);
  const minute = match[4] ? Number(match[4]) : 0;
  parsed.setHours(hour, minute, 0, 0);

  if (match[1] === "昨天" || /^yesterday$/i.test(match[1])) {
    parsed.setDate(parsed.getDate() - 1);
  } else if (!(match[1] === "今天" || /^today$/i.test(match[1]))) {
    let distance = (parsed.getDay() - targetWeekday + 7) % 7;
    if (distance === 0 && parsed.getTime() > now.getTime()) distance = 7;
    parsed.setDate(parsed.getDate() - distance);
  } else if (parsed.getTime() > now.getTime()) {
    parsed.setHours(0, 0, 0, 0);
  }

  return toParsedResult(parsed, now, "medium");
}

function parseGenericDate(text: string, now: Date): ParsedTimeResult | null {
  const manualMatch = normalizeAbsoluteTimeText(text).match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2})(?:[:.](\d{2}))?(?:[:.](\d{2}))?)?$/
  );
  if (manualMatch) {
    const parsed = new Date(
      Number(manualMatch[1]),
      Number(manualMatch[2]) - 1,
      Number(manualMatch[3]),
      manualMatch[4] ? Number(manualMatch[4]) : 0,
      manualMatch[5] ? Number(manualMatch[5]) : 0,
      manualMatch[6] ? Number(manualMatch[6]) : 0,
      0
    );
    if (!Number.isNaN(parsed.getTime())) return toParsedResult(parsed, now, "medium");
  }
  const normalized = normalizeAbsoluteTimeText(text)
    .replace(/(\d{1,2})\.(\d{2})\.(\d{2})$/, "$1:$2:$3")
    .replace(/(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}:\d{2}(?::\d{2})?)/, "$1-$2-$3T$4");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return toParsedResult(parsed, now, "medium");
}

function extractAbsoluteTimeFragment(text: string): string {
  const normalized = normalizeAbsoluteTimeText(text);
  const patterns = [
    new RegExp(`\\d{1,2}\\s+${monthTokenPattern}(?:,\\s*\\d{4})?(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*[AP]M)?`, "i"),
    new RegExp(`${monthTokenPattern}\\s+\\d{1,2}(?:,\\s*\\d{4})?(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*[AP]M)?`, "i"),
    /(?:\d{4}年\s*)?\d{1,2}月\d{1,2}日(?:\s*(?:上午|下午|中午|晚上|早上)?\s*\d{1,2}(?:[:：]\d{2})?)?/,
    /(?:Today|Yesterday|Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Tues(?:day)?|Wed(?:nesday)?|Thu(?:rsday)?|Thur(?:sday)?|Fri(?:day)?|Sat(?:urday)?|今天|昨天|周[一二三四五六日天]|星期[一二三四五六日天])(?:\s+(?:at\s+)?)?(?:上午|下午|中午|晚上|早上)?\s*\d{1,2}(?::\d{2})?\s*(?:[AP]M)?/i,
    /\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}(?:[:.]\d{2})(?:[:.]\d{2})?)?/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[0]) return match[0].trim();
  }
  return normalized;
}

function parseAbsoluteTime(text: string, now: Date): ParsedTimeResult | null {
  const fragment = extractAbsoluteTimeFragment(text);
  return (
    parseEnglishDayMonthTime(fragment, now) ||
    parseEnglishMonthTime(fragment, now) ||
    parseChineseAbsoluteTime(fragment, now) ||
    parseWeekdayTime(fragment, now) ||
    parseGenericDate(fragment, now)
  );
}

export function parseFacebookTime(rawText: string | undefined, now = new Date()): ParsedTimeResult {
  const text = (rawText || "").trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();

  if (!text) return unknownTime();
  if (["just now", "now", "刚刚"].includes(lower) || text === "刚刚") return minusMinutes(now, 0);
  if (lower === "yesterday" || text === "昨天") return minusMinutes(now, 24 * 60);

  return (
    matchNumbered(text, minutePatterns, 1, now) ||
    matchNumbered(text, hourPatterns, 60, now) ||
    matchNumbered(text, dayPatterns, 24 * 60, now) ||
    matchNumbered(text, weekPatterns, 7 * 24 * 60, now) ||
    parseAbsoluteTime(text, now) ||
    unknownTime()
  );
}
