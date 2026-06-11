import type { KeywordItem, RadarSettings } from "./types.js";

const highValue = [
  "looking for supplier",
  "need supplier",
  "need manufacturer",
  "looking for manufacturer",
  "china supplier",
  "chinese supplier",
  "factory",
  "factory price",
  "wholesale",
  "bulk order",
  "custom product",
  "private label",
  "oem",
  "odm",
  "import from china",
  "source from china",
  "buy from china",
  "where can i buy",
  "who can supply",
  "need this product",
  "supplier needed",
  "manufacturer needed",
  "dropshipping supplier",
  "fulfillment",
  "agent in china",
  "sourcing agent"
];

const normal = [
  "price",
  "quote",
  "quotation",
  "moq",
  "sample",
  "shipping",
  "logistics",
  "warehouse",
  "product",
  "catalog",
  "available",
  "stock",
  "brand",
  "customized",
  "packaging"
];

const negative = [
  "job",
  "hiring",
  "looking for job",
  "course",
  "training",
  "free",
  "giveaway",
  "scam",
  "investment",
  "crypto",
  "loan",
  "dating",
  "used only",
  "second hand only",
  "repair service"
];

function keywordItems(words: string[], category: KeywordItem["category"]): KeywordItem[] {
  return words.map((text) => ({
    id: `${category}-${text.replace(/[^a-z0-9]+/gi, "-")}`,
    text,
    category,
    enabled: true
  }));
}

export const defaultSettings: RadarSettings = {
  keywords: [
    ...keywordItems(highValue, "highValue"),
    ...keywordItems(normal, "normal"),
    ...keywordItems(negative, "negative")
  ],
  alerts: {
    soundEnabled: true,
    flashWindowEnabled: true,
    desktopNotificationEnabled: true,
    newPostMinutes: 3,
    minimumScore: 70,
    requireHighValueKeyword: false,
    ignoreNegativeKeywordPosts: true,
    alertOncePerPost: true
  },
  autoScroll: {
    defaultScrollCount: 5,
    waitMsAfterScroll: 2500
  },
  groupMonitor: {
    enabled: false,
    defaultIntervalSeconds: 60,
    autoRefreshEnabled: false,
    autoRefreshSeconds: 120,
    groups: []
  },
  translation: {
    enabled: false,
    apiType: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    targetLanguage: "中文"
  }
};
