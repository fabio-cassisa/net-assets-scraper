// ─── Net Assets Scraper V2 — Service Worker ─────────────────────────
// Passively captures network resources via webRequest API.
// Stores metadata per tab in memory.
// Communicates with popup panel + content script via messaging.
// Orchestrates background download pipeline (survives popup close).

importScripts("lib/jszip.min.js");

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
  "facebook.net", "analytics.google.com",
  "hotjar.com", "clarity.ms", "newrelic.com", "sentry.io",
  "segment.com", "mixpanel.com", "amplitude.com",
  "googleadservices.com", "googlesyndication.com",
  "cdn.mxpnl.com", "bat.bing.com", "px.ads.linkedin.com"
]);

// ─── State ───────────────────────────────────────────────────────────
// In-memory store per tab: tabId → Map<url, resourceMeta>
const tabResources = new Map();

// Scan pipeline state — survives panel close/reopen
const scanCache = new Map();            // tabId → { status, platformData, domData, networkResources, timestamp }
const activeScanKeepalive = new Map();  // tabId → intervalId
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ─────────────────────────────────────────────────────────
function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot === -1 || dot === pathname.length - 1) return "";
    const ext = pathname.substring(dot + 1).toLowerCase();
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
// Try with responseHeaders first; if the browser doesn't support it, fall back
try {
  chrome.webRequest.onCompleted.addListener(
    handleRequest,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
} catch {
  // Fallback: listen without responseHeaders (classify by URL extension only)
  chrome.webRequest.onCompleted.addListener(
    handleRequest,
    { urls: ["<all_urls>"] }
  );
}

function handleRequest(details) {
  if (details.tabId < 0) return;

  const url = details.url;

  // Skip data URIs, browser-internal URLs, and tracking domains
  if (url.startsWith("data:") || url.startsWith("chrome:") || url.startsWith("chrome-extension:") || url.startsWith("moz-extension:") || url.startsWith("arc:")) return;
  if (isSkippedDomain(url)) return;

  // Get content-type from response headers (may be absent if listener fallback)
  const contentTypeHeader = (details.responseHeaders || []).find(
    (h) => h.name.toLowerCase() === "content-type"
  );
  const contentType = contentTypeHeader ? contentTypeHeader.value.split(";")[0].trim() : "";
  const contentLengthHeader = (details.responseHeaders || []).find(
    (h) => h.name.toLowerCase() === "content-length"
  );
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader.value, 10) : -1;

  const type = classifyResource(url, contentType);
  if (!type) return;

  if (!tabResources.has(details.tabId)) {
    tabResources.set(details.tabId, new Map());
  }
  const resources = tabResources.get(details.tabId);

  // Deduplicate
  if (resources.has(url)) return;

  resources.set(url, {
    url,
    type,
    contentType,
    contentLength,
    ext: getExtensionFromUrl(url),
    timestamp: Date.now(),
  });
}

// ─── Tab lifecycle — cleanup on close/navigate ───────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabResources.delete(tabId);
  scanCache.delete(tabId);
  const scanTimer = activeScanKeepalive.get(tabId);
  if (scanTimer) { clearInterval(scanTimer); activeScanKeepalive.delete(tabId); }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    tabResources.delete(tabId);
    scanCache.delete(tabId);
    const scanTimer = activeScanKeepalive.get(tabId);
    if (scanTimer) { clearInterval(scanTimer); activeScanKeepalive.delete(tabId); }
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

  // ─── Background download pipeline ─────────────────────────────────
  // Panel sends asset list → background fetches, zips, downloads.
  // Survives popup close. Panel receives progress if still open.
  if (message.action === "downloadKit") {
    handleDownloadKit(message).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // async
  }

  // ─── Background scan pipeline ──────────────────────────────────────
  // Panel sends scan request → background orchestrates content script
  // messaging, caches results, reports progress. Survives panel close.
  if (message.action === "startScan") {
    handleStartScan(message).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // async
  }

  if (message.action === "getScanCache") {
    const tabId = message.tabId;
    const tabUrl = message.tabUrl || "";
    const cached = scanCache.get(tabId);
    if (!cached || cached.status === "error") {
      sendResponse({ cached: false });
    } else if (cached.url && tabUrl && cached.url !== tabUrl) {
      // URL changed (SPA navigation) — stale cache, invalidate
      scanCache.delete(tabId);
      sendResponse({ cached: false });
    } else if (cached.status === "scanning") {
      sendResponse({ cached: true, status: "scanning" });
    } else if (Date.now() - cached.timestamp > SCAN_CACHE_TTL_MS) {
      // Expired — clean up
      scanCache.delete(tabId);
      sendResponse({ cached: false });
    } else {
      sendResponse({
        cached: true,
        status: "complete",
        platformData: cached.platformData,
        domData: cached.domData,
        networkResources: cached.networkResources,
      });
    }
    return false;
  }
});

// ─── Background Download Pipeline ────────────────────────────────────
// Runs entirely in the service worker. Panel can close at any time —
// the download still completes and the zip appears in the downloads folder.

const BG_MIME_TO_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/tiff": "tif",
  "image/svg+xml": "svg", "image/x-icon": "ico", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogg",
  "font/woff": "woff", "font/woff2": "woff2", "font/ttf": "ttf",
  "font/otf": "otf", "application/vnd.ms-fontobject": "eot",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
};

/**
 * Convert ArrayBuffer to base64 data URL.
 * MV3 service workers don't have URL.createObjectURL — this is the workaround.
 * Processes in 32KB chunks to avoid call stack overflow on large buffers.
 */
function arrayBufferToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return `data:${mimeType};base64,${btoa(chunks.join(""))}`;
}

/** Send progress update to panel (best-effort — panel may be closed). */
function sendProgress(data) {
  try {
    chrome.runtime.sendMessage({ action: "downloadProgress", ...data }).catch(() => {});
  } catch {
    // Panel closed — ignore
  }
}

/** Send scan progress update to panel (best-effort — panel may be closed). */
function sendScanProgress(data) {
  try {
    chrome.runtime.sendMessage({ action: "scanProgress", ...data }).catch(() => {});
  } catch {
    // Panel closed — ignore
  }
}

/**
 * Check if a platform video URL can be fetched directly from the service worker.
 * Only URLs with self-authenticating tokens (no page cookies needed).
 */
function bgIsDirectFetchable(asset) {
  if (!asset.url) return false;
  if (asset.platformTag?.startsWith("vimeo-") && /akamaized\.net|vimeocdn\.com/.test(asset.url)) return true;
  return false;
}

/** Fetch a blob via the content script (MAIN world proxy for platform CDN cookies). */
async function fetchViaContentScript(tabId, url) {
  const result = await chrome.tabs.sendMessage(tabId, { action: "fetchBlob", url });
  if (result?.error) throw new Error(result.error);
  // Convert data URL to ArrayBuffer in service worker
  const res = await fetch(result.dataUrl);
  return { buffer: await res.arrayBuffer(), type: result.type || "", size: result.size || 0 };
}

/** Guess extension from MIME type or asset metadata. */
function bgGuessExt(asset, blobType) {
  if (blobType && BG_MIME_TO_EXT[blobType]) return BG_MIME_TO_EXT[blobType];
  if (asset.ext && asset.ext.length > 0 && asset.ext.length <= 5) return asset.ext;
  if (asset.contentType && BG_MIME_TO_EXT[asset.contentType]) return BG_MIME_TO_EXT[asset.contentType];
  if (asset.type === "image") return "png";
  if (asset.type === "video") return "mp4";
  if (asset.type === "font") return "woff2";
  return "bin";
}

/** Build filename using the same smart naming logic as the panel. */
function bgBuildFilename(asset, ext) {
  const e = ext || bgGuessExt(asset, "");
  if (asset.platformTag) {
    const parts = [];
    if (asset.username) parts.push(`@${asset.username.replace(/^@/, "")}`);
    parts.push(asset.platformTag);
    const w = asset.domWidth || 0;
    const h = asset.domHeight || 0;
    if (w > 0 && h > 0) parts.push(`${w}x${h}`);
    return bgSanitize(parts.join("-") + "." + e);
  }
  let name = asset.displayName || "asset";
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    const currentExt = name.substring(dotIdx + 1).toLowerCase();
    if (currentExt !== e && e) name = name.substring(0, dotIdx) + "." + e;
  } else if (e) {
    name = name + "." + e;
  }
  return bgSanitize(name);
}

function bgSanitize(name) {
  const s = name.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "-").toLowerCase();
  const dotIdx = s.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = s.substring(dotIdx);
    if (ext.length >= 2 && ext.length <= 6) return s.substring(0, dotIdx).slice(0, 60) + ext;
  }
  return s.slice(0, 65);
}

function bgDedup(name, usedSet) {
  if (!usedSet.has(name)) return name;
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.substring(dotIdx) : "";
  let counter = 2;
  while (usedSet.has(`${base}-${counter}${ext}`)) counter++;
  return `${base}-${counter}${ext}`;
}

function bgFormatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Check if an MP4 blob is a playable file (not a DASH/HLS fragment).
 * Reads the first 8 bytes for MP4 box type signature.
 */
function bgIsPlayable(buffer) {
  if (buffer.byteLength < 8) return false;
  try {
    const view = new DataView(buffer);
    const boxType = view.getUint32(4);
    const FTYP = 0x66747970;
    const MOOV = 0x6D6F6F76;
    const MOOF = 0x6D6F6F66;
    const STYP = 0x73747970;
    if (boxType === FTYP || boxType === MOOV) return true;
    if (boxType === MOOF || boxType === STYP) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Main download orchestrator. Runs in background service worker.
 * Survives popup close — sends progress via runtime messaging + notification on complete.
 * @param {Object} msg - { assets, domData, platform, platformMeta, tabId }
 */
async function handleDownloadKit(msg) {
  const { assets, domData, platform, platformMeta, tabId } = msg;
  const total = assets.length;
  if (total === 0) return;

  // ── Service worker keepalive ──
  // Chrome kills idle service workers after ~30s. Active fetches keep it alive,
  // but gaps between asset processing can cause the worker to die.
  // Ping every 25s to stay alive during the download.
  const keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { /* noop ping to stay alive */ });
  }, 25000);

  try {
    const zip = new JSZip();
    const folders = {
      image: zip.folder("images"),
      video: zip.folder("videos"),
      font: zip.folder("fonts"),
      audio: zip.folder("audio"),
    };
    const logosFolder = zip.folder("logos");
    const usedNames = new Map();

    let completed = 0;
    let failed = 0;
    let totalBytes = 0;
    const failures = []; // { url, name, reason }

    sendProgress({ phase: "starting", completed: 0, total, failed: 0, bytes: 0 });

    for (const asset of assets) {
      try {
        let buffer;
        let blobType = "";

        sendProgress({
          phase: "fetching",
          completed,
          total,
          failed,
          bytes: totalBytes,
          detail: `Fetching ${completed + 1} of ${total}…`,
        });

        if (asset.needsMux || asset.isMSECapture) {
          // Instagram transcode pipeline — skip, handled by panel
          console.warn("[BG downloadKit] Skipping transcode asset — should be handled by panel:", asset.url);
          failed++;
          completed++;
          failures.push({ url: asset.url, name: asset.displayName, reason: "Transcode asset routed to panel" });
          continue;
        }

        const needsProxy = asset.url.startsWith("blob:")
          || (asset.type === "video" && asset.platformTag && !bgIsDirectFetchable(asset));

        if (needsProxy) {
          // Fetch via content script → MAIN world (page cookies)
          const result = await fetchViaContentScript(tabId, asset.url);
          buffer = result.buffer;
          blobType = result.type;
        } else {
          // Direct fetch from service worker
          const response = await fetch(asset.url);
          if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
          blobType = response.headers.get("content-type") || "";
          buffer = await response.arrayBuffer();
        }

        // Validate video files
        if (asset.type === "video" && !bgIsPlayable(buffer)) {
          console.warn(`[BG downloadKit] Skipping unplayable video: ${asset.displayName}`);
          completed++;
          sendProgress({ phase: "fetching", completed, total, failed, bytes: totalBytes });
          continue;
        }

        const ext = bgGuessExt(asset, blobType);
        let fileName = bgBuildFilename(asset, ext);

        const folderKey = asset.isLogo ? "logos" : asset.type;
        const targetFolder = asset.isLogo ? logosFolder : (folders[asset.type] || folders.image);

        if (!usedNames.has(folderKey)) usedNames.set(folderKey, new Set());
        const nameSet = usedNames.get(folderKey);
        fileName = bgDedup(fileName, nameSet);
        nameSet.add(fileName);

        targetFolder.file(fileName, buffer, { binary: true, compression: "STORE" });
        totalBytes += buffer.byteLength;
        completed++;

        sendProgress({ phase: "fetching", completed, total, failed, bytes: totalBytes });
      } catch (err) {
        console.error(`[BG downloadKit] Failed: ${asset.url}:`, err);
        failed++;
        completed++;
        failures.push({
          url: asset.url,
          name: asset.displayName || "unknown",
          reason: err.message || "Unknown error",
        });
        sendProgress({ phase: "fetching", completed, total, failed, bytes: totalBytes });
      }
    }

    // If ALL assets failed, send error instead of generating an empty/report-only zip
    if (failed === total) {
      const errDetail = `All ${total} assets failed to download. ` + (failures[0]?.reason || "Check service worker console.");
      sendProgress({ phase: "error", detail: errDetail });
      try {
        chrome.notifications.create(`nas-download-${Date.now()}`, {
          type: "basic",
          iconUrl: "assets/icons/icon128.png",
          title: "NAS — Download Failed",
          message: errDetail,
          priority: 2,
        });
      } catch { /* best effort */ }
      return;
    }

    // Zipping phase
    sendProgress({ phase: "zipping", completed, total, failed, bytes: totalBytes, detail: `Zipping ${completed - failed} files…` });

    // Add brand.json
    if (domData) {
      const brandKit = {
        colors: (domData.colors || []).map((c) => ({ hex: c.hex, name: c.name || null, source: c.source })),
        fonts: domData.fontInfo || { declared: [], used: [] },
        meta: domData.pageMeta || {},
        exportedAt: new Date().toISOString(),
        assetCount: completed - failed,
      };
      zip.file("brand.json", JSON.stringify(brandKit, null, 2));
    }

    // Add download report if there were failures
    if (failures.length > 0) {
      const lines = [
        `Net Assets Scraper — Download Report`,
        `Exported: ${new Date().toISOString()}`,
        `Platform: ${platform || "generic"}`,
        ``,
        `Results: ${completed - failed} succeeded, ${failed} failed out of ${total} total`,
        ``,
        `── Failed Assets ──`,
        ...failures.map((f, i) => `${i + 1}. ${f.name}\n   URL: ${f.url}\n   Reason: ${f.reason}`),
      ];
      zip.file("download-report.txt", lines.join("\n"));
    }

    // Remove empty folders
    for (const [type] of Object.entries(folders)) {
      const folderName = type === "image" ? "images" : type === "video" ? "videos" : type === "font" ? "fonts" : "audio";
      if (zip.folder(folderName).file(/.+/).length === 0) zip.remove(folderName);
    }
    if (zip.folder("logos").file(/.+/).length === 0) zip.remove("logos");

    // Generate zip — STORE (no compression) because all binary assets (images, videos,
    // fonts) are already compressed formats. Deflate on a 30MB MP4 wastes seconds of
    // CPU for ~0% size reduction, and risks the service worker being killed mid-zip.
    const content = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });

    // MV3 service workers don't have URL.createObjectURL — convert to base64 data URL.
    // Brief memory spike (~33% overhead) but it's freed immediately after download starts.
    const dataUrl = arrayBufferToDataUrl(content, "application/zip");

    // Build zip filename
    const dateStr = new Date().toISOString().slice(0, 10);
    const metaUser = platformMeta?.username;
    let zipName;
    if (platform && metaUser) {
      zipName = `@${metaUser.replace(/^@/, "")}-${platform}-assets-${dateStr}.zip`;
    } else if (platform) {
      zipName = `${platform}-assets-${dateStr}.zip`;
    } else {
      zipName = `assets-brand-kit-${dateStr}.zip`;
    }
    zipName = bgSanitize(zipName);

    // Trigger download
    chrome.downloads.download({ url: dataUrl, filename: zipName }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[BG downloadKit] Download failed:", chrome.runtime.lastError);
        sendProgress({ phase: "error", detail: "Download failed: " + chrome.runtime.lastError.message });
      } else {
        console.log(`[BG downloadKit] Download started: ${zipName} (${bgFormatBytes(totalBytes)})`);
      }
    });

    const succeeded = completed - failed;
    const failedNote = failed > 0 ? ` · ${failed} failed` : "";
    const summary = `${succeeded} files · ${bgFormatBytes(totalBytes)}${failedNote}`;

    sendProgress({
      phase: "done",
      completed,
      total,
      failed,
      bytes: totalBytes,
      detail: `Kit downloaded — ${summary}`,
    });

    // Chrome notification — visible even if panel is closed
    try {
      chrome.notifications.create(`nas-download-${Date.now()}`, {
        type: "basic",
        iconUrl: "assets/icons/icon128.png",
        title: "NAS — Download Complete",
        message: failed > 0
          ? `${succeeded}/${total} assets downloaded (${bgFormatBytes(totalBytes)}). ${failed} failed — see download-report.txt`
          : `${succeeded} assets downloaded — ${bgFormatBytes(totalBytes)}`,
        priority: 1,
      });
    } catch (notifErr) {
      console.warn("[BG downloadKit] Notification failed:", notifErr);
    }

  } catch (err) {
    // Top-level catch — something unexpected blew up (zip generation, blob creation, etc.)
    console.error("[BG downloadKit] Fatal error:", err);
    sendProgress({ phase: "error", detail: `Download failed: ${err.message || "Unknown error"}` });
    try {
      chrome.notifications.create(`nas-download-${Date.now()}`, {
        type: "basic",
        iconUrl: "assets/icons/icon128.png",
        title: "NAS — Download Failed",
        message: `${err.message || "Unknown error"}. Check service worker console.`,
        priority: 2,
      });
    } catch { /* best effort */ }
  } finally {
    // Always clean up keepalive — whether success, failure, or crash
    clearInterval(keepaliveTimer);
  }
}

// ─── Background Scan Pipeline ────────────────────────────────────────
// Runs deep scan from service worker. Panel can close at any time —
// results are cached and available when panel reopens.

/**
 * Orchestrate a deep scan entirely from the service worker.
 * Panel sends { tabId, platform, platformScript, tabUrl } → background handles
 * all content script messaging, caches results, reports progress.
 */
async function handleStartScan({ tabId, platform, platformScript, tabUrl }) {
  // Guard: reject if scan already running for this tab
  const existing = scanCache.get(tabId);
  if (existing?.status === "scanning") {
    sendScanProgress({ phase: "error", detail: "Scan already in progress for this tab." });
    return;
  }

  // Init cache entry
  scanCache.set(tabId, { status: "scanning", url: tabUrl || "", platformData: null, domData: null, networkResources: [], timestamp: Date.now() });

  // Keepalive — same 25s pattern as downloads
  const keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 25000);
  activeScanKeepalive.set(tabId, keepaliveTimer);

  try {
    let platformData = null;
    let domData = null;

    // ── Phase 1: Platform-specific deep scan (scrolling + asset extraction) ──
    if (platform && platformScript) {
      sendScanProgress({ phase: "platform-scan", detail: "Scrolling page…" });
      try {
        platformData = await chrome.tabs.sendMessage(tabId, { action: "deepScanPlatform" });
      } catch {
        // Content script not injected yet — inject and retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [platformScript],
          });
          await new Promise((r) => setTimeout(r, 300));
          platformData = await chrome.tabs.sendMessage(tabId, { action: "deepScanPlatform" });
        } catch {
          platformData = null;
        }
      }
      // Fallback: lightweight analyzePlatform (no scrolling)
      if (!platformData || !platformData.platform) {
        try {
          platformData = await chrome.tabs.sendMessage(tabId, { action: "analyzePlatform" });
        } catch {
          platformData = null;
        }
      }
    }

    // ── Phase 2: DOM analysis ──
    sendScanProgress({ phase: "dom-scan", detail: platformData ? "Analyzing assets…" : "Scanning page…" });
    const domAction = platformData ? "analyzeDOM" : "deepScan";
    try {
      domData = await chrome.tabs.sendMessage(tabId, { action: domAction });
    } catch {
      // Fallback: inject content.js and retry
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        await new Promise((r) => setTimeout(r, 300));
        domData = await chrome.tabs.sendMessage(tabId, { action: domAction });
      } catch {
        domData = null;
      }
    }

    // ── Phase 3: Network resources (local — no messaging needed) ──
    const resources = tabResources.get(tabId);
    const networkResources = resources ? Array.from(resources.values()) : [];

    // ── Cache results ──
    scanCache.set(tabId, {
      status: "complete",
      url: tabUrl || "",
      platformData,
      domData,
      networkResources,
      timestamp: Date.now(),
    });

    // ── Report completion to panel (best-effort) ──
    sendScanProgress({
      phase: "complete",
      platformData,
      domData,
      networkResources,
    });

    console.log(`[BG scan] Tab ${tabId} scan complete — platform: ${platform || "generic"}, network: ${networkResources.length} resources`);

  } catch (err) {
    console.error("[BG scan] Fatal error:", err);
    scanCache.set(tabId, { status: "error", error: err.message, timestamp: Date.now() });
    sendScanProgress({ phase: "error", detail: `Scan failed: ${err.message || "Unknown error"}` });
  } finally {
    // Always clean up keepalive
    clearInterval(keepaliveTimer);
    activeScanKeepalive.delete(tabId);
  }
}

// ─── Install log ─────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log("Net Assets Scraper V2 installed.");
});
