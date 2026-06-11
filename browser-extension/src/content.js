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
let cachedPageReferenceTimeMs = null;
const storyFallbackCache = new Map();
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

const TIME_CANDIDATE_SELECTOR = "time, abbr, a[href], a[aria-label], span[aria-label], a[title], span[title], [data-utime], [aria-describedby], [aria-labelledby]";

function normalizeTimeCandidateText(value) {
  return String(value || "")
    .replace(/\u00A0|\u202F/g, " ")
    .replace(/(\d{1,2}:\d{2})(?:\s|[^\da-zA-Z])+(AM|PM)\b/gi, "$1 $2")
    .replace(/(\d{1,2})(?:\s|[^\da-zA-Z])+(AM|PM)\b/gi, "$1 $2")
    .replace(/(\d{1,2}:\d{2})(?:\s|[^\da-zA-Z]){1,4}M\b/gi, "$1 PM")
    .replace(/(\d{1,2})(?:\s|[^\da-zA-Z]){1,4}M\b/gi, "$1 PM")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleLines(element) {
  return (element?.innerText || element?.textContent || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function orderedVisibleText(element) {
  if (!element) return "";
  const flexCandidates = [element, ...element.querySelectorAll("span, div, a")]
    .filter((node) => {
      try {
        const style = window.getComputedStyle(node);
        return style.display.includes("flex");
      } catch {
        return false;
      }
    })
    .slice(0, 12);

  const texts = flexCandidates.map((root) => {
    const children = [...root.children]
      .map((child, index) => {
        const text = (child.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return null;
        const style = window.getComputedStyle(child);
        const hidden = style.position === "absolute" || style.visibility === "hidden" || style.display === "none";
        return {
          text,
          hidden,
          index,
          order: Number(style.order || 0)
        };
      })
      .filter(Boolean)
      .filter((item) => !item.hidden)
      .sort((a, b) => a.order - b.order || a.index - b.index);
    return children.map((child) => child.text).join("").replace(/\s+/g, " ").trim();
  }).filter(Boolean);

  return texts.sort((a, b) => b.length - a.length)[0] || "";
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

function isFacebookPhotoPage(url = window.location.href) {
  try {
    const parsed = new URL(url, window.location.href);
    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) return false;
    if (!/^\/photo(?:\/|\.php|$)/i.test(parsed.pathname)) return false;
    const setValue = parsed.searchParams.get("set") || "";
    return parsed.searchParams.has("fbid") || /(^|[.:])pcb(?:[.:]|$)/i.test(setValue);
  } catch {
    return false;
  }
}

function isSupportedCollectionPage(url = window.location.href) {
  return isFacebookHomePage(url) || isFacebookGroupPage(url) || isFacebookPhotoPage(url);
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

function isCanonicalPostHref(href = "") {
  return href.includes("/posts/") || href.includes("/permalink/") || href.includes("story_fbid=");
}

function isPhotoShellHref(href = "") {
  return href.includes("/photo/") || href.includes("fbid=") || href.includes("set=pcb");
}

function isProfileLikeHref(href = "") {
  if (!href || !/^https:\/\/(?:www\.)?facebook\.com\//i.test(href)) return false;
  return !(
    href.includes("/groups/") ||
    href.includes("/posts/") ||
    href.includes("/permalink/") ||
    href.includes("/photo/") ||
    href.includes("story_fbid=") ||
    href.includes("fbid=") ||
    href.includes("set=pcb") ||
    href.includes("comment_id=") ||
    href.includes("/watch") ||
    href.includes("/marketplace")
  );
}

function isViewPostText(text = "") {
  return /^(view post|see post|open post|查看帖子|打开帖子)$/i.test(String(text || "").trim());
}

function findPreferredPostAnchor(container) {
  const anchors = [...container.querySelectorAll("a[href]")].filter((anchor) => isVisibleElement(anchor));
  const ranked = anchors
    .map((anchor) => {
      const href = normalizeUrl(anchor.href || "");
      const text = visibleText(anchor);
      let score = 0;
      if (isCanonicalPostHref(href)) score += 100;
      else if (isPhotoShellHref(href)) score += 25;
      if (isViewPostText(text)) score += 30;
      if (isInTopSection(container, anchor)) score += 8;
      return { anchor, href, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.anchor.getBoundingClientRect().top - b.anchor.getBoundingClientRect().top);
  return ranked[0]?.anchor || null;
}

function findPhotoPostContext(container) {
  if (!isFacebookPhotoPage()) return container;
  const postAnchor = findPreferredPostAnchor(container);
  if (!postAnchor || !isCanonicalPostHref(postAnchor.href || "")) return container;

  let current = postAnchor.parentElement;
  let best = container;
  let depth = 0;
  while (current && depth < 10) {
    if (isVisibleElement(current)) {
      const text = visibleText(current);
      if (text.length >= 20) best = current;
      const hasTime = [...current.querySelectorAll(TIME_CANDIDATE_SELECTOR)]
        .some((element) => extractTimeFragment(
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("datetime") ||
          element.getAttribute("data-utime") ||
          visibleText(element)
        ));
      if (hasTime && /\/groups\/[^/?#]+/i.test(current.innerHTML || "")) break;
      if (current.matches("div[role='dialog'], div[role='main'], [role='article'], [role='complementary']")) break;
    }
    current = current.parentElement;
    depth += 1;
  }
  return best;
}

function firstTopSectionRow(container) {
  return [...container.children].find((child) => isVisibleElement(child) && isInTopSection(container, child)) || null;
}

function secondTopSectionRow(container) {
  const rows = [...container.children].filter((child) => isVisibleElement(child) && isInTopSection(container, child));
  return rows[1] || rows[0] || null;
}

function currentPhotoIdentifiers(url = window.location.href) {
  try {
    const parsed = new URL(url, window.location.href);
    const photoId = parsed.searchParams.get("fbid") || "";
    const setValue = parsed.searchParams.get("set") || "";
    const mediaSetToken = setValue || "";
    const postId = (setValue.match(/(?:^|[.:])([a-z_]+)\.(\d+)/i)?.[2]) || parsed.searchParams.get("story_fbid") || "";
    return { photoId, postId, mediaSetToken };
  } catch {
    return { photoId: "", postId: "", mediaSetToken: "" };
  }
}

function extractPostIdFromUrl(url = "") {
  const normalized = normalizeUrl(url);
  if (!normalized) return "";
  return normalized.match(/\/(?:posts|permalink)\/(\d+)/i)?.[1]
    || normalized.match(/[?&](?:story_fbid|multi_permalinks)=(\d+)/i)?.[1]
    || "";
}

function extractCandidatePostUrlsFromText(text = "") {
  const decoded = decodeFacebookEscapes(text);
  const matches = [
    ...decoded.matchAll(/https?:\/\/www\.facebook\.com\/groups\/[^\s"'<>]+/g),
    ...decoded.matchAll(/\/groups\/[^/\s"'<>?#]+\/(?:posts|permalink)\/\d+[^\s"'<>]*/g),
    ...decoded.matchAll(/https?:\/\/www\.facebook\.com\/photo\/\?[^\s"'<>]+/g)
  ].map((match) => normalizeUrl(match[0]));
  return [...new Set(matches.filter(Boolean))];
}

function parseJsonScriptText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeFacebookEscapes(value = "") {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .trim();
}

function styleValue(styles, name) {
  return Array.isArray(styles) ? (styles.find((item) => item?.name === name)?.val || "") : "";
}

function isHiddenLabelChild(node) {
  const styles = Array.isArray(node?.styles) ? node.styles : [];
  return styleValue(styles, "position") === "absolute" || styleValue(styles, "top") === "3em";
}

function readVisibleLabelText(labelNode) {
  const children = Array.isArray(labelNode?.children) ? labelNode.children : [];
  const ordered = children
    .map((child) => ({
      order: Number(styleValue(child?.styles, "order") || Number.POSITIVE_INFINITY),
      text: decodeFacebookEscapes(child?.text || ""),
      hidden: isHiddenLabelChild(child)
    }))
    .filter((child) => child.text)
    .filter((child) => !child.hidden)
    .sort((a, b) => a.order - b.order);
  const text = ordered.map((child) => child.text).join("").replace(/\s+/g, " ").trim();
  return text || "";
}

function readVisibleLabelTextFromScriptText(text = "", anchorIndex = 0) {
  const source = decodeFacebookEscapes(text);
  const marker = "\"ghl_label\":{";
  const candidates = [];
  let searchIndex = 0;

  while (searchIndex < source.length) {
    const labelIndex = source.indexOf(marker, searchIndex);
    if (labelIndex === -1) break;
    const slice = source.slice(labelIndex, Math.min(source.length, labelIndex + 12000));
    const childRegex = /"styles":\[(.*?)\],"text":"(.*?)","tag":"span","children":\[\]/g;
    const visible = [];
    for (let childMatch = childRegex.exec(slice); childMatch; childMatch = childRegex.exec(slice)) {
      const styles = decodeFacebookEscapes(childMatch[1] || "");
      const order = Number(styles.match(/"name":"order","val":"(\d+)"/)?.[1] || Number.POSITIVE_INFINITY);
      const hidden = styles.includes("\"name\":\"position\",\"val\":\"absolute\"") || styles.includes("\"name\":\"top\",\"val\":\"3em\"");
      const childText = decodeFacebookEscapes(childMatch[2] || "");
      if (!hidden && childText) visible.push({ order, text: childText });
      if (childMatch.index === childRegex.lastIndex) childRegex.lastIndex += 1;
    }
    const textValue = visible
      .sort((a, b) => a.order - b.order)
      .map((item) => item.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (textValue) candidates.push({ text: textValue, distance: Math.abs(labelIndex - anchorIndex) });
    searchIndex = labelIndex + marker.length;
  }

  candidates.sort((a, b) => {
    const looksLikeTimeA = looksLikeTime(a.text) ? 1 : 0;
    const looksLikeTimeB = looksLikeTime(b.text) ? 1 : 0;
    return looksLikeTimeB - looksLikeTimeA || a.distance - b.distance;
  });
  return candidates[0]?.text || "";
}

function parseClockTime(text = "") {
  const match = String(text || "").match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = (match[3] || "").toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return { hour, minute };
}

function normalizePhotoTimeText(displayTimeText = "", rawTimestamp = 0) {
  const normalized = String(displayTimeText || "").replace(/\s+/g, " ").trim();
  if (!normalized) return rawTimestamp ? formatPhotoFallbackTime(rawTimestamp) : "";
  if (isRelativeTimeText(normalized) && rawTimestamp) return formatPhotoFallbackTime(rawTimestamp);
  const clock = parseClockTime(normalized);
  if (clock && rawTimestamp) {
    const date = new Date(rawTimestamp);
    if (!Number.isNaN(date.getTime())) {
      date.setHours(clock.hour, clock.minute, 0, 0);
      return formatPhotoFallbackTime(date.getTime());
    }
  }
  return normalized;
}

function extractServerTimeMsFromText(text = "") {
  const match = String(text || "").match(/"ServerTimeData",\[\],\{"serverTime":(\d{13})/);
  if (!match?.[1]) return 0;
  const timestampMs = Number(match[1]);
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function getPageReferenceTimeMs() {
  if (cachedPageReferenceTimeMs && Number.isFinite(cachedPageReferenceTimeMs)) return cachedPageReferenceTimeMs;
  for (const script of document.querySelectorAll("script[type='application/json'], script")) {
    const timestampMs = extractServerTimeMsFromText(script.textContent || "");
    if (timestampMs) {
      cachedPageReferenceTimeMs = timestampMs;
      return timestampMs;
    }
  }
  cachedPageReferenceTimeMs = Date.now();
  return cachedPageReferenceTimeMs;
}

function nearestRegexMatch(text, pattern, anchorIndex) {
  const source = String(text || "");
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let best = null;
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    const distance = Math.abs(match.index - anchorIndex);
    if (!best || distance < best.distance) best = { match, distance };
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return best?.match || null;
}

function findPhotoStoryFromRawScriptText(text, identifiers) {
  const { photoId = "", postId = "", mediaSetToken = "" } = identifiers || {};
  if (!text || (!photoId && !postId)) return null;

  const markers = [
    postId ? `permalink\\/${postId}` : "",
    postId ? `post_id":"${postId}"` : "",
    postId ? `post_id\\":\\"${postId}\\"` : "",
    postId ? `story_fbid":["${postId}"]` : "",
    postId ? `story_fbid\\":[\\"${postId}\\"]` : "",
    mediaSetToken ? `mediasetToken":"${mediaSetToken}"` : "",
    mediaSetToken ? `mediasetToken\\":\\"${mediaSetToken}\\"` : "",
    postId ? `mediasetToken":"gm.${postId}"` : "",
    postId ? `mediasetToken\\":\\"gm.${postId}\\"` : "",
    postId ? `mediasetToken":"pcb.${postId}"` : "",
    postId ? `mediasetToken\\":\\"pcb.${postId}\\"` : "",
    photoId ? `"nodeID":"${photoId}"` : "",
    photoId ? `"id":"${photoId}"` : "",
    photoId ? `fbid=${photoId}` : ""
  ].filter(Boolean);

  const segments = [];
  for (const marker of markers) {
    let index = text.indexOf(marker);
    while (index !== -1) {
      const start = Math.max(0, index - 7000);
      const end = Math.min(text.length, index + 14000);
      segments.push(text.slice(start, end));
      if (segments.length >= 12) break;
      index = text.indexOf(marker, index + marker.length);
    }
    if (segments.length >= 12) break;
  }

  const uniqueSegments = [...new Set(segments)];
  const candidates = uniqueSegments.map((segment) => {
    const decoded = decodeFacebookEscapes(segment);
    const anchorIndex = Math.max(
      postId ? segment.indexOf(postId) : -1,
      photoId ? segment.indexOf(photoId) : -1,
      0
    );
    const publishMatch = nearestRegexMatch(segment, /publish_time\\?":(\d{10,13})/g, anchorIndex);
    const creationMatch = nearestRegexMatch(segment, /creation_time\\?":(\d{10,13})/g, anchorIndex);
    const authorMatch = nearestRegexMatch(
      decoded,
      /"actors"?\s*:\s*\[\{[\s\S]{0,400}?(?:^|[,{])"name"\s*:\s*"([^"]{1,120})"/g,
      Math.max(postId ? decoded.indexOf(postId) : -1, photoId ? decoded.indexOf(photoId) : -1, 0)
    );
    const messageMatch = nearestRegexMatch(
      decoded,
      /message"?\s*:\s*\{[\s\S]{0,1200}?text"?\s*:\s*"([\s\S]{1,1500}?)"\s*[,}]/g,
      Math.max(postId ? decoded.indexOf(postId) : -1, photoId ? decoded.indexOf(photoId) : -1, 0)
    );
    const urlMatches = extractCandidatePostUrlsFromText(decoded);
    const matchedPostUrl = urlMatches.find((url) => !postId || extractPostIdFromUrl(url) === postId)
      || urlMatches[0]
      || normalizeUrl(window.location.href);
    const matchedPostId = postId || extractPostIdFromUrl(matchedPostUrl);
    const rawTimestamp = publishMatch?.[1] ? Number(publishMatch[1]) * 1000 : creationMatch?.[1] ? Number(creationMatch[1]) * 1000 : 0;
    const visibleLabelText = readVisibleLabelTextFromScriptText(segment, anchorIndex);

    if (!rawTimestamp) return null;
    return {
      authorName: decodeFacebookEscapes(authorMatch?.[1] || ""),
      postUrl: matchedPostUrl,
      rawTimestamp,
      timestampKind: publishMatch?.[1] ? "publish_time" : "creation_time",
      postText: decodeFacebookEscapes(messageMatch?.[1] || ""),
      matchedPostId,
      displayTimeText: visibleLabelText
    };
  }).filter(Boolean);

  return candidates.sort((a, b) => {
    const scoreA = (a.timestampKind === "publish_time" ? 100 : 0) + (a.matchedPostId && postId && a.matchedPostId === postId ? 50 : 0);
    const scoreB = (b.timestampKind === "publish_time" ? 100 : 0) + (b.matchedPostId && postId && b.matchedPostId === postId ? 50 : 0);
    return scoreB - scoreA || b.rawTimestamp - a.rawTimestamp;
  })[0] || null;
}

function walkForPhotoStoryFallback(node, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) {
    for (const item of node) walkForPhotoStoryFallback(item, result);
    return result;
  }
  if (typeof node !== "object") return result;

  const actorName = node?.story?.actors?.[0]?.name;
  const actorUrl = node?.story?.actors?.[0]?.url || node?.story?.actors?.[0]?.profile_url;
  const storyUrl = node?.story?.url;
  const creationTime = node?.story?.creation_time;
  const visibleTimeText = readVisibleLabelText(node?.story?.ghl_label);
  if (actorName && storyUrl && creationTime) {
    result.push({
      authorName: actorName,
      authorUrl: normalizeUrl(actorUrl || ""),
      postUrl: normalizeUrl(storyUrl),
      rawTimestamp: Number(creationTime) * 1000,
      timestampKind: "creation_time",
      displayTimeText: visibleTimeText
    });
  }

  const shareable = node?.shareable_from_perspective_of_feed_ufi;
  const publishTime = node?.page_insights && typeof node?.page_insights === "object"
    ? Object.values(node.page_insights).find((entry) => entry?.post_context?.publish_time)?.post_context?.publish_time
    : null;
  const messageText = node?.message?.text;
  const actors = Array.isArray(node?.actors) ? node.actors : [];
  if (shareable?.url && publishTime && actors[0]?.name) {
    result.push({
      authorName: actors[0].name,
      authorUrl: normalizeUrl(actors[0].url || actors[0].profile_url || ""),
      postUrl: normalizeUrl(shareable.url),
      rawTimestamp: Number(publishTime) * 1000,
      timestampKind: "publish_time",
      postText: typeof messageText === "string" ? messageText : "",
      displayTimeText: visibleTimeText
    });
  }

  for (const value of Object.values(node)) {
    walkForPhotoStoryFallback(value, result);
  }
  return result;
}

function formatPhotoFallbackTime(timestampMs) {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "";
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}.${String(date.getMinutes()).padStart(2, "0")}.${String(date.getSeconds()).padStart(2, "0")}`;
}

function findStoryScriptFallback(postUrl = "") {
  const normalizedPostUrl = normalizeUrl(postUrl || "");
  const postId = extractPostIdFromUrl(normalizedPostUrl) || extractPostIdFromUrl(window.location.href);
  const cacheKey = postId || normalizedPostUrl || normalizeUrl(window.location.href);
  if (storyFallbackCache.has(cacheKey)) return storyFallbackCache.get(cacheKey);

  const candidates = [];
  for (const script of document.querySelectorAll("script[type='application/json'], script")) {
    const text = script.textContent || "";
    if (!text) continue;
    const hasTargetPost = Boolean(postId && text.includes(postId));
    const hasTimeMarkers = text.includes("publish_time") || text.includes("creation_time");
    if (!hasTargetPost && !hasTimeMarkers) continue;

    const textFallback = findPhotoStoryFromRawScriptText(text, { photoId: "", postId, mediaSetToken: "" });
    if (textFallback) candidates.push(textFallback);

    const parsed = parseJsonScriptText(text);
    if (!parsed) continue;
    walkForPhotoStoryFallback(parsed, candidates);
  }

  const filtered = candidates.filter((item) => {
    if (!item?.rawTimestamp) return false;
    if (!postId) return true;
    return (item.matchedPostId || extractPostIdFromUrl(item.postUrl)) === postId;
  });

  const ranked = filtered
    .map((item) => {
      const itemPostId = item.matchedPostId || extractPostIdFromUrl(item.postUrl);
      const resolvedPostUrl = item.postUrl || normalizedPostUrl || normalizeUrl(window.location.href);
      let score = 0;
      if (item.timestampKind === "publish_time") score += 100;
      if (postId && itemPostId === postId) score += 80;
      if (normalizedPostUrl && resolvedPostUrl === normalizedPostUrl) score += 40;
      if (resolvedPostUrl.includes("/permalink/") || resolvedPostUrl.includes("/posts/")) score += 10;
      if (item.displayTimeText && !isRelativeTimeText(item.displayTimeText)) score += 6;
      return { ...item, postUrl: resolvedPostUrl, score };
    })
    .sort((a, b) => b.score - a.score || b.rawTimestamp - a.rawTimestamp);

  const result = ranked[0] || null;
  storyFallbackCache.set(cacheKey, result);
  return result;
}

function findPhotoStoryFallback() {
  if (!isFacebookPhotoPage()) return null;
  const { photoId, postId, mediaSetToken } = currentPhotoIdentifiers();
  const candidates = [];
  for (const script of document.querySelectorAll("script[type='application/json'], script")) {
    const text = script.textContent || "";
    if (!text) continue;
    const mayContainCurrentPhoto = Boolean(photoId && text.includes(photoId));
    const mayContainCurrentPost = Boolean(postId && text.includes(postId));
    const mayContainCurrentMediaSet = Boolean(mediaSetToken && text.includes(mediaSetToken));
    const hasPhotoMarkers = text.includes("CometPhotoRootContentQuery") || text.includes("shareable_from_perspective_of_feed_ufi");
    const hasTimeMarkers = text.includes("publish_time") || text.includes("creation_time");
    if (!mayContainCurrentPhoto && !mayContainCurrentPost && !mayContainCurrentMediaSet && !hasPhotoMarkers && !hasTimeMarkers) continue;
    const textFallback = findPhotoStoryFromRawScriptText(text, { photoId, postId, mediaSetToken });
    if (textFallback) candidates.push(textFallback);
    const parsed = parseJsonScriptText(text);
    if (!parsed) continue;
    walkForPhotoStoryFallback(parsed, candidates);
  }
  const filtered = candidates.filter((item) => item?.rawTimestamp);
  const merged = filtered.map((item) => {
    if (item.displayTimeText) return item;
    const itemPostId = item.matchedPostId || extractPostIdFromUrl(item.postUrl);
    const related = filtered.find((candidate) => {
      if (!candidate.displayTimeText) return false;
      const candidatePostId = candidate.matchedPostId || extractPostIdFromUrl(candidate.postUrl);
      return candidatePostId && itemPostId && candidatePostId === itemPostId;
    });
    return related ? { ...item, displayTimeText: related.displayTimeText } : item;
  });
  const exactPostMatches = postId
    ? merged.filter((item) => extractPostIdFromUrl(item.postUrl) === postId)
    : [];
  const scoped = exactPostMatches.length > 0 ? exactPostMatches : merged;
  const ranked = scoped
    .map((item) => {
      const resolvedPostUrl = item.postUrl || normalizeUrl(window.location.href);
      const itemPostId = item.matchedPostId || extractPostIdFromUrl(resolvedPostUrl);
      let score = 0;
      if (item.timestampKind === "publish_time") score += 100;
      if (postId && itemPostId === postId) score += 80;
      if (resolvedPostUrl.includes("/permalink/") || resolvedPostUrl.includes("/posts/")) score += 12;
      if (photoId && resolvedPostUrl.includes(photoId)) score += 8;
      if (item.displayTimeText && looksLikeTime(item.displayTimeText)) score += 6;
      return { ...item, postUrl: resolvedPostUrl, score };
    })
    .sort((a, b) => b.score - a.score || b.rawTimestamp - a.rawTimestamp);
  return ranked[0] || null;
}

function fallbackContainersFromTimeMarkers() {
  return [...document.querySelectorAll(TIME_CANDIDATE_SELECTOR)]
    .filter((element) => isVisibleElement(element))
    .filter((element) => {
      const marker = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("datetime"),
        element.getAttribute("data-utime"),
        orderedVisibleText(element),
        visibleText(element)
      ].map((candidate) => extractTimeFragment(candidate)).find(Boolean);
      const href = normalizeUrl(element.closest("a[href]")?.href || element.getAttribute("href") || "");
      return Boolean(marker || isCanonicalPostHref(href) || isPhotoShellHref(href));
    })
    .flatMap((element) => {
      const containers = [];
      let current = element.parentElement;
      let depth = 0;
      while (current && depth < 10) {
        const rect = current.getBoundingClientRect();
        const text = visibleText(current);
        if (isVisibleElement(current) && rect.width >= 220 && rect.height >= 80 && text.length >= 20) {
          containers.push(current);
        }
        if (current.matches("div[role='dialog'], div[role='main'], [role='article'], [role='complementary']")) break;
        current = current.parentElement;
        depth += 1;
      }
      return containers;
    })
    .filter((element, index, list) => list.indexOf(element) === index)
    .sort((a, b) => {
      const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
      const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
      return areaA - areaB;
    })
    .filter((element, index, list) => !list.some((other, otherIndex) => otherIndex !== index && other.contains(element)))
    .slice(0, 6);
}

function findSourceLink(container) {
  const candidates = [...container.querySelectorAll("a[href*='/groups/']")]
    .filter((anchor) => isVisibleElement(anchor))
    .map((anchor) => ({ anchor, text: visibleText(anchor), href: normalizeUrl(anchor.href || "") }))
    .filter(({ text, href }) => text && /\/groups\/[^/?#]+/i.test(href) && !looksLikeTime(text) && !isNoiseLine(text))
    .sort((a, b) => a.anchor.getBoundingClientRect().top - b.anchor.getBoundingClientRect().top || a.text.length - b.text.length);
  return candidates[0] || null;
}

function findSourceName(container) {
  const source = findSourceLink(container);
  if (source?.text) return source.text;
  if (/\/groups\/feed\/?$/i.test(location.pathname)) return "群组总动态";
  if (isFacebookGroupPage()) {
    const heading = document.querySelector("h1");
    const title = visibleText(heading);
    if (title) return title;
  }
  if (isFacebookHomePage()) return "Facebook 首页";
  if (isFacebookPhotoPage()) return "图片帖子";
  return document.title.replace(/\| Facebook$/i, "").trim() || "未知来源";
}

function findSourceUrl(container, postUrl = "") {
  const source = findSourceLink(container);
  if (source?.href) return source.href;
  if (/\/groups\/feed\/?$/i.test(location.pathname)) return normalizeUrl(window.location.href);
  if (isFacebookPhotoPage() && postUrl) return postUrl;
  return normalizeUrl(window.location.href);
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
  const markerFallback = fallbackContainersFromTimeMarkers();
  if (!isFacebookPhotoPage()) return [...new Set([...markerFallback, ...filtered])];
  return [...new Set([...markerFallback, ...filtered])];
}

function extractTimeFragment(value) {
  const text = normalizeTimeCandidateText(value);
  if (!text) return "";
  if (/^\d{10,13}$/.test(text)) {
    const millis = text.length === 13 ? Number(text) : Number(text) * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }
  const weekdayMatch = text.match(/(?:Today|Yesterday|Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Tues(?:day)?|Wed(?:nesday)?|Thu(?:rsday)?|Thur(?:sday)?|Fri(?:day)?|Sat(?:urday)?|今天|昨天|周[一二三四五六日天]|星期[一二三四五六日天])(?:\s+(?:at\s+)?)?(?:上午|下午|中午|晚上|早上)?\s*\d{1,2}(?::\d{2})?\s*(?:[AP]M)?/i);
  if (weekdayMatch?.[0]) return weekdayMatch[0].trim();
  const dayMonthMatch = text.match(/\b\d{1,2}\s+(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}\s*[AP]M)?\b/i);
  if (dayMonthMatch?.[0]) return dayMonthMatch[0].trim();
  const absoluteMatch = text.match(/\b(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}\s*[AP]M)?\b/i);
  if (absoluteMatch?.[0]) return absoluteMatch[0].trim();
  const chineseAbsoluteMatch = text.match(/(?:\d{4}年\s*)?\d{1,2}月\d{1,2}日(?:\s*(?:上午|下午|中午|晚上|早上)?\s*\d{1,2}(?:[:：]\d{2})?)?/);
  if (chineseAbsoluteMatch?.[0]) return chineseAbsoluteMatch[0].trim();
  const relativeMatch = text.match(/(Just now|Now|Today|Yesterday|刚刚|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|分钟|分|小时|小時|天|周))/i);
  if (relativeMatch?.[1]) return relativeMatch[1].trim();
  const isoMatch = text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}(?:[:.]\d{2})(?:[:.]\d{2})?)?/);
  if (isoMatch?.[0]) return isoMatch[0].trim();
  const normalized = text.replace(/ at /i, " ").replace(/(\d{1,2})\.(\d{2})\.(\d{2})$/, "$1:$2:$3");
  return Number.isNaN(new Date(normalized).getTime()) ? "" : text;
}

function isRelativeTimeText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return /^(?:just now|now|today|yesterday|about an hour ago|\d+\s*(?:[mM]|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))$/i.test(text);
}

function isAbsoluteTimeText(value) {
  const fragment = extractTimeFragment(value);
  return Boolean(fragment) && !isRelativeTimeText(fragment);
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
  const postLink = findPreferredPostAnchor(container);
  return postLink ? normalizeUrl(postLink.href) : normalizeUrl(window.location.href);
}

async function findRawTime(container) {
  const preferredPostUrl = findPostUrl(container);
  if (isFacebookPhotoPage()) {
    const textRows = [secondTopSectionRow(container), firstTopSectionRow(container), container]
      .filter(Boolean)
      .flatMap((element) => visibleLines(element));
    const exactLine = textRows.find((line) => /\b\d{1,2}\s+(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\b/i.test(line));
    if (exactLine) {
      const fragment = extractTimeFragment(exactLine);
      if (fragment) return fragment;
    }
  }
  const candidates = [...container.querySelectorAll(TIME_CANDIDATE_SELECTOR)]
    .filter((element) => isVisibleElement(element) && isInTopSection(container, element))
    .map((element) => {
      const orderedText = isFacebookPhotoPage() ? orderedVisibleText(element) : "";
      const value = [
        tooltipTimeTextsForElement(element, { includeHidden: true })[0],
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("datetime"),
        element.getAttribute("data-utime"),
        orderedText,
        visibleText(element)
      ].map((candidate) => extractTimeFragment(candidate)).find(Boolean);
      let score = 0;
      const nearestAnchor = element.closest("a[href]");
      const anchorHref = normalizeUrl(nearestAnchor?.href || "");
      const hasVisibleText = Boolean(visibleText(element));
      if (value) score += 3;
      if (element.tagName.toLowerCase() === "time" || element.getAttribute("datetime")) score += 2;
      if (anchorHref && anchorHref === preferredPostUrl) score += 8;
      if (isCanonicalPostHref(anchorHref)) score += 5;
      if (isPhotoShellHref(anchorHref)) score += isFacebookPhotoPage() ? -3 : 2;
      if (element.tagName.toLowerCase() === "a") score += 1;
      if (hasVisibleText) score += 2;
      if (orderedText && orderedText !== visibleText(element)) score += 4;
      if (element.getAttribute("data-utime") && isFacebookPhotoPage() && !hasVisibleText) score -= 2;
      return { element, value: value || "", score, anchorHref };
    })
    .filter((item) => item.value)
    .sort((a, b) => b.score - a.score || a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);
  const topCandidate = candidates[0];
  if (topCandidate?.value && isAbsoluteTimeText(topCandidate.value)) return topCandidate.value.trim();
  if ((isFacebookPhotoPage() || preferredPostUrl.includes("/groups/")) && candidates.length > 0) {
    const hoverCandidates = candidates
      .filter((item) => item.anchorHref === preferredPostUrl || item.element === topCandidate?.element)
      .concat(candidates)
      .filter((item, index, list) => list.findIndex((entry) => entry.element === item.element) === index)
      .slice(0, 3);
    for (const item of hoverCandidates) {
      const tooltipValue = await hoverForTooltipTime(item.element);
      if (tooltipValue) return tooltipValue;
    }
  }
  if (topCandidate?.value) return topCandidate.value.trim();
  for (const line of topSectionLines(container)) {
    const fragment = extractTimeFragment(line);
    if (fragment) return fragment;
  }
  return "";
}

function findAuthor(container, rawTimeText = "", sourceName = "") {
  if (isFacebookPhotoPage()) {
    const headerRow = secondTopSectionRow(container) || firstTopSectionRow(container);
    if (headerRow) {
      const strongName = [...headerRow.querySelectorAll("strong, h1, h2, h3, h4")]
        .map((element) => visibleText(element))
        .find((text) => text && !looksLikeTime(text) && !isNoiseLine(text) && !isViewPostText(text));
      if (strongName) return strongName;
      const profileLinkName = [...headerRow.querySelectorAll("a[href]")]
        .map((element) => ({ text: visibleText(element), href: normalizeUrl(element.href || "") }))
        .find(({ text, href }) => text && isProfileLikeHref(href) && !looksLikeTime(text) && !isNoiseLine(text) && !isViewPostText(text));
      if (profileLinkName?.text) return profileLinkName.text;
    }
  }
  const timeCandidates = [...container.querySelectorAll(TIME_CANDIDATE_SELECTOR)]
    .filter((element) => isVisibleElement(element) && isInTopSection(container, element))
    .map((element) => {
      const value = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("datetime"),
        element.getAttribute("data-utime"),
        visibleText(element)
      ].map((candidate) => extractTimeFragment(candidate)).find(Boolean);
      return value ? element : null;
    })
    .filter(Boolean);
  const timeTop = timeCandidates[0]?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
  const candidates = [...container.querySelectorAll("strong, h2, h3, h4, a[href]")]
    .filter((element) => isVisibleElement(element) && isInTopSection(container, element))
    .map((element) => ({ element, text: visibleText(element), href: normalizeUrl(element.href || "") }))
    .filter(({ element, text }) => {
      if (!text || text.length > 80) return false;
      if (text === rawTimeText || text === sourceName) return false;
      if (looksLikeTime(text) || isNoiseLine(text) || isViewPostText(text)) return false;
      if (element.tagName.toLowerCase() === "a") {
        const href = element.href || "";
        if (href.includes("/groups/") || href.includes("/posts/") || href.includes("/permalink/") || href.includes("comment_id=") || href.includes("/photo/")) return false;
      }
      return true;
    })
    .map((candidate) => {
      const rect = candidate.element.getBoundingClientRect();
      let score = 0;
      if (/^strong$/i.test(candidate.element.tagName)) score += 5;
      if (/^h[234]$/i.test(candidate.element.tagName)) score += 4;
      if (candidate.href && isProfileLikeHref(candidate.href)) score += 4;
      if (candidate.href && isPhotoShellHref(candidate.href)) score -= 6;
      if (candidate.href && isCanonicalPostHref(candidate.href)) score -= 6;
      if (timeTop < Number.POSITIVE_INFINITY && rect.top <= timeTop + 18 && rect.top >= timeTop - 120) score += 6;
      return { ...candidate, score, rectTop: rect.top };
    })
    .sort((a, b) => b.score - a.score || a.rectTop - b.rectTop);
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

async function extractPost(container) {
  const contextContainer = findPhotoPostContext(container);
  const domPostUrl = findPostUrl(contextContainer);
  const photoFallback = findPhotoStoryFallback();
  const scriptFallback = photoFallback || findStoryScriptFallback(domPostUrl);
  const pageReferenceTimeMs = getPageReferenceTimeMs();
  const domRawTimeText = await findRawTime(contextContainer);
  const postUrl = scriptFallback?.postUrl || domPostUrl;
  const fallbackRawTimeText = scriptFallback ? normalizePhotoTimeText(scriptFallback.displayTimeText, scriptFallback.rawTimestamp) : "";
  const rawTimeText = scriptFallback && (!domRawTimeText || isRelativeTimeText(domRawTimeText))
    ? (fallbackRawTimeText || domRawTimeText)
    : domRawTimeText;
  const groupName = findSourceName(contextContainer);
  const groupUrl = findSourceUrl(contextContainer, postUrl);
  const authorName = scriptFallback?.authorName || findAuthor(contextContainer, rawTimeText, groupName);
  const postText = extractPostText(contextContainer, authorName, rawTimeText) || scriptFallback?.postText || "未识别到正文";
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
    timeReferenceAt: new Date(pageReferenceTimeMs || Date.now()).toISOString(),
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

async function collectVisiblePosts({ allowSeen = false } = {}) {
  if (!contextActive || !collecting) return [];
  const containers = likelyPostContainers();
  const scanned = [];
  const extractErrors = [];

  for (const container of containers) {
    try {
      const post = await extractPost(container);
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
      void collectVisiblePosts();
    }, 900);
  });
  feedObserver.observe(observerRoot, { childList: true, subtree: true });
}

function startCollectLoop({ allowSeen = false } = {}) {
  collecting = true;
  if (collectTimer) clearInterval(collectTimer);
  void collectVisiblePosts({ allowSeen });
  collectTimer = setInterval(() => { void collectVisiblePosts(); }, 4000);
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

function dispatchHoverEvent(target, type, eventInit) {
  const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  target.dispatchEvent(new EventCtor(type, eventInit));
}

function relatedTooltipNodes(target) {
  const ids = [];
  let current = target;
  let depth = 0;
  while (current && depth < 6) {
    const describedBy = current.getAttribute?.("aria-describedby");
    const labelledBy = current.getAttribute?.("aria-labelledby");
    if (describedBy) ids.push(...String(describedBy).split(/\s+/));
    if (labelledBy) ids.push(...String(labelledBy).split(/\s+/));
    current = current.parentElement;
    depth += 1;
  }

  return ids
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

function tooltipTimeTextsForElement(element, { includeHidden = false } = {}) {
  return relatedTooltipNodes(element)
    .filter((node) => includeHidden || isVisibleElement(node))
    .map((node) => (includeHidden ? (node.textContent || "") : visibleText(node)))
    .map((text) => normalizeTimeCandidateText(text))
    .filter((text) => isAbsoluteTimeText(text));
}

function visibleTooltipTimeTexts() {
  const tooltipNodes = [...document.querySelectorAll("[role='tooltip']")]
    .filter((element) => isVisibleElement(element));
  return tooltipNodes
    .map((element) => normalizeTimeCandidateText(visibleText(element)))
    .filter((text) => isAbsoluteTimeText(text));
}

async function hoverForTooltipTime(element) {
  if (!element || !isVisibleElement(element)) return "";
  const target = element.closest("a[href], [role='link']") || element;
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    await wait(80);
  }
  const rect = target.getBoundingClientRect();
  const clientX = Math.max(4, Math.min(window.innerWidth - 4, Math.floor(rect.left + Math.min(Math.max(rect.width / 2, 8), Math.max(rect.width - 8, 8)))));
  const clientY = Math.max(4, Math.min(window.innerHeight - 4, Math.floor(rect.top + Math.min(Math.max(rect.height / 2, 8), Math.max(rect.height - 8, 8)))));
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
    screenX: clientX,
    screenY: clientY,
    buttons: 0,
    button: 0,
    pointerType: "mouse",
    relatedTarget: null,
    view: window
  };
  const hoverTargets = [target, document.elementFromPoint(clientX, clientY)]
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);

  if (typeof target.focus === "function") {
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  for (const type of ["pointerenter", "mouseenter", "pointerover", "mouseover", "pointermove", "mousemove"]) {
    for (const hoverTarget of hoverTargets) dispatchHoverEvent(hoverTarget, type, eventInit);
  }

  for (const delayMs of [120, 220, 360, 520]) {
    await wait(delayMs);
    for (const hoverTarget of hoverTargets) dispatchHoverEvent(hoverTarget, "mousemove", eventInit);
    const texts = visibleTooltipTimeTexts();
    const describedTexts = tooltipTimeTextsForElement(target);
    const bestText = texts[0] || describedTexts[0] || "";
    if (bestText) {
      for (const type of ["pointerout", "mouseout", "mouseleave", "pointerleave"]) {
        for (const hoverTarget of hoverTargets) dispatchHoverEvent(hoverTarget, type, eventInit);
      }
      return bestText;
    }
  }

  for (const type of ["pointerout", "mouseout", "mouseleave", "pointerleave"]) {
    for (const hoverTarget of hoverTargets) dispatchHoverEvent(hoverTarget, type, eventInit);
  }
  return "";
}

async function collectAfterScroll(delayMs) {
  const settleMs = Math.max(1200, Math.min(2500, Math.floor((delayMs || 3000) * 0.5)));
  await wait(settleMs);
  let posts = await collectVisiblePosts();
  if (posts.length === 0) {
    await wait(900);
    posts = await collectVisiblePosts();
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
  const initialPosts = await collectVisiblePosts({ allowSeen: true });
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
  const run = async () => {
    const posts = await collectVisiblePosts();
    scheduleMonitorReload(safeInterval);
    sendAck(commandId, "start_group_monitor", true, restored ? `群组监控已恢复，本轮发现 ${posts.length} 条新帖子` : `群组监控检查完成，发现 ${posts.length} 条新帖子`, "monitoring", {
      groupName: findGroupName(),
      groupUrl: findGroupUrl(),
      collectedCount: posts.length,
      autoRefreshEnabled: Boolean(latestSettings?.groupMonitor?.autoRefreshEnabled),
      autoRefreshSeconds: Number(latestSettings?.groupMonitor?.autoRefreshSeconds || 0)
    });
  };
  void run();
  monitorTimer = setInterval(() => { void run(); }, safeInterval * 1000);
}

async function diagnose(commandId) {
  if (!isSupportedCollectionPage()) {
    sendAck(commandId, "diagnose", false, "当前页面不是支持的 Facebook 采集页，请打开首页、groups/feed、具体群组页或图片帖子详情页。", "error", {
      facebookPage: location.href,
      contentScript: "injected",
      supportedCollectionPage: false
    });
    return;
  }
  collecting = true;
  const posts = await collectVisiblePosts({ allowSeen: true });
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
      message: "当前页面不是支持的 Facebook 采集页，请打开首页、groups/feed、具体群组页或图片帖子详情页。",
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
    const posts = await collectVisiblePosts({ allowSeen: true });
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
