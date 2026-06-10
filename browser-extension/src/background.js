const LOCAL_WS = "ws://127.0.0.1:8765";
const LOCAL_HEALTH = "http://127.0.0.1:8765/health";
const LOCAL_HEARTBEAT = "http://127.0.0.1:8765/client-heartbeat";
const LOCAL_POSTS = "http://127.0.0.1:8765/posts";
const LOCAL_ACK = "http://127.0.0.1:8765/command-ack";

let socket = null;
let clientId = `ext-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let connected = false;
let latestSettings = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let extensionState = "stopped";

function setConnected(value) {
  connected = value;
  chrome.storage.local.set({ connected, clientId, lastStatusAt: Date.now(), extensionState });
}

function facebookTabQuery() {
  return { url: ["https://www.facebook.com/*", "https://facebook.com/*"] };
}

async function listFacebookTabs() {
  return chrome.tabs.query(facebookTabQuery());
}

async function getActiveFacebookTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (activeTab?.id && /^https:\/\/(www\.)?facebook\.com\//.test(activeTab.url || "")) return activeTab;
  const facebookTabs = await listFacebookTabs();
  return facebookTabs.find((tab) => tab.id);
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping_content" });
    return response?.ok === true;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const response = await chrome.tabs.sendMessage(tabId, { type: "ping_content" });
    return response?.ok === true;
  }
}

async function sendToFacebookTab(message) {
  const tab = await getActiveFacebookTab();
  if (!tab?.id) {
    return { ok: false, error: "当前没有可采集的 Facebook 页面，请先在 AdsPower/Chrome 中打开 Facebook 页面" };
  }

  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    return {
      ok: false,
      error: `content script 未注入或无法连接：${String(error?.message || error)}`,
      tabId: tab.id,
      url: tab.url
    };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    return { ok: response?.ok !== false, ...response, tabId: tab.id, url: tab.url };
  } catch (error) {
    return {
      ok: false,
      error: `命令已到 background，但发送到 Facebook 页面失败：${String(error?.message || error)}`,
      tabId: tab.id,
      url: tab.url
    };
  }
}

async function postAck(ack) {
  const payload = {
    ...ack,
    type: "command_ack",
    command: ack.command || ack.commandType,
    pluginState: ack.pluginState || ack.currentState,
    clientId,
    timestamp: new Date().toISOString()
  };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  try {
    await fetch(LOCAL_ACK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    // WebSocket may already have delivered the ACK.
  }
}

async function heartbeatToLocal() {
  try {
    const tab = await getActiveFacebookTab();
    const response = await fetch(LOCAL_HEARTBEAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, userAgent: navigator.userAgent, tabUrl: tab?.url || "" })
    });
    if (!response.ok) throw new Error(`Heartbeat failed: ${response.status}`);
    const data = await response.json();
    if (data.settings) latestSettings = data.settings;
    if (Array.isArray(data.commands)) {
      data.commands.forEach((command) => runExtensionCommand(command));
    }
    setConnected(true);
    return true;
  } catch {
    setConnected(false);
    return false;
  }
}

function defaultSuccessMessage(commandType) {
  return {
    start_collecting: "采集已启动，当前正在监听 Facebook 页面",
    pause_collecting: "采集已暂停",
    stop_collecting: "采集已停止",
    collect_once: "测试采集完成",
    scroll_once: "测试滚动成功",
    get_plugin_state: "插件状态已返回",
    get_active_facebook_tabs: "Facebook 页面列表已返回",
    start_auto_scroll: "自动滚动已启动，正在控制 Facebook 页面滚动",
    stop_auto_scroll: "自动滚动已停止",
    diagnose: "连接诊断完成",
    start_group_monitor: "群组监控已启动",
    stop_group_monitor: "群组监控已停止"
  }[commandType] || "命令已执行";
}

async function runExtensionCommand(message) {
  if (!message || !message.type) return;
  if (message.type === "settings_updated") {
    latestSettings = message.payload;
    const tabs = await listFacebookTabs();
    tabs.forEach((tab) => tab.id && chrome.tabs.sendMessage(tab.id, message).catch(() => undefined));
    return;
  }

  const commandId = message.commandId || `cmd-${Date.now()}`;
  const commandType = message.type;

  try {
    let result = { ok: true };
    let nextState = extensionState;

    if (commandType === "get_plugin_state") {
      const tab = await getActiveFacebookTab();
      result = { ok: true, message: "插件在线", tabId: tab?.id, url: tab?.url };
      nextState = extensionState;
    } else if (commandType === "get_active_facebook_tabs") {
      const tabs = await listFacebookTabs();
      result = {
        ok: true,
        message: tabs.length ? `检测到 ${tabs.length} 个 Facebook 页面` : "没有检测到 Facebook 页面",
        tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }))
      };
      nextState = extensionState;
    } else if (commandType === "collect_once") {
      result = await sendToFacebookTab({ ...message, type: "collect_now" });
      nextState = result.ok === false ? "error" : "collecting";
    } else if (commandType === "scroll_once") {
      result = await sendToFacebookTab({ ...message, type: "test_scroll_once" });
      nextState = result.ok === false ? "error" : extensionState === "stopped" ? "collecting" : extensionState;
    } else if (commandType === "start_collecting") {
      result = await sendToFacebookTab(message);
      nextState = result.ok === false ? "error" : "collecting";
    } else if (commandType === "pause_collecting") {
      result = await sendToFacebookTab(message);
      nextState = result.ok === false ? "error" : "paused";
    } else if (commandType === "stop_collecting") {
      result = await sendToFacebookTab(message);
      nextState = result.ok === false ? "error" : "stopped";
    } else if (commandType === "start_auto_scroll") {
      result = await sendToFacebookTab(message);
      nextState = result.ok === false ? "error" : "auto_scrolling";
    } else if (commandType === "stop_auto_scroll") {
      result = await sendToFacebookTab(message);
      nextState = result.ok === false ? "error" : "collecting";
    } else if (commandType === "diagnose" || commandType === "start_group_monitor" || commandType === "stop_group_monitor") {
      result = await sendToFacebookTab(message);
      if (commandType === "start_group_monitor" && result.ok !== false) nextState = "monitoring";
      if (commandType === "stop_group_monitor" && result.ok !== false) nextState = "stopped";
      if (result.ok === false) nextState = "error";
    } else {
      result = { ok: false, error: `命令 ${commandType} 尚未实现，已禁用真实执行` };
      nextState = "error";
    }

    extensionState = nextState;
    await postAck({
      commandId,
      commandType,
      command: commandType,
      success: result.ok !== false,
      message: result.message || result.error || defaultSuccessMessage(commandType),
      currentState: extensionState,
      pluginState: extensionState,
      tabId: result.tabId,
      url: result.url,
      details: result
    });
  } catch (error) {
    extensionState = "error";
    await postAck({
      commandId,
      commandType,
      command: commandType,
      success: false,
      message: String(error?.message || error || "命令执行失败"),
      currentState: "error",
      pluginState: "error"
    });
  }
}

function scheduleReconnect(delay = 2500) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    heartbeatToLocal();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      scheduleReconnect();
      return;
    }
    socket.send(JSON.stringify({ type: "ping", clientId }));
  }, 4000);
}

async function isDesktopAvailable() {
  try {
    const response = await fetch(LOCAL_HEALTH, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function connect() {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
  if (!(await isDesktopAvailable())) {
    setConnected(false);
    scheduleReconnect();
    return;
  }

  socket = new WebSocket(LOCAL_WS);
  socket.addEventListener("open", () => {
    setConnected(true);
    heartbeatToLocal();
    startHeartbeat();
    socket.send(JSON.stringify({ type: "extension_connected", clientId, payload: { userAgent: navigator.userAgent } }));
  });
  socket.addEventListener("message", (event) => runExtensionCommand(JSON.parse(event.data)));
  socket.addEventListener("close", () => {
    setConnected(false);
    stopHeartbeat();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setConnected(false);
    socket?.close();
  });
}

async function sendToLocal(message) {
  await connect();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    try {
      const body = message.type === "posts_batch_collected" ? { clientId, posts: message.payload } : { clientId, post: message.payload };
      const response = await fetch(LOCAL_POSTS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Post failed: ${response.status}`);
      await heartbeatToLocal();
      return true;
    } catch {
      return false;
    }
  }
  socket.send(JSON.stringify({ ...message, clientId }));
  return true;
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "get_status") {
    heartbeatToLocal().then(() => {
      connect();
      sendResponse({ connected, clientId, settings: latestSettings, extensionState });
    });
    return true;
  }
  if (message.type === "posts_batch_collected" || message.type === "post_collected") {
    sendToLocal(message).then((ok) => sendResponse({ ok, connected }));
    return true;
  }
  if (message.type === "command_ack") {
    postAck({ ...message, clientId }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "collect_current_tab") {
    runExtensionCommand({ type: "start_collecting", commandId: `popup-${Date.now()}` }).then(() => sendResponse({ ok: true, connected }));
    return true;
  }
  if (message.type === "send_test_post") {
    const post = {
      postId: `test-${Date.now()}`,
      groupName: "Test Facebook Group",
      groupUrl: "https://www.facebook.com/groups/test",
      authorName: "Test Buyer",
      postText: "Looking for supplier in China for custom product. Need factory price and bulk order quote.",
      postTextPreview: "Looking for supplier in China for custom product...",
      postUrl: `https://www.facebook.com/groups/test/posts/${Date.now()}`,
      rawTimeText: "1m",
      collectedAt: new Date().toISOString(),
      sourceWindowId: clientId,
      sourceAccountNote: "",
      statusNote: "测试数据"
    };
    sendToLocal({ type: "post_collected", payload: post }).then((ok) => sendResponse({ ok, connected }));
    return true;
  }
});
