// ─── Net Assets Scraper V2 — Side Panel Logic ────────────────────────
// Manages: tab communication, asset preview grid, filtering,
// selection, zip generation with organized folders + brand.json

// ─── State ───────────────────────────────────────────────────────────
let allAssets = [];       // All captured resources (from background + DOM)
let domData = null;       // DOM analysis data (colors, fonts, meta)
let platformData = null;  // Platform-specific data (Instagram, YouTube, etc.)
let detectedPlatform = null; // Current platform name or null
let selectedUrls = new Set();
let currentTab = "all";   // Active filter tab
let hideSmall = true;     // Filter toggle state
let hideUI = true;        // Filter UI elements (nav icons, social icons, etc.)

// ─── File type constants ─────────────────────────────────────────────
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "svg", "avif", "ico", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "avi", "mov", "wmv", "m4v", "mkv"]);
const FONT_EXTS  = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

const MIME_TO_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/tiff": "tif",
  "image/svg+xml": "svg", "image/x-icon": "ico", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogg",
  "font/woff": "woff", "font/woff2": "woff2", "font/ttf": "ttf",
  "font/otf": "otf", "application/vnd.ms-fontobject": "eot",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
};

const SIZE_THRESHOLD = 5 * 1024; // 5KB — below this is likely UI junk
const TINY_DIMENSION = 48;       // ≤48px on both axes = likely icon/bullet

// URL patterns that strongly indicate UI/icon assets
const UI_URL_PATTERNS = /favicon|icon[_\-./]|badge[_\-./]|arrow[_\-./]|chevron|sprite|pixel|tracking|spacer|blank\.|1x1|transparent\.|loader|spinner|bullet|check[-_.]?mark|close[-_.]?btn|hamburger|caret/i;
const UI_CDN_PATTERNS = /fontawesome|icomoon|material.*icon|googleapis.*icon|use\.typekit/i;

// Patterns that indicate DASH/HLS streaming fragments (not playable standalone)
const VIDEO_FRAGMENT_PATTERNS = /\.m4s(?:\?|$)|\.ts(?:\?|$)|\/segment|\/chunk\/|\/range\/|sq=\d|bytestart=|byteend=|\/frag\(|\.dash|init\.mp4/i;

// ─── Platform Detection ──────────────────────────────────────────────
const PLATFORM_PATTERNS = {
  instagram: /instagram\.com/,
  youtube:   /youtube\.com|youtu\.be/,
  twitter:   /twitter\.com|x\.com/,
  tiktok:    /tiktok\.com/,
  facebook:  /facebook\.com/,
};

const PLATFORM_LABELS = {
  instagram: "Instagram",
  youtube:   "YouTube",
  twitter:   "Twitter / X",
  tiktok:    "TikTok",
  facebook:  "Facebook",
};

const PLATFORM_SCRIPTS = {
  instagram: "platforms/instagram.js",
  tiktok: "platforms/tiktok.js",
  facebook: "platforms/facebook.js",
  twitter: "platforms/twitter.js",
  // Future: youtube
};

function detectPlatform(url) {
  if (!url) return null;
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    if (pattern.test(url)) return platform;
  }
  return null;
}

// ─── Init ────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initTabNav();
  initControls();
  initDownload();
  scanCurrentTab();
});

// ─── Scan current tab ────────────────────────────────────────────────
async function scanCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Update site name
  try {
    const url = new URL(tab.url);
    document.getElementById("siteName").textContent = url.hostname;
  } catch {
    document.getElementById("siteName").textContent = "—";
  }

  // Detect platform
  detectedPlatform = detectPlatform(tab.url);
  renderPlatformBadge();

  // Bail on restricted pages (chrome://, arc://, etc.)
  if (isRestrictedTab(tab)) {
    allAssets = [];
    domData = null;
    platformData = null;
    renderGrid();
    renderBadges();
    return;
  }

  // 1. Get network resources from background service worker
  const bgResponse = await chrome.runtime.sendMessage({
    action: "getResources",
    tabId: tab.id,
  });
  const networkResources = bgResponse?.resources || [];

  // 2. Get DOM analysis from content script
  domData = await queryContentScript(tab.id);

  // 3. If on a known platform, also query the platform-specific script
  platformData = null;
  if (detectedPlatform && PLATFORM_SCRIPTS[detectedPlatform]) {
    platformData = await queryPlatformScript(tab.id, detectedPlatform);
  }

  // 4. Merge network resources with DOM context + platform assets
  allAssets = enrichAssets(networkResources, domData?.imageContext || [], platformData);

  // 5. Render
  renderGrid();
  renderBadges();

  if (domData) {
    renderColors(domData.colors);
    renderFonts(domData.fontInfo);
    renderMeta(domData.pageMeta);
  }

  // Show platform meta if available
  if (platformData?.platformMeta) {
    renderPlatformMeta(platformData.platformMeta, detectedPlatform);
  }
}

// ─── Content script communication (with auto-inject fallback) ────────
const RESTRICTED_PROTOCOLS = ["chrome:", "chrome-extension:", "arc:", "about:", "devtools:", "edge:", "brave:"];

function isRestrictedTab(tab) {
  if (!tab?.url) return true;
  return RESTRICTED_PROTOCOLS.some((p) => tab.url.startsWith(p));
}

async function queryContentScript(tabId) {
  // Try messaging the existing content script first
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "analyzeDOM" });
    if (response) return response;
  } catch { /* content script not available */ }

  // Content script not injected — inject it and retry
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Brief delay for script to initialize and set up listeners
    await new Promise((r) => setTimeout(r, 300));
    const response = await chrome.tabs.sendMessage(tabId, { action: "analyzeDOM" });
    return response || null;
  } catch (err) {
    console.warn("Content script injection failed:", err);
    return null;
  }
}

// ─── Platform script communication ───────────────────────────────────
async function queryPlatformScript(tabId, platform) {
  const scriptFile = PLATFORM_SCRIPTS[platform];
  if (!scriptFile) return null;

  // Try messaging the already-injected platform script
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "analyzePlatform" });
    if (response && response.platform) return response;
  } catch { /* platform script not available */ }

  // Inject platform script and retry
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile],
    });
    await new Promise((r) => setTimeout(r, 300));
    const response = await chrome.tabs.sendMessage(tabId, { action: "analyzePlatform" });
    return response && response.platform ? response : null;
  } catch (err) {
    console.warn(`Platform script injection failed (${platform}):`, err);
    return null;
  }
}

// ─── Enrich network assets with DOM context ──────────────────────────
function enrichAssets(networkResources, imageContext, platformResult) {
  // Build a lookup from DOM image context
  const contextMap = new Map();
  for (const img of imageContext) {
    contextMap.set(img.url, img);
  }

  // On social platforms, filter out ALL video from webRequest.
  // Instagram/TikTok/etc deliver video via DASH/MSE — webRequest only captures
  // moof+mdat fragments (unplayable without init segment). The fetch interceptor
  // captures complete video CDN URLs from API responses instead.
  // Use detectedPlatform (URL-based, always set) as fallback when platformResult
  // is null (e.g. deepScanPlatform timed out or the message channel closed).
  const streamingPlatforms = ["instagram", "tiktok", "facebook", "twitter"];
  const platformName = platformResult?.platform || detectedPlatform;
  const isStreamingPlatform = platformName && streamingPlatforms.includes(platformName);

  if (isStreamingPlatform) {
    const videoCount = networkResources.filter((r) => r.type === "video").length;
    console.log(`[NAS] Streaming platform "${platformName}" — filtering ${videoCount} webRequest videos (platformResult: ${platformResult ? "OK" : "null"})`);
  }

  // Filter out known DASH/HLS fragment URLs from ANY website
  const filtered = networkResources.filter((r) => {
    // On streaming platforms, drop all webRequest video
    if (isStreamingPlatform && r.type === "video") return false;
    // On all sites, drop URLs that match fragment patterns
    if (r.type === "video" && VIDEO_FRAGMENT_PATTERNS.test(r.url)) return false;
    return true;
  });

  const enriched = filtered.map((res) => {
    const ctx = contextMap.get(res.url);
    return {
      ...res,
      alt: ctx?.alt || "",
      context: ctx?.context || "unknown",
      isLogo: ctx?.isLogo || false,
      isUI: ctx?.isUI || false,
      domWidth: ctx?.width || 0,
      domHeight: ctx?.height || 0,
      displayName: buildDisplayName(res, ctx),
      selected: false,
      platformTag: null,
    };
  });

  // Also add DOM-discovered images not in network resources
  const allUrls = new Set(filtered.map((r) => r.url));
  for (const img of imageContext) {
    if (!allUrls.has(img.url)) {
      const ext = getExtFromUrl(img.url);
      allUrls.add(img.url);
      enriched.push({
        url: img.url,
        type: "image",
        contentType: "",
        contentLength: -1,
        ext,
        timestamp: Date.now(),
        alt: img.alt || "",
        context: img.context || "unknown",
        isLogo: img.isLogo || false,
        isUI: img.isUI || false,
        domWidth: img.width || 0,
        domHeight: img.height || 0,
        displayName: buildDisplayName({ url: img.url, ext }, img),
        selected: false,
        platformTag: null,
      });
    }
  }

  // Merge platform-specific assets (higher quality, platform-aware)
  if (platformResult?.assets) {
    for (const pAsset of platformResult.assets) {
      if (allUrls.has(pAsset.url)) {
        // Asset already exists — upgrade it with platform context
        const existing = enriched.find((a) => a.url === pAsset.url);
        if (existing) {
          existing.platformTag = pAsset.platformTag || null;
          existing.context = pAsset.context || existing.context;
          existing.isLogo = pAsset.isLogo || existing.isLogo;
          existing.isUI = false; // Platform assets are never UI junk
          if (pAsset.alt && pAsset.alt.length > existing.alt.length) {
            existing.alt = pAsset.alt;
            existing.displayName = buildDisplayName(existing, pAsset);
          }
        }
      } else {
        // New asset from platform script — add it
        const ext = getExtFromUrl(pAsset.url);
        allUrls.add(pAsset.url);
        enriched.push({
          url: pAsset.url,
          type: pAsset.type || "image",
          contentType: pAsset.isMSECapture ? "video/mp4" : "",
          contentLength: pAsset.mseBytes || -1,
          ext: pAsset.isMSECapture ? "mp4" : ext,
          timestamp: Date.now(),
          alt: pAsset.alt || "",
          context: pAsset.context || "platform",
          isLogo: pAsset.isLogo || false,
          isUI: false,
          domWidth: pAsset.width || 0,
          domHeight: pAsset.height || 0,
          displayName: pAsset.isMSECapture
            ? `instagram-video-${(pAsset.mseVideoId || "").replace(/[^a-z0-9]/gi, "").slice(-8)}.mp4`
            : buildDisplayName({ url: pAsset.url, ext }, pAsset),
          selected: false,
          platformTag: pAsset.platformTag || null,
          poster: pAsset.poster || null,
          isBlob: pAsset.isBlob || false,
          isMSECapture: pAsset.isMSECapture || false,
          mseVideoId: pAsset.mseVideoId || null,
          // Pipeline metadata for DASH video muxing / transcoding
          needsMux: pAsset.needsMux || false,
          audioUrl: pAsset.audioUrl || null,
          audioCodec: pAsset.audioCodec || null,
          needsTranscode: pAsset.needsTranscode || false,
          videoId: pAsset.videoId || null,
          codec: pAsset.codec || null,
          bandwidth: pAsset.bandwidth || 0,
          // Asset naming metadata (username + shortcode for human-readable filenames)
          username: pAsset.username || null,
          shortcode: pAsset.shortcode || null,
        });
      }
    }
  }

  // Sort: logos first, platform-tagged next, UI last, then by size descending
  enriched.sort((a, b) => {
    if (a.isLogo && !b.isLogo) return -1;
    if (!a.isLogo && b.isLogo) return 1;
    if (a.platformTag && !b.platformTag) return -1;
    if (!a.platformTag && b.platformTag) return 1;
    if (a.isUI && !b.isUI) return 1;
    if (!a.isUI && b.isUI) return -1;
    const sizeA = a.contentLength > 0 ? a.contentLength : 0;
    const sizeB = b.contentLength > 0 ? b.contentLength : 0;
    return sizeB - sizeA;
  });

  return enriched;
}

// ─── Display name builder ────────────────────────────────────────────
function buildDisplayName(resource, ctx) {
  // Priority 1: alt text
  if (ctx?.alt && ctx.alt.length > 2 && ctx.alt.length < 60) {
    return sanitizeFilename(ctx.alt) + "." + (resource.ext || guessExt(resource));
  }

  // Priority 2: Clean URL filename
  try {
    const pathname = new URL(resource.url).pathname;
    const segment = pathname.substring(pathname.lastIndexOf("/") + 1);
    if (segment && segment.length > 1 && segment.length < 80 && segment.includes(".")) {
      return decodeURIComponent(segment);
    }
    if (segment && segment.length > 1 && segment.length < 40) {
      return segment + "." + (resource.ext || guessExt(resource));
    }
  } catch { /* skip */ }

  // Priority 3: Context-based name
  const prefix = ctx?.isLogo ? "logo" : (ctx?.context || "asset");
  const ext = resource.ext || guessExt(resource);
  return `${prefix}-${Date.now().toString(36)}.${ext}`;
}

function guessExt(resource) {
  if (resource.contentType && MIME_TO_EXT[resource.contentType]) {
    return MIME_TO_EXT[resource.contentType];
  }
  if (resource.type === "image") return "png";
  if (resource.type === "video") return "mp4";
  if (resource.type === "font") return "woff2";
  return "bin";
}

function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return "";
    const ext = pathname.substring(dot + 1).toLowerCase();
    return ext.length <= 6 ? ext : "";
  } catch {
    return "";
  }
}

function sanitizeFilename(name) {
  const sanitized = name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "-")
    .toLowerCase();

  // Truncate base name but preserve file extension
  const dotIdx = sanitized.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = sanitized.substring(dotIdx); // e.g. ".jpg"
    if (ext.length >= 2 && ext.length <= 6) {
      return sanitized.substring(0, dotIdx).slice(0, 60) + ext;
    }
  }
  return sanitized.slice(0, 65);
}

// ─── Render Grid ─────────────────────────────────────────────────────
// Cached reference — survives grid.innerHTML = "" clears
let emptyStateEl = null;

function renderGrid() {
  const grid = document.getElementById("assetGrid");
  if (!emptyStateEl) emptyStateEl = document.getElementById("emptyState");
  const filtered = getFilteredAssets();

  if (filtered.length === 0) {
    grid.innerHTML = "";
    grid.appendChild(emptyStateEl);
    emptyStateEl.style.display = "flex";
    return;
  }

  emptyStateEl.style.display = "none";
  // Detach empty state before clearing so it survives
  if (emptyStateEl.parentNode === grid) grid.removeChild(emptyStateEl);
  grid.innerHTML = "";

  for (const asset of filtered) {
    const card = createAssetCard(asset);
    grid.appendChild(card);
  }
}

function getFilteredAssets() {
  let filtered = allAssets;

  // Tab filter
  if (currentTab !== "all" && currentTab !== "colors") {
    filtered = filtered.filter((a) => a.type === currentTab);
  }

  // Hide small toggle — check contentLength AND DOM dimensions AND URL hints
  if (hideSmall) {
    filtered = filtered.filter((a) => {
      // Known small file size
      if (a.contentLength > 0 && a.contentLength < SIZE_THRESHOLD) return false;
      // Known tiny dimensions from DOM
      const w = a.domWidth || 0;
      const h = a.domHeight || 0;
      if (w > 0 && h > 0 && w <= TINY_DIMENSION && h <= TINY_DIMENSION) return false;
      return true;
    });
  }

  // Hide UI elements — check isUI flag AND URL-based heuristics
  if (hideUI) {
    filtered = filtered.filter((a) => {
      // Content script flagged it as UI
      if (a.isUI) return false;
      // URL-based UI detection (fallback for network-only assets)
      if (a.url && (UI_URL_PATTERNS.test(a.url) || UI_CDN_PATTERNS.test(a.url))) return false;
      // Very small known dimensions are almost always UI
      const w = a.domWidth || 0;
      const h = a.domHeight || 0;
      if (w > 0 && h > 0 && w <= 24 && h <= 24) return false;
      return true;
    });
  }

  return filtered;
}

function createAssetCard(asset) {
  const card = document.createElement("div");
  card.className = `asset-card${selectedUrls.has(asset.url) ? " selected" : ""}`;
  card.dataset.url = asset.url;

  // Checkbox indicator
  const checkbox = document.createElement("div");
  checkbox.className = "card-checkbox";
  card.appendChild(checkbox);

  // Type badge
  const typeBadge = document.createElement("span");
  typeBadge.className = `card-type-badge type-${asset.type}`;
  typeBadge.textContent = asset.type;
  card.appendChild(typeBadge);

  // Logo badge
  if (asset.isLogo) {
    const logoBadge = document.createElement("span");
    logoBadge.className = "card-logo-badge";
    logoBadge.textContent = "logo";
    card.appendChild(logoBadge);
  }

  // Platform tag badge (e.g., "instagram-post", "instagram-reel-thumb")
  if (asset.platformTag) {
    const platformBadge = document.createElement("span");
    platformBadge.className = "card-platform-badge";
    // Short readable label
    const label = asset.platformTag
      .replace("instagram-", "ig:")
      .replace("youtube-", "yt:")
      .replace("twitter-", "tw:")
      .replace("tiktok-", "tt:");
    platformBadge.textContent = label;
    card.appendChild(platformBadge);
  }

  // Thumbnail
  if (asset.type === "image") {
    const img = document.createElement("img");
    img.className = "card-thumb";
    img.src = asset.url;
    img.alt = asset.alt || asset.displayName;
    img.loading = "lazy";
    img.onerror = () => {
      img.replaceWith(createPlaceholder("🖼"));
    };
    // Detect images that load but are essentially empty (1×1 pixels, etc.)
    // Also capture actual dimensions for smarter filtering on toggle
    img.onload = () => {
      if (img.naturalWidth <= 2 && img.naturalHeight <= 2) {
        img.replaceWith(createPlaceholder("·"));
      }
      // Back-fill dimensions if we didn't have them from DOM analysis
      if (!asset.domWidth || !asset.domHeight) {
        asset.domWidth = img.naturalWidth;
        asset.domHeight = img.naturalHeight;
      }
    };
    card.appendChild(img);
  } else if (asset.type === "video") {
    if (asset.isMSECapture) {
      // MSE-captured videos can't preview — show placeholder with size info
      const sizeStr = asset.contentLength > 0 ? formatBytes(asset.contentLength) : "";
      card.appendChild(createPlaceholder(`🎬${sizeStr ? "\n" + sizeStr : ""}`));
    } else if (asset.poster) {
      // Platform videos (Instagram, etc.) — use poster frame as thumbnail
      // because CDN video URLs can't be loaded directly from the extension context
      const img = document.createElement("img");
      img.className = "card-thumb";
      img.src = asset.poster;
      img.alt = asset.displayName;
      img.loading = "lazy";
      img.onerror = () => {
        img.replaceWith(createPlaceholder("🎬"));
      };
      card.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.className = "card-thumb";
      video.src = asset.url;
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      // Seek slightly in to grab a real frame (some videos have blank first frames)
      video.addEventListener("loadedmetadata", () => {
        video.currentTime = Math.min(1, video.duration * 0.1);
      });
      video.onerror = () => {
        video.replaceWith(createPlaceholder("🎬"));
      };
      card.appendChild(video);
    }
  } else if (asset.type === "font") {
    card.appendChild(createFontPreview(asset));
  } else if (asset.type === "audio") {
    card.appendChild(createPlaceholder("♪"));
  } else {
    card.appendChild(createPlaceholder("📄"));
  }

  // Info
  const info = document.createElement("div");
  info.className = "card-info";

  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = asset.displayName;
  name.title = asset.displayName;
  info.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (asset.contentLength > 0) {
    meta.textContent = formatBytes(asset.contentLength);
  }
  if (asset.domWidth && asset.domHeight) {
    meta.textContent += (meta.textContent ? " · " : "") + `${asset.domWidth}×${asset.domHeight}`;
  }
  info.appendChild(meta);

  card.appendChild(info);

  // Click to toggle selection
  card.addEventListener("click", () => {
    toggleSelection(asset.url);
    card.classList.toggle("selected");
    updateDownloadBar();
  });

  return card;
}

function createPlaceholder(icon) {
  const div = document.createElement("div");
  div.className = "card-thumb-placeholder";
  div.textContent = icon;
  return div;
}

// Counter for unique @font-face family names
let fontPreviewCounter = 0;

function createFontPreview(asset) {
  const div = document.createElement("div");
  div.className = "card-thumb-placeholder font-preview";

  const familyName = `nas-preview-${fontPreviewCounter++}`;
  const sampleText = "Ag";

  // Inject @font-face rule to load the actual font
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: '${familyName}'; src: url('${asset.url}'); }`;
  div.appendChild(style);

  const glyph = document.createElement("span");
  glyph.className = "font-glyph";
  glyph.textContent = sampleText;
  glyph.style.fontFamily = `'${familyName}', serif`;
  div.appendChild(glyph);

  // Show font name below glyph
  const label = document.createElement("span");
  label.className = "font-label";
  label.textContent = asset.displayName.replace(/\.[^.]+$/, "");
  div.appendChild(label);

  return div;
}

// ─── Tab Navigation ──────────────────────────────────────────────────
function initTabNav() {
  const tabNav = document.getElementById("tabNav");
  tabNav.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;

    tabNav.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    currentTab = btn.dataset.tab;

    const grid = document.getElementById("assetGrid");
    const colorsPanel = document.getElementById("colorsPanel");

    if (currentTab === "colors") {
      grid.style.display = "none";
      colorsPanel.style.display = "block";
      document.getElementById("controlsBar").style.display = "none";
    } else {
      grid.style.display = "grid";
      colorsPanel.style.display = "none";
      document.getElementById("controlsBar").style.display = "flex";
      renderGrid();
    }
  });
}

// ─── Controls ────────────────────────────────────────────────────────
function initControls() {
  document.getElementById("hideSmall").addEventListener("change", (e) => {
    hideSmall = e.target.checked;
    renderGrid();
    renderBadges();
  });

  document.getElementById("hideUI").addEventListener("change", (e) => {
    hideUI = e.target.checked;
    renderGrid();
    renderBadges();
  });

  document.getElementById("selectAll").addEventListener("click", () => {
    const filtered = getFilteredAssets();
    filtered.forEach((a) => selectedUrls.add(a.url));
    renderGrid();
    updateDownloadBar();
  });

  document.getElementById("selectNone").addEventListener("click", () => {
    selectedUrls.clear();
    renderGrid();
    updateDownloadBar();
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    const btnText = btn.querySelector("span");
    const originalText = btnText.textContent;

    // Show scanning state
    btn.disabled = true;
    btnText.textContent = "Scanning…";
    allAssets = [];
    domData = null;
    platformData = null;
    detectedPlatform = null;
    selectedUrls.clear();
    renderGrid();
    renderBadges();
    updateDownloadBar();

    // Deep scan: auto-scrolls the page to trigger lazy loaders
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && !isRestrictedTab(tab)) {
        // Detect platform for this scan
        detectedPlatform = detectPlatform(tab.url);
        renderPlatformBadge();

        // If on a known platform, use platform-specific deep scan
        if (detectedPlatform && PLATFORM_SCRIPTS[detectedPlatform]) {
          try {
            platformData = await chrome.tabs.sendMessage(tab.id, { action: "deepScanPlatform" });
          } catch {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: [PLATFORM_SCRIPTS[detectedPlatform]],
              });
              await new Promise((r) => setTimeout(r, 300));
              platformData = await chrome.tabs.sendMessage(tab.id, { action: "deepScanPlatform" });
            } catch {
              platformData = null;
            }
          }
          // Fallback: if deepScan failed/returned nothing, try lightweight analyzePlatform
          // (no scrolling — just grabs what's already loaded + intercepted videos)
          if (!platformData || !platformData.platform) {
            try {
              platformData = await chrome.tabs.sendMessage(tab.id, { action: "analyzePlatform" });
            } catch {
              platformData = null;
            }
          }
        }

        try {
          // If platform already deep-scanned (scrolled), just analyze DOM without re-scrolling
          const domAction = platformData ? "analyzeDOM" : "deepScan";
          domData = await chrome.tabs.sendMessage(tab.id, { action: domAction });
        } catch {
          // Fallback: inject + scan
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["content.js"],
            });
            await new Promise((r) => setTimeout(r, 300));
            const domAction = platformData ? "analyzeDOM" : "deepScan";
            domData = await chrome.tabs.sendMessage(tab.id, { action: domAction });
          } catch {
            domData = null;
          }
        }

        // Also grab network resources
        const bgResponse = await chrome.runtime.sendMessage({
          action: "getResources",
          tabId: tab.id,
        });
        const networkResources = bgResponse?.resources || [];

        allAssets = enrichAssets(networkResources, domData?.imageContext || [], platformData);
      }
    } catch (err) {
      console.error("NAS deep scan error:", err);
    }

    // Always render results — even partial data is better than stale UI
    renderGrid();
    renderBadges();
    if (domData) {
      renderColors(domData.colors);
      renderFonts(domData.fontInfo);
      renderMeta(domData.pageMeta);
    }
    if (platformData?.platformMeta) {
      renderPlatformMeta(platformData.platformMeta, detectedPlatform);
    }

    btn.disabled = false;
    btnText.textContent = originalText;
    showToast(`Deep scan complete — ${allAssets.length} assets found`);
  });
}

// ─── Selection ───────────────────────────────────────────────────────
function toggleSelection(url) {
  if (selectedUrls.has(url)) {
    selectedUrls.delete(url);
  } else {
    selectedUrls.add(url);
  }
}

function updateDownloadBar() {
  const count = selectedUrls.size;
  document.getElementById("selectedCount").textContent = `${count} selected`;
  document.getElementById("downloadBtn").disabled = count === 0;

  // Estimate size
  let totalSize = 0;
  for (const asset of allAssets) {
    if (selectedUrls.has(asset.url) && asset.contentLength > 0) {
      totalSize += asset.contentLength;
    }
  }
  document.getElementById("selectedSize").textContent = totalSize > 0 ? `~${formatBytes(totalSize)}` : "";
}

// ─── Render Badges ───────────────────────────────────────────────────
function renderBadges() {
  const counts = { image: 0, video: 0, font: 0 };
  // Count ALL assets (with hide-small/hide-UI filters but NOT tab filter)
  // so badges always reflect totals regardless of which tab is active
  for (const asset of allAssets) {
    // Apply same hide-small / hide-UI logic as getFilteredAssets
    if (hideSmall) {
      if (asset.contentLength > 0 && asset.contentLength < SIZE_THRESHOLD) continue;
      const w = asset.domWidth || 0;
      const h = asset.domHeight || 0;
      if (w > 0 && h > 0 && w <= TINY_DIMENSION && h <= TINY_DIMENSION) continue;
    }
    if (hideUI) {
      if (asset.isUI) continue;
      if (asset.url && (UI_URL_PATTERNS.test(asset.url) || UI_CDN_PATTERNS.test(asset.url))) continue;
      const w = asset.domWidth || 0;
      const h = asset.domHeight || 0;
      if (w > 0 && h > 0 && w <= 24 && h <= 24) continue;
    }
    if (counts[asset.type] !== undefined) counts[asset.type]++;
  }

  document.getElementById("badgeImage").textContent = counts.image;
  document.getElementById("badgeVideo").textContent = counts.video;
  document.getElementById("badgeFont").textContent = counts.font;
}

// ─── Render Colors ───────────────────────────────────────────────────
function renderColors(colors) {
  const grid = document.getElementById("colorGrid");
  grid.innerHTML = "";

  if (!colors || colors.length === 0) {
    document.getElementById("colorsHint").textContent = "No brand colors detected on this page.";
    return;
  }

  for (const color of colors) {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";

    const circle = document.createElement("div");
    circle.className = "swatch-circle";
    circle.style.backgroundColor = color.hex;
    swatch.appendChild(circle);

    const hex = document.createElement("span");
    hex.className = "swatch-hex";
    hex.textContent = color.hex;
    swatch.appendChild(hex);

    if (color.name) {
      const name = document.createElement("span");
      name.className = "swatch-name";
      name.textContent = color.name;
      swatch.appendChild(name);
    }

    swatch.addEventListener("click", () => {
      navigator.clipboard.writeText(color.hex).then(() => {
        showToast(`Copied ${color.hex}`);
      });
    });

    grid.appendChild(swatch);
  }
}

// ─── Render Fonts ────────────────────────────────────────────────────
function renderFonts(fontInfo) {
  const list = document.getElementById("fontList");
  list.innerHTML = "";

  if (!fontInfo) return;

  const allFonts = [
    ...fontInfo.declared.map((f) => ({ name: f.name, source: f.source })),
    ...fontInfo.used.filter((name) => !fontInfo.declared.some((d) => d.name === name))
      .map((name) => ({ name, source: "computed" })),
  ];

  if (allFonts.length === 0) {
    list.innerHTML = '<p class="hint">No custom fonts detected.</p>';
    return;
  }

  for (const font of allFonts) {
    const item = document.createElement("div");
    item.className = "font-item";

    const name = document.createElement("span");
    name.className = "font-name";
    name.textContent = font.name;
    item.appendChild(name);

    const source = document.createElement("span");
    source.className = "font-source";
    source.textContent = font.source;
    item.appendChild(source);

    list.appendChild(item);
  }
}

// ─── Render Meta ─────────────────────────────────────────────────────
function renderMeta(meta) {
  const container = document.getElementById("metaInfo");
  container.innerHTML = "";

  if (!meta) return;

  const rows = [
    { label: "title", value: meta.title },
    { label: "site", value: meta.siteName },
    { label: "url", value: meta.hostname },
    { label: "og:image", value: meta.ogImage ? "✓ found" : "—" },
    { label: "theme", value: meta.themeColor || "—" },
  ];

  for (const row of rows) {
    if (!row.value) continue;
    const div = document.createElement("div");
    div.className = "meta-row";
    const label = document.createElement("span");
    label.className = "meta-label";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "meta-value";
    value.textContent = row.value;
    div.appendChild(label);
    div.appendChild(value);
    container.appendChild(div);
  }
}

// ─── Download / Zip Generation ───────────────────────────────────────

/** Convert a data URL (from content script fetchBlob) to an ArrayBuffer. */
async function dataUrlToArrayBuffer(dataUrl) {
  const res = await fetch(dataUrl);
  return res.arrayBuffer();
}

function initDownload() {
  document.getElementById("downloadBtn").addEventListener("click", downloadKit);
}

async function downloadKit() {
  const btn = document.getElementById("downloadBtn");
  const progressEl = document.getElementById("downloadProgress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");

  btn.style.display = "none";
  progressEl.style.display = "flex";
  progressFill.style.width = "0%";

  try {
    const zip = new JSZip();
    const selected = allAssets.filter((a) => selectedUrls.has(a.url));
    const total = selected.length;

    // Create folder structure
    const folders = {
      image: zip.folder("images"),
      video: zip.folder("videos"),
      font: zip.folder("fonts"),
      audio: zip.folder("audio"),
    };

    // Create logos subfolder
    const logosFolder = zip.folder("logos");

    // Track used filenames to avoid duplicates
    const usedNames = new Map(); // folder → Set<name>

    let completed = 0;
    let totalBytes = 0;

    // Update progress UI
    function updateProgress() {
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      progressFill.style.width = `${pct}%`;
      const sizeStr = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : "";
      progressText.textContent = `${completed} / ${total}${sizeStr}`;
    }

    updateProgress();

    // Transcode mutex — serialize heavy video processing (1 at a time)
    // so we don't spawn 30 WebCodecs instances and melt the GPU
    let _transcodeGate = Promise.resolve();
    function acquireTranscodeLock() {
      let release;
      const prev = _transcodeGate;
      _transcodeGate = new Promise((r) => (release = r));
      return { wait: prev, release };
    }

    // Download each selected asset
    const promises = selected.map(async (asset) => {
      try {
        let blob;
        let wasMuxed = false;

        if (asset.isMSECapture && asset.mseVideoId) {
          // MSE-captured video — reassemble via content script bridge
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const result = await chrome.tabs.sendMessage(tab.id, {
            action: "fetchMSEVideo",
            videoId: asset.mseVideoId,
          });
          if (!result?.dataUrl) throw new Error("MSE video reassembly failed");
          const res = await fetch(result.dataUrl);
          blob = await res.blob();

        } else if (asset.needsMux && asset.audioUrl) {
          // ── DASH video with separate audio — fetch both, transcode, mux ──
          // Acquire lock so only 1 transcode runs at a time (GPU-heavy)
          const lock = acquireTranscodeLock();
          await lock.wait;

          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const vidLabel = asset.videoId
              ? asset.videoId.slice(-6)
              : String(selected.indexOf(asset) + 1);

            // 1. Fetch video buffer
            progressText.textContent = `Fetching video ${vidLabel}…`;
            const vidResult = await chrome.tabs.sendMessage(tab.id, {
              action: "fetchBlob",
              url: asset.url,
            });
            if (vidResult?.error) throw new Error(`Video fetch: ${vidResult.error}`);
            let videoBuffer = await dataUrlToArrayBuffer(vidResult.dataUrl);

            // 2. Fetch audio buffer
            progressText.textContent = `Fetching audio ${vidLabel}…`;
            const audResult = await chrome.tabs.sendMessage(tab.id, {
              action: "fetchBlob",
              url: asset.audioUrl,
            });
            if (audResult?.error) throw new Error(`Audio fetch: ${audResult.error}`);
            const audioBuffer = await dataUrlToArrayBuffer(audResult.dataUrl);

            // 3. Transcode VP9 → H.264 if needed (graceful fallback to VP9 if it fails)
            if (asset.needsTranscode && typeof VideoPipeline.transcode === "function") {
              try {
                progressText.textContent = `Transcoding ${vidLabel}…`;
                videoBuffer = await VideoPipeline.transcode(videoBuffer, ({ percent, detail }) => {
                  progressText.textContent = `Transcoding ${vidLabel}: ${detail || percent + "%"}`;
                });
                console.log(`[downloadKit] Transcoded ${vidLabel} VP9 → H.264`);
              } catch (err) {
                console.warn(`[downloadKit] Transcode failed for ${vidLabel}, using VP9:`, err);
                // videoBuffer stays as original VP9 — mux may fail (MP4Box VP9 limitation),
                // in which case the fallback below serves video-only
              }
            }

            // 4. Mux video + audio → .mp4
            progressText.textContent = `Muxing ${vidLabel}…`;
            try {
              blob = await VideoPipeline.mux(videoBuffer, audioBuffer, ({ percent, detail }) => {
                progressText.textContent = `Muxing ${vidLabel}: ${detail || percent + "%"}`;
              });
              wasMuxed = true;
              console.log(`[downloadKit] Muxed ${vidLabel}: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
            } catch (muxErr) {
              console.warn(`[downloadKit] Mux failed for ${vidLabel}, using video-only:`, muxErr);
              blob = new Blob([videoBuffer], { type: "video/mp4" });
            }
          } finally {
            lock.release(); // let next video proceed
          }

        } else if (asset.url.startsWith("blob:") || (asset.type === "video" && asset.platformTag)) {
          // Blob URLs and platform video CDN URLs must be fetched from the
          // PAGE context (content script) — the extension panel can't access
          // Instagram/TikTok CDN due to CORS and missing auth cookies.
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const result = await chrome.tabs.sendMessage(tab.id, {
            action: "fetchBlob",
            url: asset.url,
          });
          if (result?.error) throw new Error(result.error);
          // Convert data URL back to blob
          const res = await fetch(result.dataUrl);
          blob = await res.blob();
        } else {
          const response = await fetch(asset.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          blob = await response.blob();
        }

        // Sniff actual content type from blob if available
        const actualType = blob.type || asset.contentType;
        const ext = getActualExtension(asset, actualType);

        // Validate video files — skip DASH/HLS fragments that aren't playable
        // (muxed videos are guaranteed playable by construction)
        if (asset.type === "video" && !asset.isMSECapture && !wasMuxed) {
          const isPlayable = await isPlayableVideo(blob);
          if (!isPlayable) {
            console.warn(`Skipping unplayable video fragment: ${asset.displayName}`);
            completed++;
            updateProgress();
            return;
          }
        }

        let fileName = buildFinalFilename(asset, ext);

        // Pick the right folder
        const targetFolder = asset.isLogo ? logosFolder : (folders[asset.type] || folders.image);
        const folderKey = asset.isLogo ? "logos" : asset.type;

        // Deduplicate filename within folder
        if (!usedNames.has(folderKey)) usedNames.set(folderKey, new Set());
        const nameSet = usedNames.get(folderKey);
        fileName = deduplicateFilename(fileName, nameSet);
        nameSet.add(fileName);

        targetFolder.file(fileName, blob, { binary: true });
        totalBytes += blob.size;
        completed++;
        updateProgress();
      } catch (err) {
        console.error(`Failed to fetch ${asset.url}:`, err);
        completed++;
        updateProgress();
      }
    });

    await Promise.all(promises);

    // Zipping phase
    progressText.textContent = `Zipping ${completed} files…`;
    progressFill.style.width = "100%";

    // Add brand.json with colors, fonts, and meta
    if (domData) {
      const brandKit = {
        colors: (domData.colors || []).map((c) => ({
          hex: c.hex,
          name: c.name || null,
          source: c.source,
        })),
        fonts: domData.fontInfo || { declared: [], used: [] },
        meta: domData.pageMeta || {},
        exportedAt: new Date().toISOString(),
        assetCount: completed,
      };
      zip.file("brand.json", JSON.stringify(brandKit, null, 2));
    }

    // Remove empty folders
    for (const [type, folder] of Object.entries(folders)) {
      const folderName = type === "image" ? "images" : type === "video" ? "videos" : type === "font" ? "fonts" : "audio";
      if (zip.folder(folderName).file(/.+/).length === 0) {
        zip.remove(folderName);
      }
    }
    // Check logos folder
    if (zip.folder("logos").file(/.+/).length === 0) {
      zip.remove("logos");
    }

    // Generate zip
    const content = await zip.generateAsync({ type: "blob" });
    const hostname = document.getElementById("siteName").textContent.replace(/[^a-z0-9.-]/gi, "_");
    const zipName = `${hostname || "assets"}_brand_kit.zip`;

    // Download
    const blobUrl = URL.createObjectURL(content);
    chrome.downloads.download({ url: blobUrl, filename: zipName }, () => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError);
      }
      URL.revokeObjectURL(blobUrl);
    });

    showToast(`Kit downloaded — ${completed} files · ${formatBytes(totalBytes)}`);
  } catch (err) {
    console.error("Kit generation failed:", err);
    showToast("Download failed. Check console.");
  } finally {
    progressEl.style.display = "none";
    btn.style.display = "";
    btn.disabled = false;
    btn.textContent = "Download Kit ↓";
    updateDownloadBar();
  }
}

function getActualExtension(asset, blobType) {
  // Trust blob type over URL extension
  if (blobType && MIME_TO_EXT[blobType]) return MIME_TO_EXT[blobType];
  if (asset.ext && asset.ext.length > 0 && asset.ext.length <= 5) return asset.ext;
  return guessExt(asset);
}

function buildFinalFilename(asset, ext) {
  // Platform-aware naming: use username + shortcode when available
  // Produces: nike_DI3xK2_1080x1350.mp4 instead of api-capture-mnu0xahl.mp4
  if (asset.username || asset.shortcode) {
    const parts = [];
    if (asset.username) parts.push(asset.username);
    if (asset.shortcode) parts.push(asset.shortcode);
    // Append dimensions if known (helps identify quality at a glance)
    const w = asset.domWidth || 0;
    const h = asset.domHeight || 0;
    if (w > 0 && h > 0) parts.push(`${w}x${h}`);
    const name = parts.join("_") + "." + (ext || "mp4");
    return sanitizeFilename(name);
  }

  let name = asset.displayName;

  // Make sure extension matches actual detected type
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    const currentExt = name.substring(dotIdx + 1).toLowerCase();
    // If current extension doesn't match, replace it
    if (currentExt !== ext && ext) {
      name = name.substring(0, dotIdx) + "." + ext;
    }
  } else if (ext) {
    name = name + "." + ext;
  }

  return sanitizeFilename(name);
}

function deduplicateFilename(name, usedSet) {
  if (!usedSet.has(name)) return name;
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.substring(dotIdx) : "";
  let counter = 2;
  while (usedSet.has(`${base}-${counter}${ext}`)) counter++;
  return `${base}-${counter}${ext}`;
}

// ─── Utilities ───────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Check if a video blob is a complete, playable file (not a DASH/HLS fragment).
 * Reads the first 8 bytes and checks for MP4 box types:
 *   ftyp (0x66747970) = complete MP4 → playable ✓
 *   moov (0x6D6F6F76) = metadata box → playable ✓
 *   moof (0x6D6F6F66) = movie fragment → NOT playable ✗
 *   styp (0x73747970) = segment type → NOT playable ✗
 */
async function isPlayableVideo(blob) {
  if (blob.size < 8) return false;
  try {
    const header = await blob.slice(0, 8).arrayBuffer();
    const view = new DataView(header);
    // MP4 box type is at bytes 4-7 (first 4 bytes are box size)
    const boxType = view.getUint32(4);
    const FTYP = 0x66747970; // complete file
    const MOOV = 0x6D6F6F76; // metadata (some tools put moov first)
    const MOOF = 0x6D6F6F66; // fragment
    const STYP = 0x73747970; // segment type
    // Accept ftyp and moov (playable), reject moof and styp (fragments)
    if (boxType === FTYP || boxType === MOOV) return true;
    if (boxType === MOOF || boxType === STYP) return false;
    // Unknown box type — let it through (could be webm, ogg, etc.)
    return true;
  } catch {
    return true; // On error, don't block — let the user decide
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2500);
}

// ─── Platform UI ─────────────────────────────────────────────────────

function renderPlatformBadge() {
  let badge = document.getElementById("platformBadge");
  let separator = document.getElementById("platformSep");
  if (!detectedPlatform) {
    if (badge) badge.style.display = "none";
    if (separator) separator.style.display = "none";
    return;
  }

  const context = document.querySelector(".header-context");
  if (!context) return;

  if (!separator) {
    separator = document.createElement("span");
    separator.id = "platformSep";
    separator.className = "header-sep";
    separator.textContent = "·";
    context.appendChild(separator);
  }

  if (!badge) {
    badge = document.createElement("span");
    badge.id = "platformBadge";
    badge.className = "platform-badge";
    context.appendChild(badge);
  }

  badge.textContent = PLATFORM_LABELS[detectedPlatform] || detectedPlatform;
  badge.className = `platform-badge platform-${detectedPlatform}`;
  badge.style.display = "inline-flex";
  separator.style.display = "inline";
}

function renderPlatformMeta(meta, platform) {
  const container = document.getElementById("metaInfo");
  if (!container || !meta) return;

  // Clear previous platform meta rows to avoid duplication on re-scan
  container.querySelectorAll(".platform-meta-row").forEach(el => el.remove());

  // Add platform-specific rows to the existing meta section
  const platformRows = [];

  if (platform === "instagram") {
    if (meta.username) platformRows.push({ label: "user", value: `@${meta.username}` });
    if (meta.fullName) platformRows.push({ label: "name", value: meta.fullName });
    if (meta.bio) platformRows.push({ label: "bio", value: meta.bio.slice(0, 120) + (meta.bio.length > 120 ? "…" : "") });
    if (meta.isVerified) platformRows.push({ label: "verified", value: "✓" });
    if (meta.isCarousel) platformRows.push({ label: "carousel", value: "swipe for more slides" });
    if (meta.author) platformRows.push({ label: "author", value: `@${meta.author}` });
    if (meta.caption) platformRows.push({ label: "caption", value: meta.caption.slice(0, 120) + (meta.caption.length > 120 ? "…" : "") });
  }

  for (const row of platformRows) {
    const div = document.createElement("div");
    div.className = "meta-row platform-meta-row";
    const label = document.createElement("span");
    label.className = "meta-label";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "meta-value";
    value.textContent = row.value;
    div.appendChild(label);
    div.appendChild(value);
    container.appendChild(div);
  }
}
