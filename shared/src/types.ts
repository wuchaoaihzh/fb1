export type TimeConfidence = "high" | "medium" | "low" | "unknown";

export type CollectionState = "stopped" | "collecting" | "paused" | "auto_scrolling" | "monitoring" | "error";

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

export interface GroupMonitorItem {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: "not_open" | "open" | "monitoring" | "error";
  intervalSeconds: 30 | 60 | 180 | 300;
  lastCheckedAt?: string;
  lastNewPostAt?: string;
  todayNewPosts: number;
}

export interface GroupMonitorSettings {
  enabled: boolean;
  defaultIntervalSeconds: 30 | 60 | 180 | 300;
  groups: GroupMonitorItem[];
}

export interface TranslationSettings {
  enabled: boolean;
  apiType: "openai" | "openai-compatible" | "local";
  apiKey: string;
  baseUrl: string;
  model: string;
  targetLanguage: string;
}

export interface RadarSettings {
  keywords: KeywordItem[];
  alerts: AlertSettings;
  autoScroll: AutoScrollSettings;
  groupMonitor: GroupMonitorSettings;
  translation: TranslationSettings;
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
  | { type: "start_collecting"; commandId?: string }
  | { type: "pause_collecting"; commandId?: string }
  | { type: "stop_collecting"; commandId?: string }
  | { type: "collect_once"; commandId?: string }
  | { type: "scroll_once"; commandId?: string }
  | { type: "get_plugin_state"; commandId?: string }
  | { type: "get_active_facebook_tabs"; commandId?: string }
  | { type: "clear_posts"; commandId?: string }
  | { type: "start_auto_scroll"; commandId?: string; payload: { count: number; delayMs?: number } }
  | { type: "stop_auto_scroll"; commandId?: string }
  | { type: "test_collect_once"; commandId?: string }
  | { type: "test_scroll_once"; commandId?: string }
  | { type: "diagnose"; commandId?: string }
  | { type: "start_group_monitor"; commandId?: string; payload: { intervalSeconds: number } }
  | { type: "stop_group_monitor"; commandId?: string }
  | { type: "start_monitoring"; commandId?: string; payload: { intervalSeconds: number } }
  | { type: "stop_monitoring"; commandId?: string }
  | {
      type: "command_ack";
      clientId?: string;
      commandId: string;
      commandType: string;
      command?: string;
      success: boolean;
      message: string;
      currentState: CollectionState;
      pluginState?: CollectionState;
      timestamp: string;
      tabId?: number;
      url?: string;
      details?: Record<string, unknown>;
    }
  | { type: "alert_triggered"; payload: { postId: string } }
  | { type: "ping"; clientId?: string }
  | { type: "pong"; clientId?: string };
