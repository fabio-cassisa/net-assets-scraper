// ─── Net Assets Scraper V2 — Service Worker ─────────────────────────
// Passively captures network resources via webRequest API.
// Stores metadata per tab in chrome.storage.session.
// Communicates with side panel + content script via messaging.

// ─── Constants ───────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "svg", "avif", "ico", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "avi", "mov", "wmv", "m4v", "mkv"]);
const FONT_EXTS  = new Set(["woff", "woff2", "ttf", "otf", "eot"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "aac", "flac", "m4a"]);

const IMAGE_MIMES = ["image/"];
const VIDEO_MIMES = ["video/"];
const FONT_MIMES  = ["font/", "application/font", "application/vnd.ms-fontobject", "application/x-font"];
const AUDIO_MIMES = ["audio/"];

// Domains to skip — tracking, analytics, ad networks
const SKIP_DOMAINS = new Set([
  "google-analytics.com", "googletagmanager.com", "doubleclick.net",
  "facebook.net", "fbcdn.net", "analytics.google.com",
  "hotjar.com", "clarity.ms", "newrelic.com", "sentry.io",
  "segment.com", "mixpanel.com", "amplitude.com",
  "googleadservices.com", "googlesyndication.com",
  "cdn.mxpnl.com", "bat.bing.com", "px.ads.linkedin.com"
]);

// ─── State ───────────────────────────────────────────────────────────
// In-memory store per tab: tabId → Map<url, resourceMeta>
const tabResources = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────
function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot === -1 || dot === pathname.length - 1) return "";
    const ext = pathname.substring(dot + 1).toLowerCase();
    // Guard against long strings that aren't extensions
    return ext.length <= 6 ? ext : "";
  } catch {
    return "";
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isSkippedDomain(url) {
  const domain = getDomain(url);
  for (const skip of SKIP_DOMAINS) {
    if (domain === skip || domain.endsWith("." + skip)) return true;
  }
  return false;
}

function classifyByExtension(ext) {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (FONT_EXTS.has(ext))  return "font";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

function classifyByMime(contentType) {
  if (!contentType) return null;
  const ct = contentType.toLowerCase();
  if (IMAGE_MIMES.some((m) => ct.startsWith(m))) return "image";
  if (VIDEO_MIMES.some((m) => ct.startsWith(m))) return "video";
  if (FONT_MIMES.some((m) => ct.includes(m)))    return "font";
  if (AUDIO_MIMES.some((m) => ct.startsWith(m))) return "audio";
  return null;
}

function classifyResource(url, contentType) {
  const ext = getExtensionFromUrl(url);
  return classifyByExtension(ext) || classifyByMime(contentType) || null;
}

// ─── webRequest listener — passive resource capture ──────────────────
chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Only track main frame and sub-resource requests
    if (details.tabId < 0) return;

    const url = details.url;

    // Skip data URIs, chrome-extension URLs, and tracking domains
    if (url.startsWith("data:") || url.startsWith("chrome") || url.startsWith("moz-extension")) return;
    if (isSkippedDomain(url)) return;

    // Get content-type from response headers
    const contentTypeHeader = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const contentType = contentTypeHeader ? contentTypeHeader.value.split(";")[0].trim() : "";
    const contentLengthHeader = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === "content-length"
    );
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader.value, 10) : -1;

    const type = classifyResource(url, contentType);
    if (!type) return; // Not an asset we care about

    // Get or create the resource map for this tab
    if (!tabResources.has(details.tabId)) {
      tabResources.set(details.tabId, new Map());
    }
    const resources = tabResources.get(details.tabId);

    // Deduplicate — only store first occurrence of each URL
    if (resources.has(url)) return;

    resources.set(url, {
      url,
      type,
      contentType,
      contentLength,
      ext: getExtensionFromUrl(url),
      timestamp: Date.now(),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ─── Tab lifecycle — cleanup on close/navigate ───────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabResources.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Clear resources when a tab navigates to a new page
  if (changeInfo.status === "loading" && changeInfo.url) {
    tabResources.delete(tabId);
  }
});

// ─── Messaging — panel and content script communication ──────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getResources") {
    const tabId = message.tabId;
    const resources = tabResources.get(tabId);
    const list = resources ? Array.from(resources.values()) : [];
    sendResponse({ resources: list });
    return false;
  }

  if (message.action === "clearResources") {
    tabResources.delete(message.tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "getResourceCount") {
    const tabId = message.tabId;
    const resources = tabResources.get(tabId);
    sendResponse({ count: resources ? resources.size : 0 });
    return false;
  }
});

// ─── Install log ─────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log("Net Assets Scraper V2 installed.");

  // Enable side panel on action click for browsers that support it
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Side panel not supported (e.g., Arc) — popup fallback handles it
    });
  }
});
