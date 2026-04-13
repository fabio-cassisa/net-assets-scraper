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

// ─── Settings (persisted via chrome.storage.local) ───────────────────
const SETTINGS_DEFAULTS = { compressImages: false, autoSelectLogos: true, minImageSize: 48, quickScan: false };
let settings = { ...SETTINGS_DEFAULTS };

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

// ─── CDN Normalization ───────────────────────────────────────────────
// Recognizes CDN transform patterns and extracts a "base key" for deduplication.
// Returns { baseUrl, cdnType, quality[, originalDims] } or null if not a recognized CDN transform.

// Storyblok: a.storyblok.com/f/SPACE/ORIGWxH/HASH/FILE.ext/m/WxH/filters:format(X):quality(Y)
// Transforms are appended AFTER the filename via /m/ — must fire before generic Thumbor
const STORYBLOK_HOST = /\.storyblok\.com$/;
const STORYBLOK_TRANSFORM = /\/m\/(\d+)x(\d+)(?:\/filters:[^?#]*)?(?:[?#]|$)/;

// Thumbor: /unsafe/WIDTHxHEIGHT/filters:.../PATH  or  /unsafe/smart/PATH
// Variants: some skip /unsafe/, some use /fit-in/, some chain multiple transforms
// Require at least one Thumbor indicator (unsafe, fit-in, dims, smart, or filters) to avoid matching any URL
const THUMBOR_INDICATORS = /\/(?:unsafe|fit-in)\/|\/\d+x\d+\/|\/(?:smart|center|top|bottom|left|right)\/|\/filters:/;
const THUMBOR_PATTERN = /^(https?:\/\/[^/]+)\/(?:unsafe\/)?(?:fit-in\/)?(?:\d+x\d+\/)?(?:(?:smart|center|top|bottom|left|right)\/)*(?:filters:[^/]+\/)*(.+)$/;

// Imgix: ?w=WIDTH&h=HEIGHT&fit=CROP&fm=FORMAT&q=QUALITY&...
// Known Imgix-powered hosts (including white-label CMSes that proxy through Imgix)
const IMGIX_HOSTS = /\.imgix\.net$|\.datocms-assets\.com$|^images\.prismic\.io$/;
const IMGIX_SIZING_PARAMS = /[?&](w|h)=\d/; // require at least one numeric w or h param
const IMGIX_KEYS = ["w", "h", "fit", "crop", "fm", "auto", "q", "dpr", "blur", "sharp",
  "cs", "ch", "mark", "txt", "exp", "faceindex", "facepad", "orient", "flip",
  "usm", "usmrad", "sat", "bri", "con", "hue", "gam", "vib"];

// Cloudinary: /image/upload/c_fill,w_WIDTH,h_HEIGHT,f_FORMAT,q_QUALITY,.../PATH
const CLOUDINARY_PATTERN = /^(https?:\/\/[^/]+\/(?:image|video)\/upload)\/(?:[a-z]_[^/]+(?:,|\/))*(v\d+\/)?(.+)$/;

// Contentful: images.ctfassets.net/SPACE/ID/HASH/NAME?w=WIDTH&h=HEIGHT&fm=FORMAT&q=QUALITY
const CONTENTFUL_PARAMS = /[?&](w|h|fm|q|fit|f|r)=/;
const CONTENTFUL_HOST = /images\.ctfassets\.net/;

// Shopify: cdn.shopify.com/.../file.jpg?v=TIMESTAMP&width=WIDTH
// Also: _WIDTHx. or _WIDTHx_crop_center. in filename
const SHOPIFY_HOST = /cdn\.shopify\.com/;
const SHOPIFY_SIZE_SUFFIX = /_\d+x(?:\d+)?(?:_crop_center)?(?=\.)/;

// WordPress Photon: i[0-3].wp.com proxies origin images with ?w=&h=&resize=&fit=&crop=
const WP_PHOTON_HOST = /^i[0-3]\.wp\.com$/;

// WordPress native size suffixes: /wp-content/uploads/2024/01/photo-300x200.jpg
const WP_SIZE_SUFFIX = /(\/wp-content\/uploads\/.*)-\d+x\d+(\.\w+)$/;

// Wix: static.wixstatic.com/media/HASH.ext/v1/fill/w_X,h_Y,.../name.ext
const WIX_HOST = /^static\.wixstatic\.com$|^static\.parastorage\.com$/;
const WIX_TRANSFORM = /^(\/media\/[^/]+\.\w+)\/v1\/(?:fill|crop|fit)\/.+$/;

// Next.js / Vercel: /_next/image?url=ENCODED_URL&w=WIDTH&q=QUALITY
const NEXTJS_PATH = /^\/_next\/image$/;

// Cloudflare Image Resizing: /cdn-cgi/image/width=X,height=Y,.../ORIGINAL_PATH
const CF_IMAGE_PATH = /^\/cdn-cgi\/image\/([^/]+)\/(.+)$/;

// Sanity.io: cdn.sanity.io/images/PROJECT/DATASET/HASH-WxH.ext?w=X&h=Y&...
const SANITY_HOST = /^cdn\.sanity\.io$/;
const SANITY_DIMS = /-(\d+)x(\d+)\.\w+$/;

// ImageKit: ik.imagekit.io/ACCOUNT/tr:w-X,h-Y/PATH  or  ?tr=w-X,h-Y
const IMAGEKIT_HOST = /^ik\.imagekit\.io$/;
const IMAGEKIT_PATH_TR = /\/tr:[^/]+\//;

/**
 * Normalize a CDN URL to a base key for deduplication.
 * Returns { baseUrl, cdnType, quality[, originalDims] } or null.
 * quality = estimated quality score (higher = better) for picking the best variant.
 *
 * Supports 15 CDN patterns:
 *   Storyblok, Thumbor, Cloudinary, Shopify, Contentful, Imgix (+ DatoCMS, Prismic),
 *   WordPress Photon, WordPress size suffixes, Wix, Next.js/Vercel, Cloudflare,
 *   Sanity.io, ImageKit
 */
function normalizeCdnUrl(url) {
  try {
    const parsed = new URL(url);
    const fullUrl = parsed.href;

    // ── Storyblok ── (must fire before generic Thumbor)
    if (STORYBLOK_HOST.test(parsed.hostname)) {
      const transformMatch = fullUrl.match(STORYBLOK_TRANSFORM);
      if (transformMatch) {
        const baseUrl = fullUrl.slice(0, transformMatch.index);
        const w = parseInt(transformMatch[1]);
        const h = parseInt(transformMatch[2]);
        // Extract original dimensions from the path: /f/SPACE/ORIGWxH/HASH/FILE.ext
        const origDimMatch = baseUrl.match(/\/f\/\d+\/(\d+)x(\d+)\//);
        const originalDims = origDimMatch
          ? { w: parseInt(origDimMatch[1]), h: parseInt(origDimMatch[2]) }
          : null;
        return { baseUrl, cdnType: "storyblok", quality: w * h, originalDims };
      }
      // Storyblok URL without transforms — not a CDN variant
      return null;
    }

    // ── WordPress Photon ── (i0-i3.wp.com proxy with query param transforms)
    if (WP_PHOTON_HOST.test(parsed.hostname)) {
      const width = parseInt(parsed.searchParams.get("w") || parsed.searchParams.get("resize")?.split(",")[0]) || 0;
      const height = parseInt(parsed.searchParams.get("h") || parsed.searchParams.get("resize")?.split(",")[1]) || 0;
      // Original = the proxied URL (path after host) with no query transforms
      const originPath = parsed.pathname.replace(/^\//, "");
      const baseUrl = `https://${originPath}`;
      return { baseUrl, cdnType: "wp-photon", quality: width * (height || 1) };
    }

    // ── Wix ── (static.wixstatic.com/media/HASH.ext/v1/fill|crop|fit/params/name.ext)
    if (WIX_HOST.test(parsed.hostname)) {
      const wixMatch = parsed.pathname.match(WIX_TRANSFORM);
      if (wixMatch) {
        const baseUrl = `${parsed.origin}${wixMatch[1]}`;
        // Extract requested dimensions from transform params
        const wMatch = parsed.pathname.match(/w_(\d+)/);
        const hMatch = parsed.pathname.match(/h_(\d+)/);
        const quality = (wMatch ? parseInt(wMatch[1]) : 0) * (hMatch ? parseInt(hMatch[1]) : 1);
        return { baseUrl, cdnType: "wix", quality };
      }
      return null;
    }

    // ── Sanity.io ── (cdn.sanity.io — query param transforms, dims in filename)
    if (SANITY_HOST.test(parsed.hostname)) {
      const hasTransforms = /[?&](w|h|fit|crop|rect|blur|sharp|q|fm|auto|dpr)=/.test(parsed.search);
      if (hasTransforms) {
        const width = parseInt(parsed.searchParams.get("w")) || 0;
        const height = parseInt(parsed.searchParams.get("h")) || 0;
        const baseUrl = `${parsed.origin}${parsed.pathname}`;
        // Extract original dimensions from filename: HASH-WxH.ext
        const dimMatch = parsed.pathname.match(SANITY_DIMS);
        const originalDims = dimMatch
          ? { w: parseInt(dimMatch[1]), h: parseInt(dimMatch[2]) }
          : null;
        return { baseUrl, cdnType: "sanity", quality: width * (height || 1), originalDims };
      }
      return null;
    }

    // ── ImageKit ── (ik.imagekit.io — path-based tr:params or ?tr= query)
    if (IMAGEKIT_HOST.test(parsed.hostname)) {
      // Path-based: /tr:w-300,h-200/path/to/image.jpg
      if (IMAGEKIT_PATH_TR.test(parsed.pathname)) {
        const cleanPath = parsed.pathname.replace(/\/tr:[^/]+\//, "/");
        const wMatch = parsed.pathname.match(/w-(\d+)/);
        const hMatch = parsed.pathname.match(/h-(\d+)/);
        const quality = (wMatch ? parseInt(wMatch[1]) : 0) * (hMatch ? parseInt(hMatch[1]) : 1);
        const baseUrl = `${parsed.origin}${cleanPath}`;
        return { baseUrl, cdnType: "imagekit", quality };
      }
      // Query-based: ?tr=w-300,h-200
      if (parsed.searchParams.has("tr")) {
        const tr = parsed.searchParams.get("tr");
        const wMatch = tr.match(/w-(\d+)/);
        const hMatch = tr.match(/h-(\d+)/);
        const quality = (wMatch ? parseInt(wMatch[1]) : 0) * (hMatch ? parseInt(hMatch[1]) : 1);
        const baseUrl = `${parsed.origin}${parsed.pathname}`;
        return { baseUrl, cdnType: "imagekit", quality };
      }
      return null;
    }

    // ── Thumbor ── (require at least one Thumbor indicator to avoid false matches)
    if (THUMBOR_INDICATORS.test(fullUrl)) {
      const thumborMatch = fullUrl.match(THUMBOR_PATTERN);
      if (thumborMatch) {
        const origin = thumborMatch[1];
        const path = thumborMatch[2];
        // Extract dimensions from URL for quality scoring
        const dimMatch = fullUrl.match(/\/(\d+)x(\d+)\//);
        const quality = dimMatch ? parseInt(dimMatch[1]) * parseInt(dimMatch[2]) : 0;
        return { baseUrl: `${origin}/${path}`, cdnType: "thumbor", quality };
      }
    }

    // ── Cloudinary ──
    const cloudMatch = fullUrl.match(CLOUDINARY_PATTERN);
    if (cloudMatch) {
      const base = cloudMatch[1];
      const version = cloudMatch[2] || "";
      const path = cloudMatch[3];
      // Extract dimensions from transform params
      const wMatch = fullUrl.match(/w_(\d+)/);
      const hMatch = fullUrl.match(/h_(\d+)/);
      const quality = (wMatch ? parseInt(wMatch[1]) : 0) * (hMatch ? parseInt(hMatch[1]) : 1);
      return { baseUrl: `${base}/${version}${path}`, cdnType: "cloudinary", quality };
    }

    // ── Shopify ──
    if (SHOPIFY_HOST.test(parsed.hostname)) {
      // Strip size suffix from filename: product_800x.jpg → product.jpg
      let cleanPath = parsed.pathname.replace(SHOPIFY_SIZE_SUFFIX, "");
      // Strip sizing query params
      const cleanParams = new URLSearchParams(parsed.search);
      const width = parseInt(cleanParams.get("width")) || 0;
      const height = parseInt(cleanParams.get("height")) || 0;
      cleanParams.delete("width");
      cleanParams.delete("height");
      cleanParams.delete("crop");
      cleanParams.delete("format");
      const qs = cleanParams.toString();
      const baseUrl = `${parsed.origin}${cleanPath}${qs ? "?" + qs : ""}`;
      return { baseUrl, cdnType: "shopify", quality: width * (height || 1) };
    }

    // ── Contentful ──
    if (CONTENTFUL_HOST.test(parsed.hostname) && CONTENTFUL_PARAMS.test(parsed.search)) {
      const width = parseInt(parsed.searchParams.get("w")) || 0;
      const height = parseInt(parsed.searchParams.get("h")) || 0;
      const baseUrl = `${parsed.origin}${parsed.pathname}`;
      return { baseUrl, cdnType: "contentful", quality: width * (height || 1) };
    }

    // ── Next.js / Vercel ── (/_next/image?url=ENCODED&w=WIDTH&q=QUALITY)
    if (NEXTJS_PATH.test(parsed.pathname)) {
      const imageUrl = parsed.searchParams.get("url");
      if (imageUrl) {
        const width = parseInt(parsed.searchParams.get("w")) || 0;
        // Resolve relative URLs against the page origin
        let baseUrl;
        try {
          baseUrl = new URL(imageUrl, parsed.origin).href;
        } catch {
          baseUrl = imageUrl;
        }
        return { baseUrl, cdnType: "nextjs", quality: width };
      }
    }

    // ── Cloudflare Image Resizing ── (/cdn-cgi/image/PARAMS/ORIGINAL_PATH)
    const cfMatch = parsed.pathname.match(CF_IMAGE_PATH);
    if (cfMatch) {
      const params = cfMatch[1]; // e.g. "width=300,height=200,fit=crop"
      const originalPath = cfMatch[2]; // e.g. "images/hero.jpg" or absolute URL
      const wMatch = params.match(/width=(\d+)/);
      const hMatch = params.match(/height=(\d+)/);
      const quality = (wMatch ? parseInt(wMatch[1]) : 0) * (hMatch ? parseInt(hMatch[1]) : 1);
      // Original path can be relative or absolute URL
      let baseUrl;
      if (/^https?:\/\//.test(originalPath)) {
        baseUrl = originalPath;
      } else {
        baseUrl = `${parsed.origin}/${originalPath}`;
      }
      return { baseUrl, cdnType: "cloudflare", quality };
    }

    // ── WordPress native size suffixes ── (photo-300x200.jpg → photo.jpg)
    const wpMatch = parsed.pathname.match(WP_SIZE_SUFFIX);
    if (wpMatch) {
      const dimPart = parsed.pathname.match(/-(\d+)x(\d+)\.\w+$/);
      const width = dimPart ? parseInt(dimPart[1]) : 0;
      const height = dimPart ? parseInt(dimPart[2]) : 0;
      const cleanPath = parsed.pathname.replace(/-\d+x\d+(\.\w+)$/, "$1");
      const baseUrl = `${parsed.origin}${cleanPath}${parsed.search}`;
      return { baseUrl, cdnType: "wordpress", quality: width * height };
    }

    // ── Imgix ── (known hosts OR unknown hosts with numeric w/h params)
    // Known Imgix hosts match immediately; unknown hosts need numeric w or h to avoid false positives
    const isKnownImgix = IMGIX_HOSTS.test(parsed.hostname);
    const hasImgixSizing = IMGIX_SIZING_PARAMS.test(parsed.search);
    if (isKnownImgix || hasImgixSizing) {
      const width = parseInt(parsed.searchParams.get("w")) || 0;
      const height = parseInt(parsed.searchParams.get("h")) || 0;
      const cleanParams = new URLSearchParams(parsed.search);
      for (const key of IMGIX_KEYS) cleanParams.delete(key);
      const qs = cleanParams.toString();
      const baseUrl = `${parsed.origin}${parsed.pathname}${qs ? "?" + qs : ""}`;
      // Only treat as Imgix if we actually stripped meaningful params
      if (baseUrl !== fullUrl) {
        return { baseUrl, cdnType: isKnownImgix ? "imgix" : "imgix-like", quality: width * (height || 1) };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Deduplicate CDN variants: group by normalized base URL, keep the best variant.
 * Also groups srcset variants: images with the same pathname base but different
 * size suffixes (e.g. image-400.jpg, image-800.jpg, image-1200.jpg).
 * Returns the deduplicated array with cdnVariants/cdnType metadata on winners.
 */
function deduplicateAssets(assets) {
  const cdnGroups = new Map();  // baseUrl → [{ asset, quality }]
  const ungrouped = [];

  for (const asset of assets) {
    if (asset.type !== "image") {
      ungrouped.push(asset);
      continue;
    }

    const cdn = normalizeCdnUrl(asset.url);
    if (cdn) {
      const key = cdn.baseUrl;
      if (!cdnGroups.has(key)) cdnGroups.set(key, []);
      cdnGroups.get(key).push({ asset, quality: cdn.quality, cdnType: cdn.cdnType, originalDims: cdn.originalDims, baseUrl: cdn.baseUrl });
    } else {
      ungrouped.push(asset);
    }
  }

  // For each CDN group, pick the best variant (highest quality score or largest contentLength)
  const deduped = [...ungrouped];
  let totalCollapsed = 0;

  for (const [baseUrl, variants] of cdnGroups) {
    // Sort by quality desc, then by contentLength desc as tiebreaker
    variants.sort((a, b) => {
      if (b.quality !== a.quality) return b.quality - a.quality;
      const sizeA = a.asset.contentLength > 0 ? a.asset.contentLength : 0;
      const sizeB = b.asset.contentLength > 0 ? b.asset.contentLength : 0;
      return sizeB - sizeA;
    });

    const winner = variants[0];
    winner.asset.cdnType = winner.cdnType;
    winner.asset.cdnBaseUrl = baseUrl;
    // Always set cdnOriginalUrl — this is the fetchable original (no transforms)
    // Only set if baseUrl differs from the asset's current URL (i.e. transforms were stripped)
    if (baseUrl !== winner.asset.url) {
      winner.asset.cdnOriginalUrl = baseUrl;
    }
    // Attach original dimensions if extractable from URL
    if (winner.originalDims) {
      winner.asset.cdnOriginalDims = winner.originalDims;
    }

    if (variants.length > 1) {
      winner.asset.cdnVariants = variants.length;
      totalCollapsed += variants.length - 1;
    }

    deduped.push(winner.asset);
  }

  if (totalCollapsed > 0) {
    console.log(`[NAS] CDN dedup: collapsed ${totalCollapsed} duplicate variants across ${cdnGroups.size} unique assets`);
  }

  return deduped;
}

// ─── Platform Detection ──────────────────────────────────────────────
const PLATFORM_PATTERNS = {
  instagram: /instagram\.com/,
  youtube:   /youtube\.com|youtu\.be/,
  twitter:   /twitter\.com|:\/\/(?:www\.)?x\.com(?:\/|$)/,
  tiktok:    /tiktok\.com/,
  facebook:  /facebook\.com/,
  vimeo:     /vimeo\.com/,
};

const PLATFORM_LABELS = {
  instagram: "Instagram",
  youtube:   "YouTube",
  twitter:   "Twitter / X",
  tiktok:    "TikTok",
  facebook:  "Facebook",
  vimeo:     "Vimeo",
};

const PLATFORM_SCRIPTS = {
  instagram: "platforms/instagram.js",
  tiktok: "platforms/tiktok.js",
  facebook: "platforms/facebook.js",
  twitter: "platforms/twitter.js",
  youtube: "platforms/youtube.js",
  vimeo: "platforms/vimeo.js",
};

// Page types that are feed/discovery pages (not single-entity targets)
const FEED_PAGE_TYPES = new Set([
  "home", "explore", "search", "list",  // Twitter
  "feed", "discover",                     // TikTok FYP + discover
  "browse",                               // YouTube feed/trending/gaming
  // Facebook/Instagram "home" covered by "home"
]);

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
  initScan();
  initFeedWarning();
  initSettings();
  scanCurrentTab();
});

// ─── Scan current tab ────────────────────────────────────────────────

/** Returns the scan button label based on current quickScan setting. */
function scanButtonLabel() {
  return settings.quickScan ? "Quick Scan ⟳" : "Deep Scan ⟳";
}
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

  // ── Check background for cached deep scan results ──
  // If a deep scan completed (or is in progress) for this tab, use/show that
  // instead of the lightweight scan — deep results are strictly better.
  try {
    const cache = await chrome.runtime.sendMessage({ action: "getScanCache", tabId: tab.id, tabUrl: tab.url });
    if (cache?.cached && cache.status === "complete") {
      // Fresh deep scan results available — use them
      applyScanResults(cache.platformData, cache.domData, cache.networkResources);
      showToast("Restored deep scan results");
      return;
    }
    if (cache?.cached && cache.status === "scanning") {
      // Scan is still running in background — show scanning UI, wait for scanProgress
      const btn = document.getElementById("refreshBtn");
      const btnText = btn?.querySelector("span");
      const scanProgress = document.getElementById("scanProgress");
      const scanFill = document.getElementById("scanProgressFill");
      const scanText = document.getElementById("scanProgressText");
      btn.disabled = true;
      if (btnText) btnText.textContent = "Scanning…";
      scanProgress.style.display = "flex";
      scanFill.style.width = "50%";
      scanText.textContent = "Scan in progress…";
      document.body.classList.add("scanning");
      startBgScanTimer();
      // Don't do lightweight scan — wait for background to finish
      return;
    }
  } catch {
    // getScanCache failed — proceed with lightweight scan
  }

  // ── Lightweight scan (no scrolling — just what's already loaded) ──
  const bgResponse = await chrome.runtime.sendMessage({
    action: "getResources",
    tabId: tab.id,
  });
  const networkResources = bgResponse?.resources || [];

  // Get DOM analysis from content script
  domData = await queryContentScript(tab.id);

  // If on a known platform, also query the platform-specific script
  platformData = null;
  if (detectedPlatform && PLATFORM_SCRIPTS[detectedPlatform]) {
    platformData = await queryPlatformScript(tab.id, detectedPlatform);
  }

  // Merge network resources with DOM context + platform assets
  allAssets = enrichAssets(networkResources, domData?.imageContext || [], platformData);

  // Render
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

  // Check for feed page warning
  checkFeedWarning();
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
  const streamingPlatforms = ["instagram", "tiktok", "facebook", "twitter", "youtube", "vimeo"];
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
    // Filter out malformed URLs with encoded quotes (%22) — phantom DOM entries
    if (r.url.includes('%22')) return false;
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
          existing.username = pAsset.username || existing.username;
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

  // Deduplicate CDN variants — collapse same image at different sizes/formats
  return deduplicateAssets(enriched);
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
let renderOverlayEl = null;
const RENDER_BATCH_SIZE = 20; // Cards per animation frame

function renderGrid() {
  const grid = document.getElementById("assetGrid");
  if (!emptyStateEl) emptyStateEl = document.getElementById("emptyState");
  if (!renderOverlayEl) renderOverlayEl = document.getElementById("renderOverlay");
  const filtered = getFilteredAssets();

  // Cancel any in-progress batch render
  if (window.__nasRenderBatchId) {
    cancelAnimationFrame(window.__nasRenderBatchId);
    window.__nasRenderBatchId = null;
  }

  if (filtered.length === 0) {
    grid.innerHTML = "";
    grid.appendChild(emptyStateEl);
    emptyStateEl.style.display = "flex";
    if (renderOverlayEl) {
      renderOverlayEl.style.display = "none";
      grid.appendChild(renderOverlayEl);
    }
    return;
  }

  emptyStateEl.style.display = "none";
  // Detach empty state before clearing so it survives
  if (emptyStateEl.parentNode === grid) grid.removeChild(emptyStateEl);
  // Detach overlay before clearing
  if (renderOverlayEl && renderOverlayEl.parentNode === grid) grid.removeChild(renderOverlayEl);
  grid.innerHTML = "";

  // For small sets, render synchronously (no jank to worry about)
  if (filtered.length <= RENDER_BATCH_SIZE) {
    for (const asset of filtered) {
      grid.appendChild(createAssetCard(asset));
    }
    return;
  }

  // Large set — batch render with overlay to block interaction
  if (renderOverlayEl) {
    grid.appendChild(renderOverlayEl);
    renderOverlayEl.style.display = "flex";
  }

  let i = 0;
  function renderBatch() {
    const end = Math.min(i + RENDER_BATCH_SIZE, filtered.length);
    // Use DocumentFragment for minimal reflows per batch
    const fragment = document.createDocumentFragment();
    for (; i < end; i++) {
      fragment.appendChild(createAssetCard(filtered[i]));
    }
    // Insert before overlay so overlay stays on top visually
    if (renderOverlayEl && renderOverlayEl.parentNode === grid) {
      grid.insertBefore(fragment, renderOverlayEl);
    } else {
      grid.appendChild(fragment);
    }

    if (i < filtered.length) {
      window.__nasRenderBatchId = requestAnimationFrame(renderBatch);
    } else {
      // Done — remove overlay
      window.__nasRenderBatchId = null;
      if (renderOverlayEl) renderOverlayEl.style.display = "none";
    }
  }

  window.__nasRenderBatchId = requestAnimationFrame(renderBatch);
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
      // CDN assets with verified originals bypass size checks — the thumbnail is tiny
      // but we'll download the full-size original
      if (a.cdnOriginalVerified) return true;
      // Known small file size
      if (a.contentLength > 0 && a.contentLength < SIZE_THRESHOLD) return false;
      // Known tiny dimensions from DOM
      const w = a.domWidth || 0;
      const h = a.domHeight || 0;
      if (w > 0 && h > 0 && w <= settings.minImageSize && h <= settings.minImageSize) return false;
      return true;
    });
  }

  // Hide UI elements — check isUI flag AND URL-based heuristics
  if (hideUI) {
    filtered = filtered.filter((a) => {
      // CDN assets with verified originals are real content, not UI junk
      if (a.cdnOriginalVerified) return true;
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

  // CDN dedup badge — shows when multiple CDN variants were collapsed
  if (asset.cdnVariants && asset.cdnVariants > 1) {
    const cdnBadge = document.createElement("span");
    cdnBadge.className = "card-cdn-badge";
    cdnBadge.textContent = `${asset.cdnVariants} sizes`;
    cdnBadge.title = `Best of ${asset.cdnVariants} CDN variants (${asset.cdnType})`;
    card.appendChild(cdnBadge);
  }

  // CDN original resolution badge — shows when full-size original is verified
  if (asset.cdnOriginalVerified) {
    const origBadge = document.createElement("span");
    origBadge.className = "card-cdn-original-badge";
    if (asset.cdnOriginalDims) {
      origBadge.textContent = `${asset.cdnOriginalDims.w}×${asset.cdnOriginalDims.h}`;
      origBadge.title = `Full-size original available (${asset.cdnOriginalDims.w}×${asset.cdnOriginalDims.h}, ${asset.cdnOriginalSize ? formatBytes(asset.cdnOriginalSize) : "size unknown"}) — ${asset.cdnType}`;
    } else {
      origBadge.textContent = asset.cdnOriginalSize ? formatBytes(asset.cdnOriginalSize) : "original";
      origBadge.title = `Full-size original available (${asset.cdnOriginalSize ? formatBytes(asset.cdnOriginalSize) : "size unknown"}) — ${asset.cdnType}`;
    }
    card.appendChild(origBadge);
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
  // For CDN-verified originals, show the original's size/dims — that's what gets downloaded
  if (asset.cdnOriginalVerified && asset.cdnOriginalSize > 0) {
    meta.textContent = formatBytes(asset.cdnOriginalSize);
  } else if (asset.contentLength > 0) {
    meta.textContent = formatBytes(asset.contentLength);
  }
  if (asset.cdnOriginalVerified && asset.cdnOriginalDims) {
    meta.textContent += (meta.textContent ? " · " : "") + `${asset.cdnOriginalDims.w}×${asset.cdnOriginalDims.h}`;
  } else if (asset.domWidth && asset.domHeight) {
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
    const scanProgress = document.getElementById("scanProgress");
    const scanFill = document.getElementById("scanProgressFill");
    const scanText = document.getElementById("scanProgressText");

    // Show scanning state
    btn.disabled = true;
    btnText.textContent = "Scanning…";
    scanProgress.style.display = "flex";
    scanFill.style.width = "0%";
    scanText.textContent = "Starting scan…";
    document.body.classList.add("scanning");

    // Clear stale state
    allAssets = [];
    domData = null;
    platformData = null;
    detectedPlatform = null;
    selectedUrls.clear();
    feedWarningDismissed = false; // Reset on new scan — page may have changed
    renderGrid();
    renderBadges();
    updateDownloadBar();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && !isRestrictedTab(tab)) {
        detectedPlatform = detectPlatform(tab.url);
        renderPlatformBadge();

        // Route scan through background service worker (survives panel close)
        startBgScanTimer();
        chrome.runtime.sendMessage({
          action: "startScan",
          tabId: tab.id,
          tabUrl: tab.url,
          platform: detectedPlatform,
          platformScript: (detectedPlatform && PLATFORM_SCRIPTS[detectedPlatform]) || null,
          quickScan: settings.quickScan,
        });
        // Results arrive via scanProgress listener in initScan()
        // UI unlock happens there too — nothing more to do here
        return;
      }
    } catch (err) {
      console.error("NAS deep scan error:", err);
    }

    // Only reached if tab was restricted or query failed
    finishScanUI("Cannot scan this page.");
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

  // Estimate size — use CDN original size when available (that's what gets downloaded)
  let totalSize = 0;
  for (const asset of allAssets) {
    if (selectedUrls.has(asset.url)) {
      if (asset.cdnOriginalVerified && asset.cdnOriginalSize > 0) {
        totalSize += asset.cdnOriginalSize;
      } else if (asset.contentLength > 0) {
        totalSize += asset.contentLength;
      }
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
      if (!asset.cdnOriginalVerified) {
        if (asset.contentLength > 0 && asset.contentLength < SIZE_THRESHOLD) continue;
        const w = asset.domWidth || 0;
        const h = asset.domHeight || 0;
        if (w > 0 && h > 0 && w <= settings.minImageSize && h <= settings.minImageSize) continue;
      }
    }
    if (hideUI) {
      if (!asset.cdnOriginalVerified) {
        if (asset.isUI) continue;
        if (asset.url && (UI_URL_PATTERNS.test(asset.url) || UI_CDN_PATTERNS.test(asset.url))) continue;
        const w = asset.domWidth || 0;
        const h = asset.domHeight || 0;
        if (w > 0 && h > 0 && w <= 24 && h <= 24) continue;
      }
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

/**
 * Check if a platform video URL can be fetched directly from the panel
 * (no content-script proxy needed). True for CDN URLs that are
 * self-authenticated via tokens in the URL — no cookies required.
 */
function isDirectFetchableVideo(asset) {
  if (!asset.url) return false;
  // Vimeo progressive MP4s — token-signed, publicly accessible
  if (asset.platformTag?.startsWith("vimeo-") && /akamaized\.net|vimeocdn\.com/.test(asset.url)) {
    return true;
  }
  return false;
}

// ── Safety timeout for background downloads ──
// If the background worker crashes and never sends "done"/"error",
// the UI stays locked forever. This timer auto-unlocks after 120s.
const BG_DOWNLOAD_TIMEOUT_MS = 120_000;
let _bgDownloadTimer = null;

function clearBgDownloadTimer() {
  if (_bgDownloadTimer) {
    clearTimeout(_bgDownloadTimer);
    _bgDownloadTimer = null;
  }
}

function startBgDownloadTimer() {
  clearBgDownloadTimer();
  _bgDownloadTimer = setTimeout(() => {
    console.error("[downloadKit] Background download timed out after 120s — unlocking UI");
    const progressEl = document.getElementById("downloadProgress");
    const btn = document.getElementById("downloadBtn");
    document.body.classList.remove("downloading");
    if (progressEl) progressEl.style.display = "none";
    if (btn) {
      btn.style.display = "";
      btn.disabled = false;
      btn.textContent = "Download Kit ↓";
    }
    updateDownloadBar();
    showToast("Download timed out — background worker may have crashed. Try again.");
  }, BG_DOWNLOAD_TIMEOUT_MS);
}

function initDownload() {
  document.getElementById("downloadBtn").addEventListener("click", downloadKit);

  // Listen for background download progress (survives popup close/reopen)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== "downloadProgress") return;
    const progressEl = document.getElementById("downloadProgress");
    const progressFill = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    const btn = document.getElementById("downloadBtn");

    if (msg.phase === "starting") {
      // Download just started in background — lock UI, show progress
      btn.style.display = "none";
      progressEl.style.display = "flex";
      progressFill.style.width = "0%";
      progressFill.classList.remove("pulsing");
      progressText.textContent = "Starting download…";
      document.body.classList.add("downloading");
      startBgDownloadTimer();
    }

    if (msg.phase === "fetching") {
      // Asset fetch progress — update bar and text
      const pct = msg.total > 0 ? Math.round((msg.completed / msg.total) * 100) : 0;
      progressFill.style.width = `${pct}%`;
      progressFill.classList.remove("pulsing");
      const failedNote = msg.failed > 0 ? ` · ${msg.failed} failed` : "";
      progressText.textContent = msg.detail || `${msg.completed} / ${msg.total}${failedNote}`;
      // Reset safety timer on each progress tick (worker is alive)
      startBgDownloadTimer();
    }

    if (msg.phase === "zipping") {
      // Zipping phase — pulsing bar, almost done
      progressFill.style.width = "100%";
      progressFill.classList.add("pulsing");
      progressText.textContent = msg.detail || "Zipping…";
      // Reset safety timer — zipping can take a moment for huge kits
      startBgDownloadTimer();
    }

    if (msg.phase === "done") {
      // Download complete — unlock UI, show success toast
      clearBgDownloadTimer();
      progressFill.classList.remove("pulsing");
      document.body.classList.remove("downloading");
      progressEl.style.display = "none";
      btn.style.display = "";
      btn.disabled = false;
      btn.textContent = "Download Kit ↓";
      updateDownloadBar();
      showToast(msg.detail || "Kit downloaded");
    }

    if (msg.phase === "error") {
      // Download failed — unlock UI, show error toast
      clearBgDownloadTimer();
      progressFill.classList.remove("pulsing");
      document.body.classList.remove("downloading");
      progressEl.style.display = "none";
      btn.style.display = "";
      btn.disabled = false;
      btn.textContent = "Download Kit ↓";
      updateDownloadBar();
      showToast(msg.detail || "Download failed. Check console.");
    }
  });
}

// ─── Background Scan Progress Listener ───────────────────────────────
// Mirrors the downloadProgress listener pattern. Background sends
// scanProgress messages as it orchestrates the deep scan.

let _bgScanTimer = null;
const BG_SCAN_TIMEOUT_MS = 60000; // 60s safety timeout for scans

function startBgScanTimer() {
  clearTimeout(_bgScanTimer);
  _bgScanTimer = setTimeout(() => {
    console.error("[scan] Background scan timed out after 60s — unlocking UI");
    finishScanUI("Scan timed out — try again.");
  }, BG_SCAN_TIMEOUT_MS);
}

function clearBgScanTimer() {
  clearTimeout(_bgScanTimer);
  _bgScanTimer = null;
}

/** Restore scan UI to idle state with optional toast. */
function finishScanUI(toastMsg) {
  clearBgScanTimer();
  const btn = document.getElementById("refreshBtn");
  const btnText = btn?.querySelector("span");
  const scanProgress = document.getElementById("scanProgress");
  document.body.classList.remove("scanning");
  if (scanProgress) scanProgress.style.display = "none";
  if (btn) btn.disabled = false;
  if (btnText) btnText.textContent = scanButtonLabel();
  if (toastMsg) showToast(toastMsg);
}

/** Apply scan results to panel state and render everything. */
function applyScanResults(pData, dData, netResources) {
  platformData = pData;
  domData = dData;
  const rawCount = (netResources || []).length;
  allAssets = enrichAssets(netResources || [], dData?.imageContext || [], pData);
  const enrichedCount = allAssets.length;
  const filteredCount = getFilteredAssets().length;
  console.log(`[NAS] Asset pipeline: ${rawCount} raw → ${enrichedCount} enriched → ${filteredCount} after filters`);

  // Auto-select logos if enabled (before rendering so cards show as selected)
  if (settings.autoSelectLogos) {
    allAssets.filter((a) => a.isLogo).forEach((a) => selectedUrls.add(a.url));
  }

  renderGrid();
  renderBadges();
  updateDownloadBar();
  if (dData) {
    renderColors(dData.colors);
    renderFonts(dData.fontInfo);
    renderMeta(dData.pageMeta);
  }
  if (pData?.platformMeta) {
    renderPlatformMeta(pData.platformMeta, detectedPlatform);
  }
  checkFeedWarning();

  // Enable guideline button now that we have scan data
  const guidelineBtn = document.getElementById("openGuidelineBtn");
  if (guidelineBtn && dData) {
    guidelineBtn.disabled = false;
  }

  // ── CDN original resolution (async) ───────────────────────────────
  // After initial render, verify CDN original URLs in the background.
  // When verified, update assets and re-render to show originals.
  verifyCdnOriginals();
}

/** Show final scan-complete toast with accurate counts (called after CDN verification). */
function showScanCompleteToast() {
  const visibleCount = getFilteredAssets().length;
  const totalCount = allAssets.length;
  const filterNote = visibleCount < totalCount ? ` (${totalCount - visibleCount} filtered)` : "";
  const mode = settings.quickScan ? "Quick" : "Deep";
  showToast(`${mode} scan complete — ${visibleCount} assets${filterNote}`);
}

/**
 * Async CDN original resolution: collect all cdnOriginalUrl candidates,
 * send HEAD requests via background worker to verify they're fetchable,
 * then update assets with verified original size and re-render.
 */
async function verifyCdnOriginals() {
  // Collect unique CDN original URLs that differ from the served URL
  const candidates = allAssets.filter((a) => a.cdnOriginalUrl && a.cdnOriginalUrl !== a.url);
  if (candidates.length === 0) {
    // No CDN candidates — show final scan toast with current counts
    showScanCompleteToast();
    return;
  }

  const uniqueUrls = [...new Set(candidates.map((a) => a.cdnOriginalUrl))];
  console.log(`[NAS] CDN resolution: verifying ${uniqueUrls.length} original URLs…`);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "verifyCdnOriginals",
      urls: uniqueUrls,
    });
    if (!response?.results) return;

    let verified = 0;
    for (const asset of candidates) {
      const result = response.results[asset.cdnOriginalUrl];
      if (result?.ok) {
        asset.cdnOriginalVerified = true;
        asset.cdnOriginalSize = result.size;
        asset.cdnOriginalType = result.type;
        verified++;
      } else {
        // HEAD failed — remove the original URL so we don't try to download it
        delete asset.cdnOriginalUrl;
        delete asset.cdnOriginalDims;
      }
    }

    console.log(`[NAS] CDN resolution: ${verified}/${candidates.length} originals verified`);

    if (verified > 0) {
      // Re-render to show updated cards with original info + unfilter verified assets
      const visibleAfter = getFilteredAssets().length;
      console.log(`[NAS] CDN resolution: re-rendering — ${visibleAfter} assets visible after filters`);
      renderGrid();
      renderBadges();
      updateDownloadBar();
    }
    // Show final scan toast with accurate post-verification counts
    showScanCompleteToast();
  } catch (err) {
    console.warn("[NAS] CDN resolution failed:", err);
    showScanCompleteToast(); // Still show toast even if CDN verification fails
  }
}

function initScan() {
  // Listen for background scan progress (survives panel close/reopen)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== "scanProgress") return;

    const scanProgressEl = document.getElementById("scanProgress");
    const scanFill = document.getElementById("scanProgressFill");
    const scanText = document.getElementById("scanProgressText");

    if (msg.phase === "platform-scan" || msg.phase === "dom-scan") {
      // Scan is running — show progress, reset safety timer
      scanProgressEl.style.display = "flex";
      document.body.classList.add("scanning");
      if (msg.phase === "platform-scan") {
        scanFill.style.width = "30%";
        scanText.textContent = msg.detail || "Scrolling page…";
      } else {
        scanFill.style.width = "70%";
        scanText.textContent = msg.detail || "Analyzing assets…";
      }
      startBgScanTimer();
    }

    if (msg.phase === "complete") {
      // Scan complete — apply results, unlock UI
      scanFill.style.width = "100%";
      scanText.textContent = "Done";
      applyScanResults(msg.platformData, msg.domData, msg.networkResources);
      // NOTE: asset count is deferred — verifyCdnOriginals() runs async and
      // changes the visible count. The final toast fires from there instead.
      setTimeout(() => {
        finishScanUI(); // no toast — CDN verification will show the final count
      }, 600); // Brief flash of 100%
    }

    if (msg.phase === "error") {
      // Scan failed — unlock UI, show error
      finishScanUI(msg.detail || "Scan failed. Check console.");
    }
  });
}

/** Route download: transcode assets → panel pipeline, everything else → background worker. */
async function downloadKit() {
  const btn = document.getElementById("downloadBtn");
  const progressEl = document.getElementById("downloadProgress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");

  btn.style.display = "none";
  progressEl.style.display = "flex";
  progressFill.style.width = "0%";
  document.body.classList.add("downloading");

  const selected = allAssets.filter((a) => selectedUrls.has(a.url));
  if (selected.length === 0) {
    showToast("No assets selected");
    document.body.classList.remove("downloading");
    progressEl.style.display = "none";
    btn.style.display = "";
    return;
  }

  // Split: Instagram transcode assets stay in panel, everything else goes to background
  const transcodeAssets = selected.filter((a) => a.needsMux || a.isMSECapture);
  const bgAssets = selected.filter((a) => !a.needsMux && !a.isMSECapture);

  // If we have transcode assets, handle them in the panel (needs WebCodecs/GPU)
  if (transcodeAssets.length > 0 && bgAssets.length === 0) {
    // All transcode — run legacy panel pipeline
    return downloadKitInPanel(selected);
  }

  if (transcodeAssets.length > 0) {
    // Mixed — run transcode in panel first, then send rest to background
    // For now, show a warning and run everything in panel (legacy path)
    progressText.textContent = "Processing video transcode…";
    return downloadKitInPanel(selected);
  }

  // All non-transcode — delegate entirely to background service worker
  progressText.textContent = "Starting download…";
  startBgDownloadTimer();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Send serializable asset data to background
    // Resolve relative URLs against the tab's origin — service worker has no page context
    const pageOrigin = new URL(tab.url).origin;
    const serializableAssets = bgAssets.map((a) => {
      // Use CDN original URL for download when verified — get full-size instead of thumbnail
      let downloadUrl = a.cdnOriginalVerified && a.cdnOriginalUrl ? a.cdnOriginalUrl : a.url;
      // Resolve relative URLs against the tab's origin — service worker has no page context
      if (downloadUrl.startsWith("/")) downloadUrl = `${pageOrigin}${downloadUrl}`;
      else if (!downloadUrl.startsWith("http") && !downloadUrl.startsWith("data:") && !downloadUrl.startsWith("blob:")) downloadUrl = `${pageOrigin}/${downloadUrl}`;
      return {
        url: downloadUrl,
        type: a.type,
        ext: a.ext,
        contentType: a.contentType,
        displayName: a.displayName,
        platformTag: a.platformTag,
        username: a.username,
        domWidth: a.cdnOriginalDims?.w || a.domWidth,
        domHeight: a.cdnOriginalDims?.h || a.domHeight,
        isLogo: a.isLogo,
        isMSECapture: false,
        needsMux: false,
      };
    });

    chrome.runtime.sendMessage({
      action: "downloadKit",
      assets: serializableAssets,
      domData: domData ? {
        colors: domData.colors,
        fontInfo: domData.fontInfo,
        pageMeta: domData.pageMeta,
        copy: domData.copy,
        ctas: domData.ctas,
        typographyScale: domData.typographyScale,
        socialLinks: domData.socialLinks,
        structuredData: domData.structuredData,
        favicons: domData.favicons,
        colorSemantics: domData.colorSemantics,
      } : null,
      platform: detectedPlatform,
      platformMeta: platformData?.platformMeta || null,
      tabId: tab.id,
      settings,
    });

    // Progress is now handled by the onMessage listener in initDownload().
    // Panel can close — download continues in background.
    progressText.textContent = "Downloading in background…";

  } catch (err) {
    console.error("Failed to start background download:", err);
    clearBgDownloadTimer();
    // Fallback to panel-based download
    return downloadKitInPanel(selected);
  }
}

/** Legacy panel-based download — used for Instagram transcode (needs WebCodecs). */
async function downloadKitInPanel() {
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
    let failed = 0;
    let totalBytes = 0;

    // Update progress UI
    function updateProgress(subPercent) {
      // subPercent (0-100) interpolates between completed/total and (completed+1)/total
      // for smooth feedback during long transcode/mux operations
      const basePct = total > 0 ? (completed / total) * 100 : 0;
      const slicePct = total > 0 ? (1 / total) * 100 : 0;
      const sub = typeof subPercent === "number" ? Math.min(subPercent, 100) : 0;
      const pct = Math.round(basePct + slicePct * (sub / 100));
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
            updateProgress(5);
            const vidResult = await chrome.tabs.sendMessage(tab.id, {
              action: "fetchBlob",
              url: asset.url,
            });
            if (vidResult?.error) throw new Error(`Video fetch: ${vidResult.error}`);
            let videoBuffer = await dataUrlToArrayBuffer(vidResult.dataUrl);

            // 2. Fetch audio buffer
            progressText.textContent = `Fetching audio ${vidLabel}…`;
            updateProgress(15);
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
                  updateProgress(20 + (percent * 0.6)); // 20-80% of sub-progress
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
                updateProgress(80 + (percent * 0.2)); // 80-100% of sub-progress
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

        } else if (asset.url.startsWith("blob:") || (asset.type === "video" && asset.platformTag && !isDirectFetchableVideo(asset))) {
          // Blob URLs and platform video CDN URLs must be fetched from the
          // PAGE context (content script) — the extension panel can't access
          // Instagram/TikTok CDN due to CORS and missing auth cookies.
          // Exception: Vimeo progressive URLs are self-authenticated (token in URL)
          // and can be fetched directly from the panel.
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
          // Use CDN original URL when verified — download full-size instead of thumbnail
          const fetchUrl = asset.cdnOriginalVerified && asset.cdnOriginalUrl ? asset.cdnOriginalUrl : asset.url;
          const response = await fetch(fetchUrl);
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

        targetFolder.file(fileName, blob, { binary: true, compression: "STORE" });
        totalBytes += blob.size;
        completed++;
        updateProgress();
      } catch (err) {
        console.error(`Failed to fetch ${asset.url}:`, err);
        failed++;
        completed++;
        updateProgress();
      }
    });

    await Promise.all(promises);

    // Zipping phase
    progressText.textContent = `Zipping ${completed} files…`;
    progressFill.style.width = "100%";

    // Add brand.json — mirror background.js buildBrandKit() structure
    if (domData) {
      const meta = domData.pageMeta || {};
      const colorSemantics = domData.colorSemantics || {};
      const brandKit = {
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
        assetCount: completed - failed,
      };
      zip.file("brand.json", JSON.stringify(brandKit, null, 2));

      // Request guideline HTML from background (generateBrandGuideHTML lives there)
      try {
        const resp = await chrome.runtime.sendMessage({ action: "generateGuideHTML", kit: brandKit });
        if (resp?.html) zip.file("brand-guideline.html", resp.html);
      } catch (e) {
        console.warn("[downloadKit] Could not generate guideline HTML:", e);
      }
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

    // Generate zip — STORE compression (binary assets are already compressed)
    const content = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const dateStr = new Date().toISOString().slice(0, 10);
    const metaUser = platformData?.platformMeta?.username;
    let zipName;
    if (detectedPlatform && metaUser) {
      zipName = `@${metaUser.replace(/^@/, "")}-${detectedPlatform}-assets-${dateStr}.zip`;
    } else if (detectedPlatform) {
      zipName = `${detectedPlatform}-assets-${dateStr}.zip`;
    } else {
      const hostname = document.getElementById("siteName").textContent.replace(/[^a-z0-9.-]/gi, "_");
      zipName = `${hostname || "assets"}-brand-kit-${dateStr}.zip`;
    }
    zipName = sanitizeFilename(zipName);

    // Download
    const blobUrl = URL.createObjectURL(content);
    chrome.downloads.download({ url: blobUrl, filename: zipName }, () => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError);
      }
      URL.revokeObjectURL(blobUrl);
    });

    const succeeded = completed - failed;
    const failedNote = failed > 0 ? ` (${failed} failed)` : "";
    showToast(`Kit downloaded — ${succeeded} files · ${formatBytes(totalBytes)}${failedNote}`);
  } catch (err) {
    console.error("Kit generation failed:", err);
    showToast("Download failed. Check console.");
  } finally {
    document.body.classList.remove("downloading");
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
  // ── Smart naming: @username-platformTag-WxH.ext ──────────────────
  // Tier 1: Platform asset with username → @nike-twitter-banner-1500x500.jpg
  // Tier 2: Platform asset, no username  → twitter-banner-1500x500.jpg
  // Tier 3: Non-platform asset           → alt text / URL-derived fallback
  const e = ext || guessExt(asset);

  if (asset.platformTag) {
    const parts = [];
    if (asset.username) parts.push(`@${asset.username.replace(/^@/, "")}`);
    parts.push(asset.platformTag);
    // Append dimensions when known (useful for picking the right size)
    const w = asset.domWidth || 0;
    const h = asset.domHeight || 0;
    if (w > 0 && h > 0) parts.push(`${w}x${h}`);
    return sanitizeFilename(parts.join("-") + "." + e);
  }

  // Non-platform: fall back to display name with corrected extension
  let name = asset.displayName;
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    const currentExt = name.substring(dotIdx + 1).toLowerCase();
    if (currentExt !== e && e) name = name.substring(0, dotIdx) + "." + e;
  } else if (e) {
    name = name + "." + e;
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

function formatCount(n) {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
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

// ─── Feed Page Warning ───────────────────────────────────────────────
// Shows a dismissible amber banner when the user is on a feed/discovery page
// (homepage, explore, search) where assets come from multiple accounts.
let feedWarningDismissed = false;

function checkFeedWarning() {
  if (feedWarningDismissed) return;
  const banner = document.getElementById("feedWarning");
  if (!banner) return;

  const pageType = platformData?.pageType;
  if (!pageType || !FEED_PAGE_TYPES.has(pageType)) {
    banner.style.display = "none";
    return;
  }

  // Customize message per platform/page
  const textEl = document.getElementById("feedWarningText");
  const platformLabel = PLATFORM_LABELS[detectedPlatform] || "this platform";
  const pageLabel = pageType === "home" ? "homepage feed"
    : pageType === "feed" ? "For You feed"
    : pageType === "explore" ? "Explore page"
    : pageType === "discover" ? "Discover page"
    : pageType === "search" ? "search results"
    : pageType === "list" ? "list feed"
    : "feed page";

  textEl.textContent = `You're on the ${pageLabel} — content from multiple accounts. Navigate to a specific ${platformLabel} profile or post for clean brand assets.`;
  banner.style.display = "flex";
}

function initFeedWarning() {
  const closeBtn = document.getElementById("feedWarningClose");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      feedWarningDismissed = true;
      document.getElementById("feedWarning").style.display = "none";
    });
  }
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

  if (platform === "twitter") {
    if (meta.username) platformRows.push({ label: "user", value: `@${meta.username}` });
    if (meta.name) platformRows.push({ label: "name", value: meta.name });
    if (meta.bio) platformRows.push({ label: "bio", value: meta.bio.slice(0, 120) + (meta.bio.length > 120 ? "…" : "") });
    if (meta.followers) platformRows.push({ label: "followers", value: formatCount(meta.followers) });
    if (meta.following) platformRows.push({ label: "following", value: formatCount(meta.following) });
    if (meta.verified) platformRows.push({ label: "verified", value: "✓" });
  }

  if (platform === "youtube") {
    if (meta.username) platformRows.push({ label: "channel", value: `@${meta.username}` });
    if (meta.name) platformRows.push({ label: "name", value: meta.name });
    if (meta.subscribers) platformRows.push({ label: "subscribers", value: meta.subscribers });
  }

  if (platform === "tiktok") {
    if (meta.username) platformRows.push({ label: "user", value: `@${meta.username}` });
    if (meta.displayName) platformRows.push({ label: "name", value: meta.displayName });
    if (meta.bio) platformRows.push({ label: "bio", value: meta.bio.slice(0, 120) + (meta.bio.length > 120 ? "…" : "") });
    if (meta.verified) platformRows.push({ label: "verified", value: "✓" });
    if (meta.stats?.followers) platformRows.push({ label: "followers", value: formatCount(meta.stats.followers) });
    if (meta.stats?.likes) platformRows.push({ label: "likes", value: formatCount(meta.stats.likes) });
  }

  if (platform === "vimeo") {
    if (meta.username) platformRows.push({ label: "user", value: meta.username });
    if (meta.name) platformRows.push({ label: "name", value: meta.name });
  }

  if (platform === "facebook") {
    if (meta.username) platformRows.push({ label: "user", value: meta.username });
    if (meta.name) platformRows.push({ label: "name", value: meta.name });
    if (meta.category) platformRows.push({ label: "category", value: meta.category });
    if (meta.about) platformRows.push({ label: "about", value: meta.about.slice(0, 120) + (meta.about.length > 120 ? "…" : "") });
    if (meta.website) platformRows.push({ label: "website", value: meta.website });
    if (meta.followers) platformRows.push({ label: "followers", value: formatCount(meta.followers) });
    if (meta.verified) platformRows.push({ label: "verified", value: "✓" });
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

// ─── Settings ────────────────────────────────────────────────────────

function initSettings() {
  const gearBtn = document.getElementById("settingsBtn");
  const panel = document.getElementById("settingsPanel");
  const compressToggle = document.getElementById("settingCompress");
  const autoLogosToggle = document.getElementById("settingAutoLogos");
  const minSizeSelect = document.getElementById("settingMinSize");
  const quickScanToggle = document.getElementById("settingQuickScan");

  // Load persisted settings
  chrome.storage.local.get("nasSettings", (result) => {
    if (result.nasSettings) {
      settings = { ...SETTINGS_DEFAULTS, ...result.nasSettings };
    }
    // Apply to UI
    compressToggle.checked = settings.compressImages;
    autoLogosToggle.checked = settings.autoSelectLogos;
    minSizeSelect.value = String(settings.minImageSize);
    quickScanToggle.checked = settings.quickScan;
    // Set scan button label to match persisted mode
    const btnText = document.getElementById("refreshBtn")?.querySelector("span");
    if (btnText) btnText.textContent = scanButtonLabel();
  });

  // Gear button toggles panel visibility
  gearBtn.addEventListener("click", () => {
    const isOpen = panel.style.display !== "none";
    panel.style.display = isOpen ? "none" : "block";
    gearBtn.classList.toggle("active", !isOpen);
  });

  // Persist on change
  compressToggle.addEventListener("change", () => {
    settings.compressImages = compressToggle.checked;
    chrome.storage.local.set({ nasSettings: settings });
  });

  autoLogosToggle.addEventListener("change", () => {
    settings.autoSelectLogos = autoLogosToggle.checked;
    chrome.storage.local.set({ nasSettings: settings });
  });

  minSizeSelect.addEventListener("change", () => {
    settings.minImageSize = parseInt(minSizeSelect.value, 10);
    chrome.storage.local.set({ nasSettings: settings });
    // Re-render grid immediately so they see the effect
    renderGrid();
    renderBadges();
  });

  quickScanToggle.addEventListener("change", () => {
    settings.quickScan = quickScanToggle.checked;
    chrome.storage.local.set({ nasSettings: settings });
    // Update scan button label reactively
    const btnText = document.getElementById("refreshBtn")?.querySelector("span");
    if (btnText) btnText.textContent = scanButtonLabel();
  });

  // ── Open Brand Guideline button ──
  const guidelineBtn = document.getElementById("openGuidelineBtn");
  if (guidelineBtn) {
    guidelineBtn.addEventListener("click", async () => {
      if (!domData) {
        showToast("No brand data yet — scan a page first");
        return;
      }

      guidelineBtn.disabled = true;
      guidelineBtn.textContent = "Generating…";

      try {
        const response = await chrome.runtime.sendMessage({
          action: "generateGuideline",
          domData: {
            colors: domData.colors,
            fontInfo: domData.fontInfo,
            pageMeta: domData.pageMeta,
            copy: domData.copy,
            ctas: domData.ctas,
            typographyScale: domData.typographyScale,
            socialLinks: domData.socialLinks,
            structuredData: domData.structuredData,
            favicons: domData.favicons,
            colorSemantics: domData.colorSemantics,
          },
        });

        if (response.error) throw new Error(response.error);

        // Store kit data in session storage, then open the viewer extension page.
        // The viewer page is a real chrome-extension:// page — its own <script src> is
        // treated as 'self' by CSP, so full JS interactivity works (no inline scripts).
        try {
          await chrome.storage.session.set({ guidelineKit: response.kit });
        } catch {
          // Fallback for older Chrome without session storage
          await chrome.storage.local.set({ guidelineKit: response.kit });
        }
        chrome.tabs.create({ url: chrome.runtime.getURL("guideline-viewer.html") });
      } catch (err) {
        console.error("Failed to generate guideline:", err);
        showToast("Failed to generate guideline");
      } finally {
        guidelineBtn.disabled = false;
        guidelineBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Open Brand Guideline`;
      }
    });
  }
}
