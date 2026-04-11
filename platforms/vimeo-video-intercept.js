// ─── Net Assets Scraper V2 — Vimeo Video Intercept (MAIN world) ──────
// Runs in MAIN world to intercept Vimeo's player config API responses
// that contain progressive MP4 download URLs and video metadata.
//
// Vimeo loads player config via separate JSON fetches to endpoints like
// /video/ID/config or player.vimeo.com/video/ID/config. The inline
// window.playerConfig pattern is no longer reliable. This script
// monkey-patches fetch() and XMLHttpRequest to capture those responses
// and extract progressive[] MP4 URLs.
//
// Captured data is stored on window.__NAS_VIMEO_DATA__ for the
// ISOLATED world content script (vimeo.js) to read via postMessage.

(function () {
  if (window.__NAS_VIMEO_INTERCEPT_LOADED__) return;
  window.__NAS_VIMEO_INTERCEPT_LOADED__ = true;

  // Storage for intercepted data
  window.__NAS_VIMEO_DATA__ = {
    videos: new Map(),     // videoId → { url, width, height, quality, fps, codec }
    users: new Map(),      // ownerId → { name, url, img, id }
    thumbnails: new Map(), // videoId → { url, width, height }
    ready: false,
  };

  const store = window.__NAS_VIMEO_DATA__;

  // ─── API URL patterns that carry video/player config data ─────────
  const API_PATTERNS = [
    /\/video\/\d+\/config/,          // Player config endpoint
    /\/videos\/\d+/,                 // Video detail API
    /\/api\/v2\//,                   // Vimeo API v2
    /\/player\.vimeo\.com\//,        // Embedded player requests
  ];

  function isVimeoApiUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      return API_PATTERNS.some((p) => p.test(u.pathname + u.hostname));
    } catch {
      return false;
    }
  }

  // Also match by response content — some config URLs don't match patterns
  // but contain progressive arrays. We check response JSON as fallback.

  // ─── Data extraction from API response ────────────────────────────

  function extractFromResponse(data) {
    if (!data || typeof data !== "object") return;
    walkApiResponse(data, 0);
    store.ready = true;
  }

  const MAX_DEPTH = 15;

  function walkApiResponse(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) return;

    if (Array.isArray(obj)) {
      for (const item of obj) walkApiResponse(item, depth + 1);
      return;
    }

    // Progressive MP4 array — the main prize
    // Found at: request.files.progressive[] or video.files.progressive[]
    const progressive = obj.progressive || obj.files?.progressive;
    if (Array.isArray(progressive) && progressive.length > 0) {
      processProgressiveArray(progressive, obj);
    }

    // Direct video object with progressive field at different paths
    if (obj.request?.files?.progressive) {
      processProgressiveArray(obj.request.files.progressive, obj);
    }
    if (obj.video?.files?.progressive) {
      processProgressiveArray(obj.video.files.progressive, obj);
    }

    // Owner/user data
    const owner = obj.video?.owner || obj.owner;
    if (owner && owner.name && !store.users.has(owner.id || owner.name)) {
      const key = owner.id || owner.name;
      store.users.set(key, {
        name: owner.name || null,
        url: owner.url || null,
        img: owner.img_2x || owner.img || null,
        id: owner.id || null,
        account: owner.account_type || null,
      });
      console.log(`[NAS Vimeo intercept] Captured owner: ${owner.name}`);
    }

    // Thumbnail data
    const thumbs = obj.video?.thumbs;
    if (thumbs) {
      const videoId = obj.video?.id || null;
      if (videoId && !store.thumbnails.has(videoId)) {
        const thumbUrl = thumbs["1280"] || thumbs.base || thumbs["640"] || null;
        if (thumbUrl) {
          store.thumbnails.set(videoId, {
            url: thumbUrl.replace(/_\d+x\d+/, "_1920x1080"),
            width: 1920,
            height: 1080,
          });
        }
      }
    }

    // Also check for thumbnail in pictures.sizes array (API v2 format)
    if (obj.pictures?.sizes && Array.isArray(obj.pictures.sizes)) {
      const videoId = obj.uri?.match(/\/videos\/(\d+)/)?.[1] || obj.resource_key || null;
      if (videoId && !store.thumbnails.has(videoId)) {
        // Get largest thumbnail
        const sorted = [...obj.pictures.sizes].sort((a, b) => (b.width || 0) - (a.width || 0));
        if (sorted[0]?.link) {
          store.thumbnails.set(videoId, {
            url: sorted[0].link,
            width: sorted[0].width || 0,
            height: sorted[0].height || 0,
          });
        }
      }
    }

    // Recurse into all keys
    for (const key of Object.keys(obj)) {
      // Skip known large/irrelevant branches to save CPU
      if (key === "text_tracks" || key === "seo" || key === "embed") continue;
      walkApiResponse(obj[key], depth + 1);
    }
  }

  function processProgressiveArray(progressive, context) {
    // Sort by width (highest first)
    const sorted = [...progressive].sort((a, b) => (b.width || 0) - (a.width || 0));

    for (const entry of sorted) {
      if (!entry.url) continue;
      // Only MP4 (skip DASH/HLS manifests)
      if (entry.mime && !entry.mime.includes("video/mp4")) continue;

      // Build a unique key from URL or dimensions
      const videoId = context?.video?.id
        || context?.id
        || entry.url.match(/\/(\d+)\//)?.[1]
        || entry.url;

      // Store each quality variant keyed by "videoId:quality"
      const qualityKey = `${videoId}:${entry.quality || entry.width || "unknown"}`;

      if (!store.videos.has(qualityKey)) {
        store.videos.set(qualityKey, {
          url: entry.url,
          width: entry.width || 0,
          height: entry.height || 0,
          quality: entry.quality || entry.rendition || null,
          fps: entry.fps || 0,
          codec: "h264",
          videoId: String(videoId),
          size: entry.size || 0,
        });
        console.log(`[NAS Vimeo intercept] Captured video ${videoId} (${entry.width}x${entry.height} ${entry.quality || ""})`);
      }
    }
  }

  // ─── fetch() monkey-patch ─────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (isVimeoApiUrl(url)) {
      try {
        const clone = response.clone();
        clone.json().then((data) => {
          extractFromResponse(data);
        }).catch(() => {});
      } catch {}
    }

    return response;
  };

  // ─── XMLHttpRequest monkey-patch ──────────────────────────────────
  // Some Vimeo player embeds use XHR for config fetches

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__nas_url = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__nas_url && isVimeoApiUrl(this.__nas_url)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          extractFromResponse(data);
        } catch {}
      });
    }
    return originalSend.apply(this, args);
  };

  // ─── Also try to parse inline config data that might exist ────────
  // Belt and suspenders — some pages still have inline config JSON.

  function parseExistingConfigs() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent;
      if (!text || !text.includes("progressive")) continue;

      // Try to find config objects with progressive arrays
      const patterns = [
        /window\.playerConfig\s*=\s*(\{.+?\});/s,
        /var\s+config\s*=\s*(\{.+?"progressive".+?\});/s,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            extractFromResponse(data);
          } catch {}
        }
      }
    }
  }

  // Parse any existing inline configs
  parseExistingConfigs();

  // ─── postMessage bridge (CSP-safe MAIN<->ISOLATED communication) ───

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    // Share intercepted video/user/thumbnail data with ISOLATED world
    if (msg?.type === "NAS_VIMEO_GET_DATA") {
      window.postMessage({
        type: "NAS_VIMEO_DATA_RESPONSE",
        requestId: msg.requestId,
        data: {
          videos: Object.fromEntries(store.videos),
          users: Object.fromEntries(store.users),
          thumbnails: Object.fromEntries(store.thumbnails),
          ready: store.ready,
        },
      }, "*");
    }

    // Fetch a URL with full page cookies (MAIN world has full cookie jar)
    // Vimeo CDN URLs (vod-progressive.akamaized.net) may need credentials
    if (msg?.type === "NAS_MAIN_FETCH" && msg.url) {
      try {
        const r = await fetch(msg.url, { credentials: "include" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const blob = await r.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          window.postMessage({
            type: "NAS_MAIN_FETCH_RESPONSE",
            requestId: msg.requestId,
            dataUrl: reader.result,
            contentType: blob.type,
            size: blob.size,
          }, "*");
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        window.postMessage({
          type: "NAS_MAIN_FETCH_RESPONSE",
          requestId: msg.requestId,
          error: err.message,
        }, "*");
      }
    }
  });

  console.log("[NAS Vimeo intercept] Fetch/XHR intercept + postMessage bridge active");
})();
