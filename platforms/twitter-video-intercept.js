// ─── Net Assets Scraper V2 — Twitter/X Video Intercept (MAIN world) ──
// Runs in MAIN world to intercept Twitter/X's GraphQL API responses
// that contain video download URLs and media metadata.
//
// Twitter/X loads all tweet/user data via GraphQL API calls to
// /i/api/graphql/... — SSR hydration data is no longer available.
// This script monkey-patches fetch() and XMLHttpRequest to capture
// those responses and extract video variant URLs.
//
// Captured data is stored on window.__NAS_TWITTER_DATA__ for the
// ISOLATED world content script (twitter.js) to read via postMessage.

(function () {
  if (window.__NAS_TWITTER_INTERCEPT_LOADED__) return;
  window.__NAS_TWITTER_INTERCEPT_LOADED__ = true;

  // Storage for intercepted data
  window.__NAS_TWITTER_DATA__ = {
    videos: new Map(),   // mediaKey → { url, width, height, thumbnail, type, bitrate }
    users: new Map(),    // screenName → { name, profilePic, banner, bio, ... }
    images: new Map(),   // mediaKey → { url, width, height, alt }
    ready: false,
  };

  const store = window.__NAS_TWITTER_DATA__;

  // ─── API URL patterns that carry tweet/user data ──────────────────
  const API_PATTERNS = [
    /\/i\/api\/graphql\//,           // Main GraphQL endpoint
    /\/i\/api\/2\//,                 // REST v2 API
    /\/i\/api\/1\.1\//,              // REST v1.1 API
  ];

  function isTwitterApiUrl(url) {
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

  const MAX_DEPTH = 20;

  function walkApiResponse(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) return;

    if (Array.isArray(obj)) {
      for (const item of obj) walkApiResponse(item, depth + 1);
      return;
    }

    // User object — has screen_name + profile_image_url_https
    if (obj.screen_name && obj.profile_image_url_https) {
      const uid = obj.screen_name;
      if (!store.users.has(uid)) {
        store.users.set(uid, {
          screenName: uid,
          name: obj.name || null,
          profilePic: obj.profile_image_url_https
            ? obj.profile_image_url_https.replace(/_(normal|bigger|mini|200x200|400x400)(?=\.\w+$)/, "")
            : null,
          banner: obj.profile_banner_url || null,
          bio: obj.description || null,
          followers: obj.followers_count || 0,
          following: obj.friends_count || 0,
          verified: obj.verified || obj.is_blue_verified || false,
          id: obj.id_str || obj.id || null,
        });
        console.log(`[NAS Twitter intercept] Captured user @${uid}`);
      }
    }

    // Also handle the "legacy" user format nested in GraphQL results
    if (obj.legacy?.screen_name && obj.legacy?.profile_image_url_https) {
      const uid = obj.legacy.screen_name;
      if (!store.users.has(uid)) {
        const u = obj.legacy;
        store.users.set(uid, {
          screenName: uid,
          name: u.name || null,
          profilePic: u.profile_image_url_https
            ? u.profile_image_url_https.replace(/_(normal|bigger|mini|200x200|400x400)(?=\.\w+$)/, "")
            : null,
          banner: u.profile_banner_url || null,
          bio: u.description || null,
          followers: u.followers_count || 0,
          following: u.friends_count || 0,
          verified: u.verified || obj.is_blue_verified || false,
          id: u.id_str || u.id || null,
        });
        console.log(`[NAS Twitter intercept] Captured user @${uid} (legacy)`);
      }
    }

    // Media entity — has media_url_https + type
    if (obj.media_url_https && obj.type) {
      if (obj.type === "video" || obj.type === "animated_gif") {
        const variants = obj.video_info?.variants || [];
        const mp4s = variants
          .filter((v) => v.content_type === "video/mp4" && v.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (mp4s.length > 0) {
          const best = mp4s[0];
          const key = obj.id_str || obj.media_key || best.url;
          if (!store.videos.has(key)) {
            store.videos.set(key, {
              url: best.url,
              thumbnail: obj.media_url_https
                ? obj.media_url_https.replace(/name=\w+/, "name=orig")
                : null,
              width: obj.original_info?.width || obj.sizes?.large?.w || 0,
              height: obj.original_info?.height || obj.sizes?.large?.h || 0,
              bitrate: best.bitrate || 0,
              type: obj.type,
              id: obj.id_str || obj.media_key || null,
            });
            console.log(`[NAS Twitter intercept] Captured ${obj.type} ${key} (${best.bitrate || 0}bps)`);
          }
        }
      } else if (obj.type === "photo") {
        const key = obj.id_str || obj.media_key || obj.media_url_https;
        if (!store.images.has(key)) {
          const url = obj.media_url_https.includes("name=")
            ? obj.media_url_https.replace(/name=\w+/, "name=orig")
            : obj.media_url_https + "?name=orig";
          store.images.set(key, {
            url,
            width: obj.original_info?.width || obj.sizes?.large?.w || 0,
            height: obj.original_info?.height || obj.sizes?.large?.h || 0,
            alt: obj.ext_alt_text || "",
            id: obj.id_str || obj.media_key || null,
          });
        }
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

    if (isTwitterApiUrl(url)) {
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

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__nas_url = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__nas_url && isTwitterApiUrl(this.__nas_url)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          extractFromResponse(data);
        } catch {}
      });
    }
    return originalSend.apply(this, args);
  };

  // ─── postMessage bridge (CSP-safe MAIN↔ISOLATED communication) ────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    if (msg?.type === "NAS_TWITTER_GET_DATA") {
      window.postMessage({
        type: "NAS_TWITTER_DATA_RESPONSE",
        requestId: msg.requestId,
        data: {
          videos: Object.fromEntries(store.videos),
          users: Object.fromEntries(store.users),
          images: Object.fromEntries(store.images),
          ready: store.ready,
        },
      }, "*");
    }
  });

  console.log("[NAS Twitter intercept] Fetch/XHR intercept + postMessage bridge active");
})();
