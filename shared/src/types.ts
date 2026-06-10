export type TimeConfidence = "high" | "medium" | "low" | "unknown";

export type CollectionState = "collecting" | "paused" | "stopped";

export type KeywordCategory = "highValue" | "normal" | "negative";

export interface KeywordItem {
  id: string;
  text: string;
  category: KeywordCategory;
  enabled: boolean;
}

export interface RadarPost {
  postId: string;
  groupName: string;
  groupUrl: string;
  authorName: string;
  postText: string;
  postTextPreview: string;
  postUrl: string;
  rawTimeText: string;
  parsedPostTime: string;
  timeConfidence: TimeConfidence;
  isNewPost: boolean;
  matchedKeywords: string[];
  negativeKeywords: string[];
  score: number;
  scoreReasons: string[];
  alertTriggered: boolean;
  collectedAt: string;
  sourceWindowId: string;
  sourceAccountNote: string;
  statusNote: string;
  ignored?: boolean;
  handled?: boolean;
}

export interface AlertSettings {
  soundEnabled: boolean;
  flashWindowEnabled: boolean;
  desktopNotificationEnabled: boolean;
  newPostMinutes: 1 | 3 | 5 | 10;
  minimumScore: 60 | 70 | 80;
  requireHighValueKeyword: boolean;
  ignoreNegativeKeywordPosts: boolean;
  alertOncePerPost: boolean;
}

export interface AutoScrollSettings {
  defaultScrollCount: number;
  waitMsAfterScroll: number;
}

export interface RadarSettings {
  keywords: KeywordItem[];
  alerts: AlertSettings;
  autoScroll: AutoScrollSettings;
}

export interface ExtensionClientInfo {
  clientId: string;
  tabUrl?: string;
  userAgent?: string;
  connectedAt: string;
}

export interface RadarStats {
  totalPosts: number;
  newPosts: number;
  todayPosts: number;
  alertedPosts: number;
  unknownTimePosts: number;
  connectedClients: number;
}

export type BridgeMessage =
  | { type: "extension_connected"; clientId: string; payload?: Partial<ExtensionClientInfo> }
  | { type: "extension_disconnected"; clientId: string }
  | { type: "post_collected"; clientId: string; payload: Partial<RadarPost> }
  | { type: "posts_batch_collected"; clientId: string; payload: Partial<RadarPost>[] }
  | { type: "settings_updated"; payload: RadarSettings }
  | { type: "start_collecting" }
  | { type: "stop_collecting" }
  | { type: "start_auto_scroll"; payload: { count: number } }
  | { type: "stop_auto_scroll" }
  | { type: "alert_triggered"; payload: { postId: string } }
  | { type: "ping"; clientId?: string }
  | { type: "pong"; clientId?: string };
