const LOCAL_HEARTBEAT = "http://127.0.0.1:8765/client-heartbeat";
const LOCAL_POSTS = "http://127.0.0.1:8765/posts";
const LOCAL_ACK = "http://127.0.0.1:8765/command-ack";
const contentClientId = `content-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

if (globalThis.__FORADAR_CONTENT_STOP__) {
  try {
    globalThis.__FORADAR_CONTENT_STOP__();
  } catch {
    // Ignore stale cleanup errors.
  }
}

let collecting = false;
let autoScrollStopped = false;
let monitorTimer = null;
let latestSettings = null;
let collectTimer = null;
let contextActive = true;
let feedObserver = null;
let desktopPollTimer = null;
const seenKeys = new Set();

function stopAllLocalWork() {
  contextActive = false;
  collecting = false;
  autoScrollStopped = true;
  if (collectTimer) clearInterval(collectTimer);
  if (monitorTimer) clearInterval(monitorTimer);
  if (desktopPollTimer) clearInterval(desktopPollTimer);
  collectTimer = null;
  monitorTimer = null;
  desktopPollTimer = null;
  if (feedObserver) feedObserver.disconnect();
}

globalThis.__FORADAR_CONTENT_STOP__ = stopAllLocalWork;

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return response.ok ? await response.json().catch(() => ({ ok: true })) : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function isExtensionContextValid() {
  try {
    return Boolean(contextActive && chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    stopAllLocalWork();
    return false;
  }
}

function safeSendMessage(message) {
  if (!isExtensionContextValid()) return Promise.resolve({ ok: false, error: "extension_context_invalidated" });
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          if (String(error.message || "").includes("Extension context invalidated")) stopAllLocalWork();
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response || { ok: true });
      });
    } catch (error) {
      if (String(error?.message || error).includes("Extension context invalidated")) stopAllLocalWork();
      resolve({ ok: false, error: String(error?.message || error) });
    }
  });
}

async function requestDebuggerScroll(distance, commandId) {
  const response = await safeSendMessage({
    type: "debugger_scroll_request",
    commandId,
    distance,
    url: location.href
  });
  if (response?.ok) {
    return {
      ok: true,
      method: response.method || "cdp-debugger-mouseWheel",
      distance: response.distance || distance,
      beforeScrollTop: null,
      afterScrollTop: null,
      debuggerResult: response
    };
  }
  return {
    ok: false,
    method: "cdp-debugger-mouseWheel",
    distance,
    error: response?.error || response?.message || "debugger_scroll_request_failed",
    debuggerResult: response
  };
}

window.addEventListener("error", (event) => {
  if (String(event.message || "").includes("Extension context invalidated")) {
    stopAllLocalWork();
    event.preventDefault();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (String(event.reason?.message || event.reason || "").includes("Extension context invalidated")) {
    stopAllLocalWork();
    event.preventDefault();
  }
});

const noiseTexts = new Set([
  "facebook",
  "home",
  "watch",
  "marketplace",
  "groups",
  "gaming",
  "notifications",
  "messenger",
  "menu",
  "like",
  "comment",
  "share",
  "send",
  "all reactions",
  "write a comment",
  "view more comments",
  "most relevant",
  "newest",
  "author",
  "top contributor"
]);

const fallbackKeywords = {
  highValue: [
    "looking for supplier", "need supplier", "need manufacturer", "looking for manufacturer", "china supplier",
    "chinese supplier", "factory", "factory price", "wholesale", "bulk order", "custom product", "private label",
    "oem", "odm", "import from china", "source from china", "buy from china", "where can i buy", "who can supply",
    "need this product", "supplier needed", "manufacturer needed", "dropshipping supplier", "fulfillment",
    "agent in china", "sourcing agent"
  ],
  normal: [
    "price", "quote", "quotation", "moq", "sample", "shipping", "logistics", "warehouse", "product", "catalog",
    "available", "stock", "brand", "customized", "packaging"
  ],
  negative: [
    "job", "hiring", "looking for job", "course", "training", "free", "giveaway", "scam", "investment",
    "crypto", "loan", "dating", "used only", "second hand only", "repair service"
  ]
};

function hash(value) {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) result = (result * 33) ^ value.charCodeAt(index);
  return (result >>> 0).toString(16);
}

function normalizeUrl(url) {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return "";
  }
}

function visibleText(element) {
  return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
}

function visibleLines(element) {
  return (element?.innerText || element?.textContent || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isNoiseLine(line) {
  const text = line.trim();
  const lower = text.toLowerCase();
  if (!text) return true;
  if (noiseTexts.has(lower)) return true;
  if (/^(like|comment|share|send|\d+\s+comments?|\d+\s+shares?)$/i.test(text)) return true;
  if (/^(home|watch|marketplace|groups|gaming|notifications|messenger)$/i.test(text)) return true;
  if (/^(\d+[smhdw]|just now|yesterday)$/i.test(text)) return true;
  if (text.length <= 2) return true;
  return false;
}

function findGroupName() {
  const heading = document.querySelector("h1");
  const title = visibleText(heading);
  if (title) return title;
  return document.title.replace(/\| Facebook$/i, "").trim() || "未知群组";
}

function findGroupUrl() {
  const groupLink = [...document.querySelectorAll("a[href*='/groups/']")].find((anchor) => /\/groups\/[^/?#]+/.test(anchor.href));
  return groupLink ? normalizeUrl(groupLink.href) : normalizeUrl(window.location.href);
}

function likelyPostContainers() {
  const candidates = [
    ...document.querySelectorAll("[role='article']"),
    ...document.querySelectorAll("[data-pagelet*='FeedUnit']"),
    ...document.querySelectorAll("[aria-posinset]")
  ].filter((element) => {
    const rect = element.getBoundingClientRect();
    const text = visibleText(element);
    return rect.bottom > 0 && rect.top < window.innerHeight * 1.25 && text.length >= 20;
  });
  return [...new Set(candidates)];
}

function looksLikeTime(value) {
  const text = (value || "").trim();
  return /^(Just now|Now|Yesterday|\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))$/i.test(text) ||
    /^(刚刚|刚才|昨天|\d+\s*(分钟|分|小时|天|周|星期)前?)$/.test(text);
}

function findRawTime(container) {
  const direct = [...container.querySelectorAll("time, abbr, a[aria-label], span[aria-label], a[title], span[title]")];
  for (const element of direct) {
    const value = element.getAttribute("datetime") || element.getAttribute("aria-label") || element.getAttribute("title") || visibleText(element);
    if (looksLikeTime(value)) return value.trim();
  }
  for (const line of visibleLines(container)) {
    if (looksLikeTime(line)) return line;
  }
  return "";
}

function findPostUrl(container) {
  const anchors = [...container.querySelectorAll("a[href]")];
  const postLink = anchors.find((anchor) => {
    const href = anchor.href;
    return href.includes("/posts/") || href.includes("/permalink/") || href.includes("story_fbid=") || href.includes("fbid=") || href.includes("set=pcb");
  });
  return postLink ? normalizeUrl(postLink.href) : normalizeUrl(window.location.href);
}

function findAuthor(container) {
  const strong = container.querySelector("strong");
  if (strong && visibleText(strong).length < 80) return visibleText(strong);
  const authorLink = [...container.querySelectorAll("a[href]")].find((anchor) => {
    const text = visibleText(anchor);
    return text && text.length < 80 && !looksLikeTime(text) && !anchor.href.includes("/groups/") && !isNoiseLine(text);
  });
  return authorLink ? visibleText(authorLink) : "";
}

function extractPostText(container, authorName, rawTimeText) {
  const messageSelectors = [
    "div[data-ad-preview='message']",
    "div[data-ad-comet-preview='message']",
    "[data-testid='post_message']",
    "[dir='auto']"
  ];
  const candidateLines = [];

  for (const selector of messageSelectors) {
    for (const element of container.querySelectorAll(selector)) {
      const text = visibleText(element);
      if (text && text.length >= 8) candidateLines.push(text);
    }
  }

  if (candidateLines.length === 0) {
    candidateLines.push(
      ...visibleLines(container).filter((line) => {
        if (line === authorName || line === rawTimeText) return false;
        if (isNoiseLine(line)) return false;
        return true;
      })
    );
  }

  const cleaned = candidateLines
    .map((line) => line.replace(authorName || "", "").replace(rawTimeText || "", "").trim())
    .filter((line) => !isNoiseLine(line))
    .filter((line, index, list) => list.indexOf(line) === index);

  const meaningful = cleaned
    .filter((line) => line.length >= 8)
    .sort((a, b) => b.length - a.length);

  return meaningful[0] || cleaned.join(" ").slice(0, 500) || "";
}

function extractPost(container) {
  const postUrl = findPostUrl(container);
  const rawTimeText = findRawTime(container);
  const groupName = findGroupName();
  const groupUrl = findGroupUrl();
  const authorName = findAuthor(container);
  const extractedText = extractPostText(container, authorName, rawTimeText);
  const postText = extractedText || "未识别到正文";
  const postId = hash([postUrl, postText.slice(0, 120), groupName, rawTimeText].join("|"));
  return {
    postId,
    groupName,
    groupUrl,
    authorName,
    postText,
    postTextPreview: postText.slice(0, 160),
    postUrl,
    rawTimeText,
    collectedAt: new Date().toISOString(),
    sourceWindowId: `tab-${Date.now()}`,
    sourceAccountNote: "",
    statusNote: rawTimeText ? "正常" : "时间未识别，需要人工确认"
  };
}

function enabledKeywords(category) {
  if (!latestSettings?.keywords?.length) return fallbackKeywords[category] || [];
  return (latestSettings?.keywords || [])
    .filter((keyword) => keyword.enabled && keyword.category === category)
    .map((keyword) => String(keyword.text || "").trim().toLowerCase())
    .filter(Boolean);
}

function matchKeywords(text) {
  const lower = String(text || "").toLowerCase();
  const positive = [...enabledKeywords("highValue"), ...enabledKeywords("normal")].filter((keyword) => lower.includes(keyword));
  const negative = enabledKeywords("negative").filter((keyword) => lower.includes(keyword));
  return { positive: [...new Set(positive)], negative: [...new Set(negative)] };
}

function shouldKeepPost(post) {
  if (!post.postText || post.postText === "未识别到正文") return { keep: false, positive: [], negative: [], reason: "正文未识别" };
  if (isNoiseLine(post.postText)) return { keep: false, positive: [], negative: [], reason: "页面导航或交互噪音" };
  const matches = matchKeywords(post.postText);
  if (matches.negative.length > 0) return { keep: false, ...matches, reason: `命中排除关键词：${matches.negative.join(", ")}` };
  if (matches.positive.length === 0) return { keep: false, ...matches, reason: "未匹配高价值或普通关键词" };
  return { keep: true, ...matches, reason: "关键词匹配" };
}

function sendScanLog(scannedCount, matchedCount, ignoredCount, source, extra = {}) {
  postJson(LOCAL_ACK, {
    clientId: contentClientId,
    type: "command_ack",
    commandId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    commandType: "scan_result",
    command: "scan_result",
    success: true,
    message: `本次扫描：发现 ${scannedCount} 条帖子，关键词匹配 ${matchedCount} 条，忽略 ${ignoredCount} 条`,
    currentState: collecting ? "collecting" : "paused",
    pluginState: collecting ? "collecting" : "paused",
    timestamp: new Date().toISOString(),
    details: { scannedCount, matchedCount, ignoredCount, source, url: location.href, ...extra }
  });
}

function collectVisiblePosts({ allowSeen = false } = {}) {
  if (!contextActive) return [];
  if (!collecting) return [];
  const scanned = [];
  const extractErrors = [];
  for (const container of likelyPostContainers()) {
    try {
      const post = extractPost(container);
      if (post.postText.length >= 8 && !isNoiseLine(post.postText)) scanned.push(post);
    } catch (error) {
      const message = String(error?.message || error);
      extractErrors.push(message);
      if (message.includes("Extension context invalidated")) {
        stopAllLocalWork();
        break;
      }
    }
  }
  const matched = [];
  const ignoredReasons = {};
  for (const post of scanned) {
    const decision = shouldKeepPost(post);
    if (decision.keep) {
      matched.push(post);
    } else {
      ignoredReasons[decision.reason] = (ignoredReasons[decision.reason] || 0) + 1;
    }
  }
  const fresh = allowSeen ? matched : matched.filter((post) => {
    const key = post.postUrl && post.postUrl !== window.location.href ? post.postUrl : post.postId;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  sendScanLog(scanned.length, matched.length, scanned.length - matched.length, "visible_posts", { ignoredReasons, sentCount: fresh.length, extractErrors: extractErrors.slice(0, 5) });
  if (fresh.length > 0) postJson(LOCAL_POSTS, { clientId: contentClientId, posts: fresh });
  return fresh;
}

function startCollectLoop() {
  collecting = true;
  if (collectTimer) clearInterval(collectTimer);
  collectVisiblePosts();
  collectTimer = setInterval(() => collectVisiblePosts(), 4000);
}

function pauseCollectLoop() {
  collecting = false;
  if (collectTimer) clearInterval(collectTimer);
  collectTimer = null;
}

function stopCollectLoop() {
  pauseCollectLoop();
  autoScrollStopped = true;
}

function scrollCandidates() {
  const centerElement = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
  const ancestors = [];
  let current = centerElement;
  while (current) {
    ancestors.push(current);
    current = current.parentElement;
  }
  const base = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    document.querySelector("main"),
    document.querySelector("[role='main']"),
    ...ancestors
  ].filter(Boolean);
  const allScrollable = [...document.querySelectorAll("body *")]
    .filter((element) => element.scrollHeight > element.clientHeight + 120)
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    .slice(0, 50);
  return [...new Set([...base, ...allScrollable])];
}

function scrollTopOf(target) {
  if (target === document.body || target === document.documentElement || target === document.scrollingElement) {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }
  return target.scrollTop || 0;
}

function dispatchWheel(target, distance) {
  const eventInit = {
    bubbles: true,
    cancelable: true,
    deltaY: distance,
    deltaX: 0,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    clientX: Math.floor(window.innerWidth / 2),
    clientY: Math.floor(window.innerHeight / 2)
  };
  target.dispatchEvent(new WheelEvent("wheel", eventInit));
  document.dispatchEvent(new WheelEvent("wheel", eventInit));
  window.dispatchEvent(new WheelEvent("wheel", eventInit));
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanScrollBy(target, distance) {
  const steps = 10;
  const stepDistance = Math.max(40, Math.floor(distance / steps));
  for (let index = 0; index < steps; index += 1) {
    if (target === window) {
      window.scrollBy(0, stepDistance);
    } else if (target === document.body || target === document.documentElement || target === document.scrollingElement) {
      window.scrollBy(0, stepDistance);
      if (typeof target.scrollBy === "function") target.scrollBy(0, stepDistance);
      else target.scrollTop = (target.scrollTop || 0) + stepDistance;
    } else if (typeof target.scrollBy === "function") {
      target.scrollBy(0, stepDistance);
    } else {
      target.scrollTop = (target.scrollTop || 0) + stepDistance;
    }
    await wait(45 + Math.floor(Math.random() * 55));
  }
}

function forceDomScroll(target, distance) {
  const before = scrollTopOf(target);
  if (target === document.body || target === document.documentElement || target === document.scrollingElement) {
    const root = document.scrollingElement || document.documentElement || document.body;
    root.scrollTop = before + distance;
    document.documentElement.scrollTop = before + distance;
    document.body.scrollTop = before + distance;
  } else {
    target.scrollTop = before + distance;
  }
  return { before, after: scrollTopOf(target) };
}

async function tryScrollOnce(preferredDistance) {
  const distance = Math.floor(preferredDistance || (600 + Math.random() * 600));
  const attempts = [];
  window.focus();
  for (const target of scrollCandidates()) {
    const before = scrollTopOf(target);

    const forced = forceDomScroll(target, distance);
    await wait(180);
    let after = scrollTopOf(target);
    attempts.push({ method: "force-dom-scrollTop", container: target.tagName || "document", beforeScrollTop: forced.before, afterScrollTop: after });
    if (Math.abs(after - forced.before) > 8) {
      return { ok: true, distance, beforeScrollTop: forced.before, afterScrollTop: after, method: "force-dom-scrollTop", container: target.tagName || "document", attempts };
    }

    await humanScrollBy(target, distance);
    await wait(260);
    after = scrollTopOf(target);
    attempts.push({ method: "human-scrollBy", container: target.tagName || "document", beforeScrollTop: before, afterScrollTop: after });
    if (Math.abs(after - before) > 8) {
      return { ok: true, distance, beforeScrollTop: before, afterScrollTop: after, method: "human-scrollBy", container: target.tagName || "document", attempts };
    }

    dispatchWheel(target, distance);
    await wait(360);
    after = scrollTopOf(target);
    attempts.push({ method: "wheel", container: target.tagName || "document", beforeScrollTop: before, afterScrollTop: after });
    if (Math.abs(after - before) > 8) {
      return { ok: true, distance, beforeScrollTop: before, afterScrollTop: after, method: "wheel", container: target.tagName || "document", attempts };
    }
  }

  const beforeWindow = window.scrollY;
  await humanScrollBy(window, distance);
  await wait(260);
  attempts.push({ method: "window-human-scrollBy", container: "window", beforeScrollTop: beforeWindow, afterScrollTop: window.scrollY });
  if (Math.abs(window.scrollY - beforeWindow) > 8) {
    return { ok: true, distance, beforeScrollTop: beforeWindow, afterScrollTop: window.scrollY, method: "window-human-scrollBy", container: "window", attempts };
  }

  dispatchWheel(document.scrollingElement || document.body, distance);
  await wait(360);
  attempts.push({ method: "wheel-window", container: "window", beforeScrollTop: beforeWindow, afterScrollTop: window.scrollY });
  return Math.abs(window.scrollY - beforeWindow) > 8
    ? { ok: true, distance, beforeScrollTop: beforeWindow, afterScrollTop: window.scrollY, method: "wheel-window", container: "window", attempts }
    : { ok: false, code: "auto_scroll_failed", error: "没有找到可滚动容器，或 Facebook 忽略了脚本滚动事件", attempts };
}

function sendAck(commandId, commandType, success, message, currentState, details = {}) {
  postJson(LOCAL_ACK, {
    clientId: contentClientId,
    type: "command_ack",
    commandId,
    commandType,
    command: commandType,
    success,
    message,
    currentState,
    pluginState: currentState,
    timestamp: new Date().toISOString(),
    url: location.href,
    details
  });
}

async function startAutoScroll(commandId, total, delayMs) {
  autoScrollStopped = false;
  collecting = true;
  startCollectLoop();
  const initialPosts = collectVisiblePosts();
  sendAck(commandId, "start_auto_scroll", true, `自动滚动已启动，当前滑动次数：0 / ${total}`, "auto_scrolling", {
    currentStep: 0,
    totalSteps: total,
    delayMs,
    collectedCount: initialPosts.length
  });

  for (let current = 1; current <= total; current += 1) {
    if (autoScrollStopped) {
      sendAck(commandId, "start_auto_scroll", true, "自动滚动已停止", "collecting", {
        currentStep: current - 1,
        totalSteps: total,
        delayMs
      });
      return;
    }

    const scrollResult = await tryScrollOnce();
    const posts = collectVisiblePosts();
    sendAck(
      commandId,
      "start_auto_scroll",
      scrollResult.ok,
      scrollResult.ok ? `自动滚动第 ${current} 次完成，采集到 ${posts.length} 个新帖子` : `自动滚动第 ${current} 次失败：${scrollResult.error}`,
      scrollResult.ok ? "auto_scrolling" : "error",
      {
        ...scrollResult,
        currentStep: current,
        totalSteps: total,
        delayMs,
        scrollDistance: scrollResult.distance,
        collectedCount: posts.length
      }
    );
    if (!scrollResult.ok) return;
    await wait(delayMs);
  }

  sendAck(commandId, "start_auto_scroll", true, "自动滚动已完成", "collecting", {
    currentStep: total,
    totalSteps: total,
    delayMs
  });
}

function startGroupMonitor(commandId, intervalSeconds) {
  collecting = true;
  if (monitorTimer) clearInterval(monitorTimer);
  const run = () => {
    const posts = collectVisiblePosts();
    sendAck(commandId, "start_group_monitor", true, `群组监控检查完成，发现 ${posts.length} 个新帖子`, "monitoring", {
      groupName: findGroupName(),
      groupUrl: findGroupUrl(),
      collectedCount: posts.length
    });
  };
  run();
  monitorTimer = setInterval(run, Math.max(30, Number(intervalSeconds) || 60) * 1000);
}

async function diagnose(commandId) {
  const posts = collectVisiblePosts({ allowSeen: true });
  const scrollResult = await tryScrollOnce();
  sendAck(
    commandId,
    "diagnose",
    scrollResult.ok,
    scrollResult.ok ? "连接诊断完成：当前状态可正常使用" : `测试滚动失败：${scrollResult.error}`,
    scrollResult.ok ? "collecting" : "error",
    {
      localService: "正常",
      plugin: "正常",
      facebookPage: location.href,
      contentScript: "已注入",
      testCollect: { ok: true, count: posts.length },
      testScroll: scrollResult
    }
  );
}

async function runDesktopCommand(message) {
  if (!message || !message.type) return { ok: false, message: "空命令", currentState: "error" };
  if (message.type === "settings_updated") {
    latestSettings = message.payload;
    return { ok: true, message: "关键词和配置已同步到 content script", currentState: collecting ? "collecting" : "paused" };
  }
  if (message.type === "ping_content") return { ok: true, url: location.href, currentState: collecting ? "collecting" : "stopped" };
  if (message.type === "collect_now" || message.type === "collect_once" || message.type === "start_collecting") {
    startCollectLoop();
    const posts = collectVisiblePosts();
    return { ok: true, message: `采集已启动，后台正在监听此 Facebook 页面；本次发现 ${posts.length} 个新帖子`, count: posts.length, currentState: "collecting" };
  }
  if (message.type === "clear_posts") {
    seenKeys.clear();
    return { ok: true, message: "插件采集缓存已清空", currentState: collecting ? "collecting" : "stopped" };
  }
  if (message.type === "stop_collecting") {
    stopCollectLoop();
    return { ok: true, message: "采集已停止", currentState: "stopped" };
  }
  if (message.type === "pause_collecting") {
    pauseCollectLoop();
    return { ok: true, message: "采集已暂停", currentState: "paused" };
  }
  if (message.type === "start_auto_scroll") {
    const total = Math.max(1, Number(message.payload?.count || 5));
    const delayMs = Math.max(1000, Number(message.payload?.delayMs || 3000));
    startAutoScroll(message.commandId || `content-${Date.now()}`, total, delayMs);
    return { ok: true, message: "自动滚动已启动", currentState: "auto_scrolling" };
  }
  if (message.type === "stop_auto_scroll") {
    autoScrollStopped = true;
    return { ok: true, message: "自动滚动已停止", currentState: collecting ? "collecting" : "paused" };
  }
  if (message.type === "test_scroll_once" || message.type === "scroll_once") {
    let result = await tryScrollOnce();
    if (!result.ok) {
      const debuggerResult = await requestDebuggerScroll(result.distance || Math.floor(window.innerHeight * 0.8), message.commandId || `scroll-${Date.now()}`);
      result = debuggerResult.ok ? debuggerResult : { ...result, debuggerResult, error: `${result.error || "dom_scroll_failed"}; ${debuggerResult.error || "debugger_scroll_failed"}` };
    }
    const posts = result.ok ? collectVisiblePosts() : [];
    return { ...result, message: result.ok ? `测试滚动成功，本次采集到 ${posts.length} 个新帖子` : result.error, currentState: result.ok ? "collecting" : "error", collectedCount: posts.length };
  }
  if (message.type === "diagnose") {
    diagnose(message.commandId || `diag-${Date.now()}`);
    return { ok: true, message: "诊断已启动", currentState: "collecting" };
  }
  if (message.type === "start_group_monitor" || message.type === "start_monitoring") {
    startGroupMonitor(message.commandId || `monitor-${Date.now()}`, Number(message.payload?.intervalSeconds || 60));
    return { ok: true, message: "群组监控已启动", currentState: "monitoring" };
  }
  if (message.type === "stop_group_monitor" || message.type === "stop_monitoring") {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
    return { ok: true, message: "群组监控已停止", currentState: "stopped" };
  }
  return { ok: false, message: `content script 未实现命令：${message.type}`, currentState: "error" };
}

async function pollDesktopCommands() {
  if (!contextActive) return;
  const data = await postJson(LOCAL_HEARTBEAT, {
    clientId: contentClientId,
    tabUrl: location.href,
    userAgent: navigator.userAgent
  });
  if (data?.settings) latestSettings = data.settings;
  if (Array.isArray(data?.commands)) {
    for (const command of data.commands) {
      let response;
      try {
        response = await runDesktopCommand(command);
      } catch (error) {
        response = {
          ok: false,
          message: `content_command_failed: ${String(error?.message || error)}`,
          currentState: "error"
        };
      }
      if (command.commandId) {
        sendAck(command.commandId, command.type, response.ok !== false, response.message || "命令已执行", response.currentState || (response.ok === false ? "error" : "collecting"), { ...response, url: location.href });
      }
    }
  }
}

if (isExtensionContextValid()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    runDesktopCommand(message).then(sendResponse);
    return true;
  });
}

// Collection is intentionally command-driven. The desktop app or popup must send
// start_collecting/collect_now before this script scans the page.
pollDesktopCommands();
desktopPollTimer = setInterval(pollDesktopCommands, 3000);
