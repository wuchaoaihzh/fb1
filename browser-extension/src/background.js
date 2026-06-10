const LOCAL_WS = "ws://127.0.0.1:8765";
const LOCAL_HEALTH = "http://127.0.0.1:8765/health";
const LOCAL_HEARTBEAT = "http://127.0.0.1:8765/client-heartbeat";
const LOCAL_POSTS = "http://127.0.0.1:8765/posts";
let socket = null;
let clientId = `ext-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let connected = false;
let latestSettings = null;
let reconnectTimer = null;
let heartbeatTimer = null;

function setConnected(value) {
  connected = value;
  chrome.storage.local.set({ connected, clientId, lastStatusAt: Date.now() });
}

async function heartbeatToLocal() {
  try {
    const response = await fetch(LOCAL_HEARTBEAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, userAgent: navigator.userAgent })
    });
    if (!response.ok) throw new Error(`Heartbeat failed: ${response.status}`);
    const data = await response.json();
    if (data.settings) latestSettings = data.settings;
    setConnected(true);
    return true;
  } catch {
    setConnected(false);
    return false;
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
  }, 20000);
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

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "settings_updated") {
      latestSettings = message.payload;
      chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://facebook.com/*"] }, (tabs) => {
        tabs.forEach((tab) => tab.id && chrome.tabs.sendMessage(tab.id, { type: "settings_updated", payload: latestSettings }));
      });
    }
    if (message.type === "start_auto_scroll" || message.type === "stop_auto_scroll") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId) chrome.tabs.sendMessage(tabId, message);
      });
    }
  });

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
      const body = message.type === "posts_batch_collected"
        ? { clientId, posts: message.payload }
        : { clientId, post: message.payload };
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "get_status") {
    heartbeatToLocal().then(() => {
      connect();
      sendResponse({ connected, clientId, settings: latestSettings });
    });
    return true;
  }

  if (message.type === "posts_batch_collected" || message.type === "post_collected") {
    sendToLocal(message).then((ok) => sendResponse({ ok, connected }));
    return true;
  }

  if (message.type === "collect_current_tab") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) return sendResponse({ ok: false, error: "No active tab" });
      chrome.tabs.sendMessage(tabId, { type: "collect_now" }, sendResponse);
    });
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
