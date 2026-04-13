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
  if (details.statusCode < 200 || details.statusCode >= 400) return; // Skip failed requests (404, 5xx, etc.)

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

  // ─── Generate brand kit data on demand (for guideline viewer page) ──
  if (message.action === "generateGuideline") {
    try {
      const kit = buildBrandKit(message.domData, 0);
      sendResponse({ kit });
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return false;
  }

  // ─── Generate brand guideline HTML (for panel legacy download path) ──
  if (message.action === "generateGuideHTML") {
    try {
      const html = generateBrandGuideHTML(message.kit);
      sendResponse({ html });
    } catch (err) {
      console.warn("[BG] generateGuideHTML failed:", err);
      sendResponse({ html: null });
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
  const { assets, domData, platform, platformMeta, tabId, settings: dlSettings } = msg;
  const compressImages = dlSettings?.compressImages || false;
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

        // ── Image compression (if enabled in settings) ──
        if (compressImages && asset.type === "image" && buffer.byteLength > 50 * 1024) {
          const compressibleTypes = ["image/jpeg", "image/png", "image/webp"];
          const mime = blobType.split(";")[0].trim().toLowerCase();
          if (compressibleTypes.includes(mime) || ["jpg", "jpeg", "png", "webp"].includes(ext)) {
            try {
              buffer = await compressImageBuffer(buffer, mime || `image/${ext === "jpg" ? "jpeg" : ext}`);
            } catch (e) {
              console.warn("[BG downloadKit] Compression failed, using original:", e.message);
            }
          }
        }

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

    // ── Proactive font file resolution ──
    // Fetch font files from Google Fonts CSS URLs and @font-face src URLs
    // that may not have been captured by webRequest (cached before extension load).
    if (domData?.fontInfo) {
      sendProgress({ phase: "zipping", completed, total, failed, bytes: totalBytes, detail: "Resolving font files…" });
      // Collect URLs already in the zip fonts/ folder to deduplicate
      const existingFontUrls = assets.filter((a) => a.type === "font").map((a) => a.url);
      try {
        const resolvedFonts = await resolveFontFiles(domData.fontInfo, existingFontUrls);
        for (const font of resolvedFonts) {
          const name = fontFileName(font);
          if (!usedNames.has("font")) usedNames.set("font", new Set());
          const fontNameSet = usedNames.get("font");
          if (!fontNameSet.has(name)) {
            folders.font.file(name, font.buffer);
            fontNameSet.add(name);
            totalBytes += font.buffer.byteLength;
          }
        }
        if (resolvedFonts.length > 0) {
          sendProgress({ phase: "zipping", completed, total, failed, bytes: totalBytes, detail: `Resolved ${resolvedFonts.length} font file${resolvedFonts.length > 1 ? "s" : ""}` });
        }
      } catch (fontErr) {
        console.warn("[BG downloadKit] Font resolution failed:", fontErr);
      }
    }

    // Add brand.json + brand-guide.html
    if (domData) {
      const brandKit = buildBrandKit(domData, completed - failed);
      zip.file("brand.json", JSON.stringify(brandKit, null, 2));
      zip.file("brand-guideline.html", generateBrandGuideHTML(brandKit));
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
async function handleStartScan({ tabId, platform, platformScript, tabUrl, quickScan }) {
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
    if (platform && platformScript && !quickScan) {
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
    sendScanProgress({ phase: "dom-scan", detail: quickScan ? "Quick scan…" : (platformData ? "Analyzing assets…" : "Scanning page…") });
    const domAction = (platformData || quickScan) ? "analyzeDOM" : "deepScan";
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

// ─── Image Compression (Service Worker) ──────────────────────────────
// Uses createImageBitmap + OffscreenCanvas — available in MV3 service workers

const COMPRESS_MAX_PX = 2000;   // Max dimension on longest side
const COMPRESS_QUALITY = 0.80;  // JPEG quality 0-1

async function compressImageBuffer(buffer, mimeType) {
  const blob = new Blob([buffer], { type: mimeType });
  const bitmap = await createImageBitmap(blob);

  let { width, height } = bitmap;

  // Only resize if larger than threshold
  if (width > COMPRESS_MAX_PX || height > COMPRESS_MAX_PX) {
    const scale = COMPRESS_MAX_PX / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Re-encode: PNG stays PNG (transparency), everything else → JPEG
  const isPng = mimeType.includes("png");
  const outputType = isPng ? "image/png" : "image/jpeg";
  const quality = isPng ? undefined : COMPRESS_QUALITY;

  const outBlob = await canvas.convertToBlob({ type: outputType, quality });
  return await outBlob.arrayBuffer();
}

// ─── Font File Resolver ──────────────────────────────────────────────
// Proactively fetches font files from URLs discovered by content.js.
// Handles Google Fonts CSS → woff2 URL resolution, and direct @font-face URLs.
// Returns array of { name, weight, style, format, buffer, url }

const GFONTS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function resolveFontFiles(fontInfo, existingFontUrls) {
  const declared = fontInfo?.declared || [];
  if (declared.length === 0) return [];

  const resolved = [];
  const fetchedUrls = new Set(existingFontUrls || []);

  // ── 1. Google Fonts — fetch the CSS, parse @font-face rules, get woff2 URLs ──
  const googleCssUrls = new Set();
  for (const font of declared) {
    if (font.source === "google-fonts" && font.cssUrl) {
      googleCssUrls.add(font.cssUrl);
    }
  }

  for (const cssUrl of googleCssUrls) {
    try {
      // Must send a modern User-Agent or Google returns woff/ttf instead of woff2
      const resp = await fetch(cssUrl, { headers: { "User-Agent": GFONTS_UA } });
      if (!resp.ok) continue;
      const cssText = await resp.text();

      // Parse @font-face blocks from the CSS text
      const faceRegex = /@font-face\s*\{([^}]+)\}/g;
      let match;
      while ((match = faceRegex.exec(cssText)) !== null) {
        const block = match[1];
        const familyMatch = block.match(/font-family:\s*['"]?([^;'"]+)['"]?\s*;/);
        const urlMatch = block.match(/url\(([^)]+)\)/);
        const weightMatch = block.match(/font-weight:\s*(\d+)/);
        const styleMatch = block.match(/font-style:\s*(\w+)/);

        if (!familyMatch || !urlMatch) continue;
        const family = familyMatch[1].trim();
        const url = urlMatch[1].replace(/['"]/g, "").trim();
        const weight = weightMatch ? weightMatch[1] : "400";
        const style = styleMatch ? styleMatch[1] : "normal";

        if (fetchedUrls.has(url)) continue;
        fetchedUrls.add(url);

        try {
          const fontResp = await fetch(url);
          if (!fontResp.ok) continue;
          const buffer = await fontResp.arrayBuffer();
          const format = url.includes(".woff2") ? "woff2" : url.includes(".woff") ? "woff" : url.includes(".ttf") ? "ttf" : "woff2";
          resolved.push({ name: family, weight, style, format, buffer, url });
        } catch { /* skip individual font fetch failures */ }
      }
    } catch { /* skip CSS fetch failure */ }
  }

  // ── 2. Direct @font-face URLs (non-Google) ──
  for (const font of declared) {
    if (font.source !== "font-face" || !font.url) continue;
    if (fetchedUrls.has(font.url)) continue;
    fetchedUrls.add(font.url);

    try {
      const resp = await fetch(font.url);
      if (!resp.ok) continue;
      const buffer = await resp.arrayBuffer();
      const ext = font.url.split("?")[0].split(".").pop().toLowerCase();
      const format = ["woff2", "woff", "ttf", "otf"].includes(ext) ? ext : "woff2";
      resolved.push({
        name: font.name,
        weight: font.weight || "400",
        style: font.style || "normal",
        format,
        buffer,
        url: font.url,
      });
    } catch { /* skip */ }
  }

  return resolved;
}

/** Build a clean filename for a resolved font: Inter-400.woff2, Roboto-700-italic.woff2 */
function fontFileName(font) {
  const safeName = font.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const italic = font.style === "italic" ? "-italic" : "";
  return `${safeName}-${font.weight}${italic}.${font.format}`;
}

// ─── Brand Kit Builder ───────────────────────────────────────────────

function buildBrandKit(domData, assetCount) {
  const meta = domData.pageMeta || {};
  const colorSemantics = domData.colorSemantics || {};

  return {
    brand: {
      name: meta.siteName || meta.title || meta.hostname || "",
      url: meta.url || "",
      description: meta.description || "",
      ogImage: meta.ogImage || "",
      favicons: domData.favicons || [{ url: meta.favicon, sizes: null, type: "icon" }],
      socialLinks: domData.socialLinks || {},
    },
    colors: {
      primary: colorSemantics.primary || null,
      secondary: colorSemantics.secondary || null,
      background: colorSemantics.background || "#ffffff",
      text: colorSemantics.text || "#000000",
      all: (domData.colors || []).map((c) => ({ hex: c.hex, name: c.name || null, source: c.source })),
    },
    typography: {
      scale: domData.typographyScale || [],
      fonts: domData.fontInfo || { declared: [], used: [] },
    },
    copy: domData.copy || { headlines: [], tagline: null, description: null },
    ctas: domData.ctas || [],
    structuredData: domData.structuredData || null,
    exportedAt: new Date().toISOString(),
    assetCount,
  };
}

// ─── Brand Guide HTML Generator ──────────────────────────────────────

function generateBrandGuideHTML(kit, { embedScript = true } = {}) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const brandName = esc(kit.brand.name) || "Brand Kit";
  const brandUrl = esc(kit.brand.url);
  const exportDate = new Date(kit.exportedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  // ── Auto-detect theme: dark brands → light page, light brands → dark page ──
  function hexLuminance(hex) {
    const c = (hex || "#000000").replace("#", "");
    const r = parseInt(c.substr(0, 2), 16) / 255;
    const g = parseInt(c.substr(2, 2), 16) / 255;
    const b = parseInt(c.substr(4, 2), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const allHexes = (kit.colors.all || []).map((c) => c.hex).filter(Boolean);
  const avgLum = allHexes.length > 0 ? allHexes.reduce((sum, h) => sum + hexLuminance(h), 0) / allHexes.length : 0.5;
  const defaultTheme = avgLum < 0.4 ? "light" : "dark"; // dark brand colors → light page for contrast

  // ── Ensure typography sample contrast ──
  function contrastSafe(textColor, theme) {
    if (!textColor) return "var(--text)";
    const lum = hexLuminance(textColor);
    if (theme === "dark" && lum < 0.25) return "var(--text)"; // dark text on dark bg → use theme text
    if (theme === "light" && lum > 0.75) return "var(--text)"; // light text on light bg → use theme text
    return textColor;
  }

  // ── Color swatches ──
  const semanticColors = [
    { label: "Primary", hex: kit.colors.primary },
    { label: "Secondary", hex: kit.colors.secondary },
    { label: "Background", hex: kit.colors.background },
    { label: "Text", hex: kit.colors.text },
  ].filter((c) => c.hex);

  const allColorSwatches = (kit.colors.all || []).map((c) => {
    const name = c.name ? esc(c.name) : "";
    return `<div class="swatch" title="Select and copy">
        <div class="swatch-color" style="background:${esc(c.hex)}"></div>
        <input class="swatch-hex copyable" type="text" value="${esc(c.hex)}" readonly tabindex="0">
        ${name ? `<span class="swatch-name">${name}</span>` : ""}
      </div>`;
  }).join("\n");

  const semanticSwatches = semanticColors.map((c) => `
      <div class="swatch semantic" title="Select and copy">
        <div class="swatch-color" style="background:${esc(c.hex)}"></div>
        <span class="swatch-label">${c.label}</span>
        <input class="swatch-hex copyable" type="text" value="${esc(c.hex)}" readonly tabindex="0">
      </div>`).join("\n");

  // ── Typography scale ──
  const typoRows = (kit.typography.scale || []).map((t) => {
    const sample = t.element.startsWith("h") ? "The quick brown fox" : t.element === "button" ? "Click here" : "The quick brown fox jumps over the lazy dog";
    // Use CSS custom properties for sample color with fallback — both themes get safe contrast
    const safeDark = contrastSafe(t.color, "dark");
    const safeLight = contrastSafe(t.color, "light");
    // We use the theme-appropriate safe color via a class-based approach
    const sampleColor = t.color || "var(--text)";
    return `<div class="type-row">
        <div class="type-meta">
          <strong>${esc(t.element)}</strong>
          <span>${esc(t.fontFamily)} · ${esc(t.fontWeight)} · ${esc(t.fontSize)} / ${esc(t.lineHeight)}</span>
          ${t.letterSpacing && t.letterSpacing !== "0" ? `<span>tracking: ${esc(t.letterSpacing)}</span>` : ""}
          ${t.textTransform ? `<span>transform: ${esc(t.textTransform)}</span>` : ""}
        </div>
        <div class="type-sample" style="font-size:${esc(t.fontSize)};font-weight:${esc(t.fontWeight)};line-height:${esc(t.lineHeight)};letter-spacing:${t.letterSpacing || "normal"};${t.textTransform ? "text-transform:" + esc(t.textTransform) + ";" : ""}" data-original-color="${esc(t.color || "")}">${sample}</div>
      </div>`;
  }).join("\n");

  // ── Fonts list ──
  const fontDeclared = (kit.typography.fonts?.declared || []).map((f) =>
    `<li><strong>${esc(f.name)}</strong> <span class="tag">${esc(f.source)}</span> <input class="copyable inline" type="text" value="${esc(f.name)}" readonly tabindex="0"></li>`
  ).join("\n");
  const fontUsed = (kit.typography.fonts?.used || []).map((f) =>
    `<li>${esc(f)} <input class="copyable inline" type="text" value="${esc(f)}" readonly tabindex="0"></li>`
  ).join("\n");

  // ── Copy bank ──
  const headlines = (kit.copy.headlines || []).map((h) =>
    `<div class="copy-item">
        <input class="copyable copy-field" type="text" value="${esc(h)}" readonly tabindex="0">
      </div>`
  ).join("\n");

  const tagline = kit.copy.tagline ? `<div class="copy-item">
      <span class="copy-label">Tagline</span>
      <input class="copyable copy-field" type="text" value="${esc(kit.copy.tagline)}" readonly tabindex="0">
    </div>` : "";

  const description = kit.copy.description ? `<div class="copy-item">
      <span class="copy-label">Description</span>
      <input class="copyable copy-field" type="text" value="${esc(kit.copy.description)}" readonly tabindex="0">
    </div>` : "";

  // ── CTA buttons ──
  const ctaCards = (kit.ctas || []).map((cta) => {
    const cssSpec = `background: ${cta.backgroundColor}; color: ${cta.color}; font-family: ${cta.fontFamily}, sans-serif; font-weight: ${cta.fontWeight}; font-size: ${cta.fontSize}; border-radius: ${cta.borderRadius}; padding: ${cta.padding};`;
    return `<div class="cta-card">
        <div class="cta-preview" style="background:${esc(cta.backgroundColor)};color:${esc(cta.color)};font-family:${esc(cta.fontFamily)},sans-serif;font-weight:${esc(cta.fontWeight)};font-size:${esc(cta.fontSize)};border-radius:${esc(cta.borderRadius)};padding:${esc(cta.padding)};display:inline-block">${esc(cta.text)}</div>
        <div class="cta-specs">
          <span>bg: <strong>${esc(cta.backgroundColor)}</strong></span>
          <span>color: <strong>${esc(cta.color)}</strong></span>
          <span>font: ${esc(cta.fontFamily)} ${esc(cta.fontWeight)} ${esc(cta.fontSize)}</span>
          <span>radius: ${esc(cta.borderRadius)}</span>
          <span>padding: ${esc(cta.padding)}</span>
        </div>
        <input class="copyable cta-css" type="text" value="${esc(cssSpec)}" readonly tabindex="0" title="Full CSS — click to select">
      </div>`;
  }).join("\n");

  // ── Social links ──
  const socialEntries = Object.entries(kit.brand.socialLinks || {}).filter(([, url]) => url);
  const socialLinks = socialEntries.map(([platform, url]) =>
    `<a href="${esc(url)}" class="social-link" target="_blank" rel="noopener">${esc(platform)}</a>`
  ).join("\n");

  // ── Structured data ──
  let structuredBlock = "";
  if (kit.structuredData && kit.structuredData.length > 0) {
    const items = kit.structuredData.map((d) => {
      const lines = [`<strong>${esc(d.type)}</strong>`];
      if (d.name) lines.push(`Name: ${esc(d.name)}`);
      if (d.url) lines.push(`URL: <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>`);
      if (d.description) lines.push(`Desc: ${esc(d.description)}`);
      if (d.sameAs) lines.push(`Links: ${d.sameAs.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join(", ")}`);
      return `<div class="structured-item">${lines.join("<br>")}</div>`;
    }).join("\n");
    structuredBlock = `<section><h2>Structured Data (JSON-LD)</h2>${items}</section>`;
  }

  // ── Asset summary ──
  const assetSummary = kit.assetCount > 0
    ? `${kit.assetCount} asset${kit.assetCount !== 1 ? "s" : ""} in this kit`
    : "brand data only — no media assets";

  // ── Quick summary (plain text for sales) ──
  const summaryLines = [];
  summaryLines.push(`${kit.brand.name || "Brand"} — ${(kit.brand.url || "").replace(/^https?:\/\//, "")}`);
  if (kit.brand.description) { summaryLines.push(""); summaryLines.push(kit.brand.description); }
  const colorParts = [];
  if (kit.colors.primary) colorParts.push(`Primary: ${kit.colors.primary}`);
  if (kit.colors.secondary) colorParts.push(`Secondary: ${kit.colors.secondary}`);
  if (kit.colors.background) colorParts.push(`Background: ${kit.colors.background}`);
  if (kit.colors.text) colorParts.push(`Text: ${kit.colors.text}`);
  if (colorParts.length > 0) summaryLines.push("Colors: " + colorParts.join("  ·  "));
  const declFonts = kit.typography.fonts?.declared || [];
  if (declFonts.length > 0) summaryLines.push("Fonts: " + declFonts.map((f) => f.name).join(", "));
  const firstCta = (kit.ctas || [])[0];
  if (firstCta) summaryLines.push(`CTA style: ${firstCta.borderRadius !== "0px" ? "rounded" : "sharp"}, ${Number(firstCta.fontWeight) >= 600 ? "bold" : "regular"}, ${firstCta.backgroundColor} on ${firstCta.color}`);
  const quickSummaryText = summaryLines.join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${brandName} — Brand Guideline</title>
<style>
  /* ── Pure CSS theme toggle (works without JS — CSP-safe) ──
     Checkbox at top of <body> drives all theme styles via :checked ~ selectors.
     JS enhances with localStorage persistence when available (file:// context). */
  .theme-checkbox { display: none; }

  /* ── Dark theme (default when unchecked) ── */
  body {
    --bg: #0f0e17; --bg2: #1a1929; --bg3: #252438; --card: #1e1d30;
    --text: #fffffe; --text2: #a7a9be; --muted: #6b6d82;
    --accent: #ff6e9c; --accent2: #c77dff; --border: #2e2d44;
    --swatch-border: #3a3955; --sample-text: var(--text);
  }
  /* ── Light theme (when checked) ── */
  .theme-checkbox:checked ~ .page {
    --bg: #f8f8fb; --bg2: #f0eff5; --bg3: #e8e7f0; --card: #ffffff;
    --text: #1a1a2e; --text2: #4a4a68; --muted: #8888a4;
    --accent: #e0457b; --accent2: #9b59b6; --border: #d8d8e6;
    --swatch-border: #ccccd8; --sample-text: var(--text);
  }

  :root { --radius: 10px; --font: Inter, -apple-system, system-ui, sans-serif; --mono: "SF Mono", "Fira Code", monospace; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
  .page { background: var(--bg); color: var(--text); min-height: 100vh; transition: background 0.25s, color 0.25s; }
  .container { max-width: 800px; margin: 0 auto; padding: 40px 24px 60px; }

  /* Header */
  .brand-header { margin-bottom: 40px; padding-bottom: 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .brand-header-left { flex: 1; min-width: 0; }
  .brand-header-left h1 { font-size: 28px; font-weight: 700; margin-bottom: 4px; line-height: 1.25; }
  .brand-header-left h1 em { color: var(--accent); font-style: normal; }
  .brand-header .meta { font-size: 13px; color: var(--muted); font-family: var(--mono); display: flex; gap: 12px; flex-wrap: wrap; }
  .brand-header .meta a { color: var(--accent); text-decoration: none; }

  /* Theme toggle label (pure CSS) */
  .theme-label { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; background: var(--card); border: 1px solid var(--border); border-radius: 20px; cursor: pointer; font-size: 16px; line-height: 1; transition: all 0.2s; flex-shrink: 0; user-select: none; }
  .theme-label:hover { border-color: var(--accent); }
  .theme-label .icon-sun { display: none; }
  .theme-label .icon-moon { display: inline; }
  .theme-checkbox:checked ~ .page .theme-label .icon-sun { display: inline; }
  .theme-checkbox:checked ~ .page .theme-label .icon-moon { display: none; }

  /* Sections */
  section { margin-bottom: 36px; }
  h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }

  /* Color swatches */
  .color-grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .swatch { text-align: center; transition: transform 0.15s; width: 72px; }
  .swatch:hover { transform: translateY(-2px); }
  .swatch-color { width: 72px; height: 72px; border-radius: var(--radius); border: 2px solid var(--swatch-border); margin-bottom: 6px; }
  .swatch.semantic { width: 100px; }
  .swatch.semantic .swatch-color { width: 100px; height: 60px; border-radius: 8px; }
  .swatch-hex { display: block; font-size: 11px; font-family: var(--mono); color: var(--text2); word-break: break-all; }
  .swatch-name { display: block; font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatch-label { display: block; font-size: 11px; font-weight: 600; color: var(--text); margin-bottom: 2px; }
  .color-semantic { margin-bottom: 20px; }

  /* Typography */
  .type-row { background: var(--card); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 10px; border: 1px solid var(--border); transition: background 0.25s, border-color 0.25s; }
  .type-meta { font-size: 11px; color: var(--muted); font-family: var(--mono); margin-bottom: 8px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .type-meta strong { color: var(--accent); text-transform: uppercase; }
  .type-sample { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }

  /* Fonts list */
  .font-list { list-style: none; }
  .font-list li { padding: 8px 12px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; font-size: 13px; display: flex; align-items: center; gap: 10px; transition: background 0.25s; }
  .tag { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--accent2); background: rgba(199, 125, 255, 0.12); padding: 2px 6px; border-radius: 4px; }

  /* Copy bank */
  .copy-item { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 8px; transition: border-color 0.15s, background 0.25s; }
  .copy-item:hover { border-color: var(--accent); }
  .copy-label { display: block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 4px; }

  /* CTA cards */
  .cta-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 12px; transition: background 0.25s; }
  .cta-preview { margin-bottom: 12px; cursor: default; }
  .cta-specs { font-size: 11px; font-family: var(--mono); color: var(--muted); display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; }
  .cta-specs strong { color: var(--text2); }

  /* Copyable input fields (CSP-safe: user selects with click, copies with Cmd/Ctrl+C) */
  .copyable { background: transparent; border: none; color: var(--text2); font-family: var(--mono); font-size: 11px; outline: none; cursor: text; width: auto; padding: 0; }
  .copyable:focus { color: var(--accent); }
  .copyable.copy-field { width: 100%; font-size: 14px; color: var(--text); font-family: var(--font); padding: 0; }
  .copyable.copy-field:focus { color: var(--accent); }
  .copyable.inline { max-width: 120px; }
  .copyable.cta-css { width: 100%; font-size: 10px; color: var(--muted); padding: 6px 0; border-top: 1px solid var(--border); margin-top: 4px; }
  .copyable.cta-css:focus { color: var(--accent); }

  /* Social */
  .social-links { display: flex; flex-wrap: wrap; gap: 8px; }
  .social-link { display: inline-block; padding: 6px 14px; background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; color: var(--text2); text-decoration: none; font-size: 12px; font-weight: 500; text-transform: capitalize; transition: all 0.15s; }
  .social-link:hover { border-color: var(--accent); color: var(--accent); background: rgba(255, 110, 156, 0.08); }

  /* Structured data */
  .structured-item { font-size: 12px; color: var(--text2); background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; line-height: 1.7; transition: background 0.25s; }
  .structured-item a { color: var(--accent); text-decoration: none; }
  .structured-item a:hover { text-decoration: underline; }

  /* Toast (JS-enhanced only — hidden when JS blocked) */
  .toast-notify { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--card); color: var(--text); border: 1px solid var(--accent); padding: 8px 20px; border-radius: var(--radius); font-size: 12px; font-weight: 500; opacity: 0; transition: all 0.25s ease; pointer-events: none; z-index: 100; }
  .toast-notify.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* Footer */
  .guide-footer { text-align: center; padding-top: 24px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  .guide-footer a { color: var(--accent); text-decoration: none; }

  /* Copy hint badge */
  .copy-hint-banner { font-size: 10px; color: var(--muted); text-align: center; margin-bottom: 24px; font-family: var(--mono); letter-spacing: 0.3px; }

  /* Quick Summary */
  .quick-summary { background: var(--card); border: 1px solid var(--accent); border-radius: var(--radius); padding: 16px 20px; margin-bottom: 32px; }
  .quick-summary-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .quick-summary-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: var(--accent); }
  .quick-summary-text { font-size: 13px; line-height: 1.7; color: var(--text2); font-family: var(--mono); white-space: pre-wrap; word-break: break-word; margin: 0; }
  .btn-summary-copy { background: var(--accent); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
  .btn-summary-copy:hover { opacity: 0.85; }

  /* Export section */
  .export-section { margin-top: 8px; }
  .export-buttons { display: flex; flex-wrap: wrap; gap: 10px; }
  .btn-export { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 10px 18px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: Inter, -apple-system, system-ui, sans-serif; }
  .btn-export:hover { border-color: var(--accent); color: var(--accent); }
  .btn-export-secondary { background: transparent; border-style: dashed; }

  /* Responsive */
  @media (max-width: 500px) {
    .container { padding: 20px 16px 40px; }
    .swatch { width: 56px; }
    .swatch-color { width: 56px; height: 56px; }
    .swatch.semantic { width: 72px; }
    .swatch.semantic .swatch-color { width: 72px; height: 48px; }
    .type-sample { font-size: 14px !important; }
    .export-buttons { flex-direction: column; }
  }

  /* Print / PDF */
  @media print {
    body { background: #fff !important; color: #1a1a2e !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { background: #fff !important; color: #1a1a2e !important; }
    .container { max-width: 100%; padding: 0; }
    .theme-label, .copy-hint-banner, .export-section, .btn-summary-copy, .copy-btn, .copy-hint, .toast-notify { display: none !important; }
    .brand-header { page-break-after: avoid; }
    section { page-break-inside: avoid; }
    .swatch-color { border-color: #ccc !important; }
    .quick-summary { border-color: #ccc; }
    a { color: inherit !important; text-decoration: underline; }
    h2 { color: #666 !important; border-color: #ddd !important; }
    .type-row, .cta-card, .font-list li, .copy-item, .structured-item { background: #f8f8f8 !important; border-color: #ddd !important; }
    .social-link { background: #f0f0f0 !important; border-color: #ddd !important; color: #333 !important; }
  }
</style>
</head>
<body>
<!-- Theme toggle: pure CSS checkbox drives :checked ~ .page selectors -->
<input type="checkbox" class="theme-checkbox" id="themeToggle" ${defaultTheme === "light" ? "checked" : ""}>
<div class="page">
<div class="container">

  <header class="brand-header">
    <div class="brand-header-left">
      <h1>${brandName}<em>.</em></h1>
      <div class="meta">
        ${brandUrl ? `<a href="${brandUrl}" target="_blank" rel="noopener">${esc(kit.brand.url.replace(/^https?:\/\//, ""))}</a>` : ""}
        <span>${exportDate}</span>
        <span>${assetSummary}</span>
      </div>
    </div>
    <label class="theme-label" for="themeToggle" title="Switch light/dark theme"><span class="icon-moon">🌙</span><span class="icon-sun">☀️</span></label>
  </header>

  <div class="copy-hint-banner">click any value to select · ${"{Cmd}"}+C to copy</div>

  <div class="quick-summary">
    <div class="quick-summary-header">
      <span class="quick-summary-label">📋 QUICK SUMMARY</span>
      <button class="btn-summary-copy" id="copySummary">Copy to clipboard</button>
    </div>
    <pre class="quick-summary-text">${esc(quickSummaryText)}</pre>
  </div>

  ${semanticColors.length > 0 ? `<section>
    <h2>Colors</h2>
    <div class="color-grid color-semantic">${semanticSwatches}</div>
    ${kit.colors.all.length > 0 ? `<div class="color-grid" style="margin-top:16px">${allColorSwatches}</div>` : ""}
  </section>` : ""}

  ${(kit.typography.scale || []).length > 0 ? `<section>
    <h2>Typography</h2>
    ${typoRows}
  </section>` : ""}

  ${fontDeclared || fontUsed ? `<section>
    <h2>Fonts</h2>
    ${fontDeclared ? `<ul class="font-list">${fontDeclared}</ul>` : ""}
    ${fontUsed ? `<p style="font-size:11px;color:var(--muted);margin-top:12px;margin-bottom:6px">Also detected in computed styles:</p><ul class="font-list">${fontUsed}</ul>` : ""}
  </section>` : ""}

  ${headlines || tagline || description ? `<section>
    <h2>Copy</h2>
    ${headlines}
    ${tagline}
    ${description}
  </section>` : ""}

  ${ctaCards ? `<section>
    <h2>Call-to-Action Buttons</h2>
    ${ctaCards}
  </section>` : ""}

  ${socialLinks ? `<section>
    <h2>Social</h2>
    <div class="social-links">${socialLinks}</div>
  </section>` : ""}

  ${structuredBlock}

  <section class="export-section">
    <h2>Export</h2>
    <div class="export-buttons">
      <button class="btn-export" id="exportCSS" title="CSS custom properties for web projects">⬇ CSS Tokens</button>
      <button class="btn-export" id="exportDesignTokens" title="W3C Design Tokens JSON for Figma / Style Dictionary">⬇ Design Tokens</button>
      <button class="btn-export" id="exportJSON" title="Full brand kit data — colors, fonts, typography, CTAs, copy, social">⬇ Brand JSON</button>
      <button class="btn-export" id="exportBrief" title="Markdown brand brief for AI agents">⬇ Brand Brief</button>
      <button class="btn-export" id="exportASE" title="Adobe Swatch Exchange — import colors into Photoshop, Illustrator, InDesign">⬇ Adobe Swatches</button>
      <button class="btn-export btn-export-secondary" id="printPDF" title="Print or save as PDF">🖨 Print / PDF</button>
    </div>
  </section>

  <footer class="guide-footer">
    <p>Extracted by <strong>Net Assets Scraper</strong> v2.7 · ${exportDate}</p>
  </footer>

</div>
</div>

<div class="toast-notify" id="toast"></div>

${embedScript ? `<!-- JS interactivity — works in file:// (no CSP). For blob: preview, injected via chrome.scripting instead. -->
<script>
(function() {
  var kit = ${JSON.stringify(kit).replace(/<\//g, "<\\/")};
  var toast = document.getElementById('toast');
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(function() { toast.classList.remove('show'); }, 1800);
  }
  function downloadFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 100);
    showToast('Downloaded: ' + filename);
  }
  // Select-all + clipboard copy on copyable inputs
  document.querySelectorAll('.copyable').forEach(function(el) {
    el.addEventListener('click', function() { this.select(); });
    el.addEventListener('focus', function() { this.select(); });
    el.addEventListener('copy', function() {
      showToast('Copied: ' + this.value.substring(0, 40));
    });
  });
  // Quick summary copy
  var summaryBtn = document.getElementById('copySummary');
  if (summaryBtn) {
    summaryBtn.addEventListener('click', function() {
      var text = document.querySelector('.quick-summary-text').textContent;
      navigator.clipboard.writeText(text).then(function() { showToast('Summary copied!'); }, function() { showToast('Select and Cmd+C to copy'); });
    });
  }
  // Theme persistence via localStorage
  var cb = document.getElementById('themeToggle');
  var stored = localStorage.getItem('nas-guide-theme');
  if (stored === 'dark') cb.checked = false;
  else if (stored === 'light') cb.checked = true;
  cb.addEventListener('change', function() {
    localStorage.setItem('nas-guide-theme', cb.checked ? 'light' : 'dark');
  });
  // ── Token generators ──
  function generateBrandTokensCSS(k) {
    var l = ['/* Brand Tokens */', '/* ' + (k.brand.name||'Brand') + ' · ' + (k.brand.url||'') + ' */', '', ':root {'];
    l.push('  /* Colors */');
    if(k.colors.primary) l.push('  --brand-primary: '+k.colors.primary+';');
    if(k.colors.secondary) l.push('  --brand-secondary: '+k.colors.secondary+';');
    if(k.colors.background) l.push('  --brand-bg: '+k.colors.background+';');
    if(k.colors.text) l.push('  --brand-text: '+k.colors.text+';');
    (k.colors.all||[]).forEach(function(c,i){ l.push('  --brand-color-'+(i+1)+': '+c.hex+';'+(c.name?' /* '+c.name+' */':'')); });
    var sc=k.typography.scale||[], dc=k.typography.fonts&&k.typography.fonts.declared||[];
    if(dc.length||sc.length){l.push('');l.push('  /* Typography */');}
    var hf=dc[0]||sc.find(function(t){return t.element&&t.element.startsWith('h')});
    var bf=sc.find(function(t){return t.element==='p'||t.element==='body'});
    if(hf)l.push('  --font-heading: "'+( hf.name||hf.fontFamily)+'", sans-serif;');
    if(bf)l.push('  --font-body: "'+bf.fontFamily+'", sans-serif;');
    sc.forEach(function(t){var tag=t.element.replace(/[^a-z0-9]/g,'');l.push('  --font-size-'+tag+': '+t.fontSize+';');l.push('  --line-height-'+tag+': '+t.lineHeight+';');l.push('  --font-weight-'+tag+': '+t.fontWeight+';');});
    var ctas=k.ctas||[];if(ctas.length){var c=ctas[0];l.push('');l.push('  /* CTA */');l.push('  --cta-bg: '+c.backgroundColor+';');l.push('  --cta-color: '+c.color+';');l.push('  --cta-font: "'+c.fontFamily+'", sans-serif;');l.push('  --cta-weight: '+c.fontWeight+';');l.push('  --cta-size: '+c.fontSize+';');l.push('  --cta-radius: '+c.borderRadius+';');l.push('  --cta-padding: '+c.padding+';');}
    l.push('}'); return l.join('\\n');
  }
  function generateDesignTokensJSON(k) {
    var t={color:{}};
    if(k.colors.primary)t.color.primary={$value:k.colors.primary,$type:'color'};
    if(k.colors.secondary)t.color.secondary={$value:k.colors.secondary,$type:'color'};
    if(k.colors.background)t.color.background={$value:k.colors.background,$type:'color'};
    if(k.colors.text)t.color.text={$value:k.colors.text,$type:'color'};
    (k.colors.all||[]).forEach(function(c,i){var key=c.name?c.name.toLowerCase().replace(/[^a-z0-9]+/g,'-'):'palette-'+(i+1);t.color[key]={$value:c.hex,$type:'color'};});
    var dc=k.typography.fonts&&k.typography.fonts.declared||[];
    if(dc.length){t.fontFamily={};t.fontFamily.heading={$value:dc[0].name,$type:'fontFamily'};t.fontFamily.body={$value:(dc[1]||dc[0]).name,$type:'fontFamily'};}
    var sc=k.typography.scale||[];
    if(sc.length){t.fontSize={};t.lineHeight={};t.fontWeight={};sc.forEach(function(s){var key=s.element.replace(/[^a-z0-9]/g,'');t.fontSize[key]={$value:s.fontSize,$type:'dimension'};t.lineHeight[key]={$value:s.lineHeight,$type:'dimension'};t.fontWeight[key]={$value:s.fontWeight,$type:'fontWeight'};});}
    var ctas=k.ctas||[];if(ctas.length){var c=ctas[0];t.cta={background:{$value:c.backgroundColor,$type:'color'},color:{$value:c.color,$type:'color'},borderRadius:{$value:c.borderRadius,$type:'dimension'},padding:{$value:c.padding,$type:'dimension'},fontFamily:{$value:c.fontFamily,$type:'fontFamily'},fontWeight:{$value:c.fontWeight,$type:'fontWeight'},fontSize:{$value:c.fontSize,$type:'dimension'}};}
    return JSON.stringify(t,null,2);
  }
  function generateBrandBriefMD(k) {
    var l=['# Brand Brief: '+(k.brand.name||'Unknown'),'','> Auto-extracted by Net Assets Scraper · '+new Date(k.exportedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}),'','## Identity'];
    if(k.brand.url)l.push('- **URL**: '+k.brand.url);
    if(k.brand.description)l.push('- **Description**: '+k.brand.description);
    l.push('','## Colors','','| Role | Hex |','|------|-----|');
    if(k.colors.primary)l.push('| Primary | \`'+k.colors.primary+'\` |');
    if(k.colors.secondary)l.push('| Secondary | \`'+k.colors.secondary+'\` |');
    if(k.colors.background)l.push('| Background | \`'+k.colors.background+'\` |');
    if(k.colors.text)l.push('| Text | \`'+k.colors.text+'\` |');
    (k.colors.all||[]).slice(0,12).forEach(function(c){l.push('| '+(c.name||'Palette')+' | \`'+c.hex+'\` |');});
    l.push('');
    var dc=k.typography.fonts&&k.typography.fonts.declared||[],sc=k.typography.scale||[];
    if(dc.length||sc.length){l.push('## Typography','');if(dc.length)l.push('**Fonts**: '+dc.map(function(f){return f.name+' ('+f.source+')';}).join(', '),'');if(sc.length){l.push('| Element | Font | Weight | Size | Line Height |','|---------|------|--------|------|-------------|');sc.forEach(function(t){l.push('| '+t.element+' | '+t.fontFamily+' | '+t.fontWeight+' | '+t.fontSize+' | '+t.lineHeight+' |');});l.push('');}}
    var ctas=k.ctas||[];if(ctas.length){l.push('## Call-to-Action Buttons','');ctas.forEach(function(c){l.push('- **"'+c.text+'"** — bg: \`'+c.backgroundColor+'\`, color: \`'+c.color+'\`, font: '+c.fontFamily+' '+c.fontWeight+' '+c.fontSize+', radius: '+c.borderRadius+', padding: '+c.padding);});l.push('');}
    var cp=k.copy||{},hl=cp.headlines||[];if(hl.length||cp.tagline||cp.description){l.push('## Copy Bank','');if(cp.tagline)l.push('- **Tagline**: "'+cp.tagline+'"');if(cp.description)l.push('- **Description**: "'+cp.description+'"');if(hl.length){l.push('- **Headlines**:');hl.slice(0,10).forEach(function(h){l.push('  - "'+h+'"');});}l.push('');}
    var so=Object.entries(k.brand.socialLinks||{}).filter(function(e){return e[1];});if(so.length){l.push('## Social Presence','');so.forEach(function(e){l.push('- **'+e[0]+'**: '+e[1]);});l.push('');}
    return l.join('\\n');
  }
  // ── ASE (Adobe Swatch Exchange) generator ──
  function generateASE(k) {
    var colors = [];
    if(k.colors.primary) colors.push({name:'Primary',hex:k.colors.primary});
    if(k.colors.secondary) colors.push({name:'Secondary',hex:k.colors.secondary});
    if(k.colors.background) colors.push({name:'Background',hex:k.colors.background});
    if(k.colors.text) colors.push({name:'Text',hex:k.colors.text});
    (k.colors.all||[]).slice(0,50).forEach(function(c){colors.push({name:c.name||c.hex,hex:c.hex});});
    if(!colors.length) return null;
    function hexToRGB(h){h=(h||'#000000').replace('#','');return[parseInt(h.substr(0,2),16)/255,parseInt(h.substr(2,2),16)/255,parseInt(h.substr(4,2),16)/255];}
    var groupName=(k.brand.name||'Brand')+' Colors';
    var totalSize=12;
    totalSize+=2+4+(2+(groupName.length+1)*2);
    colors.forEach(function(c){totalSize+=2+4+(2+(c.name.length+1)*2)+4+12+2;});
    totalSize+=2+4;
    var buf=new ArrayBuffer(totalSize),view=new DataView(buf),off=0;
    function w32(v){view.setUint32(off,v,false);off+=4;}
    function w16(v){view.setUint16(off,v,false);off+=2;}
    function wF(v){view.setFloat32(off,v,false);off+=4;}
    function wStr(s){for(var i=0;i<s.length;i++){view.setUint16(off,s.charCodeAt(i),false);off+=2;}view.setUint16(off,0,false);off+=2;}
    view.setUint8(off++,0x41);view.setUint8(off++,0x53);view.setUint8(off++,0x45);view.setUint8(off++,0x46);
    w16(1);w16(0);w32(colors.length+2);
    w16(0xC001);w32(2+(groupName.length+1)*2);w16(groupName.length+1);wStr(groupName);
    colors.forEach(function(c){
      w16(0x0001);w32(2+(c.name.length+1)*2+4+12+2);w16(c.name.length+1);wStr(c.name);
      view.setUint8(off++,0x52);view.setUint8(off++,0x47);view.setUint8(off++,0x42);view.setUint8(off++,0x20);
      var rgb=hexToRGB(c.hex);wF(rgb[0]);wF(rgb[1]);wF(rgb[2]);w16(0);
    });
    w16(0xC002);w32(0);
    return buf;
  }
  // ── Export button wiring ──
  var safeName = (kit.brand.name||'brand').toLowerCase().replace(/[^a-z0-9]+/g,'-');
  document.getElementById('exportCSS').addEventListener('click', function() { downloadFile(generateBrandTokensCSS(kit), safeName+'-tokens.css', 'text/css'); });
  document.getElementById('exportDesignTokens').addEventListener('click', function() { downloadFile(generateDesignTokensJSON(kit), safeName+'-tokens.json', 'application/json'); });
  document.getElementById('exportJSON').addEventListener('click', function() { downloadFile(JSON.stringify(kit,null,2), safeName+'-brand.json', 'application/json'); });
  document.getElementById('exportBrief').addEventListener('click', function() { downloadFile(generateBrandBriefMD(kit), safeName+'-brand-brief.md', 'text/markdown'); });
  document.getElementById('exportASE').addEventListener('click', function() {
    var aseData = generateASE(kit);
    if(aseData){var blob=new Blob([aseData],{type:'application/octet-stream'});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download=safeName+'-colors.ase';document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(url);a.remove();},100);showToast('Downloaded: '+safeName+'-colors.ase');}
    else{showToast('No colors to export');}
  });
  document.getElementById('printPDF').addEventListener('click', function() { window.print(); });
})();
</script>` : ""}
</body>
</html>`;
}

// ─── Install log ─────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log("Net Assets Scraper V2 installed.");
});
