const LOCAL_HEARTBEAT = "http://127.0.0.1:8765/client-heartbeat";
const LOCAL_POSTS = "http://127.0.0.1:8765/posts";
const LOCAL_ACK = "http://127.0.0.1:8765/command-ack";
const contentClientId = `content-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const monitorSessionKey = "__foradar_group_monitor__";

if (globalThis.__FORADAR_CONTENT_STOP__) {
  try {
    globalThis.__FORADAR_CONTENT_STOP__();
  } catch {
    // Ignore stale cleanup errors.
  }
}

let collecting = false;
let autoScrollStopped = false;
let collectTimer = null;
let monitorTimer = null;
let feedObserver = null;
let desktopPollTimer = null;
let observerCollectTimer = null;
let monitorReloadTimer = null;
let latestSettings = null;
let contextActive = true;
const seenKeys = new Set();

function stopAllLocalWork() {
  contextActive = false;
  collecting = false;
  autoScrollStopped = true;
  if (collectTimer) clearInterval(collectTimer);
  if (monitorTimer) clearInterval(monitorTimer);
  if (desktopPollTimer) clearInterval(desktopPollTimer);
  if (observerCollectTimer) clearTimeout(observerCollectTimer);
  if (monitorReloadTimer) clearTimeout(monitorReloadTimer);
  if (feedObserver) feedObserver.disconnect();
  collectTimer = null;
  monitorTimer = null;
  desktopPollTimer = null;
  observerCollectTimer = null;
  monitorReloadTimer = null;
  feedObserver = null;
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

function readMonitorSession() {
  try {
    const raw = window.sessionStorage.getItem(monitorSessionKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveMonitorSession(intervalSeconds) {
  try {
    const previous = readMonitorSession() || {};
    window.sessionStorage.setItem(monitorSessionKey, JSON.stringify({
      ...previous,
      active: true,
      intervalSeconds: Math.max(30, Number(intervalSeconds) || 60)
    }));
  } catch {
    // Ignore storage failures.
  }
}

function clearMonitorSession() {
  try {
    window.sessionStorage.removeItem(monitorSessionKey);
  } catch {
    // Ignore storage failures.
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

function isVisibleElement(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function isNoiseLine(line) {
  const text = String(line || "").trim();
  const lower = text.toLowerCase();
  if (!text) return true;
  if (noiseTexts.has(lower)) return true;
  if (/^(like|comment|share|send|\d+\s+comments?|\d+\s+shares?)$/i.test(text)) return true;
  if (/^(home|watch|marketplace|groups|gaming|notifications|messenger)$/i.test(text)) return true;
  if (text.length <= 2) return true;
  return false;
}

function isFacebookHomePage(url = window.location.href) {
  try {
    const parsed = new URL(url, window.location.href);
    return /(^|\.)facebook\.com$/i.test(parsed.hostname) && (parsed.pathname === "/" || parsed.pathname === "/home.php");
  } catch {
    return false;
  }
}

function isFacebookGroupPage(url = window.location.href) {
  try {
    const parsed = new URL(url, window.location.href);
    return /(^|\.)facebook\.com$/i.test(parsed.hostname) && (parsed.pathname.includes("/groups/") || parsed.pathname === "/groups/feed/");
  } catch {
    return false;
  }
}

function isSupportedCollectionPage(url = window.location.href) {
  return isFacebookHomePage(url) || isFacebookGroupPage(url);
}

function findGroupName() {
  if (/\/groups\/feed\/?$/i.test(location.pathname)) return "Facebook Groups Feed";
  const heading = document.querySelector("h1");
  const title = visibleText(heading);
  if (title) return title;
  return document.title.replace(/\| Facebook$/i, "").trim() || "Unknown Group";
}

function findGroupUrl() {
  if (/\/groups\/feed\/?$/i.test(location.pathname)) return normalizeUrl(window.location.href);
  const groupLink = [...document.querySelectorAll("a[href*='/groups/']")].find((anchor) => /\/groups\/[^/?#]+/.test(anchor.href));
  return groupLink ? normalizeUrl(groupLink.href) : normalizeUrl(window.location.href);
}

function likelyPostContainers() {
  const selectors = [
    "div[role='feed'] [role='article']",
    "div[role='feed'] [data-pagelet*='FeedUnit']",
    "div[role='feed'] [aria-posinset]",
    "div[role='main'] [role='article']",
    "div[role='main'] [data-pagelet*='FeedUnit']",
    "div[role='main'] [aria-posinset]",
    "[role='article']",
    "[data-pagelet*='FeedUnit']",
    "[aria-posinset]"
  ];
  const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
  const filtered = candidates.filter((element) => {
    const rect = element.getBoundingClientRect();
    const text = visibleText(element);
    const nestedArticle = element.parentElement?.closest?.("[role='article'], [data-pagelet*='FeedUnit'], [aria-posinset]");
    return isVisibleElement(element) && !nestedArticle && rect.bottom > 0 && rect.top < window.innerHeight * 1.35 && text.length >= 10;
  });
  return [...new Set(filtered)];
}

function extractTimeFragment(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/^\d{10,13}$/.test(text)) {
    const millis = text.length === 13 ? Number(text) : Number(text) * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  const relativeMatch = text.match(/(Just now|Now|Yesterday|刚刚|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|分钟|分|小时|小時|天|周))/i);
  if (relativeMatch?.[1]) return relativeMatch[1].trim();
  const absoluteMatch = text.match(/\b(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}\s*[AP]M)?\b/i);
  if (absoluteMatch?.[0]) return absoluteMatch[0].trim();
  const chineseAbsoluteMatch = text.match(/(?:\d{4}年\s*)?\d{1,2}月\d{1,2}日(?:\s*(?:上午|下午|中午|晚上|早上)?\s*\d{1,2}(?:[:：]\d{2})?)?/);
  if (chineseAbsoluteMatch?.[0]) return chineseAbsoluteMatch[0].trim();
  const weekdayMatch = text.match(/(?:Today|Yesterday|Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Tues(?:day)?|Wed(?:nesday)?|Thu(?:rsday)?|Thur(?:sday)?|Fri(?:day)?|Sat(?:urday)?|今天|昨天|周[一二三四五六日天]|星期[一二三四五六日天])(?:\s+(?:at\s+)?)?(?:上午|下午|中午|晚上|早上)?\s*\d{1,2}(?::\d{2})?\s*(?:[AP]M)?/i);
  if (weekdayMatch?.[0]) return weekdayMatch[0].trim();
  const isoMatch = text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}(?:[:.]\d{2})(?:[:.]\d{2})?)?/);
  if (isoMatch?.[0]) return isoMatch[0].trim();
  const normalized = text.replace(/ at /i, " ").replace(/(\d{1,2})\.(\d{2})\.(\d{2})$/, "$1:$2:$3");
  return Number.isNaN(new Date(normalized).getTime()) ? "" : text;
}

function looksLikeTime(value) {
  return Boolean(extractTimeFragment(value));
}

function topSectionLimit(container) {
  const rect = container.getBoundingClientRect();
  return rect.top + Math.min(360, Math.max(140, rect.height * 0.55));
}

function isInTopSection(container, element) {
  return element.getBoundingClientRect().top <= topSectionLimit(container);
}

function topSectionLines(container) {
  const lines = [];
  for (const child of [...container.children]) {
    if (!isVisibleElement(child)) continue;
    if (!isInTopSection(container, child) && lines.length >= 10) break;
    for (const line of visibleLines(child)) {
      if (/^(like|comment|share|send|write a comment|most relevant|view more comments?)$/i.test(line)) return lines;
      lines.push(line);
      if (lines.length >= 24) return lines;
    }
  }
  return lines.length > 0 ? lines : visibleLines(container).slice(0, 24);
}

function findPostUrl(container) {
  const anchors = [...container.querySelectorAll("a[href]")];
  const postLink = anchors.find((anchor) => {
    const href = anchor.href;
    return href.includes("/posts/") || href.includes("/permalink/") || href.includes("story_fbid=") || href.includes("fbid=") || href.includes("set=pcb");
  });
  return postLink ? normalizeUrl(postLink.href) : normalizeUrl(window.location.href);
}

function findRawTime(container) {
  const candidates = [...container.querySelectorAll("time, abbr, a[href], a[aria-label], span[aria-label], a[title], span[title], [data-utime]")]
    .filter((element) => isVisibleElement(element) && isInTopSection(container, element))
    .map((element) => {
      const value = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("datetime"),
        element.getAttribute("data-utime"),
        visibleText(element)
      ].map((candidate) => extractTimeFragment(candidate)).find(Boolean);
      let score = 0;
      if (value) score += 3;
      if (element.tagName.toLowerCase() === "time" || element.getAttribute("datetime")) score += 2;
      if (element.closest("a[href*='/posts/'], a[href*='/permalink/'], a[href*='story_fbid='], a[href*='fbid=']")) score += 3;
      if (element.tagName.toLowerCase() === "a") score += 1;
      return { element, value: value || "", score };
    })
    .filter((item) => item.value)
    .sort((a, b) => b.score - a.score || a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);
  if (candidates[0]?.value) return candidates[0].value.trim();
  for (const line of topSectionLines(container)) {
    const fragment = extractTimeFragment(line);
    if (fragment) return fragment;
  }
  return "";
}

function findAuthor(container) {
  const candidates = [...container.querySelectorAll("strong, h2, h3, h4, a[href]")]
    .filter((element) => isVisibleElement(element) && isInTopSection(container, element))
    .map((element) => ({ element, text: visibleText(element) }))
    .filter(({ element, text }) => {
      if (!text || text.length > 80) return false;
      if (looksLikeTime(text) || isNoiseLine(text)) return false;
      if (element.tagName.toLowerCase() === "a") {
        const href = element.href || "";
        if (href.includes("/groups/") || href.includes("/posts/") || href.includes("/permalink/") || href.includes("comment_id=")) return false;
      }
      return true;
    })
    .sort((a, b) => a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);
  return candidates[0]?.text || "";
}

function extractPostText(container, authorName, rawTimeText) {
  const messageSelectors = [
    "div[data-ad-preview='message']",
    "div[data-ad-comet-preview='message']",
    "[data-testid='post_message']"
  ];
  const candidateLines = [];
  for (const selector of messageSelectors) {
    for (const element of container.querySelectorAll(selector)) {
      const text = visibleText(element);
      if (!text || text.length < 8) continue;
      if (element.closest("[aria-label*='comment' i], [aria-label*='reply' i], form")) continue;
      candidateLines.push(text);
    }
  }
  if (candidateLines.length === 0) {
    candidateLines.push(...topSectionLines(container).filter((line) => {
      if (line === authorName || line === rawTimeText) return false;
      if (looksLikeTime(line) || isNoiseLine(line)) return false;
      return true;
    }));
  }
  const cleaned = candidateLines
    .map((line) => line.replace(authorName || "", "").replace(rawTimeText || "", "").trim())
    .filter((line) => !isNoiseLine(line))
    .filter((line, index, list) => list.indexOf(line) === index);
  const meaningful = cleaned.filter((line) => line.length >= 8).sort((a, b) => b.length - a.length);
  return meaningful[0] || cleaned.join(" ").slice(0, 500) || "";
}

function extractPost(container) {
  const postUrl = findPostUrl(container);
  const rawTimeText = findRawTime(container);
  const groupName = findGroupName();
  const groupUrl = findGroupUrl();
  const authorName = findAuthor(container);
  const postText = extractPostText(container, authorName, rawTimeText) || "未识别到正文";
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
  return latestSettings.keywords
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
  if (!post.postText || post.postText === "未识别到正文") return { keep: false, positive: [], negative: [], reason: "未识别到正文" };
  if (isNoiseLine(post.postText)) return { keep: false, positive: [], negative: [], reason: "采集到的是导航或交互文本" };
  const matches = matchKeywords(post.postText);
  if (matches.negative.length > 0) return { keep: false, ...matches, reason: `命中排除关键词：${matches.negative.join(", ")}` };
  if (matches.positive.length === 0) return { keep: false, ...matches, reason: "未命中机会关键词" };
  return { keep: true, ...matches, reason: "关键词匹配成功" };
}

function sendScanLog(scannedCount, matchedCount, ignoredCount, source, extra = {}) {
  postJson(LOCAL_ACK, {
    clientId: contentClientId,
    type: "command_ack",
    commandId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    commandType: "scan_result",
    command: "scan_result",
    success: true,
    message: `本轮扫描发现 ${scannedCount} 条帖子，命中关键词 ${matchedCount} 条，忽略 ${ignoredCount} 条`,
    currentState: collecting ? "collecting" : "paused",
    pluginState: collecting ? "collecting" : "paused",
    timestamp: new Date().toISOString(),
    details: { scannedCount, matchedCount, ignoredCount, source, url: location.href, ...extra }
  });
}

function collectVisiblePosts({ allowSeen = false } = {}) {
  if (!contextActive || !collecting) return [];
  const containers = likelyPostContainers();
  const scanned = [];
  const extractErrors = [];

  for (const container of containers) {
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

  const deliverable = [];
  const ignoredReasons = {};
  let matchedCount = 0;
  let unmatchedCount = 0;
  for (const post of scanned) {
    const decision = shouldKeepPost(post);
    if (!post.postText || post.postText === "未识别到正文") {
      ignoredReasons[decision.reason] = (ignoredReasons[decision.reason] || 0) + 1;
      continue;
    }
    if (decision.positive.length > 0) matchedCount += 1;
    else unmatchedCount += 1;
    if (!decision.keep) {
      ignoredReasons[decision.reason] = (ignoredReasons[decision.reason] || 0) + 1;
      continue;
    }
    deliverable.push(post);
  }

  const fresh = allowSeen ? deliverable : deliverable.filter((post) => {
    const key = post.postUrl && post.postUrl !== window.location.href ? post.postUrl : post.postId;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  sendScanLog(scanned.length, matchedCount, scanned.length - deliverable.length, "visible_posts", {
    containerCount: containers.length,
    deliverableCount: deliverable.length,
    unmatchedCount,
    duplicateCount: Math.max(0, deliverable.length - fresh.length),
    ignoredReasons,
    sentCount: fresh.length,
    extractErrors: extractErrors.slice(0, 5)
  });

  if (fresh.length > 0) postJson(LOCAL_POSTS, { clientId: contentClientId, posts: fresh });
  return fresh;
}

function observeFeed() {
  if (feedObserver) feedObserver.disconnect();
  const observerRoot = document.querySelector("div[role='feed']") || document.querySelector("[role='main']") || document.body;
  if (!observerRoot || typeof MutationObserver === "undefined") return;
  feedObserver = new MutationObserver(() => {
    if (!collecting || !contextActive) return;
    if (observerCollectTimer) clearTimeout(observerCollectTimer);
    observerCollectTimer = setTimeout(() => {
      observerCollectTimer = null;
      collectVisiblePosts();
    }, 900);
  });
  feedObserver.observe(observerRoot, { childList: true, subtree: true });
}

function startCollectLoop({ allowSeen = false } = {}) {
  collecting = true;
  if (collectTimer) clearInterval(collectTimer);
  collectVisiblePosts({ allowSeen });
  collectTimer = setInterval(() => collectVisiblePosts(), 4000);
  observeFeed();
}

function pauseCollectLoop() {
  collecting = false;
  if (collectTimer) clearInterval(collectTimer);
  if (observerCollectTimer) clearTimeout(observerCollectTimer);
  if (feedObserver) feedObserver.disconnect();
  collectTimer = null;
  observerCollectTimer = null;
  feedObserver = null;
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

async function collectAfterScroll(delayMs) {
  const settleMs = Math.max(1200, Math.min(2500, Math.floor((delayMs || 3000) * 0.5)));
  await wait(settleMs);
  let posts = collectVisiblePosts();
  if (posts.length === 0) {
    await wait(900);
    posts = collectVisiblePosts();
  }
  return posts;
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
    : { ok: false, code: "auto_scroll_failed", error: "没有找到可滚动容器，或 Facebook 忽略了页面滚动事件", attempts };
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
  startCollectLoop({ allowSeen: true });
  const initialPosts = collectVisiblePosts({ allowSeen: true });
  sendAck(commandId, "start_auto_scroll", true, `自动滚动已启动，当前进度 0 / ${total}`, "auto_scrolling", {
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
    const posts = await collectAfterScroll(delayMs);
    sendAck(
      commandId,
      "start_auto_scroll",
      scrollResult.ok,
      scrollResult.ok ? `自动滚动第 ${current} 次完成，本次采集到 ${posts.length} 条新帖子` : `自动滚动第 ${current} 次失败：${scrollResult.error}`,
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
    await wait(Math.max(500, delayMs));
  }

  sendAck(commandId, "start_auto_scroll", true, "自动滚动已完成", "collecting", {
    currentStep: total,
    totalSteps: total,
    delayMs
  });
}

function clearMonitorTimers() {
  if (monitorTimer) clearInterval(monitorTimer);
  if (monitorReloadTimer) clearTimeout(monitorReloadTimer);
  monitorTimer = null;
  monitorReloadTimer = null;
}

function scheduleMonitorReload(intervalSeconds) {
  if (monitorReloadTimer) clearTimeout(monitorReloadTimer);
  if (!isFacebookGroupPage()) return;
  if (!latestSettings?.groupMonitor?.autoRefreshEnabled) return;
  const seconds = Math.max(60, Number(latestSettings?.groupMonitor?.autoRefreshSeconds || 120));
  monitorReloadTimer = setTimeout(() => {
    saveMonitorSession(intervalSeconds);
    location.reload();
  }, seconds * 1000);
}

function stopGroupMonitor() {
  clearMonitorTimers();
  clearMonitorSession();
  pauseCollectLoop();
}

function startGroupMonitor(commandId, intervalSeconds, options = {}) {
  const safeInterval = Math.max(30, Number(intervalSeconds) || 60);
  const restored = Boolean(options.restored);
  saveMonitorSession(safeInterval);
  clearMonitorTimers();
  startCollectLoop({ allowSeen: true });
  const run = () => {
    const posts = collectVisiblePosts();
    scheduleMonitorReload(safeInterval);
    sendAck(commandId, "start_group_monitor", true, restored ? `群组监控已恢复，本轮发现 ${posts.length} 条新帖子` : `群组监控检查完成，发现 ${posts.length} 条新帖子`, "monitoring", {
      groupName: findGroupName(),
      groupUrl: findGroupUrl(),
      collectedCount: posts.length,
      autoRefreshEnabled: Boolean(latestSettings?.groupMonitor?.autoRefreshEnabled),
      autoRefreshSeconds: Number(latestSettings?.groupMonitor?.autoRefreshSeconds || 0)
    });
  };
  run();
  monitorTimer = setInterval(run, safeInterval * 1000);
}

async function diagnose(commandId) {
  if (!isSupportedCollectionPage()) {
    sendAck(commandId, "diagnose", false, "当前页面不是支持的 Facebook 采集页，请打开首页、groups/feed 或具体群组页。", "error", {
      facebookPage: location.href,
      contentScript: "injected",
      supportedCollectionPage: false
    });
    return;
  }
  collecting = true;
  const posts = collectVisiblePosts({ allowSeen: true });
  const scrollResult = await tryScrollOnce();
  collecting = false;
  sendAck(
    commandId,
    "diagnose",
    scrollResult.ok,
    scrollResult.ok ? "连接诊断完成，当前页面可正常使用" : `测试滚动失败：${scrollResult.error}`,
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
    return { ok: true, message: "设置已同步到 content script", currentState: collecting ? "collecting" : "paused" };
  }
  if (message.type === "ping_content") return { ok: true, url: location.href, currentState: collecting ? "collecting" : "stopped" };

  const requiresCollectionPage = new Set([
    "collect_now",
    "collect_once",
    "start_collecting",
    "start_auto_scroll",
    "stop_auto_scroll",
    "test_scroll_once",
    "scroll_once",
    "diagnose",
    "start_group_monitor",
    "start_monitoring",
    "stop_group_monitor",
    "stop_monitoring"
  ]);

  if (requiresCollectionPage.has(message.type) && !isSupportedCollectionPage()) {
    return {
      ok: false,
      message: "当前页面不是支持的 Facebook 采集页，请打开首页、groups/feed 或具体群组页。",
      currentState: "error",
      url: location.href
    };
  }

  if ((message.type === "start_group_monitor" || message.type === "start_monitoring") && !isFacebookGroupPage()) {
    return {
      ok: false,
      message: "群组监控只支持 groups/feed 或具体群组页，Facebook 首页不参与自动刷新。",
      currentState: "error",
      url: location.href
    };
  }

  if (message.type === "collect_now" || message.type === "collect_once" || message.type === "start_collecting") {
    seenKeys.clear();
    startCollectLoop({ allowSeen: true });
    const posts = collectVisiblePosts({ allowSeen: true });
    return { ok: true, message: `采集已启动，本轮发现 ${posts.length} 条新帖子`, count: posts.length, currentState: "collecting" };
  }

  if (message.type === "clear_posts") {
    seenKeys.clear();
    return { ok: true, message: "插件缓存已清空", currentState: collecting ? "collecting" : "stopped" };
  }

  if (message.type === "stop_collecting") {
    pauseCollectLoop();
    clearMonitorTimers();
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
    const posts = result.ok ? await collectAfterScroll(2500) : [];
    return {
      ...result,
      message: result.ok ? `测试滚动成功，本次采集到 ${posts.length} 条新帖子` : result.error,
      currentState: result.ok ? "collecting" : "error",
      collectedCount: posts.length
    };
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
    stopGroupMonitor();
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

function restoreMonitorIfNeeded() {
  const session = readMonitorSession();
  if (!session?.active || !isFacebookGroupPage() || monitorTimer) return;
  startGroupMonitor(`restore-${Date.now()}`, Number(session.intervalSeconds || 60), { restored: true });
}

if (isExtensionContextValid()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    runDesktopCommand(message).then(sendResponse);
    return true;
  });
}

pollDesktopCommands().finally(() => {
  restoreMonitorIfNeeded();
});
desktopPollTimer = setInterval(() => {
  pollDesktopCommands();
}, 3000);
