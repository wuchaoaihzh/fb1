import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, ChevronDown, ChevronRight, Copy, Download, Eye, FileSpreadsheet, FolderOpen, Pause, Play, Plus, Radio, Save, Search, Square, Trash2, Upload, Volume2, Zap } from "lucide-react";
import type { CollectionState, ExtensionClientInfo, GroupMonitorItem, KeywordItem, RadarPost, RadarSettings, RadarStats } from "@foradar/shared";
import { defaultSettings } from "@foradar/shared";
import "./styles.css";

type KeywordCategory = KeywordItem["category"];
type OperationLog = { at: string; message: string; level: "info" | "success" | "warning" | "error" };
type SortMode = "recommended" | "score" | "postTime" | "collectedAt";
type FilterMode = "all" | "new" | "alerted" | "unknown" | "unhandled" | "handled";
type ScrollState = "stopped" | "starting" | "scrolling" | "stopped_with_data" | "error";
type PostDraft = { remark: string; color: string };

interface AppState {
  posts: RadarPost[];
  settings: RadarSettings;
  collectionState: CollectionState;
  appVersion?: string;
  scrollState?: ScrollState;
  scrollProgress?: { currentStep: number; totalSteps: number; delayMs?: number; collectedCount?: number };
  operationLog: OperationLog[];
  stats: RadarStats;
  clients: ExtensionClientInfo[];
}

const emptyStats: RadarStats = { totalPosts: 0, newPosts: 0, todayPosts: 0, alertedPosts: 0, unknownTimePosts: 0, connectedClients: 0 };
const categoryLabels: Record<KeywordCategory, string> = { highValue: "高价值关键词", normal: "普通关键词", negative: "排除关键词" };
const stateLabels: Record<CollectionState, string> = {
  stopped: "已停止",
  collecting: "采集中",
  paused: "已暂停",
  auto_scrolling: "自动滚动中",
  monitoring: "群组监控中",
  error: "错误"
};
const groupStatusLabels: Record<GroupMonitorItem["status"], string> = {
  not_open: "未打开",
  open: "已打开",
  monitoring: "监控中",
  error: "错误"
};

function createKeyword(text: string, category: KeywordCategory): KeywordItem {
  return { id: `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: text.trim(), category, enabled: true };
}

function createGroup(url: string): GroupMonitorItem {
  return {
    id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "Facebook 群组",
    url,
    enabled: true,
    status: "not_open",
    intervalSeconds: 60,
    todayNewPosts: 0
  };
}

function isFacebookGroupUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)facebook\.com$/i.test(url.hostname) && (url.pathname.includes("/groups/") || url.pathname === "/groups/feed/");
  } catch {
    return false;
  }
}

function normalizeGroupUrl(value: string): string {
  try {
    const url = new URL(value);
    if (/\/groups\/feed\/?$/i.test(url.pathname)) return `${url.origin}/groups/feed/`;
    const match = url.pathname.match(/\/groups\/([^/?#]+)/i);
    return match ? `${url.origin}/groups/${match[1].toLowerCase()}` : `${url.origin}${url.pathname}`;
  } catch {
    return value.trim();
  }
}

function parseTimeValue(text: string): number {
  const value = String(text || "").trim();
  if (!value || value === "时间未识别") return 0;
  const normalized = value.replace(/ (\d{2})\.(\d{2})\.(\d{2})$/, " $1:$2:$3").replace(" ", "T");
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? 0 : fallback.getTime();
}

function dateKeyFromText(text: string): string {
  const value = String(text || "").trim();
  const direct = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, "0")}-${direct[3].padStart(2, "0")}`;
  const parsed = parseTimeValue(value);
  if (!parsed) return "";
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function displayPostTime(post: RadarPost): { primary: string; secondary: string } {
  const parsed = String(post.parsedPostTime || "").trim();
  const raw = String(post.rawTimeText || "").trim();
  const hasParsed = parsed && parsed !== "时间未识别";
  if (hasParsed) {
    return {
      primary: parsed,
      secondary: raw && raw !== parsed ? raw : ""
    };
  }
  return {
    primary: raw || "未识别",
    secondary: ""
  };
}

async function playBeep(): Promise<void> {
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  const context = new AudioContextCtor();
  if (context.state === "suspended") await context.resume();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.5);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.55);
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>;
}

function scrollStateLabel(value?: ScrollState): string {
  if (value === "starting") return "正在启动";
  if (value === "scrolling") return "滚动中";
  if (value === "stopped_with_data") return "已完成";
  if (value === "error") return "错误";
  return "未启动";
}

function applyTranslationPreset(translation: RadarSettings["translation"], apiType: RadarSettings["translation"]["apiType"]): RadarSettings["translation"] {
  if (apiType === "deepseek") {
    return {
      ...translation,
      apiType,
      baseUrl: "https://api.deepseek.com/v1",
      model: translation.model && translation.apiType === "deepseek" ? translation.model : "deepseek-chat"
    };
  }
  if (apiType === "openai") {
    return {
      ...translation,
      apiType,
      baseUrl: "https://api.openai.com/v1",
      model: translation.model && translation.apiType === "openai" ? translation.model : "gpt-4.1-mini"
    };
  }
  return { ...translation, apiType };
}

function App() {
  const [state, setState] = useState<AppState>({
    posts: [],
    settings: defaultSettings,
    collectionState: "stopped",
    scrollState: "stopped",
    scrollProgress: { currentStep: 0, totalSteps: 0, delayMs: 0, collectedCount: 0 },
    appVersion: "0.1.14",
    operationLog: [],
    stats: emptyStats,
    clients: []
  });
  const [draftSettings, setDraftSettings] = useState<RadarSettings>(defaultSettings);
  const [socketReady, setSocketReady] = useState(false);
  const [scrollCount, setScrollCount] = useState(defaultSettings.autoScroll.defaultScrollCount);
  const [scrollDelaySeconds, setScrollDelaySeconds] = useState(Math.max(1, Math.round(defaultSettings.autoScroll.waitMsAfterScroll / 1000)));
  const [monitorInterval, setMonitorInterval] = useState(defaultSettings.groupMonitor.defaultIntervalSeconds);
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recommended");
  const [minScore, setMinScore] = useState(0);
  const [dateFilter, setDateFilter] = useState("");
  const [translationOpen, setTranslationOpen] = useState(false);
  const [keywordOpen, setKeywordOpen] = useState(false);
  const [keywordCategory, setKeywordCategory] = useState<KeywordCategory>("highValue");
  const [newKeyword, setNewKeyword] = useState("");
  const [importText, setImportText] = useState("");
  const [groupUrl, setGroupUrl] = useState("");
  const [toast, setToast] = useState("");
  const [flashUi, setFlashUi] = useState(false);
  const [selectedPost, setSelectedPost] = useState<RadarPost | null>(null);
  const [postDrafts, setPostDrafts] = useState<Record<string, PostDraft>>({});
  const [translatingPostId, setTranslatingPostId] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftSettingsDirtyRef = useRef(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      socket = new WebSocket("ws://127.0.0.1:8765?role=renderer");
      socket.addEventListener("open", () => setSocketReady(true));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as { type?: string; payload?: Partial<AppState> & { settings?: Partial<RadarSettings> } };
        if (message.type !== "state" || !message.payload) return;
        const payload = message.payload;
        const settings = {
          ...defaultSettings,
          ...payload.settings,
          alerts: { ...defaultSettings.alerts, ...payload.settings?.alerts },
          autoScroll: { ...defaultSettings.autoScroll, ...payload.settings?.autoScroll },
          groupMonitor: { ...defaultSettings.groupMonitor, ...payload.settings?.groupMonitor },
          translation: { ...defaultSettings.translation, ...payload.settings?.translation }
        };
        setState((previous) => ({
          ...previous,
          ...payload,
          settings,
          scrollState: payload.scrollState || previous.scrollState || "stopped",
          scrollProgress: payload.scrollProgress || previous.scrollProgress || { currentStep: 0, totalSteps: 0, delayMs: 0, collectedCount: 0 }
        }));
        if (!draftSettingsDirtyRef.current) {
          setDraftSettings(settings);
        } else {
          setDraftSettings((previous) => ({
            ...previous,
            groupMonitor: {
              ...previous.groupMonitor,
              groups: previous.groupMonitor.groups.map((group) => {
                const live = settings.groupMonitor.groups.find((item) => normalizeGroupUrl(item.url) === normalizeGroupUrl(group.url));
                return live ? { ...group, status: live.status, lastCheckedAt: live.lastCheckedAt, lastNewPostAt: live.lastNewPostAt, todayNewPosts: live.todayNewPosts } : group;
              })
            }
          }));
        }
      });
      socket.addEventListener("close", () => {
        setSocketReady(false);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1000);
      });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    setScrollCount(draftSettings.autoScroll.defaultScrollCount);
  }, [draftSettings.autoScroll.defaultScrollCount]);

  useEffect(() => {
    setScrollDelaySeconds(Math.max(1, Math.round(draftSettings.autoScroll.waitMsAfterScroll / 1000)));
  }, [draftSettings.autoScroll.waitMsAfterScroll]);

  useEffect(() => {
    setMonitorInterval(draftSettings.groupMonitor.defaultIntervalSeconds);
  }, [draftSettings.groupMonitor.defaultIntervalSeconds]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedPost(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    window.radarApi.onAlertSound(async () => {
      try {
        await playBeep();
      } catch (error) {
        window.radarApi.command("ui-log", `声音播放失败：${String(error)}`);
      }
    });
  }, []);

  useEffect(() => {
    const latest = state.operationLog[0];
    if (!latest) return;
    if (latest.level === "error" || latest.message.includes("ACK") || latest.message.includes("插件已断开")) {
      notify(latest.message);
    }
  }, [state.operationLog]);

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 3200);
  };

  const command = async (name: string, payload?: unknown, feedback?: string, options?: { silent?: boolean }) => {
    if (feedback && !options?.silent) notify(feedback);
    const result = await window.radarApi.command(name, payload) as { sent?: boolean; ack?: boolean; success?: boolean; message?: string; ok?: boolean } | undefined;
    if ((result?.success === false || result?.ok === false) && result?.message && !options?.silent) {
      notify(`操作失败：${result.message}`);
    } else if (result?.sent === false && !options?.silent) {
      notify("命令发送失败，请查看运行日志");
    }
    return result;
  };

  const commitSettings = async (nextSettings: RadarSettings, message: string) => {
    setDraftSettings(nextSettings);
    const result = await command("update-settings", nextSettings, message);
    draftSettingsDirtyRef.current = Boolean(result?.success === false || result?.ok === false);
  };

  const updateSettings = (updater: (settings: RadarSettings) => RadarSettings) => {
    draftSettingsDirtyRef.current = true;
    setDraftSettings((settings) => updater(structuredClone(settings)));
  };

  const saveSettings = async () => {
    await commitSettings({
      ...draftSettings,
      autoScroll: { ...draftSettings.autoScroll, defaultScrollCount: scrollCount, waitMsAfterScroll: scrollDelaySeconds * 1000 },
      groupMonitor: { ...draftSettings.groupMonitor, defaultIntervalSeconds: monitorInterval as 30 | 60 | 180 | 300 }
    }, "设置已保存到本地配置文件");
  };

  const monitorGroups = useMemo(() => {
    const liveMap = new Map(state.settings.groupMonitor.groups.map((group) => [normalizeGroupUrl(group.url), group]));
    return draftSettings.groupMonitor.groups.map((group) => {
      const live = liveMap.get(normalizeGroupUrl(group.url));
      return live ? { ...group, status: live.status, lastCheckedAt: live.lastCheckedAt, lastNewPostAt: live.lastNewPostAt, todayNewPosts: live.todayNewPosts } : group;
    });
  }, [draftSettings.groupMonitor.groups, state.settings.groupMonitor.groups]);

  const openedGroupPages = useMemo(() => state.clients.filter((client) => isFacebookGroupUrl(client.tabUrl || "")), [state.clients]);

  const posts = useMemo(() => {
    const filtered = state.posts.filter((post) => !post.ignored).filter((post) => {
      if (filterMode === "new" && !post.isNewPost) return false;
      if (filterMode === "alerted" && !post.alertTriggered) return false;
      if (filterMode === "unknown" && post.timeConfidence !== "unknown") return false;
      if (filterMode === "unhandled" && post.handled) return false;
      if (filterMode === "handled" && !post.handled) return false;
      if (post.score < minScore) return false;
      if (dateFilter) {
        const matchesDate = dateKeyFromText(post.collectedAt) === dateFilter || dateKeyFromText(post.parsedPostTime) === dateFilter;
        if (!matchesDate) return false;
      }
      const text = `${post.groupName} ${post.authorName} ${post.postText} ${post.matchedKeywords.join(" ")} ${post.remark || ""} ${post.translatedText || ""}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });

    return filtered.sort((a, b) => {
      const aTime = parseTimeValue(a.parsedPostTime) || parseTimeValue(a.rawTimeText);
      const bTime = parseTimeValue(b.parsedPostTime) || parseTimeValue(b.rawTimeText);
      if (sortMode === "score") return (b.score - a.score) || (bTime - aTime) || b.collectedAt.localeCompare(a.collectedAt);
      if (sortMode === "postTime") return (bTime - aTime) || (b.score - a.score) || b.collectedAt.localeCompare(a.collectedAt);
      if (sortMode === "collectedAt") return b.collectedAt.localeCompare(a.collectedAt);
      return (bTime - aTime) || (b.score - a.score) || b.collectedAt.localeCompare(a.collectedAt);
    });
  }, [dateFilter, filterMode, minScore, query, sortMode, state.posts]);

  const updatePostDraft = (post: RadarPost, patch: Partial<PostDraft>) => {
    setPostDrafts((drafts) => ({
      ...drafts,
      [post.postId]: {
        remark: drafts[post.postId]?.remark ?? post.remark ?? "",
        color: drafts[post.postId]?.color ?? post.handledColor ?? "#d9f2e6",
        ...patch
      }
    }));
  };

  const savePostMeta = async (post: RadarPost, handled = Boolean(post.handled)) => {
    const draft = postDrafts[post.postId];
    await command("mark-handled", {
      postId: post.postId,
      handled,
      handledColor: draft?.color || post.handledColor || "#d9f2e6",
      remark: draft?.remark ?? post.remark ?? ""
    }, handled ? "已更新处理状态" : "备注已保存");
  };

  const translatePost = async (post: RadarPost) => {
    setTranslatingPostId(post.postId);
    try {
      const result = await command("translate-post", post.postId, undefined, { silent: true });
      if (result?.ok === false || result?.success === false) {
        notify(result?.message || "翻译失败");
      } else {
        notify("翻译完成");
      }
    } finally {
      setTranslatingPostId("");
    }
  };

  const addKeyword = () => {
    const text = newKeyword.trim();
    if (!text) return;
    updateSettings((settings) => ({ ...settings, keywords: [...settings.keywords, createKeyword(text, keywordCategory)] }));
    setNewKeyword("");
  };

  const importKeywords = () => {
    const words = importText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
    updateSettings((settings) => ({ ...settings, keywords: [...settings.keywords, ...words.map((word) => createKeyword(word, keywordCategory))] }));
    setImportText("");
  };

  const exportKeywords = () => {
    const blob = new Blob([JSON.stringify(draftSettings.keywords, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "opportunity-radar-keywords.json";
    link.click();
    URL.revokeObjectURL(url);
    command("ui-log", "关键词 JSON 已导出");
  };

  const loadKeywordFile = async (file?: File) => {
    if (!file) return;
    const parsed = JSON.parse(await file.text()) as KeywordItem[];
    updateSettings((settings) => ({ ...settings, keywords: parsed }));
    command("ui-log", `关键词 JSON 已导入，共 ${parsed.length} 条`);
  };

  const addGroup = async () => {
    const url = groupUrl.trim();
    if (!isFacebookGroupUrl(url)) {
      notify("请输入有效的 Facebook 群组链接");
      await command("ui-log", `保存群组失败：无效链接 ${url}`);
      return;
    }
    const nextSettings = { ...draftSettings, groupMonitor: { ...draftSettings.groupMonitor, groups: [...draftSettings.groupMonitor.groups, createGroup(url)] } };
    await commitSettings(nextSettings, "群组已保存");
    setGroupUrl("");
  };

  const deleteGroup = async (id: string) => {
    const nextSettings = { ...draftSettings, groupMonitor: { ...draftSettings.groupMonitor, groups: draftSettings.groupMonitor.groups.filter((group) => group.id !== id) } };
    await commitSettings(nextSettings, "群组已删除");
  };

  const updateGroup = (id: string, updater: (group: GroupMonitorItem) => GroupMonitorItem) => {
    updateSettings((settings) => ({
      ...settings,
      groupMonitor: { ...settings.groupMonitor, groups: settings.groupMonitor.groups.map((group) => group.id === id ? updater(group) : group) }
    }));
  };

  const clearData = async () => {
    if (!window.confirm("确认清空当前采集数据吗？")) return;
    setSelectedPost(null);
    const result = await command("clear", undefined, "正在清空数据");
    if (result?.ok !== false) {
      setState((previous) => ({
        ...previous,
        posts: [],
        stats: { ...previous.stats, totalPosts: 0, newPosts: 0, todayPosts: 0, alertedPosts: 0, unknownTimePosts: 0 }
      }));
    }
  };

  const testSound = async () => {
    try {
      await playBeep();
      await command("ui-log", "声音提醒测试成功");
      notify("声音提醒测试成功");
    } catch (error) {
      await command("ui-log", `声音播放失败：${String(error)}`);
      notify("声音播放失败，请查看运行日志");
    }
  };

  const testFlash = async () => {
    setFlashUi(true);
    setTimeout(() => setFlashUi(false), 3500);
    await command("test-flash", undefined, "窗口闪动测试已触发");
  };

  const toggleTranslation = async () => {
    if (!draftSettings.translation.apiKey && draftSettings.translation.apiType !== "local") {
      notify("翻译 API 未配置，请先填写 API Key");
      setTranslationOpen(true);
      await command("ui-log", "实时翻译未开启：翻译 API 未配置");
      return;
    }
    const nextSettings = { ...draftSettings, translation: { ...draftSettings.translation, enabled: !draftSettings.translation.enabled } };
    await commitSettings(nextSettings, nextSettings.translation.enabled ? "实时翻译已开启" : "实时翻译已关闭");
  };

  const connectionHint = state.stats.connectedClients === 0 ? "插件未连接，请确认浏览器插件已安装并打开 Facebook 页面" : "插件已连接，等待 Facebook 页面返回 ACK";

  return (
    <main className={flashUi ? "flash-ui" : ""}>
      {toast && <div className="toast">{toast}</div>}

      <header className="topbar">
        <div>
          <h1>Facebook Opportunity Radar <span className="version-badge">v{state.appVersion || "0.1.14"}</span></h1>
          <p>仅采集当前已打开的 Facebook 首页、groups/feed、群组页面或图片帖子详情页，不会自动评论或发帖。</p>
        </div>
        <div className={`connection ${socketReady ? "online" : "offline"}`}><Radio size={18} />{socketReady ? "本地服务已连接" : "本地服务未连接"}</div>
      </header>

      <section className="status-grid">
        <div className={`panel compact state-${state.scrollState === "stopped_with_data" ? "collecting" : state.scrollState || "stopped"}`}>
          <h2>滚动状态</h2>
          <strong>{scrollStateLabel(state.scrollState)}</strong>
          <span>{state.scrollProgress?.totalSteps ? `进度 ${state.scrollProgress.currentStep || 0} / ${state.scrollProgress.totalSteps}，本轮采集 ${state.scrollProgress.collectedCount || 0} 条` : "等待滚动命令"}</span>
        </div>
        <div className="panel compact">
          <h2>插件连接</h2>
          <strong>{state.stats.connectedClients > 0 ? "已连接" : "未连接"}</strong>
          <span>{connectionHint}</span>
        </div>
        <div className={`panel compact state-${state.collectionState}`}>
          <h2>采集状态</h2>
          <strong>{stateLabels[state.collectionState]}</strong>
          <span>{state.collectionState === "error" ? "请刷新 Facebook 页面或重新加载插件" : "状态以插件 ACK 为准"}</span>
        </div>
        <StatCard label="已采集帖子" value={state.stats.totalPosts} />
        <StatCard label="新帖数量" value={state.stats.newPosts} />
        <StatCard label="今日采集" value={state.stats.todayPosts} />
        <StatCard label="已提醒" value={state.stats.alertedPosts} />
        <StatCard label="时间未识别" value={state.stats.unknownTimePosts} />
      </section>

      <section className="toolbar">
        <button onClick={() => command("start", undefined, undefined, { silent: true })}><Play size={16} />开始采集</button>
        <button onClick={() => command("pause", undefined, undefined, { silent: true })}><Pause size={16} />暂停采集</button>
        <button onClick={() => command("stop", undefined, undefined, { silent: true })}><Square size={16} />停止采集</button>
        <button onClick={() => command("diagnose", undefined, "连接诊断命令已发送")}><Radio size={16} />测试连接</button>
        <button onClick={() => command("test-collect", undefined, undefined, { silent: true })}><Search size={16} />测试采集一次</button>
        <button onClick={() => command("test-scroll", undefined, "测试滚动命令已发送")}><Zap size={16} />测试滚动一次</button>
        <button onClick={clearData}><Trash2 size={16} />清空数据</button>
        <button onClick={() => command("export-xlsx")}><FileSpreadsheet size={16} />导出 Excel</button>
        <button onClick={() => command("export-csv")}><Download size={16} />导出 CSV</button>
        <button onClick={() => command("open-data-dir")}><FolderOpen size={16} />导出目录</button>
        <button onClick={() => command("open-log-folder")}><FolderOpen size={16} />日志目录</button>
        <button onClick={() => command("clear-logs")}><Trash2 size={16} />清空日志</button>
        <button onClick={testSound}><Volume2 size={16} />测试声音</button>
        <button onClick={testFlash}><Bell size={16} />测试提醒</button>
        <button onClick={toggleTranslation}><Download size={16} />实时翻译：{draftSettings.translation.enabled ? "开" : "关"}</button>
        <button onClick={() => setTranslationOpen((value) => !value)}><Save size={16} />翻译设置</button>
      </section>

      {translationOpen && <section className="panel">
        <div className="panel-head"><h2>翻译设置</h2><span>{draftSettings.translation.apiKey || draftSettings.translation.apiType === "local" ? "已配置" : "未配置"}</span></div>
        <div className="settings-grid">
          <label className="field"><span>启用翻译</span><input type="checkbox" checked={draftSettings.translation.enabled} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, enabled: event.target.checked } }))} /></label>
          <label className="field"><span>API 类型</span><select value={draftSettings.translation.apiType} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: applyTranslationPreset(settings.translation, event.target.value as RadarSettings["translation"]["apiType"]) }))}><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI Compatible</option><option value="deepseek">DeepSeek</option><option value="local">Local API</option></select></label>
          <label className="field"><span>API Key</span><input type="password" value={draftSettings.translation.apiKey} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, apiKey: event.target.value } }))} placeholder="sk-..." /></label>
          <label className="field"><span>Base URL</span><input value={draftSettings.translation.baseUrl} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, baseUrl: event.target.value } }))} /></label>
          <label className="field"><span>模型</span><input value={draftSettings.translation.model} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, model: event.target.value } }))} /></label>
          <label className="field"><span>目标语言</span><input value={draftSettings.translation.targetLanguage} onChange={(event) => updateSettings((settings) => ({ ...settings, translation: { ...settings.translation, targetLanguage: event.target.value } }))} /></label>
        </div>
        <div className="inline-actions">
          <button onClick={saveSettings}><Save size={16} />保存翻译设置</button>
          <button onClick={() => command("test-translation", undefined, "测试翻译命令已发送")}><Radio size={16} />测试翻译</button>
        </div>
      </section>}

      <section className="split">
        <div className="panel">
          <div className="panel-head"><h2>自动滚动</h2><span>{scrollCount} 次</span></div>
          <div className="segmented">{[3, 5, 8, 10, 999].map((count) => <button className={scrollCount === count ? "active" : ""} key={count} onClick={() => setScrollCount(count)}>{count === 999 ? "长时间" : count}</button>)}</div>
          <label className="field"><span>滚动次数</span><input min="1" max="999" type="number" value={scrollCount} onChange={(event) => setScrollCount(Number(event.target.value))} /></label>
          <label className="field"><span>等待秒数</span><input min="1" max="30" type="number" value={scrollDelaySeconds} onChange={(event) => setScrollDelaySeconds(Number(event.target.value))} /></label>
          <div className="inline-actions">
            <button onClick={() => command("start-auto-scroll", { count: scrollCount, delayMs: scrollDelaySeconds * 1000 }, `自动滚动命令已发送：0 / ${scrollCount}`)}><Zap size={16} />开始自动滚动</button>
            <button onClick={() => command("stop-auto-scroll", undefined, "自动滚动停止命令已发送")}><Pause size={16} />停止自动滚动</button>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>运行日志</h2><span>{state.operationLog[0]?.at || "等待操作"}</span></div>
          <div className="operation-log">
            {(state.operationLog.length ? state.operationLog : [{ at: "--", message: "还没有操作记录", level: "info" as const }]).slice(0, 12).map((item, index) => (
              <div className={`log-line ${item.level}`} key={`${item.at}-${index}`}><span>{item.at}</span>{item.message}</div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel monitor-panel">
        <div className="panel-head">
          <h2>群组监控</h2>
          <span>仅群组页支持自动刷新；首页和图片帖子详情页可采集但不会自动刷新</span>
        </div>
        <div className="monitor-tools">
          <input value={groupUrl} placeholder="添加 groups/feed 或具体群组链接，例如 https://www.facebook.com/groups/xxx" onChange={(event) => setGroupUrl(event.target.value)} />
          <button onClick={addGroup}><Plus size={16} />添加群组</button>
          <select value={monitorInterval} onChange={(event) => setMonitorInterval(Number(event.target.value) as 30 | 60 | 180 | 300)}><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={180}>3 分钟</option><option value={300}>5 分钟</option></select>
          <button onClick={() => command("start-group-monitor", { intervalSeconds: monitorInterval }, "群组监控启动命令已发送")}><Play size={16} />开始监控已打开页</button>
          <button onClick={() => command("stop-group-monitor", undefined, "群组监控停止命令已发送")}><Square size={16} />停止监控</button>
          <button onClick={saveSettings}><Save size={16} />保存设置</button>
        </div>
        <div className="monitor-config">
          <label><input type="checkbox" checked={draftSettings.groupMonitor.autoRefreshEnabled} onChange={(event) => updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, autoRefreshEnabled: event.target.checked } }))} />仅群组页自动刷新</label>
          <select value={draftSettings.groupMonitor.autoRefreshSeconds} onChange={(event) => updateSettings((settings) => ({ ...settings, groupMonitor: { ...settings.groupMonitor, autoRefreshSeconds: Number(event.target.value) as 60 | 120 | 180 | 300 | 600 } }))}>
            <option value={60}>60 秒</option>
            <option value={120}>120 秒</option>
            <option value={180}>180 秒</option>
            <option value={300}>300 秒</option>
            <option value={600}>600 秒</option>
          </select>
          <span>当前已打开群组页：{openedGroupPages.length}</span>
        </div>
        <div className="monitor-list">
          {monitorGroups.length === 0 && <div className="empty slim">还没有添加群组链接。你也可以直接打开 groups/feed 或单个群组页面后启动监控。</div>}
          {monitorGroups.map((group) => (
            <div className="monitor-row" key={group.id}>
              <input type="checkbox" checked={group.enabled} onChange={(event) => updateGroup(group.id, (item) => ({ ...item, enabled: event.target.checked }))} />
              <input value={group.name} onChange={(event) => updateGroup(group.id, (item) => ({ ...item, name: event.target.value }))} />
              <span className={`group-status status-${group.status}`}>{groupStatusLabels[group.status]}</span>
              <span>{group.lastCheckedAt || "尚未检查"}</span>
              <span>{group.todayNewPosts} 条</span>
              <button onClick={() => deleteGroup(group.id)}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel posts-panel">
        <div className="panel-head">
          <h2>实时帖子列表</h2>
          <div className="filters">
            <div className="search"><Search size={16} /><input placeholder="搜索群组、发帖人、正文、备注、关键词" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
              <option value="recommended">最新发布 + 高评分优先</option>
              <option value="score">评分最高</option>
              <option value="postTime">发布时间最新</option>
              <option value="collectedAt">采集时间最新</option>
            </select>
            <select value={filterMode} onChange={(event) => setFilterMode(event.target.value as FilterMode)}>
              <option value="all">全部</option>
              <option value="new">只看新帖</option>
              <option value="alerted">只看已提醒</option>
              <option value="unknown">只看时间未识别</option>
              <option value="unhandled">只看未处理</option>
              <option value="handled">只看已处理</option>
            </select>
            <select value={minScore} onChange={(event) => setMinScore(Number(event.target.value))}>
              <option value={0}>最低评分 0</option>
              <option value={40}>最低评分 40</option>
              <option value={60}>最低评分 60</option>
              <option value={80}>最低评分 80</option>
            </select>
            <input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} />
            <button onClick={() => setDateFilter("")}>清空日期</button>
          </div>
        </div>
        <div className="table-hint">表格支持左右滚动；缩小窗口时建议拖动底部横向滚动条查看完整列。</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sticky-col">状态</th>
                <th>评分</th>
                <th>新帖</th>
                <th>标签/群组</th>
                <th>内容摘要</th>
                <th>发帖人</th>
                <th>发布时间</th>
                <th>采集时间</th>
                <th>关键词</th>
                <th>备注</th>
                <th>处理色</th>
                <th className="sticky-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => {
                const draft = postDrafts[post.postId];
                const rowColor = draft?.color || post.handledColor || "#d9f2e6";
                const remark = draft?.remark ?? post.remark ?? "";
                const translated = post.translatedText || "";
                const postTime = displayPostTime(post);
                return (
                  <tr key={post.postId} className={post.alertTriggered || post.isNewPost ? "alert-row" : ""} style={post.handled ? { background: rowColor } : undefined}>
                    <td className="sticky-col">{post.handled ? "已处理" : (post.alertTriggered ? "已提醒" : post.statusNote)}</td>
                    <td><strong>{post.score}</strong></td>
                    <td>{post.isNewPost ? "是" : "否"}</td>
                    <td>{post.groupName}</td>
                    <td className="preview-cell">
                      <div className="summary-tools">
                        <span>{post.postTextPreview}</span>
                        <button disabled={translatingPostId === post.postId} onClick={() => translatePost(post)}>{translatingPostId === post.postId ? "翻译中" : "翻译"}</button>
                      </div>
                      {translated && <div className="translated-text">{translated}</div>}
                    </td>
                    <td>{post.authorName || "未识别"}</td>
                    <td>
                      <div>{postTime.primary}</div>
                      {postTime.secondary && <div className="time-secondary">{postTime.secondary}</div>}
                    </td>
                    <td>{post.collectedAt}</td>
                    <td>{post.matchedKeywords.join(", ") || "无"}</td>
                    <td>
                      <input className="note-input" value={remark} placeholder="备注" onChange={(event) => updatePostDraft(post, { remark: event.target.value })} />
                    </td>
                    <td>
                      <input type="color" value={rowColor} onChange={(event) => updatePostDraft(post, { color: event.target.value })} />
                    </td>
                    <td className="row-actions sticky-right">
                      <button title="打开帖子" onClick={() => command("open-url", post.postUrl)}><Eye size={15} /></button>
                      <button title="复制链接" onClick={() => { navigator.clipboard.writeText(post.postUrl); command("ui-log", `已复制帖子链接：${post.postUrl}`); notify("链接已复制"); }}><Copy size={15} /></button>
                      <button onClick={() => savePostMeta(post, true)}>已处理</button>
                      <button onClick={() => savePostMeta(post, Boolean(post.handled))}>保存备注</button>
                      <button onClick={() => command("clear-handled", post.postId, "已清除处理标记")}>清除标记</button>
                      <button onClick={() => command("ignore-post", post.postId)}>忽略</button>
                      <button onClick={() => { setSelectedPost(post); command("ui-log", `查看帖子详情：${post.postUrl || post.postId}`); }}>详情</button>
                    </td>
                  </tr>
                );
              })}
              {posts.length === 0 && <tr><td colSpan={12} className="empty">等待插件发送帖子。请打开 Facebook 首页、groups/feed、具体群组页或图片帖子详情页后点击“测试连接”或“开始采集”。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`panel keyword-panel ${keywordOpen ? "open" : ""}`}>
        <button className="collapse-head" onClick={() => setKeywordOpen((value) => !value)}>{keywordOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}关键词管理（点击{keywordOpen ? "收起" : "展开"}）</button>
        {keywordOpen && <>
          <div className="panel-head"><h2>{categoryLabels[keywordCategory]}</h2><div className="segmented">{(Object.keys(categoryLabels) as KeywordCategory[]).map((category) => <button className={keywordCategory === category ? "active" : ""} key={category} onClick={() => setKeywordCategory(category)}>{categoryLabels[category]}</button>)}</div></div>
          <div className="keyword-tools"><input value={newKeyword} placeholder="输入英文关键词" onChange={(event) => setNewKeyword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addKeyword()} /><button onClick={addKeyword}><Plus size={16} />添加</button><button onClick={saveSettings}><Save size={16} />保存到本地</button><button onClick={() => fileInputRef.current?.click()}><Upload size={16} />导入 JSON</button><button onClick={exportKeywords}><Download size={16} />导出 JSON</button><input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(event) => loadKeywordFile(event.target.files?.[0])} /></div>
          <div className="keyword-import"><textarea value={importText} placeholder="批量导入：一行一个关键词，或使用逗号分隔" onChange={(event) => setImportText(event.target.value)} /><button onClick={importKeywords}><Upload size={16} />导入到当前分类</button></div>
          <div className="keyword-list">{draftSettings.keywords.filter((keyword) => keyword.category === keywordCategory).map((keyword) => <div className="keyword-row" key={keyword.id}><input type="checkbox" checked={keyword.enabled} onChange={(event) => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.map((item) => item.id === keyword.id ? { ...item, enabled: event.target.checked } : item) }))} /><input value={keyword.text} onChange={(event) => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.map((item) => item.id === keyword.id ? { ...item, text: event.target.value } : item) }))} /><button onClick={() => updateSettings((settings) => ({ ...settings, keywords: settings.keywords.filter((item) => item.id !== keyword.id) }))}><Trash2 size={16} /></button></div>)}</div>
        </>}
      </section>

      {selectedPost && <div className="modal-backdrop" onClick={() => setSelectedPost(null)}>
        <aside className="modal" onClick={(event) => event.stopPropagation()}>
          <button className="close" onClick={() => setSelectedPost(null)}>X</button>
          <h2>帖子详情</h2>
          <dl>
            <dt>完整内容</dt><dd>{selectedPost.postText}</dd>
            <dt>翻译内容</dt><dd>{selectedPost.translatedText || "未翻译"}</dd>
            <dt>标签/群组</dt><dd>{selectedPost.groupName}</dd>
            <dt>发帖人</dt><dd>{selectedPost.authorName || "未识别"}</dd>
            <dt>原始时间</dt><dd>{selectedPost.rawTimeText || "未识别"}</dd>
            <dt>解析时间</dt><dd>{selectedPost.parsedPostTime}</dd>
            <dt>采集时间</dt><dd>{selectedPost.collectedAt}</dd>
            <dt>评分</dt><dd>{selectedPost.score}</dd>
            <dt>匹配关键词</dt><dd>{selectedPost.matchedKeywords.join(", ") || "无"}</dd>
            <dt>排除关键词</dt><dd>{selectedPost.negativeKeywords.join(", ") || "无"}</dd>
            <dt>评分原因</dt><dd>{selectedPost.scoreReasons.join("；") || "无"}</dd>
            <dt>备注</dt><dd>{postDrafts[selectedPost.postId]?.remark ?? selectedPost.remark ?? "无"}</dd>
            <dt>链接</dt><dd>{selectedPost.postUrl}</dd>
          </dl>
          <div className="inline-actions">
            <button onClick={() => command("open-url", selectedPost.postUrl)}>打开帖子</button>
            <button onClick={() => { navigator.clipboard.writeText(selectedPost.postUrl); command("ui-log", `已复制帖子链接：${selectedPost.postUrl}`); }}>复制链接</button>
            <button onClick={() => translatePost(selectedPost)}>翻译本条</button>
            <button onClick={() => savePostMeta(selectedPost, true)}>标记已处理</button>
            <button onClick={() => command("clear-handled", selectedPost.postId, "已清除处理标记")}>清除标记</button>
          </div>
        </aside>
      </div>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
