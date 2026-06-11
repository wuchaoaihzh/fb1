import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import * as XLSX from "xlsx";
import {
  defaultSettings,
  dedupeKey,
  formatDateKey,
  formatLocalDateTime,
  parseFacebookTime,
  scorePost,
  shouldTriggerAlert,
  type BridgeMessage,
  type CollectionState,
  type ExtensionClientInfo,
  type GroupMonitorItem,
  type RadarPost,
  type RadarSettings,
  type RadarStats
} from "@foradar/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const serverPort = 8765;
const appVersion = "0.1.14";
app.setName("Facebook Opportunity Radar");

let mainWindow: BrowserWindow | null = null;
let settings: RadarSettings = defaultSettings;
let collectionState: CollectionState = "stopped";
let scrollState: "stopped" | "starting" | "scrolling" | "stopped_with_data" | "error" = "stopped";
let scrollProgress = { currentStep: 0, totalSteps: 0, delayMs: 0, collectedCount: 0 };
const posts = new Map<string, RadarPost>();
const clients = new Map<WebSocket, ExtensionClientInfo>();
const httpClients = new Map<string, ExtensionClientInfo & { lastSeenAt: number }>();
const commandQueues = new Map<string, BridgeMessage[]>();
type OperationLevel = "info" | "success" | "warning" | "error";
type CommandResult = {
  commandId: string;
  sent: boolean;
  ack?: boolean;
  success?: boolean;
  message?: string;
};

const operationLog: Array<{ at: string; message: string; level: OperationLevel }> = [];
const pendingCommands = new Map<string, {
  type: string;
  createdAt: number;
  resolve: (result: CommandResult) => void;
  timeout: NodeJS.Timeout;
}>();
const handledAckKeys = new Set<string>();
const rendererSockets = new Set<WebSocket>();
let nativeServer: http.Server | null = null;
type GroupStatusSnapshot = Pick<GroupMonitorItem, "status" | "lastCheckedAt" | "lastNewPostAt" | "todayNewPosts"> & {
  dateKey: string;
  name?: string;
  url?: string;
};
const groupStatusByKey = new Map<string, GroupStatusSnapshot>();

function operationLogFile(): string {
  return path.join(logDir(), "operation.log");
}

function addOperation(message: string, level: OperationLevel = "info"): void {
  const at = new Date().toLocaleTimeString();
  operationLog.unshift({ at, message, level });
  operationLog.splice(80);
  fs.appendFileSync(operationLogFile(), `[${at}] ${level.toUpperCase()} ${message}\n`, "utf8");
  broadcastState();
}

const commandLabels: Record<string, string> = {
  start: "开始采集",
  pause: "暂停采集",
  stop: "停止采集",
  clear: "清空数据",
  "test-collect": "测试采集一次",
  "test-scroll": "测试滚动一次",
  diagnose: "测试连接",
  "start-auto-scroll": "开始自动滚动",
  "stop-auto-scroll": "停止自动滚动",
  "test-sound": "测试声音提醒",
  "test-flash": "测试窗口闪动",
  "export-csv": "导出 CSV",
  "export-xlsx": "导出 Excel",
  "open-data-dir": "打开数据目录",
  "open-log-folder": "打开日志文件夹",
  "clear-logs": "清空日志",
  "open-url": "打开帖子",
  "mark-handled": "标记已处理",
  "clear-handled": "清除处理标记",
  "translate-post": "翻译本条帖子",
  "ignore-post": "忽略帖子",
  "update-settings": "保存设置",
  "test-translation": "测试翻译",
  "start-group-monitor": "开始群组监控",
  "stop-group-monitor": "停止群组监控"
};

function commandId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dataDir(): string {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  [logDir(), exportDir(), configDir(), cacheDir()].forEach((name) => fs.mkdirSync(name, { recursive: true }));
  return dir;
}

function logDir(): string {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exportDir(): string {
  const dir = path.join(app.getPath("userData"), "exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configDir(): string {
  const dir = path.join(app.getPath("userData"), "config");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheDir(): string {
  const dir = path.join(app.getPath("userData"), "cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function log(message: string, details?: unknown): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    message,
    details
  });
  fs.appendFileSync(path.join(dataDir(), "radar.log"), `${line}\n`, "utf8");
}

function settingsFile(): string {
  return path.join(configDir(), "settings.json");
}

function postsFile(): string {
  return path.join(dataDir(), "posts.json");
}

function firstExistingFile(paths: string[]): string | undefined {
  return paths.find((file) => fs.existsSync(file));
}

function loadPersistedData(): void {
  try {
    const savedSettingsFile = firstExistingFile([settingsFile(), path.join(dataDir(), "config", "settings.json"), path.join(dataDir(), "settings.json")]);
    if (savedSettingsFile) {
      const saved = JSON.parse(fs.readFileSync(savedSettingsFile, "utf8")) as Partial<RadarSettings>;
      settings = {
        ...defaultSettings,
        ...saved,
        alerts: { ...defaultSettings.alerts, ...saved.alerts },
        autoScroll: { ...defaultSettings.autoScroll, ...saved.autoScroll },
        groupMonitor: { ...defaultSettings.groupMonitor, ...saved.groupMonitor },
        translation: { ...defaultSettings.translation, ...saved.translation }
      };
    }
    const savedPostsFile = firstExistingFile([postsFile(), path.join(dataDir(), "history", "posts.json")]);
    if (savedPostsFile) {
      const saved = JSON.parse(fs.readFileSync(savedPostsFile, "utf8")) as RadarPost[];
      saved.forEach((post) => posts.set(dedupeKey(post), post));
    }
  } catch (error) {
    log("Failed to load persisted data", String(error));
  }
}

function persistPosts(): void {
  fs.writeFileSync(postsFile(), JSON.stringify([...posts.values()], null, 2), "utf8");
}

function persistSettings(): void {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

function stats(): RadarStats {
  const today = formatDateKey(new Date());
  const values = [...posts.values()];
  return {
    totalPosts: values.length,
    newPosts: values.filter((post) => post.isNewPost).length,
    todayPosts: values.filter((post) => post.collectedAt.startsWith(today)).length,
    alertedPosts: values.filter((post) => post.alertTriggered).length,
    unknownTimePosts: values.filter((post) => post.timeConfidence === "unknown").length,
    connectedClients: clients.size + activeHttpClients(new Set([...clients.values()].map((client) => client.clientId))).length
  };
}

function isFacebookUrl(url?: string): boolean {
  return /^https:\/\/(www\.)?facebook\.com\//.test(String(url || ""));
}

function isFacebookGroupUrl(url?: string): boolean {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)facebook\.com$/i.test(parsed.hostname) && (parsed.pathname.includes("/groups/") || parsed.pathname === "/groups/feed/");
  } catch {
    return false;
  }
}

function isFacebookHomeUrl(url?: string): boolean {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)facebook\.com$/i.test(parsed.hostname) && (parsed.pathname === "/" || parsed.pathname === "/home.php");
  } catch {
    return false;
  }
}

function isCollectibleFacebookUrl(url?: string): boolean {
  return isFacebookHomeUrl(url) || isFacebookGroupUrl(url);
}

function activeHttpClients(excludedClientIds = new Set<string>()): ExtensionClientInfo[] {
  const now = Date.now();
  const active: ExtensionClientInfo[] = [];
  httpClients.forEach((client, clientId) => {
    if (now - client.lastSeenAt > 45000) {
      httpClients.delete(clientId);
      return;
    }
    if (!excludedClientIds.has(client.clientId)) active.push({
      clientId: client.clientId,
      connectedAt: client.connectedAt,
      tabUrl: client.tabUrl,
      userAgent: client.userAgent
    });
  });
  return active;
}

function activeCommandClients(): ExtensionClientInfo[] {
  const now = Date.now();
  const active: ExtensionClientInfo[] = [];
  httpClients.forEach((client) => {
    if (now - client.lastSeenAt > 10000) return;
    if (!isCollectibleFacebookUrl(client.tabUrl)) return;
    if (client.clientId.startsWith("content-")) {
      active.unshift({
        clientId: client.clientId,
        connectedAt: client.connectedAt,
        tabUrl: client.tabUrl,
        userAgent: client.userAgent
      });
      return;
    }
    active.push({
      clientId: client.clientId,
      connectedAt: client.connectedAt,
      tabUrl: client.tabUrl,
      userAgent: client.userAgent
    });
  });
  const contentClients = active.filter((client) => client.clientId.startsWith("content-"));
  return contentClients.length > 0 ? contentClients : active;
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function groupMonitorKey(url?: string): string {
  try {
    const parsed = new URL(String(url || ""));
    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) return "";
    if (/^\/groups\/feed\/?$/i.test(parsed.pathname)) return "/groups/feed/";
    const match = parsed.pathname.match(/\/groups\/([^/?#]+)/i);
    if (match) return `/groups/${match[1].toLowerCase()}`;
    return parsed.pathname.toLowerCase();
  } catch {
    return "";
  }
}

function upsertGroupStatus(url: string | undefined, patch: Partial<GroupStatusSnapshot>): void {
  const key = groupMonitorKey(url);
  if (!key) return;
  const current = groupStatusByKey.get(key);
  groupStatusByKey.set(key, {
    status: patch.status || current?.status || "not_open",
    lastCheckedAt: patch.lastCheckedAt ?? current?.lastCheckedAt,
    lastNewPostAt: patch.lastNewPostAt ?? current?.lastNewPostAt,
    todayNewPosts: patch.todayNewPosts ?? current?.todayNewPosts ?? 0,
    dateKey: patch.dateKey || current?.dateKey || todayKey(),
    name: patch.name ?? current?.name,
    url: patch.url ?? current?.url ?? url
  });
}

function collectibleClients(): ExtensionClientInfo[] {
  return [...clients.values(), ...activeHttpClients(new Set([...clients.values()].map((client) => client.clientId)))]
    .filter((client) => isCollectibleFacebookUrl(client.tabUrl));
}

function resolveGroupMonitorGroups(groups: GroupMonitorItem[]): GroupMonitorItem[] {
  const openKeys = new Set(collectibleClients().map((client) => groupMonitorKey(client.tabUrl)).filter(Boolean));
  return groups.map((group) => {
    const key = groupMonitorKey(group.url);
    const snapshot = key ? groupStatusByKey.get(key) : undefined;
    const isOpen = key ? openKeys.has(key) : false;
    const resolvedStatus = snapshot?.status === "monitoring" && !isOpen ? "not_open" : (snapshot?.status || (isOpen ? "open" : "not_open"));
    return {
      ...group,
      status: resolvedStatus,
      lastCheckedAt: snapshot?.lastCheckedAt || group.lastCheckedAt,
      lastNewPostAt: snapshot?.lastNewPostAt || group.lastNewPostAt,
      todayNewPosts: snapshot?.todayNewPosts ?? group.todayNewPosts
    };
  });
}

function stateSettings(): RadarSettings {
  return {
    ...settings,
    groupMonitor: {
      ...settings.groupMonitor,
      groups: resolveGroupMonitorGroups(settings.groupMonitor.groups)
    }
  };
}

function appState() {
  return {
    type: "state",
    payload: {
      posts: [...posts.values()].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt)),
      settings: stateSettings(),
      collectionState,
      scrollState,
      scrollProgress,
      appVersion,
      operationLog,
      stats: stats(),
      clients: [...clients.values(), ...activeHttpClients(new Set([...clients.values()].map((client) => client.clientId)))]
    }
  };
}

function broadcastState(): void {
  const serialized = JSON.stringify(appState());
  rendererSockets.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(serialized);
  });
}

function broadcastToExtensions(message: BridgeMessage): number {
  let sentCount = 0;
  activeCommandClients().forEach((client) => {
    const queue = commandQueues.get(client.clientId) || [];
    queue.push(message);
    commandQueues.set(client.clientId, queue.slice(-20));
    sentCount += 1;
  });
  return sentCount;
}

function handleCommandAck(message: Extract<BridgeMessage, { type: "command_ack" }>): void {
  const ackKey = `${message.commandId}:${message.commandType}:${message.message}`;
  if (handledAckKeys.has(ackKey)) return;
  handledAckKeys.add(ackKey);
  setTimeout(() => handledAckKeys.delete(ackKey), 60000);
  const pending = pendingCommands.get(message.commandId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingCommands.delete(message.commandId);
    pending.resolve({
      commandId: message.commandId,
      sent: true,
      ack: true,
      success: message.success,
      message: message.message
    });
  }
  collectionState = message.pluginState || message.currentState || "error";
  if (message.commandType === "start_auto_scroll" || message.commandType === "scroll_once") {
    if (message.success) collectionState = "collecting";
    scrollState = message.success ? (message.details?.currentStep && message.details.currentStep >= (message.details.totalSteps || 1) ? "stopped_with_data" : "scrolling") : "error";
    if (message.details) {
      scrollProgress = {
        currentStep: Number(message.details.currentStep || 0),
        totalSteps: Number(message.details.totalSteps || 0),
        delayMs: Number(message.details.delayMs || 0),
        collectedCount: Number(message.details.collectedCount || 0)
      };
    }
  } else if (message.commandType === "stop_auto_scroll") {
    if (collectionState === "auto_scrolling") collectionState = "collecting";
    scrollState = "stopped";
  }
  if (message.url && isFacebookGroupUrl(message.url)) {
    upsertGroupStatus(message.url, { status: message.success ? "open" : "error", url: message.url });
  }
  if ((message.commandType === "start_group_monitor" || message.commandType === "start_monitoring") && message.success) {
    const details = message.details || {};
    const targetUrl = String(details.groupUrl || message.url || "");
    const currentDateKey = todayKey();
    const current = groupStatusByKey.get(groupMonitorKey(targetUrl));
    const collectedCount = Number(details.collectedCount || 0);
    const todayNewPosts = current && current.dateKey === currentDateKey ? (current.todayNewPosts + collectedCount) : collectedCount;
    upsertGroupStatus(targetUrl, {
      status: "monitoring",
      lastCheckedAt: formatLocalDateTime(new Date()),
      lastNewPostAt: collectedCount > 0 ? formatLocalDateTime(new Date()) : current?.lastNewPostAt,
      todayNewPosts,
      dateKey: currentDateKey,
      name: typeof details.groupName === "string" ? details.groupName : undefined,
      url: targetUrl || undefined
    });
  }
  if ((message.commandType === "stop_group_monitor" || message.commandType === "stop_monitoring") && message.success) {
    const targetUrl = String(message.details?.groupUrl || message.url || "");
    upsertGroupStatus(targetUrl, {
      status: isFacebookGroupUrl(targetUrl) ? "open" : "not_open",
      lastCheckedAt: formatLocalDateTime(new Date())
    });
  }
  const detailText = message.details ? `；详情：${JSON.stringify(message.details)}` : "";
  const locationText = message.url ? `；页面：${message.url}` : "";
  addOperation(`插件确认：${message.message}${locationText}${detailText}`, message.success ? "success" : "error");
  if (!message.success) collectionState = "error";
  broadcastState();
}

function sendCommand(type: BridgeMessage["type"], payload?: unknown): Promise<CommandResult> {
  const id = commandId();
  const connectedCount = stats().connectedClients;
  const commandClientCount = activeCommandClients().length;
  if (connectedCount === 0) {
    collectionState = "error";
    addOperation(`命令发送失败：${type}；未检测到已连接插件`, "error");
    addOperation("插件未连接，请确认浏览器插件已安装，并打开 Facebook 页面", "warning");
    broadcastState();
    return Promise.resolve({ commandId: id, sent: false, ack: false, success: false, message: "插件未连接，请确认浏览器插件已安装，并打开 Facebook 页面" });
  }
  if (commandClientCount === 0) {
    collectionState = "error";
    addOperation(`命令发送失败：${type}；当前没有正在轮询的 Facebook content script`, "error");
    addOperation("当前没有可采集的 Facebook 页面：请刷新 Facebook 页面，确认插件版本为 v0.1.14，并保持该页面打开", "warning");
    broadcastState();
    return Promise.resolve({ commandId: id, sent: false, ack: false, success: false, message: "当前没有可采集的 Facebook 页面，请刷新 Facebook 页面或重新加载插件" });
  }
  const message = payload === undefined ? ({ type, commandId: id } as BridgeMessage) : ({ type, commandId: id, payload } as BridgeMessage);
  addOperation(`桌面端发送命令：${type}；commandId=${id}`, "info");
  const sentCount = broadcastToExtensions(message);
  addOperation(`命令已投递到 ${sentCount} 个 Facebook content script`, sentCount > 0 ? "info" : "error");
  if (sentCount === 0) {
    collectionState = "error";
    addOperation(`命令发送失败：${type}；没有可投递的 Facebook 页面`, "error");
    broadcastState();
    return Promise.resolve({ commandId: id, sent: false, ack: false, success: false, message: "没有可投递的 Facebook 页面" });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingCommands.has(id)) {
        pendingCommands.delete(id);
      }
      collectionState = "error";
      addOperation(`${type} 未收到插件 ACK 确认；commandId=${id}`, "error");
      addOperation("插件已断开或当前没有可采集的 Facebook 页面，请刷新 Facebook 页面或重新打开插件", "warning");
      broadcastState();
      resolve({ commandId: id, sent: true, ack: false, success: false, message: `${type} 未收到插件 ACK 确认` });
    }, 12000);
    pendingCommands.set(id, { type, createdAt: Date.now(), resolve, timeout });
  });
}

function assertWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${Date.now()}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function flashWindow(): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.flashFrame(true);
  setTimeout(() => mainWindow?.flashFrame(false), 5000);
}

function maybeAlert(post: RadarPost): RadarPost {
  if (!shouldTriggerAlert(post, settings)) return post;
  const alerted = {
    ...post,
    alertTriggered: true,
    statusNote: post.statusNote === "正常" ? "已提醒" : post.statusNote
  };
  log("Alert triggered", { postId: alerted.postId, score: alerted.score });
  if (settings.alerts.flashWindowEnabled) flashWindow();
  if (settings.alerts.desktopNotificationEnabled && Notification.isSupported()) {
    new Notification({
      title: "发现新的机会帖子",
      body: `${alerted.rawTimeText || "时间未识别"} | ${alerted.score}分 | ${alerted.postTextPreview}`
    }).show();
  }
  if (settings.alerts.soundEnabled) mainWindow?.webContents.send("play-alert-sound");
  return alerted;
}

function normalizeDateTimeInput(value?: string): string {
  if (!value) return formatLocalDateTime(new Date());
  const normalized = value.replace(" ", "T").replace(/\.(\d{2})\.(\d{2})$/, ":$1:$2");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : formatLocalDateTime(parsed);
}

function enrichPost(input: Partial<RadarPost>, clientId = "unknown"): RadarPost {
  const rawTimeText = input.rawTimeText || "";
  const parsedTime = parseFacebookTime(rawTimeText);
  const scored = scorePost(
    {
      postText: input.postText,
      rawTimeText
    },
    settings
  );
  const postUrl = input.postUrl || "";
  const postId = input.postId || dedupeKey({ postUrl, postText: input.postText, groupName: input.groupName });
  const text = input.postText || "";
  const statusNote = parsedTime.statusNote || (text.length < 12 ? "内容过短" : "正常");

  return maybeAlert({
    postId,
    groupName: input.groupName || "未知群组",
    groupUrl: input.groupUrl || "",
    authorName: input.authorName || "",
    postText: text,
    postTextPreview: input.postTextPreview || text.slice(0, 140),
    postUrl,
    rawTimeText,
    parsedPostTime: parsedTime.parsedPostTime,
    timeConfidence: parsedTime.timeConfidence,
    isNewPost: scored.isNewPost,
    matchedKeywords: scored.matchedKeywords,
    negativeKeywords: scored.negativeKeywords,
    score: scored.score,
    scoreReasons: scored.scoreReasons,
    alertTriggered: input.alertTriggered || false,
    collectedAt: normalizeDateTimeInput(input.collectedAt),
    sourceWindowId: input.sourceWindowId || clientId,
    sourceAccountNote: input.sourceAccountNote || "",
    statusNote,
    translatedText: input.translatedText || ""
  });
}

function addPosts(incoming: Partial<RadarPost>[], clientId?: string): void {
  let count = 0;
  let ignored = 0;
  let duplicates = 0;
  incoming.forEach((item) => {
    const post = enrichPost(item, clientId);
    if (!post.postText || post.postText === "未识别到正文") {
      ignored += 1;
      return;
    }
    const key = dedupeKey(post);
    const previous = posts.get(key);
    posts.set(key, previous ? { ...previous, ...post, alertTriggered: previous.alertTriggered || post.alertTriggered } : post);
    if (previous) duplicates += 1;
    else count += 1;
  });
  persistPosts();
  log("Posts collected", { count, duplicates, ignored, source: clientId });
  addOperation(`已加入实时帖子列表：${count} 条；重复更新：${duplicates} 条；无正文忽略：${ignored} 条`, count > 0 ? "success" : "info");
  broadcastState();
}

function exportRows() {
  return [...posts.values()].map((post) => ({
    群组名称: post.groupName,
    发帖人: post.authorName,
    帖子内容: post.postText,
    帖子链接: post.postUrl,
    原始发布时间: post.rawTimeText,
    解析发布时间: post.parsedPostTime,
    是否新帖: post.isNewPost ? "是" : "否",
    匹配关键词: post.matchedKeywords.join(", "),
    排除关键词: post.negativeKeywords.join(", "),
    评分: post.score,
    是否已提醒: post.alertTriggered ? "是" : "否",
    是否已处理: post.handled ? "是" : "否",
    处理时间: post.handledAt || "",
    处理颜色: post.handledColor || "",
    是否已忽略: post.ignored ? "是" : "否",
    采集时间: post.collectedAt,
    来源窗口: post.sourceWindowId,
    状态备注: post.statusNote,
    用户备注: post.remark || "",
    翻译内容: post.translatedText || ""
  }));
}

function timestampName(ext: string): string {
  const stamp = formatLocalDateTime(new Date()).replace(/\./g, "-").replace(" ", "_");
  return path.join(exportDir(), `facebook_posts_${stamp}.${ext}`);
}

async function exportCsv(): Promise<string> {
  const rows = exportRows();
  if (rows.length === 0) throw new Error("当前没有可导出的帖子");
  const sheet = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(sheet);
  const file = timestampName("csv");
  fs.writeFileSync(file, csv, "utf8");
  log("CSV exported", file);
  return file;
}

async function exportXlsx(): Promise<string> {
  const rows = exportRows();
  if (rows.length === 0) throw new Error("当前没有可导出的帖子");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Posts");
  const file = timestampName("xlsx");
  XLSX.writeFile(workbook, file);
  log("Excel exported", file);
  return file;
}

function translationEndpoint(translation: RadarSettings["translation"]): string {
  return `${translation.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function requestTranslation(text: string): Promise<string> {
  const translation = settings.translation;
  if (!text.trim()) throw new Error("没有可翻译的内容");
  if (!translation.apiKey && translation.apiType !== "local") {
    throw new Error("翻译 API Key 未配置");
  }
  if (!translation.baseUrl) {
    throw new Error("翻译 Base URL 未配置");
  }
  const response = await fetch(translationEndpoint(translation), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(translation.apiKey ? { Authorization: `Bearer ${translation.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: translation.model,
      messages: [
        { role: "system", content: `Translate the user text to ${translation.targetLanguage}. Return only the translation.` },
        { role: "user", content: text }
      ],
      temperature: 0
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const translated = data.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error("API 没有返回翻译内容");
  return translated;
}

function startLocalServer(): void {
  const api = express();
  api.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  api.use(express.json({ limit: "5mb" }));
  api.get("/health", (_req, res) => res.json({ ok: true, connectedClients: stats().connectedClients }));
  api.get("/state", (_req, res) => res.json(appState().payload));
  api.post("/client-heartbeat", (req, res) => {
    const body = req.body as { clientId?: string; tabUrl?: string; userAgent?: string };
    const clientId = body.clientId || `http-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const previous = httpClients.get(clientId);
    httpClients.set(clientId, {
      clientId,
      connectedAt: previous?.connectedAt || new Date().toISOString(),
      tabUrl: body.tabUrl,
      userAgent: body.userAgent,
      lastSeenAt: Date.now()
    });
    if (isFacebookGroupUrl(body.tabUrl)) {
      upsertGroupStatus(body.tabUrl, { status: "open", url: body.tabUrl });
    }
    const commands = commandQueues.get(clientId) || [];
    commandQueues.set(clientId, []);
    broadcastState();
    res.json({ ok: true, clientId, settings, commands });
  });
  api.post("/command-ack", (req, res) => {
    handleCommandAck(req.body as Extract<BridgeMessage, { type: "command_ack" }>);
    res.json({ ok: true });
  });
  api.post("/posts", (req, res) => {
    const body = req.body as { clientId?: string; posts?: Partial<RadarPost>[]; post?: Partial<RadarPost> };
    addPosts(body.posts || (body.post ? [body.post] : []), body.clientId);
    res.json({ ok: true });
  });

  nativeServer = http.createServer(api);
  const wss = new WebSocketServer({ server: nativeServer });
  wss.on("connection", (socket, req) => {
    const isRenderer = req.url?.includes("role=renderer");
    if (isRenderer) {
      rendererSockets.add(socket);
      socket.send(JSON.stringify(appState()));
      socket.on("close", () => rendererSockets.delete(socket));
      return;
    }

    const clientId = `window-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    clients.set(socket, {
      clientId,
      connectedAt: new Date().toISOString(),
      tabUrl: req.url
    });
    log("Extension connected", { clientId });
    socket.send(JSON.stringify({ type: "settings_updated", payload: settings }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as BridgeMessage;
      if (message.type === "extension_connected") {
        clients.set(socket, {
          clientId: message.clientId || clientId,
          connectedAt: new Date().toISOString(),
          tabUrl: req.url,
          userAgent: message.payload?.userAgent
        });
        broadcastState();
      }
      if (message.type === "post_collected") addPosts([message.payload], message.clientId || clientId);
      if (message.type === "posts_batch_collected") addPosts(message.payload, message.clientId || clientId);
      if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", clientId }));
      if (message.type === "command_ack") handleCommandAck(message);
    });
    socket.on("close", () => {
      clients.delete(socket);
      log("Extension disconnected", { clientId });
      broadcastState();
    });
    broadcastState();
  });

  nativeServer.listen(serverPort, "127.0.0.1", () => log("Local service started", `127.0.0.1:${serverPort}`));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    title: "Facebook Opportunity Radar",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("command", async (_event, command: string, payload?: unknown) => {
  addOperation(`用户点击：${commandLabels[command] || command}`, "info");
  if (command === "start") {
    return sendCommand("start_collecting");
  }
  if (command === "pause") {
    return sendCommand("pause_collecting");
  }
  if (command === "stop") {
    return sendCommand("stop_collecting");
  }
  if (command === "clear") {
    const count = posts.size;
    posts.clear();
    persistPosts();
    addOperation(`数据已清空，共清空 ${count} 条帖子`, "success");
    if (stats().connectedClients > 0) {
      void sendCommand("clear_posts").then((result) => {
        if (!result.success) addOperation(`插件缓存清空失败：${result.message || "未收到确认"}`, "warning");
      });
    }
    broadcastState();
    return { ok: true, success: true, clearedCount: count, message: `已清空当前数据，共清除 ${count} 条帖子` };
  }
  if (command === "mark-handled" && (typeof payload === "string" || typeof payload === "object")) {
    const request = typeof payload === "string" ? { postId: payload, handled: true } : (payload as { postId?: string; handled?: boolean; handledColor?: string; remark?: string });
    const post = [...posts.values()].find((item) => item.postId === request.postId);
    if (post) {
      const nextHandled = request.handled !== false;
      posts.set(dedupeKey(post), {
        ...post,
        handled: nextHandled,
        handledAt: nextHandled ? formatLocalDateTime(new Date()) : undefined,
        handledColor: nextHandled ? (request.handledColor || post.handledColor || "#d9f2e6") : undefined,
        remark: typeof request.remark === "string" ? request.remark : post.remark,
        statusNote: nextHandled ? "已处理" : (post.alertTriggered ? "已提醒" : (post.timeConfidence === "unknown" ? "时间未识别，需要人工确认" : "正常"))
      });
      persistPosts();
      addOperation(nextHandled ? `帖子已标记处理：${post.postUrl || post.postId}` : `帖子已清除处理标记：${post.postUrl || post.postId}`, "success");
    } else {
      addOperation(`标记已处理失败：未找到帖子 ${request.postId || ""}`, "error");
    }
  }
  if (command === "clear-handled" && typeof payload === "string") {
    const post = [...posts.values()].find((item) => item.postId === payload);
    if (post) {
      posts.set(dedupeKey(post), {
        ...post,
        handled: false,
        handledAt: undefined,
        handledColor: undefined,
        statusNote: post.alertTriggered ? "已提醒" : (post.timeConfidence === "unknown" ? "时间未识别，需要人工确认" : "正常")
      });
      persistPosts();
      addOperation(`帖子已清除处理标记：${post.postUrl || post.postId}`, "success");
    } else {
      addOperation(`清除处理标记失败：未找到帖子 ${payload}`, "error");
    }
  }
  if (command === "ignore-post" && typeof payload === "string") {
    const post = [...posts.values()].find((item) => item.postId === payload);
    if (post) {
      posts.set(dedupeKey(post), { ...post, ignored: true, statusNote: "已忽略" });
      persistPosts();
      addOperation(`帖子已忽略：${post.postUrl || post.postId}`, "success");
    } else {
      addOperation(`忽略帖子失败：未找到帖子 ${payload}`, "error");
    }
  }
  if (command === "test-sound") {
    mainWindow?.webContents.send("play-alert-sound");
    addOperation("声音提醒测试已触发", "success");
  }
  if (command === "test-flash") {
    flashWindow();
    if (Notification.isSupported()) {
      new Notification({
        title: "Facebook Opportunity Radar",
        body: "测试提醒：发现新的群组帖子"
      }).show();
    }
    addOperation("窗口闪动和系统通知测试已触发", "success");
  }
  if (command === "open-data-dir") {
    const result = await shell.openPath(exportDir());
    if (result) addOperation(`打开数据目录失败：${result}`, "error");
    else addOperation(`已打开导出目录：${exportDir()}`, "success");
    return { ok: !result, path: exportDir(), message: result || "已打开导出目录" };
  }
  if (command === "open-log-folder") {
    const result = await shell.openPath(logDir());
    if (result) addOperation(`打开日志文件夹失败：${result}`, "error");
    else addOperation(`已打开日志文件夹：${logDir()}`, "success");
    return { ok: !result, path: logDir(), message: result || "已打开日志文件夹" };
  }
  if (command === "clear-logs") {
    operationLog.splice(0);
    fs.writeFileSync(operationLogFile(), "", "utf8");
    addOperation("运行日志已清空", "success");
  }
  if (command === "ui-log" && typeof payload === "string") {
    addOperation(payload, "success");
  }
  if (command === "open-url" && typeof payload === "string") {
    await shell.openExternal(payload);
    addOperation(`已打开帖子链接：${payload}`, "success");
  }
  if (command === "export-csv") {
    try {
      const file = await exportCsv();
      addOperation(`CSV 导出完成：${file}`, "success");
      return file;
    } catch (error) {
      addOperation(String(error instanceof Error ? error.message : error), "warning");
      return null;
    }
  }
  if (command === "export-xlsx") {
    try {
      const file = await exportXlsx();
      addOperation(`Excel 导出完成：${file}`, "success");
      return file;
    } catch (error) {
      addOperation(String(error instanceof Error ? error.message : error), "warning");
      return null;
    }
  }
  if (command === "update-settings") {
    const incoming = payload as RadarSettings;
    settings = {
      ...defaultSettings,
      ...incoming,
      alerts: { ...defaultSettings.alerts, ...incoming.alerts },
      autoScroll: { ...defaultSettings.autoScroll, ...incoming.autoScroll },
      groupMonitor: { ...defaultSettings.groupMonitor, ...incoming.groupMonitor },
      translation: { ...defaultSettings.translation, ...incoming.translation }
    };
    persistSettings();
    addOperation(`设置已保存；群组数量：${settings.groupMonitor.groups.length}`, "success");
    broadcastToExtensions({ type: "settings_updated", payload: settings });
  }
  if (command === "translate-post" && typeof payload === "string") {
    const post = [...posts.values()].find((item) => item.postId === payload);
    if (!post) {
      addOperation(`翻译失败：未找到帖子 ${payload}`, "error");
      return { ok: false, message: `未找到帖子 ${payload}` };
    }
    try {
      const translated = await requestTranslation(post.postText);
      posts.set(dedupeKey(post), { ...post, translatedText: translated });
      persistPosts();
      broadcastState();
      addOperation(`帖子翻译完成：${post.postUrl || post.postId}`, "success");
      return { ok: true, message: translated };
    } catch (error) {
      const message = `帖子翻译失败：${String(error instanceof Error ? error.message : error)}`;
      addOperation(message, "error");
      return { ok: false, message };
    }
  }
  if (command === "test-translation") {
    try {
      const translated = await requestTranslation("Looking for supplier for wholesale custom product.");
      addOperation(`测试翻译成功：${translated}`, "success");
      return { ok: true, message: translated };
    } catch (error) {
      const message = `测试翻译失败：${String(error instanceof Error ? error.message : error)}`;
      addOperation(message, "error");
      return { ok: false, message };
    }
  }
  if (command === "start-auto-scroll") return sendCommand("start_auto_scroll", payload as { count: number; delayMs?: number });
  if (command === "stop-auto-scroll") return sendCommand("stop_auto_scroll");
  if (command === "test-collect") return sendCommand("collect_once");
  if (command === "test-scroll") return sendCommand("scroll_once");
  if (command === "diagnose") {
    const logsOk = assertWritableDir(path.dirname(operationLogFile()));
    const configOk = assertWritableDir(path.dirname(settingsFile()));
    const translationConfigured = Boolean(settings.translation.apiKey || settings.translation.apiType === "local");
    addOperation(`功能自检：本地服务=正常；插件连接=${stats().connectedClients > 0 ? "正常" : "失败"}；日志目录=${logsOk ? "正常" : "失败"}；config目录=${configOk ? "正常" : "失败"}；翻译API=${translationConfigured ? "正常" : "未配置"}；列表过滤=只保存关键词匹配结果`, logsOk && configOk ? "info" : "error");
    return sendCommand("diagnose");
  }
  if (command === "start-group-monitor") return sendCommand("start_group_monitor", payload as { intervalSeconds: number });
  if (command === "stop-group-monitor") return sendCommand("stop_group_monitor");
  persistPosts();
  broadcastState();
  return null;
});

app.whenReady().then(() => {
  loadPersistedData();
  startLocalServer();
  createWindow();
});

app.on("window-all-closed", () => {
  nativeServer?.close();
  if (process.platform !== "darwin") app.quit();
});
