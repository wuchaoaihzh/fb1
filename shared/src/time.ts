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
  /^(\d+)\s*mins?$/i
];

const hourPatterns = [
  /^(\d+)\s*h(?:r|rs|our|ours)?$/i,
  /^(\d+)\s*hours?$/i
];

const dayPatterns = [
  /^(\d+)\s*d(?:ay|ays)?$/i,
  /^(\d+)\s*days?$/i
];

const weekPatterns = [
  /^(\d+)\s*w(?:eek|eeks)?$/i,
  /^(\d+)\s*weeks?$/i
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

function parseAbsoluteTime(text: string, now: Date): ParsedTimeResult | null {
  const normalized = text
    .replace(/ at /i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  const diffMinutes = Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 60_000));
  return {
    parsedPostTime: formatLocalDateTime(parsed),
    timeConfidence: "medium",
    minutesAgo: diffMinutes
  };
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

  if (["just now", "now"].includes(lower)) {
    return minusMinutes(now, 0);
  }

  if (lower === "yesterday") {
    return minusMinutes(now, 24 * 60);
  }

  return (
    matchNumbered(text, minutePatterns, 1, now) ||
    matchNumbered(text, hourPatterns, 60, now) ||
    matchNumbered(text, dayPatterns, 24 * 60, now) ||
    matchNumbered(text, weekPatterns, 7 * 24 * 60, now) ||
    parseAbsoluteTime(text, now) || {
      parsedPostTime: "时间未识别",
      timeConfidence: "unknown",
      statusNote: "时间未识别，需要人工确认"
    }
  );
}
