// ─── Net Assets Scraper V2 — Facebook Video Intercept (MAIN world) ───
// Runs in MAIN world to intercept Facebook's GraphQL API responses
// that contain video playable_url fields and media metadata.
//
// Facebook loads video/media data via GraphQL API calls to /api/graphql/.
// The data-sjs Relay script tags may be empty or stale on SPA navigation.
// This script monkey-patches fetch() and XMLHttpRequest to capture
// those responses and extract video URLs.
//
// Captured data is stored on window.__NAS_FACEBOOK_DATA__ for the
// ISOLATED world content script (facebook.js) to read via postMessage.

(function () {
  if (window.__NAS_FACEBOOK_INTERCEPT_LOADED__) return;
  window.__NAS_FACEBOOK_INTERCEPT_LOADED__ = true;

  // Storage for intercepted data
  window.__NAS_FACEBOOK_DATA__ = {
    videos: new Map(),     // id → { url, hdUrl, sdUrl, width, height, thumbnail, title }
    users: new Map(),      // id → { name, profilePic, coverPhoto, category, ... }
    images: new Map(),     // uri → { url, width, height }
    ready: false,
  };

  const store = window.__NAS_FACEBOOK_DATA__;

  // ─── API URL patterns that carry video/media data ─────────────────
  const API_PATTERNS = [
    /\/api\/graphql\//,              // Main GraphQL endpoint
    /\/ajax\/bulk-route-definitions/,// Prefetch data
    /\/ajax\/route-definition/,      // Route data
  ];

  function isFacebookApiUrl(url) {
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

    // Video objects — look for playable_url fields
    if (obj.playable_url || obj.playable_url_quality_hd || obj.browser_native_hd_url) {
      const url = obj.playable_url_quality_hd || obj.browser_native_hd_url
        || obj.playable_url || obj.browser_native_sd_url || null;
      const id = obj.id || obj.video_id || url;

      if (url && !store.videos.has(id)) {
        store.videos.set(id, {
          url,
          hdUrl: obj.playable_url_quality_hd || obj.browser_native_hd_url || null,
          sdUrl: obj.playable_url || obj.browser_native_sd_url || null,
          width: obj.width || obj.original_width || 0,
          height: obj.height || obj.original_height || 0,
          duration: obj.length_in_second || (obj.playable_duration_in_ms ? obj.playable_duration_in_ms / 1000 : 0),
          thumbnail: obj.preferred_thumbnail?.image?.uri || null,
          title: obj.title?.text || obj.title || null,
          description: obj.description?.text || null,
          id: obj.id || obj.video_id || null,
        });
        console.log(`[NAS Facebook intercept] Captured video ${id} (${obj.width || "?"}x${obj.height || "?"})`);
      }
    }

    // Profile picture
    if (obj.profile_picture?.uri) {
      const uri = obj.profile_picture.uri;
      if (!store.images.has("profilePic")) {
        store.images.set("profilePic", {
          url: uri,
          type: "profile-pic",
          width: obj.profile_picture.width || 0,
          height: obj.profile_picture.height || 0,
        });
      }
    }
    if (obj.profilePicLarge?.uri) {
      // Override with larger version
      store.images.set("profilePic", {
        url: obj.profilePicLarge.uri,
        type: "profile-pic",
        width: 0,
        height: 0,
      });
    }

    // Cover photo
    if (obj.cover_photo?.photo?.image?.uri) {
      store.images.set("coverPhoto", {
        url: obj.cover_photo.photo.image.uri,
        type: "cover-photo",
        width: 0,
        height: 0,
      });
    }

    // Page/user metadata
    if (obj.name && (obj.category_name || obj.category_type) && !store.users.has("page")) {
      store.users.set("page", {
        name: obj.name,
        category: obj.category_name || null,
        about: obj.page_about_fields?.about_text || obj.about?.text || null,
        website: obj.page_about_fields?.website || obj.website || null,
        followers: obj.followers_count || obj.page_likers?.count || 0,
        verified: obj.is_verified || false,
        id: obj.id || null,
      });
      console.log(`[NAS Facebook intercept] Captured page: ${obj.name}`);
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

    if (isFacebookApiUrl(url)) {
      try {
        const clone = response.clone();
        clone.text().then((text) => {
          // Facebook GraphQL responses can be multiple JSON objects
          // separated by newlines (streaming response format)
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("{")) continue;
            try {
              const data = JSON.parse(trimmed);
              extractFromResponse(data);
            } catch {}
          }
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
    if (this.__nas_url && isFacebookApiUrl(this.__nas_url)) {
      this.addEventListener("load", function () {
        try {
          // Handle multi-line JSON responses
          for (const line of this.responseText.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("{")) continue;
            try {
              const data = JSON.parse(trimmed);
              extractFromResponse(data);
            } catch {}
          }
        } catch {}
      });
    }
    return originalSend.apply(this, args);
  };

  // ─── Also parse existing data-sjs script tags ─────────────────────
  function parseExistingRelay() {
    const scripts = document.querySelectorAll('script[type="application/json"][data-sjs]');
    for (const script of scripts) {
      try {
        const json = JSON.parse(script.textContent);
        extractFromResponse(json);
      } catch {}
    }
  }

  parseExistingRelay();

  // ─── postMessage bridge (CSP-safe MAIN↔ISOLATED communication) ────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    if (msg?.type === "NAS_FACEBOOK_GET_DATA") {
      window.postMessage({
        type: "NAS_FACEBOOK_DATA_RESPONSE",
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

  console.log("[NAS Facebook intercept] Fetch/XHR intercept + postMessage bridge active");
})();
