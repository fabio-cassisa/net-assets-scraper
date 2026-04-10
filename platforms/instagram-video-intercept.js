// ─── Net Assets Scraper V2 — Instagram Video Interceptor ─────────────
// Runs in MAIN world (page JS context) to capture Instagram video URLs.
//
// Strategy (dual approach, ordered by reliability):
//
//   1. FETCH INTERCEPTION (primary) — patches window.fetch to inspect
//      Instagram's GraphQL/API responses. These contain `video_url` and
//      `video_versions` fields pointing to complete, downloadable CDN
//      MP4 files. Works in ALL Chromium browsers, survives SPA navigation.
//
//   2. MSE INTERCEPTION (fallback) — patches SourceBuffer.appendBuffer
//      to capture DASH segments as they're fed to MediaSource. Requires
//      reassembly into a playable file. More fragile, browser-dependent.
//
// The content script (ISOLATED world) queries both via postMessage bridge.

(function () {
  "use strict";

  // Guard against double injection
  if (window.__NAS_VIDEO_INTERCEPTED__) return;
  window.__NAS_VIDEO_INTERCEPTED__ = true;

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 1: Fetch Interception — capture video URLs from API data
  // ═══════════════════════════════════════════════════════════════════

  // Storage: url → { url, width, height, timestamp }
  const videoUrls = new Map();

  // Instagram API endpoint patterns
  const API_PATTERNS = [
    /instagram\.com\/graphql\/query/,
    /instagram\.com\/api\/graphql/,
    /instagram\.com\/api\/v1\//,
  ];

  // Instagram video CDN pattern
  const VIDEO_CDN_PATTERN = /scontent[.-]|cdninstagram\.com|fbcdn\.net/;

  // ─── Patch window.fetch ────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);

    try {
      // Only inspect Instagram API responses
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (API_PATTERNS.some((p) => p.test(url))) {
        // Clone so the original response stream isn't consumed
        const clone = response.clone();
        // Parse async — don't block the caller
        extractVideoUrlsFromResponse(clone).catch(() => {});
      }
    } catch {
      // Never break Instagram's normal operation
    }

    return response;
  };

  // ─── Patch XMLHttpRequest for older API calls ──────────────────────
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._nasUrl = url;
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._nasUrl && API_PATTERNS.some((p) => p.test(this._nasUrl))) {
      this.addEventListener("load", function () {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            const data = JSON.parse(this.responseText);
            walkForVideoUrls(data, 0);
          }
        } catch {
          // Silent — don't break XHR
        }
      });
    }
    return origXhrSend.apply(this, args);
  };

  // ─── Extract video URLs from a fetch response ──────────────────────
  async function extractVideoUrlsFromResponse(response) {
    const contentType = response.headers?.get("content-type") || "";
    if (!contentType.includes("json") && !contentType.includes("text")) return;

    const text = await response.text();
    // Quick check before expensive parse
    if (!text.includes("video")) return;

    try {
      const data = JSON.parse(text);
      walkForVideoUrls(data, 0);
    } catch {
      // Not valid JSON — skip
    }
  }

  // ─── Recursively walk JSON for video URL fields ────────────────────
  const MAX_DEPTH = 20;

  function walkForVideoUrls(obj, depth) {
    if (!obj || depth > MAX_DEPTH) return;
    if (typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walkForVideoUrls(item, depth + 1);
      }
      return;
    }

    // Check for video_versions array (highest quality variant)
    if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
      // Sort by width descending → pick highest quality
      const sorted = [...obj.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0));
      const best = sorted[0];
      if (best?.url && VIDEO_CDN_PATTERN.test(best.url)) {
        addVideoUrl(best.url, best.width || 0, best.height || 0);
      }
    }

    // Check for direct video_url field
    if (typeof obj.video_url === "string" && VIDEO_CDN_PATTERN.test(obj.video_url)) {
      addVideoUrl(obj.video_url, obj.video_width || obj.original_width || 0, obj.video_height || obj.original_height || 0);
    }

    // Recurse into all values
    for (const key of Object.keys(obj)) {
      if (key === "video_versions" || key === "video_url") continue; // already handled
      walkForVideoUrls(obj[key], depth + 1);
    }
  }

  function addVideoUrl(url, width, height) {
    if (videoUrls.has(url)) return;
    videoUrls.set(url, {
      url,
      width: width || 0,
      height: height || 0,
      timestamp: Date.now(),
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 2: MSE Interception — capture DASH segments (fallback)
  // ═══════════════════════════════════════════════════════════════════

  // Storage: videoId → { codec, buffers: [Uint8Array], totalBytes }
  const mseCaptures = new Map();
  const msToUrl = new WeakMap();
  let videoCounter = 0;

  // ─── Patch URL.createObjectURL ─────────────────────────────────────
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      msToUrl.set(obj, url);
    }
    return url;
  };

  // ─── Patch SourceBuffer.appendBuffer ───────────────────────────────
  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const ms = this._mediaSource || null;
      const videoId = getVideoId(ms);

      if (videoId && data && data.byteLength > 0) {
        if (!mseCaptures.has(videoId)) {
          const codec = this.mimeType || this._mimeType || "video/mp4";
          mseCaptures.set(videoId, {
            codec,
            buffers: [],
            totalBytes: 0,
            timestamp: Date.now(),
          });
        }

        const capture = mseCaptures.get(videoId);
        // True copy — original buffer may be reused/detached
        const raw = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data.buffer
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const copy = new Uint8Array(raw);
        capture.buffers.push(copy);
        capture.totalBytes += copy.byteLength;
      }
    } catch {
      // Never break video playback
    }

    return origAppendBuffer.call(this, data);
  };

  // ─── Patch MediaSource.addSourceBuffer ─────────────────────────────
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    sb._mediaSource = this;
    sb._mimeType = mimeType;
    return sb;
  };

  function getVideoId(mediaSource) {
    if (!mediaSource) return `nas-video-${++videoCounter}`;
    const url = msToUrl.get(mediaSource);
    if (url) return url;
    if (!mediaSource.__nasId) {
      mediaSource.__nasId = `nas-video-${++videoCounter}`;
    }
    return mediaSource.__nasId;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API — exposed for content script via postMessage bridge
  // ═══════════════════════════════════════════════════════════════════

  window.__NAS_VIDEO_CAPTURES__ = {
    // MSE captures
    list() {
      const result = [];
      for (const [id, capture] of mseCaptures) {
        result.push({
          id,
          codec: capture.codec,
          totalBytes: capture.totalBytes,
          segmentCount: capture.buffers.length,
          timestamp: capture.timestamp,
        });
      }
      result.sort((a, b) => b.timestamp - a.timestamp);
      return result;
    },

    reassemble(id) {
      const capture = mseCaptures.get(id);
      if (!capture || capture.buffers.length === 0) return null;
      return new Blob(capture.buffers, { type: "video/mp4" });
    },

    async reassembleAsDataUrl(id) {
      const blob = this.reassemble(id);
      if (!blob) return null;
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    },

    get count() { return mseCaptures.size; },
    clear() { mseCaptures.clear(); },
    remove(id) { mseCaptures.delete(id); },
  };

  // Fetch-intercepted video URLs (primary strategy)
  window.__NAS_VIDEO_URLS__ = {
    list() {
      return Array.from(videoUrls.values()).sort((a, b) => b.timestamp - a.timestamp);
    },
    get count() { return videoUrls.size; },
    clear() { videoUrls.clear(); },
  };

  // ─── Cross-world message bridge ────────────────────────────────────
  window.addEventListener("message", async (event) => {
    if (event.data?.source !== "nas-content") return;

    // Fetch-intercepted URLs (primary)
    if (event.data.type === "get-video-urls") {
      window.postMessage({
        source: "nas-mse",
        type: "video-url-list",
        videos: window.__NAS_VIDEO_URLS__.list(),
      }, "*");
    }

    // MSE captures (fallback)
    if (event.data.type === "get-video-list") {
      window.postMessage({
        source: "nas-mse",
        type: "video-list",
        videos: window.__NAS_VIDEO_CAPTURES__.list(),
      }, "*");
    }

    if (event.data.type === "get-video-data") {
      const dataUrl = await window.__NAS_VIDEO_CAPTURES__.reassembleAsDataUrl(event.data.id);
      window.postMessage({
        source: "nas-mse",
        type: "video-data",
        id: event.data.id,
        dataUrl,
      }, "*");
    }
  });

  console.log("[NAS] Video interceptor active (fetch + MSE)");
})();
