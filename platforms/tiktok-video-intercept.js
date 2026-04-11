// ─── Net Assets Scraper V2 — TikTok Video Intercept (MAIN world) ─────
// Runs in MAIN world to intercept TikTok's API responses that contain
// video download URLs and media metadata.
//
// TikTok no longer puts video data in SSR script tags (SIGI_STATE or
// __UNIVERSAL_DATA_FOR_REHYDRATION__). All video/user data is now loaded
// via XHR/fetch API calls after initial page render. This script
// monkey-patches fetch() and XMLHttpRequest to capture those responses.
//
// Captured data is stored on window.__NAS_TIKTOK_DATA__ for the
// ISOLATED world content script (tiktok.js) to read.

(function () {
  if (window.__NAS_TIKTOK_INTERCEPT_LOADED__) return;
  window.__NAS_TIKTOK_INTERCEPT_LOADED__ = true;

  // Storage for intercepted data
  window.__NAS_TIKTOK_DATA__ = {
    videos: new Map(),   // videoId → { url, width, height, cover, author, desc }
    users: new Map(),    // uniqueId → { avatar, nickname, verified, ... }
    ready: false,
  };

  const store = window.__NAS_TIKTOK_DATA__;

  // ─── API URL patterns that carry video/user data ──────────────────
  const API_PATTERNS = [
    /\/api\/item\/detail/,           // Single video detail
    /\/api\/post\/item_list/,        // Profile video list
    /\/api\/recommend\/item_list/,   // For You feed
    /\/api\/related\/item_list/,     // Related videos
    /\/api\/comment\/list/,          // Comments (has author data)
    /\/api\/user\/detail/,           // User profile
    /\/node\/share\/video/,          // Share endpoint (has video data)
    /\/tiktok\/v1\/video/,           // Legacy v1 endpoint
  ];

  function isVideoApiUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      return API_PATTERNS.some((p) => p.test(u.pathname));
    } catch {
      return false;
    }
  }

  // ─── Data extraction from API response ────────────────────────────

  function extractFromResponse(data) {
    if (!data || typeof data !== "object") return;
    walkApiResponse(data, 0);
    store.ready = true;
  }

  const MAX_DEPTH = 12;

  function walkApiResponse(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) return;

    if (Array.isArray(obj)) {
      for (const item of obj) walkApiResponse(item, depth + 1);
      return;
    }

    // Video item — has video.playAddr or video.downloadAddr
    if (obj.video && (obj.video.playAddr || obj.video.downloadAddr || obj.video.play_addr)) {
      const video = obj.video;
      const id = obj.id || video.id || null;
      if (id && !store.videos.has(id)) {
        // Extract URL from various formats
        const playAddr = video.playAddr || video.play_addr;
        const downloadAddr = video.downloadAddr || video.download_addr;

        const playUrl = typeof playAddr === "string"
          ? playAddr
          : playAddr?.url_list?.[0] || playAddr?.urlList?.[0] || null;
        const downloadUrl = typeof downloadAddr === "string"
          ? downloadAddr
          : downloadAddr?.url_list?.[0] || downloadAddr?.urlList?.[0] || null;

        const url = downloadUrl || playUrl;
        if (url) {
          const author = typeof obj.author === "string"
            ? obj.author
            : obj.author?.unique_id || obj.author?.uniqueId || null;

          store.videos.set(id, {
            url,
            playUrl: playUrl || null,
            downloadUrl: downloadUrl || null,
            width: video.width || video.play_addr?.width || 0,
            height: video.height || video.play_addr?.height || 0,
            duration: video.duration || 0,
            cover: video.origin_cover?.url_list?.[0] || video.originCover
              || video.cover?.url_list?.[0] || video.cover || null,
            dynamicCover: video.dynamic_cover?.url_list?.[0] || video.dynamicCover || null,
            author,
            desc: obj.desc || "",
            createTime: obj.create_time || obj.createTime || 0,
          });
          console.log(`[NAS TikTok intercept] Captured video ${id} (${video.width}x${video.height})`);
        }
      }
    }

    // User data
    if ((obj.unique_id || obj.uniqueId) && (obj.avatar_larger || obj.avatarLarger)) {
      const uid = obj.unique_id || obj.uniqueId;
      if (!store.users.has(uid)) {
        store.users.set(uid, {
          uniqueId: uid,
          nickname: obj.nickname || null,
          avatarLarger: obj.avatar_larger?.url_list?.[0] || obj.avatarLarger || null,
          avatarMedium: obj.avatar_medium?.url_list?.[0] || obj.avatarMedium || null,
          signature: obj.signature || null,
          verified: obj.verified || false,
          followerCount: obj.follower_count || obj.followerCount || 0,
        });
        console.log(`[NAS TikTok intercept] Captured user @${uid}`);
      }
    }

    // Recurse
    for (const key of Object.keys(obj)) {
      walkApiResponse(obj[key], depth + 1);
    }
  }

  // ─── fetch() monkey-patch ─────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (isVideoApiUrl(url)) {
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
  // TikTok sometimes uses XHR instead of fetch

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__nas_url = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__nas_url && isVideoApiUrl(this.__nas_url)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          extractFromResponse(data);
        } catch {}
      });
    }
    return originalSend.apply(this, args);
  };

  // ─── Also try to parse any SSR data that might exist ──────────────
  // Even though TikTok mostly uses CSR now, occasionally SSR data
  // still appears. Belt and suspenders.

  function parseExistingSSR() {
    // __UNIVERSAL_DATA_FOR_REHYDRATION__
    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (el) {
        const data = JSON.parse(el.textContent);
        const scope = data?.__DEFAULT_SCOPE__;
        if (scope) {
          // Video detail
          const itemStruct = scope["webapp.video-detail"]?.itemInfo?.itemStruct;
          if (itemStruct) extractFromResponse(itemStruct);
          // User detail
          const userInfo = scope["webapp.user-detail"]?.userInfo;
          if (userInfo?.user) extractFromResponse(userInfo);
        }
      }
    } catch {}

    // SIGI_STATE
    try {
      const el = document.getElementById("SIGI_STATE");
      if (el) {
        const data = JSON.parse(el.textContent);
        if (data?.ItemModule) {
          for (const item of Object.values(data.ItemModule)) {
            extractFromResponse(item);
          }
        }
        if (data?.UserModule) {
          for (const user of Object.values(data.UserModule)) {
            extractFromResponse(user);
          }
        }
      }
    } catch {}
  }

  // Parse SSR data immediately (it's already in the DOM)
  parseExistingSSR();

  // ─── postMessage bridge (CSP-safe MAIN↔ISOLATED communication) ────
  // Content scripts can't inject inline scripts on sites with strict CSP.
  // Instead, they use window.postMessage to request data and blob fetches.

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    // Share intercepted video/user data with ISOLATED world
    if (msg?.type === "NAS_TIKTOK_GET_DATA") {
      window.postMessage({
        type: "NAS_TIKTOK_DATA_RESPONSE",
        requestId: msg.requestId,
        data: {
          videos: Object.fromEntries(store.videos),
          users: Object.fromEntries(store.users),
          ready: store.ready,
        },
      }, "*");
    }

    // Fetch a URL with full page cookies (MAIN world has full cookie jar)
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

  console.log("[NAS TikTok intercept] Fetch/XHR intercept + postMessage bridge active");
})();
