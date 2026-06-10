import type { TimeConfidence } from "./types.js";

export interface ParsedTimeResult {
  parsedPostTime: string;
  timeConfidence: TimeConfidence;
  minutesAgo?: number;
  statusNote?: string;
}

const minutePatterns = [
  /^(\d+)\s*m(?:in|ins|inute|inutes)?$/i,
  /^(\d+)\s*分钟(?:前)?$/,
  /^(\d+)\s*分(?:钟)?前$/
];

const hourPatterns = [
  /^(\d+)\s*h(?:r|rs|our|ours)?$/i,
  /^(\d+)\s*小时(?:前)?$/
];

const dayPatterns = [
  /^(\d+)\s*d(?:ay|ays)?$/i,
  /^(\d+)\s*天(?:前)?$/
];

const weekPatterns = [
  /^(\d+)\s*w(?:eek|eeks)?$/i,
  /^(\d+)\s*周(?:前)?$/
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

export function parseFacebookTime(rawText: string | undefined, now = new Date()): ParsedTimeResult {
  const text = (rawText || "").trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();

  if (!text) {
    return {
      parsedPostTime: "时间未识别",
      timeConfidence: "unknown",
      statusNote: "时间未识别，需要人工确认"
    };
  }

  if (["just now", "now", "刚刚"].includes(lower) || text === "刚才") {
    return minusMinutes(now, 0);
  }

  if (lower === "yesterday" || text === "昨天") {
    return minusMinutes(now, 24 * 60);
  }

  return (
    matchNumbered(text, minutePatterns, 1, now) ||
    matchNumbered(text, hourPatterns, 60, now) ||
    matchNumbered(text, dayPatterns, 24 * 60, now) ||
    matchNumbered(text, weekPatterns, 7 * 24 * 60, now) || {
      parsedPostTime: "时间未识别",
      timeConfidence: "unknown",
      statusNote: "时间未识别，需要人工确认"
    }
  );
}
