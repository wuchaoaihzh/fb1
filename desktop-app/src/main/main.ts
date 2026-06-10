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
  formatLocalDateTime,
  parseFacebookTime,
  scorePost,
  shouldTriggerAlert,
  type BridgeMessage,
  type CollectionState,
  type ExtensionClientInfo,
  type RadarPost,
  type RadarSettings,
  type RadarStats
} from "@foradar/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const serverPort = 8765;

let mainWindow: BrowserWindow | null = null;
let settings: RadarSettings = defaultSettings;
let collectionState: CollectionState = "stopped";
const posts = new Map<string, RadarPost>();
const clients = new Map<WebSocket, ExtensionClientInfo>();
const httpClients = new Map<string, ExtensionClientInfo & { lastSeenAt: number }>();
const commandQueues = new Map<string, BridgeMessage[]>();
const operationLog: Array<{ at: string; message: string; level: "info" | "success" | "error" }> = [];
const pendingCommands = new Map<string, { type: string; createdAt: number }>();
const rendererSockets = new Set<WebSocket>();
let nativeServer: http.Server | null = null;

function addOperation(message: string, level: "info" | "success" | "error" = "info"): void {
  operationLog.unshift({ at: new Date().toLocaleTimeString(), message, level });
  operationLog.splice(80);
  broadcastState();
}

function commandId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dataDir(): string {
  const dir = path.join(app.getPath("userData"), "data");
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
  return path.join(dataDir(), "settings.json");
}

function postsFile(): string {
  return path.join(dataDir(), "posts.json");
}

function loadPersistedData(): void {
  try {
    if (fs.existsSync(settingsFile())) {
      const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<RadarSettings>;
      settings = {
        ...defaultSettings,
        ...saved,
        alerts: { ...defaultSettings.alerts, ...saved.alerts },
        autoScroll: { ...defaultSettings.autoScroll, ...saved.autoScroll },
        groupMonitor: { ...defaultSettings.groupMonitor, ...saved.groupMonitor }
      };
    }
    if (fs.existsSync(postsFile())) {
      const saved = JSON.parse(fs.readFileSync(postsFile(), "utf8")) as RadarPost[];
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
  const today = new Date().toISOString().slice(0, 10);
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

function appState() {
  return {
    type: "state",
    payload: {
      posts: [...posts.values()].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt)),
      settings,
      collectionState,
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

function broadcastToExtensions(message: BridgeMessage): void {
  const serialized = JSON.stringify(message);
  clients.forEach((_, socket) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(serialized);
  });
  activeHttpClients().forEach((client) => {
    const queue = commandQueues.get(client.clientId) || [];
    queue.push(message);
    commandQueues.set(client.clientId, queue.slice(-20));
  });
}

function handleCommandAck(message: Extract<BridgeMessage, { type: "command_ack" }>): void {
  pendingCommands.delete(message.commandId);
  collectionState = message.currentState;
  addOperation(`插件确认：${message.message}`, message.success ? "success" : "error");
  if (!message.success) collectionState = "error";
  broadcastState();
}

function sendCommand(type: BridgeMessage["type"], payload?: unknown): { commandId: string; sent: boolean } {
  const id = commandId();
  const connectedCount = stats().connectedClients;
  if (connectedCount === 0) {
    collectionState = "error";
    addOperation("插件未连接，请确认浏览器插件已安装并打开 Facebook 页面", "error");
    broadcastState();
    return { commandId: id, sent: false };
  }
  const message = payload === undefined ? ({ type, commandId: id } as BridgeMessage) : ({ type, commandId: id, payload } as BridgeMessage);
  pendingCommands.set(id, { type, createdAt: Date.now() });
  addOperation(`${type} 命令已发送`, "info");
  broadcastToExtensions(message);
  setTimeout(() => {
    if (pendingCommands.has(id)) {
      pendingCommands.delete(id);
      collectionState = "error";
      addOperation(`${type} 未收到插件确认，请检查 Facebook 页面是否打开`, "error");
      broadcastState();
    }
  }, 12000);
  return { commandId: id, sent: true };
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
      title: "发现新需求帖",
      body: `${alerted.rawTimeText || "时间未识别"} | ${alerted.score}分 | ${alerted.postTextPreview}`
    }).show();
  }
  if (settings.alerts.soundEnabled) mainWindow?.webContents.send("play-alert-sound");
  return alerted;
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
    collectedAt: input.collectedAt || formatLocalDateTime(new Date()),
    sourceWindowId: input.sourceWindowId || clientId,
    sourceAccountNote: input.sourceAccountNote || "",
    statusNote
  });
}

function addPosts(incoming: Partial<RadarPost>[], clientId?: string): void {
  let count = 0;
  incoming.forEach((item) => {
    const post = enrichPost(item, clientId);
    const key = dedupeKey(post);
    const previous = posts.get(key);
    posts.set(key, previous ? { ...previous, ...post, alertTriggered: previous.alertTriggered || post.alertTriggered } : post);
    count += previous ? 0 : 1;
  });
  persistPosts();
  log("Posts collected", { count, source: clientId });
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
    采集时间: post.collectedAt,
    状态备注: post.statusNote
  }));
}

function timestampName(ext: string): string {
  const stamp = formatLocalDateTime(new Date()).replace(/:/g, "-").replace(" ", "_");
  return path.join(dataDir(), `facebook_posts_${stamp}.${ext}`);
}

async function exportCsv(): Promise<string> {
  const sheet = XLSX.utils.json_to_sheet(exportRows());
  const csv = XLSX.utils.sheet_to_csv(sheet);
  const file = timestampName("csv");
  fs.writeFileSync(file, csv, "utf8");
  log("CSV exported", file);
  return file;
}

async function exportXlsx(): Promise<string> {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows()), "Posts");
  const file = timestampName("xlsx");
  XLSX.writeFile(workbook, file);
  log("Excel exported", file);
  return file;
}

function startLocalServer(): void {
  const api = express();
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
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("command", async (_event, command: string, payload?: unknown) => {
  if (command === "start") {
    return sendCommand("start_collecting");
  }
  if (command === "pause") {
    return sendCommand("stop_collecting");
  }
  if (command === "stop") {
    return sendCommand("stop_collecting");
  }
  if (command === "clear") posts.clear();
  if (command === "mark-handled" && typeof payload === "string") {
    const post = [...posts.values()].find((item) => item.postId === payload);
    if (post) posts.set(dedupeKey(post), { ...post, handled: true, statusNote: "已处理" });
  }
  if (command === "ignore-post" && typeof payload === "string") {
    const post = [...posts.values()].find((item) => item.postId === payload);
    if (post) posts.set(dedupeKey(post), { ...post, ignored: true, statusNote: "已忽略" });
  }
  if (command === "test-sound") mainWindow?.webContents.send("play-alert-sound");
  if (command === "test-flash") flashWindow();
  if (command === "open-data-dir") await shell.openPath(dataDir());
  if (command === "open-url" && typeof payload === "string") await shell.openExternal(payload);
  if (command === "export-csv") return exportCsv();
  if (command === "export-xlsx") return exportXlsx();
  if (command === "update-settings") {
    settings = { ...defaultSettings, ...(payload as RadarSettings) };
    persistSettings();
    broadcastToExtensions({ type: "settings_updated", payload: settings });
  }
  if (command === "start-auto-scroll") return sendCommand("start_auto_scroll", payload as { count: number });
  if (command === "stop-auto-scroll") return sendCommand("stop_auto_scroll");
  if (command === "test-scroll") return sendCommand("test_scroll_once");
  if (command === "diagnose") return sendCommand("diagnose");
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
