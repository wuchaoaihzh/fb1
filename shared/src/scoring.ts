import type { RadarPost, RadarSettings } from "./types.js";
import { parseFacebookTime } from "./time.js";

export interface ScoreInput {
  postText?: string;
  rawTimeText?: string;
  parsedPostTime?: string;
}

export interface ScoreResult {
  score: number;
  matchedKeywords: string[];
  negativeKeywords: string[];
  scoreReasons: string[];
  isNewPost: boolean;
}

function enabledKeywords(settings: RadarSettings, category: "highValue" | "normal" | "negative"): string[] {
  return settings.keywords
    .filter((keyword) => keyword.enabled && keyword.category === category)
    .map((keyword) => keyword.text.toLowerCase());
}

function findMatches(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword));
}

export function scorePost(input: ScoreInput, settings: RadarSettings, now = new Date()): ScoreResult {
  const text = input.postText || "";
  const highMatches = findMatches(text, enabledKeywords(settings, "highValue"));
  const normalMatches = findMatches(text, enabledKeywords(settings, "normal"));
  const negativeMatches = findMatches(text, enabledKeywords(settings, "negative"));
  const parsed = parseFacebookTime(input.rawTimeText, now);
  const reasons: string[] = [];
  let score = 0;

  if (highMatches.length > 0) {
    const points = Math.min(40, highMatches.length * 20);
    score += points;
    reasons.push(`高价值关键词 +${points}`);
  }

  if (normalMatches.length > 0) {
    const points = Math.min(15, normalMatches.length * 5);
    score += points;
    reasons.push(`普通关键词 +${points}`);
  }

  const minutesAgo = parsed.minutesAgo;
  let isNewPost = false;
  if (typeof minutesAgo === "number") {
    isNewPost = minutesAgo <= settings.alerts.newPostMinutes;
    if (minutesAgo <= 1) {
      score += 30;
      reasons.push("1 分钟内 +30");
    } else if (minutesAgo <= 3) {
      score += 25;
      reasons.push("3 分钟内 +25");
    } else if (minutesAgo <= 5) {
      score += 20;
      reasons.push("5 分钟内 +20");
    } else if (minutesAgo <= 10) {
      score += 10;
      reasons.push("10 分钟内 +10");
    }
  }

  if (text.length >= 80 && (highMatches.length > 0 || normalMatches.includes("product"))) {
    score += 10;
    reasons.push("内容较完整 +10");
  }

  if (negativeMatches.length > 0) {
    const penalty = Math.min(50, negativeMatches.length * 20);
    score -= penalty;
    reasons.push(`排除关键词 -${penalty}`);
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    matchedKeywords: [...highMatches, ...normalMatches],
    negativeKeywords: negativeMatches,
    scoreReasons: reasons,
    isNewPost
  };
}

export function shouldTriggerAlert(post: RadarPost, settings: RadarSettings): boolean {
  if (settings.alerts.alertOncePerPost && post.alertTriggered) return false;
  if (!post.isNewPost) return false;
  if (post.score < settings.alerts.minimumScore) return false;
  if (settings.alerts.requireHighValueKeyword) {
    const highValue = enabledKeywords(settings, "highValue");
    const hasHighValue = post.matchedKeywords.some((keyword) => highValue.includes(keyword.toLowerCase()));
    if (!hasHighValue) return false;
  }
  if (settings.alerts.ignoreNegativeKeywordPosts && post.negativeKeywords.length > 0) return false;
  return true;
}
