// ─── Net Assets Scraper V2 — Facebook Platform Script ────────────────
// Extracts brand assets from Facebook pages:
//   - Profile pictures (multiple sizes via CDN param manipulation)
//   - Cover photos
//   - Post images from the feed
//   - Video download URLs (H.264 MP4, muxed audio — no transcode needed)
//   - Page metadata (name, about, category, follower counts)
//
// Data sources (priority order):
//   1. MAIN world API intercept (facebook-video-intercept.js) — richest, captures GraphQL
//   2. OG meta tags — fastest, always present on initial page load
//   3. data-sjs Relay script tags — contains GraphQL prefetch
//   4. DOM scraping with aria-labels — fallback for SPA-navigated pages
//
// Page types:
//   - Page:    facebook.com/pagename or facebook.com/ID
//   - Profile: facebook.com/username
//   - Post:    facebook.com/pagename/posts/ID
//   - Video:   facebook.com/pagename/videos/ID or facebook.com/watch/?v=ID
//   - Photos:  facebook.com/pagename/photos

// Guard against duplicate injection
if (window.__NAS_FACEBOOK_LOADED__) {
  // Already loaded — skip
} else {
  window.__NAS_FACEBOOK_LOADED__ = true;

// ─── Constants ───────────────────────────────────────────────────────
// Facebook CDN domains for images and video
const FB_CDN_PATTERN = /fbcdn\.net|fbsbx\.com/;
const FB_VIDEO_CDN = /video[-\w]*\.(?:xx\.)?fbcdn\.net/;

// ─── Page Type Detection ─────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname;
  const search = window.location.search;

  if (path === "/" || path === "")                    return "home";
  if (/\/posts\/\d+/.test(path))                   return "post";
  if (/\/videos\/\d+/.test(path))                  return "video";
  if (/\/watch\/?\?v=\d+/.test(path + search))     return "video";
  if (/\/photos\/?/.test(path))                     return "photos";
  if (/\/reels\/\d+/.test(path))                   return "reel";
  if (/\/events\//.test(path))                      return "event";
  // Profile/page — anything with a single path segment
  if (/^\/[\w.]+\/?$/.test(path) && path !== "/")   return "page";
  if (/^\/profile\.php/.test(path))                 return "page";

  return "other";
}

// ─── OG Meta Tag Extraction ──────────────────────────────────────────
// Always present on initial page load. Fastest and most reliable
// for basic page info.

function getMeta(property) {
  const el = document.querySelector(`meta[property="${property}"]`)
    || document.querySelector(`meta[name="${property}"]`);
  return el?.getAttribute("content") || null;
}

function extractMetaData() {
  const data = {
    name: getMeta("og:title"),
    description: getMeta("og:description") || getMeta("description"),
    image: getMeta("og:image"),
    url: getMeta("og:url"),
    type: getMeta("og:type"),
  };

  // Extract page ID from app link meta tags (fb://page/ID)
  const iosUrl = getMeta("al:ios:url") || getMeta("al:android:url");
  if (iosUrl) {
    const idMatch = iosUrl.match(/\/(\d+)$/);
    if (idMatch) data.pageId = idMatch[1];
  }

  return data;
}

// ─── Relay/data-sjs Script Tag Extraction ────────────────────────────
// Facebook embeds GraphQL prefetch data in <script data-sjs> tags.
// This is the richest data source — contains full page/video objects.

function parseRelayData() {
  const scripts = document.querySelectorAll('script[type="application/json"][data-sjs]');
  const results = {
    pageData: null,
    videos: [],
    images: [],
    coverPhoto: null,
    profilePic: null,
  };

  for (const script of scripts) {
    try {
      const json = JSON.parse(script.textContent);
      walkRelayData(json, results, 0);
    } catch {
      // Skip unparseable
    }
  }

  return results;
}

const MAX_DEPTH = 15;

/**
 * Walk the Relay prefetch data looking for video objects, profile pics,
 * cover photos, and page metadata.
 */
function walkRelayData(obj, results, depth) {
  if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) return;

  if (Array.isArray(obj)) {
    for (const item of obj) walkRelayData(item, results, depth + 1);
    return;
  }

  // Video objects — look for playable_url fields
  if (obj.playable_url || obj.playable_url_quality_hd || obj.browser_native_hd_url) {
    const video = {
      url: obj.playable_url_quality_hd || obj.browser_native_hd_url
        || obj.playable_url || obj.browser_native_sd_url || null,
      sdUrl: obj.playable_url || obj.browser_native_sd_url || null,
      hdUrl: obj.playable_url_quality_hd || obj.browser_native_hd_url || null,
      id: obj.id || obj.video_id || null,
      title: obj.title?.text || obj.title || null,
      description: obj.description?.text || null,
      width: obj.width || obj.original_width || 0,
      height: obj.height || obj.original_height || 0,
      duration: obj.length_in_second || obj.playable_duration_in_ms / 1000 || 0,
      thumbnail: obj.preferred_thumbnail?.image?.uri || null,
    };
    if (video.url && !results.videos.some((v) => v.url === video.url)) {
      results.videos.push(video);
    }
  }

  // Profile picture — look for profile_picture or profilePicLarge
  if (obj.profile_picture?.uri && !results.profilePic) {
    results.profilePic = upgradeImageUrl(obj.profile_picture.uri);
  }
  if (obj.profilePicLarge?.uri && !results.profilePic) {
    results.profilePic = obj.profilePicLarge.uri;
  }

  // Cover photo
  if (obj.cover_photo?.photo?.image?.uri && !results.coverPhoto) {
    results.coverPhoto = obj.cover_photo.photo.image.uri;
  }

  // Page/user metadata
  if (obj.name && obj.category_name && !results.pageData) {
    results.pageData = {
      name: obj.name,
      category: obj.category_name || null,
      about: obj.page_about_fields?.about_text || obj.about?.text || null,
      website: obj.page_about_fields?.website || obj.website || null,
      followers: obj.followers_count || obj.page_likers?.count || 0,
      verified: obj.is_verified || false,
      id: obj.id || null,
    };
  }

  // Recurse
  for (const key of Object.keys(obj)) {
    walkRelayData(obj[key], results, depth + 1);
  }
}

// ─── CDN URL Manipulation ────────────────────────────────────────────
// Facebook CDN URLs have an `stp` parameter that controls dimensions.
// Removing it or replacing it gives higher resolution images.

function upgradeImageUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Remove size transform to get original resolution
    u.searchParams.delete("stp");
    return u.toString();
  } catch {
    // If URL parsing fails, try regex replacement
    return url.replace(/[?&]stp=[^&]+/, "");
  }
}

// ─── DOM Scraping (Fallback) ─────────────────────────────────────────
// Uses aria-labels and semantic selectors (NOT CSS class names,
// which Facebook obfuscates and changes with every deploy).

function extractFromDOM() {
  const data = {
    name: null,
    profilePic: null,
    coverPhoto: null,
    verified: false,
    posts: [],
  };

  // Page/profile name — h1 or heading role
  const h1 = document.querySelector('h1');
  if (h1) data.name = h1.textContent.trim();

  // Profile picture — multiple selector strategies
  const profilePicSelectors = [
    'svg[aria-label*="profile picture" i] image',
    '[aria-label*="profile picture" i] img',
    '[aria-label*="profile photo" i] img',
    'a[aria-label*="profile photo" i] img',
  ];
  for (const sel of profilePicSelectors) {
    const el = document.querySelector(sel);
    const src = el?.getAttribute("href") || el?.getAttribute("xlink:href") || el?.src;
    if (src && FB_CDN_PATTERN.test(src)) {
      data.profilePic = upgradeImageUrl(src);
      break;
    }
  }

  // Cover photo
  const coverSelectors = [
    'img[data-imgperflogname="profileCoverPhoto"]',
    '[aria-label*="Cover photo" i] img',
    '[aria-label*="cover photo" i] img',
  ];
  for (const sel of coverSelectors) {
    const el = document.querySelector(sel);
    if (el?.src && FB_CDN_PATTERN.test(el.src)) {
      data.coverPhoto = upgradeImageUrl(el.src);
      break;
    }
  }

  // Verified badge
  data.verified = !!document.querySelector(
    '[aria-label*="Verified" i]'
  );

  // Post images from feed
  const seen = new Set();
  const articles = document.querySelectorAll('[role="article"]');
  for (const article of articles) {
    const imgs = article.querySelectorAll('img[src*="fbcdn.net"]');
    for (const img of imgs) {
      const src = img.src;
      if (!src || seen.has(src) || !FB_CDN_PATTERN.test(src)) continue;
      // Skip tiny images (reaction emojis, UI elements)
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && h > 0 && w <= 48 && h <= 48) continue;
      seen.add(src);
      data.posts.push({
        url: src,
        alt: img.alt || "",
        width: w,
        height: h,
      });
    }
  }

  // Video elements — direct CDN URLs (skip blob: URLs)
  const videoEls = document.querySelectorAll("video");
  for (const el of videoEls) {
    const src = el.src || el.querySelector("source")?.src;
    if (src && !src.startsWith("blob:") && FB_CDN_PATTERN.test(src) && !seen.has(src)) {
      seen.add(src);
      data.posts.push({
        url: src,
        type: "video",
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
      });
    }
  }

  return data;
}

// ─── Username Extraction ─────────────────────────────────────────────

function extractUsername() {
  // From URL path
  const pathMatch = window.location.pathname.match(/^\/([\w.]+)\/?$/);
  if (pathMatch && pathMatch[1] !== "watch" && pathMatch[1] !== "profile.php") {
    return pathMatch[1];
  }
  // From og:url
  const ogUrl = getMeta("og:url");
  if (ogUrl) {
    const m = ogUrl.match(/facebook\.com\/([\w.]+)/);
    if (m) return m[1];
  }
  return null;
}

// ─── MAIN World Intercept Data (via postMessage bridge) ──────────────
// Reads data captured by facebook-video-intercept.js (MAIN world).
// Uses postMessage because MAIN and ISOLATED worlds can't share globals.

async function readInterceptData() {
  const requestId = `nas_fb_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(null);
    }, 2000);

    function handler(event) {
      if (event.source !== window) return;
      const msg = event.data;
      if (msg?.type !== "NAS_FACEBOOK_DATA_RESPONSE") return;
      if (msg.requestId !== requestId) return;

      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      resolve(msg.data || null);
    }

    window.addEventListener("message", handler);
    window.postMessage({ type: "NAS_FACEBOOK_GET_DATA", requestId }, "*");
  });
}

// ─── Main Analyzer ───────────────────────────────────────────────────

async function analyzeFacebook() {
  const pageType = detectPageType();
  const result = {
    platform: "facebook",
    pageType,
    assets: [],
    platformMeta: {},
  };

  const username = extractUsername();
  const meta = extractMetaData();
  const relay = parseRelayData();
  const dom = extractFromDOM();

  // ── Read intercepted API data (from MAIN world) ──
  const intercepted = await readInterceptData();

  // Merge intercepted video data into relay results
  if (intercepted?.videos) {
    for (const [id, video] of Object.entries(intercepted.videos)) {
      if (!video.url) continue;
      if (!relay.videos.some((v) => v.url === video.url)) {
        relay.videos.push({
          url: video.hdUrl || video.url,
          sdUrl: video.sdUrl || null,
          hdUrl: video.hdUrl || null,
          id: video.id || id,
          title: video.title || null,
          description: video.description || null,
          width: video.width || 0,
          height: video.height || 0,
          duration: video.duration || 0,
          thumbnail: video.thumbnail || null,
        });
      }
    }
  }

  // Merge intercepted user/page data
  if (intercepted?.users) {
    for (const [key, user] of Object.entries(intercepted.users)) {
      if (!relay.pageData && user.name) {
        relay.pageData = {
          name: user.name,
          category: user.category || null,
          about: user.about || null,
          website: user.website || null,
          followers: user.followers || 0,
          verified: user.verified || false,
          id: user.id || null,
        };
      }
    }
  }

  // Merge intercepted image data (profile pics, cover photos)
  if (intercepted?.images) {
    const profilePic = intercepted.images.profilePic;
    if (profilePic?.url && !relay.profilePic) {
      relay.profilePic = profilePic.url;
    }
    const coverPhoto = intercepted.images.coverPhoto;
    if (coverPhoto?.url && !relay.coverPhoto) {
      relay.coverPhoto = coverPhoto.url;
    }
  }

  // Build platform metadata (merge all sources)
  result.platformMeta = {
    name: relay.pageData?.name || meta.name || dom.name || null,
    username: username,
    category: relay.pageData?.category || null,
    about: relay.pageData?.about || meta.description || null,
    website: relay.pageData?.website || null,
    followers: relay.pageData?.followers || 0,
    verified: relay.pageData?.verified || dom.verified || false,
    pageId: relay.pageData?.id || meta.pageId || null,
  };

  // ── Profile picture ──
  const profilePic = relay.profilePic || dom.profilePic || meta.image || null;
  if (profilePic && FB_CDN_PATTERN.test(profilePic)) {
    result.assets.push({
      url: upgradeImageUrl(profilePic),
      type: "image",
      context: "profile-pic",
      isLogo: true,
      isUI: false,
      alt: `${result.platformMeta.name || username || "facebook"} profile picture`,
      width: 0,
      height: 0,
      platformTag: "facebook-profile-pic",
      username: username,
    });
  }

  // ── Cover photo ──
  const coverPhoto = relay.coverPhoto || dom.coverPhoto || null;
  if (coverPhoto && FB_CDN_PATTERN.test(coverPhoto)) {
    result.assets.push({
      url: upgradeImageUrl(coverPhoto),
      type: "image",
      context: "cover-photo",
      isLogo: false,
      isUI: false,
      alt: `${result.platformMeta.name || username || "facebook"} cover photo`,
      width: 0,
      height: 0,
      platformTag: "facebook-cover-photo",
      username: username,
    });
  }

  // ── Videos from Relay data ──
  // Facebook progressive URLs are H.264 with muxed audio — no transcode or mux needed
  for (const video of relay.videos) {
    if (!video.url) continue;
    result.assets.push({
      url: video.url,
      type: "video",
      context: pageType === "video" ? "single-video" : "feed-video",
      isLogo: false,
      isUI: false,
      alt: video.title || video.description || "",
      width: video.width || 0,
      height: video.height || 0,
      platformTag: "facebook-video",
      poster: video.thumbnail || null,
      videoId: video.id,
      username: username,
      shortcode: video.id,
      // H.264 muxed — no pipeline processing needed
      needsMux: false,
      needsTranscode: false,
      codec: "h264",
    });

    // Video thumbnail as image asset
    if (video.thumbnail && FB_CDN_PATTERN.test(video.thumbnail)) {
      result.assets.push({
        url: video.thumbnail,
        type: "image",
        context: "video-thumbnail",
        isLogo: false,
        isUI: false,
        alt: video.title || "",
        width: video.width || 0,
        height: video.height || 0,
        platformTag: "facebook-video-thumbnail",
        username: username,
      });
    }
  }

  // ── Post images from DOM ──
  const seenUrls = new Set(result.assets.map((a) => a.url));
  for (const post of dom.posts) {
    if (seenUrls.has(post.url)) continue;
    seenUrls.add(post.url);

    if (post.type === "video") {
      result.assets.push({
        url: post.url,
        type: "video",
        context: "dom-video",
        isLogo: false,
        isUI: false,
        alt: "",
        width: post.width || 0,
        height: post.height || 0,
        platformTag: "facebook-video",
        username: username,
        needsMux: false,
        needsTranscode: false,
        codec: "h264",
      });
    } else {
      result.assets.push({
        url: post.url,
        type: "image",
        context: "feed-image",
        isLogo: false,
        isUI: false,
        alt: post.alt || "",
        width: post.width || 0,
        height: post.height || 0,
        platformTag: "facebook-post-image",
        username: username,
      });
    }
  }

  return result;
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzePlatform") {
    analyzeFacebook()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Facebook script error:", err);
        sendResponse({ platform: "facebook", error: err.message });
      });
    return true; // Async — waiting for intercept data
  }

  if (message.action === "deepScanPlatform") {
    deepScanFacebook()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Facebook deep scan error:", err);
        sendResponse({ platform: "facebook", error: err.message });
      });
    return true; // Async
  }
});

// ─── Deep Scan ───────────────────────────────────────────────────────
// Scroll the page to trigger lazy-loaded feed content.

async function deepScanFacebook() {
  const pageType = detectPageType();

  if (pageType === "page" || pageType === "other") {
    const maxDuration = 15000;
    const stepDelay = 500;
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

    // ── Post-scroll collection window ──
    // Facebook loads video data lazily via GraphQL — API responses often arrive
    // after the scroll has finished. Wait and poll the intercept store for new
    // videos, giving pending network requests time to complete.
    let lastVideoCount = 0;
    let stablePolls = 0;
    const maxWait = 5000;
    const pollInterval = 500;
    const collectStart = Date.now();

    while ((Date.now() - collectStart) < maxWait && stablePolls < 3) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const snapshot = await readInterceptData();
      const currentCount = snapshot?.videos ? Object.keys(snapshot.videos).length : 0;

      if (currentCount > lastVideoCount) {
        lastVideoCount = currentCount;
        stablePolls = 0; // new video arrived, reset stability counter
        console.log(`[NAS Facebook] Collection window: ${currentCount} videos captured, waiting for more…`);
      } else {
        stablePolls++;
      }
    }

    if (lastVideoCount > 0) {
      console.log(`[NAS Facebook] Collection window complete: ${lastVideoCount} videos captured`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return await analyzeFacebook();
}

} // end duplicate injection guard
