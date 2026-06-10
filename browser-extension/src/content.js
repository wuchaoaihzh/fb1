let collecting = true;
let autoScrollStopped = false;
let monitorTimer = null;
const seenKeys = new Set();

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
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function findGroupName() {
  const heading = document.querySelector("h1");
  if (heading && visibleText(heading)) return visibleText(heading);
  return document.title.replace(/\| Facebook$/, "").trim() || "未知群组";
}

function findGroupUrl() {
  const groupLink = [...document.querySelectorAll("a[href*='/groups/']")].find((anchor) => /\/groups\/[^/?#]+/.test(anchor.href));
  return groupLink ? normalizeUrl(groupLink.href) : normalizeUrl(window.location.href);
}

function likelyPostContainers() {
  const articles = [...document.querySelectorAll("[role='article']")];
  const feedItems = [...document.querySelectorAll("[data-pagelet*='FeedUnit'], [aria-posinset]")];
  const candidates = [...articles, ...feedItems].filter((element) => {
    const rect = element.getBoundingClientRect();
    const text = visibleText(element);
    return rect.bottom > 0 && rect.top < window.innerHeight && text.length >= 20;
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
  const anchors = [...container.querySelectorAll("a[href]")];
  for (const anchor of anchors) {
    const text = visibleText(anchor);
    if (looksLikeTime(text)) return text;
    const match = visibleText(anchor.parentElement || anchor).match(/\b(Just now|\d+\s*(?:m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)|Yesterday)\b|刚刚|\d+\s*(?:分钟|小时|天|周)前/i);
    if (match) return match[0];
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
    return text && text.length < 80 && !looksLikeTime(text) && !anchor.href.includes("/groups/");
  });
  return authorLink ? visibleText(authorLink) : "";
}

function extractPost(container) {
  const postUrl = findPostUrl(container);
  const rawText = visibleText(container);
  const rawTimeText = findRawTime(container);
  const groupName = findGroupName();
  const groupUrl = findGroupUrl();
  const authorName = findAuthor(container);
  const postText = rawText.replace(authorName, "").replace(rawTimeText, "").replace(/\bLike\b|\bComment\b|\bShare\b/gi, "").trim();
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

function collectVisiblePosts({ allowSeen = false } = {}) {
  if (!collecting) return [];
  const posts = likelyPostContainers().map(extractPost).filter((post) => post.postText.length >= 12);
  const fresh = allowSeen ? posts : posts.filter((post) => {
    const key = post.postUrl || post.postId;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  if (fresh.length > 0) chrome.runtime.sendMessage({ type: "posts_batch_collected", payload: fresh });
  return fresh;
}

function scrollCandidates() {
  const centerElement = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
  const ancestors = [];
  let current = centerElement;
  while (current) {
    ancestors.push(current);
    current = current.parentElement;
  }
  const base = [document.scrollingElement, document.documentElement, document.body, document.querySelector("main"), document.querySelector("[role='main']"), ...ancestors].filter(Boolean);
  const allScrollable = [...document.querySelectorAll("body *")]
    .filter((element) => element.scrollHeight > element.clientHeight + 120)
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    .slice(0, 40);
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

async function tryScrollOnce() {
  const distance = Math.floor(500 + Math.random() * 700);
  for (const target of scrollCandidates()) {
    const before = scrollTopOf(target);
    dispatchWheel(target, distance);
    await wait(220);
    let after = scrollTopOf(target);
    if (Math.abs(after - before) > 8) {
      return { ok: true, distance, beforeScrollTop: before, afterScrollTop: after, method: "wheel", container: target.tagName || "unknown" };
    }

    if (typeof target.scrollBy === "function") target.scrollBy({ top: distance, behavior: "auto" });
    else target.scrollTop = before + distance;
    await wait(120);
    after = scrollTopOf(target);
    if (Math.abs(after - before) > 8) {
      return { ok: true, distance, beforeScrollTop: before, afterScrollTop: after, method: "scrollBy", container: target.tagName || "unknown" };
    }
  }
  const beforeWindow = window.scrollY;
  dispatchWheel(document.scrollingElement || document.body, distance);
  await wait(220);
  if (Math.abs(window.scrollY - beforeWindow) > 8) {
    return { ok: true, distance, beforeScrollTop: beforeWindow, afterScrollTop: window.scrollY, method: "wheel-window", container: "window" };
  }
  window.scrollBy({ top: distance, behavior: "auto" });
  await wait(120);
  return Math.abs(window.scrollY - beforeWindow) > 8
    ? { ok: true, distance, beforeScrollTop: beforeWindow, afterScrollTop: window.scrollY, method: "window.scrollBy", container: "window" }
    : { ok: false, error: "没有找到可滚动容器，或页面已经到底部" };
}

function sendAck(commandId, commandType, success, message, currentState, details = {}) {
  chrome.runtime.sendMessage({
    type: "command_ack",
    commandId,
    commandType,
    success,
    message,
    currentState,
    details
  });
}

async function startAutoScroll(commandId, total) {
  autoScrollStopped = false;
  collecting = true;
  sendAck(commandId, "start_auto_scroll", true, `自动滚动已启动，当前滑动次数：0 / ${total}`, "auto_scrolling", { current: 0, total });
  for (let current = 1; current <= total; current += 1) {
    if (autoScrollStopped) {
      sendAck(commandId, "start_auto_scroll", true, "自动滚动已停止", "collecting", { current: current - 1, total });
      return;
    }
    const scrollResult = await tryScrollOnce();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const posts = collectVisiblePosts();
    sendAck(
      commandId,
      "start_auto_scroll",
      scrollResult.ok,
      scrollResult.ok ? `自动滚动第 ${current} 次完成，采集到 ${posts.length} 个新帖子` : `自动滚动第 ${current} 次失败：${scrollResult.error}`,
      scrollResult.ok ? "auto_scrolling" : "error",
      { ...scrollResult, current, total, collectedCount: posts.length }
    );
    if (!scrollResult.ok) return;
  }
  sendAck(commandId, "start_auto_scroll", true, "自动滚动已完成", "collecting", { current: total, total });
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
  const contentScript = true;
  const posts = collectVisiblePosts({ allowSeen: true });
  const scrollResult = await tryScrollOnce();
  sendAck(commandId, "diagnose", scrollResult.ok, scrollResult.ok ? "连接诊断完成，当前状态可正常使用" : `测试滚动失败：${scrollResult.error}`, scrollResult.ok ? "collecting" : "error", {
    localService: "正常",
    plugin: "正常",
    facebookPage: location.href,
    contentScript,
    testCollect: { ok: true, count: posts.length },
    testScroll: scrollResult
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ping_content") {
    sendResponse({ ok: true, url: location.href });
    return true;
  }
  if (message.type === "collect_now" || message.type === "start_collecting") {
    collecting = true;
    const posts = collectVisiblePosts();
    sendResponse({ ok: true, message: "采集已启动，当前正在监听 Facebook 页面", count: posts.length, currentState: "collecting" });
    return true;
  }
  if (message.type === "stop_collecting") {
    collecting = false;
    sendResponse({ ok: true, message: "采集已停止", currentState: "stopped" });
    return true;
  }
  if (message.type === "start_auto_scroll") {
    startAutoScroll(message.commandId || `content-${Date.now()}`, Number(message.payload?.count || 5));
    sendResponse({ ok: true, message: "自动滚动已启动", currentState: "auto_scrolling" });
    return true;
  }
  if (message.type === "stop_auto_scroll") {
    autoScrollStopped = true;
    sendResponse({ ok: true, message: "自动滚动已停止", currentState: "collecting" });
    return true;
  }
  if (message.type === "test_scroll_once") {
    tryScrollOnce().then((result) => sendResponse({ ...result, message: result.ok ? "测试滚动成功" : result.error, currentState: result.ok ? "collecting" : "error" }));
    return true;
  }
  if (message.type === "diagnose") {
    diagnose(message.commandId || `diag-${Date.now()}`);
    sendResponse({ ok: true, message: "诊断已启动", currentState: "collecting" });
    return true;
  }
  if (message.type === "start_group_monitor") {
    startGroupMonitor(message.commandId || `monitor-${Date.now()}`, Number(message.payload?.intervalSeconds || 60));
    sendResponse({ ok: true, message: "群组监控已启动", currentState: "monitoring" });
    return true;
  }
  if (message.type === "stop_group_monitor") {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
    sendResponse({ ok: true, message: "群组监控已停止", currentState: "stopped" });
    return true;
  }
  return true;
});

window.addEventListener("scroll", () => setTimeout(collectVisiblePosts, 900));
new MutationObserver(() => setTimeout(collectVisiblePosts, 1200)).observe(document.documentElement, { childList: true, subtree: true });
setTimeout(collectVisiblePosts, 1500);
