// ─── Net Assets Scraper V2 — Vimeo Platform Script ───────────────────
// Extracts brand assets from Vimeo pages:
//   - Video download URLs (H.264 MP4 from progressive config — no transcode)
//   - Video thumbnails (multiple resolutions)
//   - User/channel avatars
//   - Profile metadata (name, bio, follower counts)
//
// Data sources (priority order):
//   1. MAIN world API intercept (vimeo-video-intercept.js) — richest, captures config API
//   2. OG meta tags + JSON-LD — fast, reliable for basic info + thumbnails
//   3. Inline player config (progressive[] array) — direct MP4 URLs (increasingly rare)
//   4. DOM scraping — fallback for profile/showcase pages
//
// Vimeo is the friendliest platform for asset extraction:
//   - Progressive MP4 URLs are H.264 with muxed audio
//   - Config JSON is right there in the page
//   - No obfuscation, no cipher games
//
// Page types:
//   - Video:    vimeo.com/123456789
//   - User:     vimeo.com/username
//   - Showcase: vimeo.com/showcase/ID
//   - Channel:  vimeo.com/channels/NAME

// Guard against duplicate injection
if (window.__NAS_VIMEO_LOADED__) {
  // Already loaded — skip
} else {
  window.__NAS_VIMEO_LOADED__ = true;

// ─── Constants ───────────────────────────────────────────────────────
const VIMEO_CDN = /vimeocdn\.com|vimeo\.com|akamaized\.net/;
const VIMEO_VIDEO_CDN = /vod-progressive\.akamaized\.net|player\.vimeo\.com\/progressive_redirect/;

// ─── Page Type Detection ─────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname;

  if (/^\/\d+\/?$/.test(path))                         return "video";
  if (/^\/[\w-]+\/\d+\/?$/.test(path))                 return "video"; // vimeo.com/user/12345
  if (/^\/showcase\/\d+/.test(path))                    return "showcase";
  if (/^\/channels\/[\w-]+/.test(path))                 return "channel";
  if (/^\/categories\/[\w-]+/.test(path))               return "category";
  if (/^\/manage\//.test(path))                         return "manage";
  if (/^\/[\w.-]+\/?$/.test(path) && path !== "/")      return "user";
  if (/^\/[\w.-]+\/videos\/?$/.test(path))              return "user-videos";

  return "other";
}

// ─── OG Meta Tags ────────────────────────────────────────────────────

function getMeta(property) {
  const el = document.querySelector(`meta[property="${property}"]`)
    || document.querySelector(`meta[name="${property}"]`);
  return el?.getAttribute("content") || null;
}

function extractMetaData() {
  return {
    name: getMeta("og:title"),
    description: getMeta("og:description") || getMeta("description"),
    image: getMeta("og:image"),
    url: getMeta("og:url"),
    type: getMeta("og:type"),
    videoUrl: getMeta("og:video:url") || getMeta("og:video:secure_url"),
    videoWidth: parseInt(getMeta("og:video:width") || "0", 10),
    videoHeight: parseInt(getMeta("og:video:height") || "0", 10),
  };
}

// ─── JSON-LD Extraction ──────────────────────────────────────────────
// Vimeo uses VideoObject schema — has thumbnail, duration, etc.

function extractJsonLd() {
  const results = {
    videos: [],
    thumbnail: null,
    author: null,
  };

  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      let data = JSON.parse(script.textContent);
      // Could be array or single object
      if (Array.isArray(data)) data = data[0];

      if (data["@type"] === "VideoObject") {
        results.videos.push({
          name: data.name || null,
          description: data.description || null,
          thumbnail: data.thumbnailUrl || null,
          duration: data.duration || null,
          uploadDate: data.uploadDate || null,
          embedUrl: data.embedUrl || null,
        });
        if (data.thumbnailUrl && !results.thumbnail) {
          results.thumbnail = data.thumbnailUrl;
        }
        if (data.author) {
          results.author = {
            name: data.author.name || null,
            url: data.author.url || null,
          };
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

// ─── Player Config Extraction ────────────────────────────────────────
// Vimeo embeds player config in inline scripts. The progressive[]
// array contains direct H.264 MP4 download URLs at various qualities.

function parsePlayerConfig() {
  const results = {
    videos: [],
    thumbnail: null,
    owner: null,
  };

  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;

    // Look for config objects containing progressive video URLs
    // Patterns vary: window.playerConfig, clip_page_config, etc.
    const configPatterns = [
      /window\.playerConfig\s*=\s*(\{.+?\});/s,
      /var\s+config\s*=\s*(\{.+?"progressive".+?\});/s,
      /"progressive"\s*:\s*(\[.+?\])/s,
    ];

    for (const pattern of configPatterns) {
      const match = text.match(pattern);
      if (!match) continue;

      try {
        let data = JSON.parse(match[1]);

        // If we matched the progressive array directly
        if (Array.isArray(data)) {
          processProgressiveArray(data, results);
          continue;
        }

        // Navigate to progressive array within config
        const progressive = data?.request?.files?.progressive
          || data?.video?.files?.progressive;
        if (progressive) {
          processProgressiveArray(progressive, results);
        }

        // Extract thumbnail from config
        const thumb = data?.video?.thumbs?.base
          || data?.video?.thumbs?.["1280"]
          || data?.video?.thumbs?.["640"];
        if (thumb && !results.thumbnail) {
          results.thumbnail = thumb;
        }

        // Extract owner info
        const owner = data?.video?.owner;
        if (owner && !results.owner) {
          results.owner = {
            name: owner.name || null,
            url: owner.url || null,
            img: owner.img || owner.img_2x || null,
            id: owner.id || null,
          };
        }
      } catch { /* skip */ }
    }

    // Also look for config_url pattern — we can't fetch it cross-origin,
    // but its presence confirms this is a video page
    if (text.includes('"config_url"')) {
      // Try to extract video ID from the config_url
      const idMatch = text.match(/"config_url"\s*:\s*"[^"]*\/video\/(\d+)\//);
      if (idMatch && !results.videoId) {
        results.videoId = idMatch[1];
      }
    }
  }

  return results;
}

function processProgressiveArray(progressive, results) {
  // Sort by quality (highest first) — use width or quality label
  const sorted = [...progressive].sort((a, b) => {
    const aW = a.width || 0;
    const bW = b.width || 0;
    return bW - aW;
  });

  for (const entry of sorted) {
    if (!entry.url) continue;
    // Only include video/mp4 (skip DASH/HLS)
    if (entry.mime && !entry.mime.includes("video/mp4")) continue;

    if (!results.videos.some((v) => v.url === entry.url)) {
      results.videos.push({
        url: entry.url,
        width: entry.width || 0,
        height: entry.height || 0,
        quality: entry.quality || entry.rendition || null,
        fps: entry.fps || 0,
        codec: "h264",
      });
    }
  }
}

// ─── Image URL Manipulation ──────────────────────────────────────────
// Vimeo thumbnail URLs have dimensions embedded:
//   i.vimeocdn.com/video/123456_1280x720.jpg
// We can change them for different sizes.

function upgradeThumbnailUrl(url) {
  if (!url) return null;
  // Replace dimension suffix with larger size
  return url.replace(/_\d+x\d+/, "_1920x1080")
    .replace(/-d_\d+x\d+/, "-d_1920x1080");
}

function upgradePortraitUrl(url) {
  if (!url) return null;
  // Portrait URLs: _300x300 → _600x600
  return url.replace(/_\d+x\d+/, "_600x600");
}

// ─── DOM Scraping (Fallback) ─────────────────────────────────────────

function extractFromDOM() {
  const data = {
    name: null,
    avatar: null,
    videos: [],
    thumbnails: [],
  };

  // User/channel name
  const nameEl = document.querySelector(
    '.header--tall h1, [class*="user_name"], .js-user_link'
  );
  if (nameEl) data.name = nameEl.textContent.trim();

  // Avatar
  const avatarSelectors = [
    '.header--tall img[src*="vimeocdn.com"]',
    'img[src*="portrait"]',
    '.user_avatar img',
  ];
  for (const sel of avatarSelectors) {
    const el = document.querySelector(sel);
    if (el?.src && VIMEO_CDN.test(el.src)) {
      data.avatar = upgradePortraitUrl(el.src);
      break;
    }
  }

  // Video thumbnails from clip listings
  const thumbEls = document.querySelectorAll(
    'img[src*="vimeocdn.com/video"], img[src*="i.vimeocdn.com"]'
  );
  const seen = new Set();
  for (const el of thumbEls) {
    if (!el.src || seen.has(el.src) || !VIMEO_CDN.test(el.src)) continue;
    seen.add(el.src);
    data.thumbnails.push({
      url: upgradeThumbnailUrl(el.src),
      alt: el.alt || "",
      width: el.naturalWidth || 0,
      height: el.naturalHeight || 0,
    });
  }

  return data;
}

// ─── Username/ID Extraction ──────────────────────────────────────────

function extractUsername() {
  // From og:url for user pages
  const ogUrl = getMeta("og:url");
  if (ogUrl) {
    const m = ogUrl.match(/vimeo\.com\/([\w.-]+)$/);
    if (m) return m[1];
  }
  // From URL path (user pages)
  const pathMatch = window.location.pathname.match(/^\/([\w.-]+)\/?$/);
  if (pathMatch && !/^\d+$/.test(pathMatch[1]) && pathMatch[1] !== "showcase") {
    return pathMatch[1];
  }
  return null;
}

function extractVideoId() {
  // From URL: /123456789
  const m = window.location.pathname.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

// ─── MAIN World Intercept Data (via postMessage bridge) ──────────────
// Reads data captured by vimeo-video-intercept.js (MAIN world).
// Uses postMessage because MAIN and ISOLATED worlds can't share globals.

async function readInterceptData() {
  const requestId = `nas_vm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(null);
    }, 2000);

    function handler(event) {
      if (event.source !== window) return;
      const msg = event.data;
      if (msg?.type !== "NAS_VIMEO_DATA_RESPONSE") return;
      if (msg.requestId !== requestId) return;

      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      resolve(msg.data || null);
    }

    window.addEventListener("message", handler);
    window.postMessage({ type: "NAS_VIMEO_GET_DATA", requestId }, "*");
  });
}

// ─── Main Analyzer ───────────────────────────────────────────────────

async function analyzeVimeo() {
  const pageType = detectPageType();
  const result = {
    platform: "vimeo",
    pageType,
    assets: [],
    platformMeta: {},
  };

  const username = extractUsername();
  const videoId = extractVideoId();
  const meta = extractMetaData();
  const jsonLd = extractJsonLd();
  const config = parsePlayerConfig();
  const dom = extractFromDOM();

  // ── Read intercepted API data (from MAIN world) ──
  const intercepted = await readInterceptData();

  // Merge intercepted video data into config results
  if (intercepted?.videos) {
    // Group by videoId, take highest quality per video
    const byVideo = new Map();
    for (const [qualityKey, video] of Object.entries(intercepted.videos)) {
      if (!video.url) continue;
      const vid = video.videoId || videoId || "unknown";
      const existing = byVideo.get(vid);
      if (!existing || (video.width || 0) > (existing.width || 0)) {
        byVideo.set(vid, video);
      }
    }
    // Add best quality videos that aren't already in config
    for (const [vid, video] of byVideo) {
      if (!config.videos.some((v) => v.url === video.url)) {
        config.videos.unshift({
          url: video.url,
          width: video.width || 0,
          height: video.height || 0,
          quality: video.quality || null,
          fps: video.fps || 0,
          codec: "h264",
        });
      }
    }
  }

  // Merge intercepted owner data
  if (intercepted?.users) {
    for (const [key, user] of Object.entries(intercepted.users)) {
      if (!config.owner && user.name) {
        config.owner = {
          name: user.name,
          url: user.url || null,
          img: user.img || null,
          id: user.id || null,
        };
      }
    }
  }

  // Merge intercepted thumbnail data
  if (intercepted?.thumbnails) {
    for (const [vid, thumb] of Object.entries(intercepted.thumbnails)) {
      if (thumb.url && !config.thumbnail) {
        config.thumbnail = thumb.url;
      }
    }
  }

  // Build platform metadata
  result.platformMeta = {
    name: config.owner?.name || jsonLd.author?.name || dom.name || meta.name || null,
    username: username,
    ownerId: config.owner?.id || null,
    ownerUrl: config.owner?.url || jsonLd.author?.url || null,
  };

  const resolvedUsername = result.platformMeta.username || username;

  // ── Owner/user avatar ──
  const avatar = config.owner?.img || dom.avatar || null;
  if (avatar && VIMEO_CDN.test(avatar)) {
    result.assets.push({
      url: upgradePortraitUrl(avatar),
      type: "image",
      context: "profile-pic",
      isLogo: true,
      isUI: false,
      alt: `${result.platformMeta.name || resolvedUsername || "vimeo"} avatar`,
      width: 0,
      height: 0,
      platformTag: "vimeo-avatar",
      username: resolvedUsername,
    });
  }

  // ── Video thumbnail ──
  const thumbnail = config.thumbnail || jsonLd.thumbnail || meta.image || null;
  if (thumbnail && VIMEO_CDN.test(thumbnail)) {
    result.assets.push({
      url: upgradeThumbnailUrl(thumbnail),
      type: "image",
      context: "video-thumbnail",
      isLogo: false,
      isUI: false,
      alt: meta.name || jsonLd.videos[0]?.name || "",
      width: meta.videoWidth || 0,
      height: meta.videoHeight || 0,
      platformTag: "vimeo-thumbnail",
      username: resolvedUsername,
      shortcode: videoId,
    });
  }

  // ── Videos from player config ──
  // Progressive MP4s are H.264 with muxed audio — no pipeline needed
  // Only include the best quality to avoid duplicate downloads
  if (config.videos.length > 0) {
    const best = config.videos[0]; // Already sorted highest-first
    result.assets.push({
      url: best.url,
      type: "video",
      context: pageType === "video" ? "single-video" : "feed-video",
      isLogo: false,
      isUI: false,
      alt: meta.name || jsonLd.videos[0]?.name || "",
      width: best.width || meta.videoWidth || 0,
      height: best.height || meta.videoHeight || 0,
      platformTag: "vimeo-video",
      videoId: videoId,
      username: resolvedUsername,
      shortcode: videoId,
      needsMux: false,
      needsTranscode: false,
      codec: "h264",
      quality: best.quality,
    });

    // If there's also an SD version, include it as alternative
    if (config.videos.length > 1) {
      const sd = config.videos[config.videos.length - 1];
      if (sd.url !== best.url) {
        result.assets.push({
          url: sd.url,
          type: "video",
          context: "sd-fallback",
          isLogo: false,
          isUI: false,
          alt: `${meta.name || ""} (SD)`,
          width: sd.width || 0,
          height: sd.height || 0,
          platformTag: "vimeo-video-sd",
          videoId: videoId,
          username: resolvedUsername,
          shortcode: videoId,
          needsMux: false,
          needsTranscode: false,
          codec: "h264",
          quality: sd.quality,
        });
      }
    }
  }

  // ── OG image fallback ──
  const seenUrls = new Set(result.assets.map((a) => a.url));
  if (meta.image && !seenUrls.has(meta.image)) {
    const upgraded = upgradeThumbnailUrl(meta.image);
    if (!seenUrls.has(upgraded)) {
      result.assets.push({
        url: upgraded,
        type: "image",
        context: "og-image",
        isLogo: false,
        isUI: false,
        alt: meta.name || "",
        width: 0,
        height: 0,
        platformTag: "vimeo-og-image",
        username: resolvedUsername,
      });
      seenUrls.add(upgraded);
    }
  }

  // ── DOM thumbnails (profile/showcase pages) ──
  for (const thumb of dom.thumbnails) {
    if (seenUrls.has(thumb.url)) continue;
    seenUrls.add(thumb.url);
    result.assets.push({
      url: thumb.url,
      type: "image",
      context: "video-thumbnail",
      isLogo: false,
      isUI: false,
      alt: thumb.alt || "",
      width: thumb.width || 0,
      height: thumb.height || 0,
      platformTag: "vimeo-thumbnail",
      username: resolvedUsername,
    });
  }

  return result;
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzePlatform") {
    analyzeVimeo()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Vimeo script error:", err);
        sendResponse({ platform: "vimeo", error: err.message });
      });
    return true; // Async — waiting for intercept data
  }

  if (message.action === "deepScanPlatform") {
    deepScanVimeo()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Vimeo deep scan error:", err);
        sendResponse({ platform: "vimeo", error: err.message });
      });
    return true; // Async
  }
});

// ─── Deep Scan ───────────────────────────────────────────────────────
// Scroll user/showcase pages to load more video listings.

async function deepScanVimeo() {
  const pageType = detectPageType();

  if (["user", "user-videos", "showcase", "channel"].includes(pageType)) {
    const maxDuration = 15000;
    const stepDelay = 600;
    const startTime = Date.now();
    const originalScroll = window.scrollY;

    let lastHeight = document.documentElement.scrollHeight;
    let stableCount = 0;

    while ((Date.now() - startTime) < maxDuration && stableCount < 3) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      await new Promise((r) => setTimeout(r, stepDelay));

      const newHeight = document.documentElement.scrollHeight;
      if (newHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = newHeight;
      }
    }

    window.scrollTo({ top: originalScroll, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 300));
  }

  return await analyzeVimeo();
}

} // end duplicate injection guard
