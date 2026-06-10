let collecting = true;
let autoScrollTimer = null;
let autoScrollProgress = { current: 0, total: 0 };
const seenKeys = new Set();

function hash(value) {
  let result = 5381;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 33) ^ value.charCodeAt(index);
  }
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
  const title = document.title.replace(/\| Facebook$/, "").trim();
  return title || "未知群组";
}

function findGroupUrl() {
  const groupLink = [...document.querySelectorAll("a[href*='/groups/']")].find((anchor) => /\/groups\/[^/?#]+/.test(anchor.href));
  return groupLink ? normalizeUrl(groupLink.href) : "";
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

function findPostUrl(container) {
  const anchors = [...container.querySelectorAll("a[href]")];
  const postLink = anchors.find((anchor) => {
    const href = anchor.href;
    return (
      href.includes("/posts/") ||
      href.includes("/permalink/") ||
      href.includes("story_fbid=") ||
      href.includes("fbid=") ||
      href.includes("set=pcb")
    );
  });
  return postLink ? normalizeUrl(postLink.href) : normalizeUrl(window.location.href);
}

function findRawTime(container) {
  const direct = [
    ...container.querySelectorAll("time, abbr, a[aria-label], span[aria-label], a[title], span[title]")
  ];
  for (const element of direct) {
    const value =
      element.getAttribute("datetime") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      visibleText(element);
    if (looksLikeTime(value)) return value.trim();
  }

  const anchors = [...container.querySelectorAll("a[href]")];
  for (const anchor of anchors) {
    const text = visibleText(anchor);
    if (looksLikeTime(text)) return text;
    const parentText = visibleText(anchor.parentElement || anchor);
    const match = parentText.match(/\b(Just now|\d+\s*(?:m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)|Yesterday)\b|刚刚|\d+\s*(?:分钟|小时|天|周)前|昨天/i);
    if (match) return match[0];
  }
  return "";
}

function looksLikeTime(value) {
  const text = (value || "").trim();
  return /^(Just now|Now|Yesterday|\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))$/i.test(text) ||
    /^(刚刚|刚才|昨天|\d+\s*(分钟|分|小时|天|周)前?)$/.test(text);
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
  const postText = rawText
    .replace(authorName, "")
    .replace(rawTimeText, "")
    .replace(/\bLike\b|\bComment\b|\bShare\b/gi, "")
    .trim();
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
    sourceWindowId: "",
    sourceAccountNote: "",
    statusNote: rawTimeText ? "正常" : "时间未识别，需要人工确认"
  };
}

function collectVisiblePosts() {
  if (!collecting) return [];
  const posts = likelyPostContainers().map(extractPost).filter((post) => post.postText.length >= 12);
  const fresh = posts.filter((post) => {
    const key = post.postUrl || post.postId;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  if (fresh.length > 0) {
    chrome.runtime.sendMessage({ type: "posts_batch_collected", payload: fresh });
  }
  return fresh;
}

function startAutoScroll(count) {
  stopAutoScroll();
  collecting = true;
  autoScrollProgress = { current: 0, total: count };
  const step = () => {
    if (autoScrollProgress.current >= autoScrollProgress.total) return stopAutoScroll();
    window.scrollBy({ top: Math.max(600, window.innerHeight * 0.85), behavior: "smooth" });
    autoScrollProgress.current += 1;
    setTimeout(collectVisiblePosts, 1800);
  };
  step();
  autoScrollTimer = setInterval(step, 2500);
}

function stopAutoScroll() {
  if (autoScrollTimer) clearInterval(autoScrollTimer);
  autoScrollTimer = null;
}

let scrollDebounce = null;
window.addEventListener("scroll", () => {
  if (scrollDebounce) clearTimeout(scrollDebounce);
  scrollDebounce = setTimeout(collectVisiblePosts, 900);
});

const observer = new MutationObserver(() => {
  if (scrollDebounce) clearTimeout(scrollDebounce);
  scrollDebounce = setTimeout(collectVisiblePosts, 1200);
});
observer.observe(document.documentElement, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "collect_now") {
    const posts = collectVisiblePosts();
    sendResponse({ ok: true, count: posts.length });
    return true;
  }
  if (message.type === "start_collecting") {
    collecting = true;
    const posts = collectVisiblePosts();
    sendResponse({ ok: true, count: posts.length });
    return true;
  }
  if (message.type === "stop_collecting") {
    collecting = false;
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "start_auto_scroll") {
    startAutoScroll(Number(message.payload?.count || 5));
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "stop_auto_scroll") {
    stopAutoScroll();
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

setTimeout(collectVisiblePosts, 1500);
