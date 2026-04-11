// ─── Net Assets Scraper V2 — TikTok Platform Script ──────────────────
// Extracts brand assets from TikTok pages:
//   - Profile pictures (multiple sizes)
//   - Video thumbnails (cover, originCover, dynamicCover)
//   - Video download URLs (H.264 MP4 — no transcode needed)
//   - Photo carousel images
//   - Bio text, username, display name, follower counts
//
// Data sources (priority order):
//   1. __UNIVERSAL_DATA_FOR_REHYDRATION__ — newer SSR hydration data
//   2. SIGI_STATE — legacy SSR state store
//   3. DOM scraping — fallback for dynamically loaded content
//
// Page types:
//   - Profile:  tiktok.com/@username
//   - Video:    tiktok.com/@username/video/ID
//   - Discover: tiktok.com/discover
//   - Tag:      tiktok.com/tag/NAME

// Guard against duplicate injection
if (window.__NAS_TIKTOK_LOADED__) {
  // Already loaded — skip
} else {
  window.__NAS_TIKTOK_LOADED__ = true;

// ─── Constants ───────────────────────────────────────────────────────
// TikTok CDN domains (video + images) — covers US, EU, SG, and legacy
const TT_CDN_PATTERN = /tiktokcdn|tiktokcdn-us|tiktokcdn-eu|tiktokv\.eu|tiktokw\.eu|muscdn\.com|v16-webapp|v19-webapp|v77\.|p16-sign|p19-sign|p77-sign/;

// ─── Page Type Detection ─────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname;

  if (/^\/@[\w.]+\/video\/\d+/.test(path))  return "video";
  if (/^\/@[\w.]+\/?$/.test(path))           return "profile";
  if (/^\/discover\/?/.test(path))            return "discover";
  if (/^\/tag\/[\w-]+\/?/.test(path))         return "tag";
  if (/^\/music\/[\w-]+-\d+\/?/.test(path))   return "music";

  return "other";
}

// ─── SSR Data Extraction ─────────────────────────────────────────────
// TikTok embeds all page data in <script> tags as JSON. Two formats
// coexist — we try both and merge results.

/**
 * Parse __UNIVERSAL_DATA_FOR_REHYDRATION__ (newer format).
 * Returns { userDetail, videoDetail, scope } or null.
 */
function parseUniversalData() {
  try {
    const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (!el) return null;
    const data = JSON.parse(el.textContent);
    const scope = data?.__DEFAULT_SCOPE__;
    if (!scope) return null;
    return {
      userDetail: scope["webapp.user-detail"] || null,
      videoDetail: scope["webapp.video-detail"] || null,
      scope,
    };
  } catch {
    return null;
  }
}

/**
 * Parse SIGI_STATE (legacy format, still present on many pages).
 * Returns { UserModule, ItemModule, UserPage } or null.
 */
function parseSigiState() {
  try {
    const el = document.getElementById("SIGI_STATE");
    if (!el) return null;
    const data = JSON.parse(el.textContent);
    if (!data) return null;
    return {
      UserModule: data.UserModule || null,
      ItemModule: data.ItemModule || null,
      UserPage: data.UserPage || null,
    };
  } catch {
    return null;
  }
}

// ─── Profile Extraction ──────────────────────────────────────────────

function extractProfileData() {
  const data = {
    username: null,
    displayName: null,
    bio: null,
    profilePic: null,
    profilePicThumb: null,
    verified: false,
    stats: null,
  };

  // Username from URL
  const pathMatch = window.location.pathname.match(/^\/@([\w.]+)/);
  if (pathMatch) data.username = pathMatch[1];

  // Try MAIN world intercept data first
  const intercepted = readInterceptData();
  if (intercepted?.users && data.username) {
    const u = intercepted.users[data.username];
    if (u) {
      data.displayName = u.nickname || null;
      data.bio = u.signature || null;
      data.profilePic = u.avatarLarger || u.avatarMedium || null;
      data.verified = u.verified || false;
      data.followerCount = u.followerCount || 0;
    }
  }

  // Try UNIVERSAL_DATA
  if (!data.profilePic) {
    const universal = parseUniversalData();
    const userInfo = universal?.userDetail?.userInfo;
    if (userInfo?.user) {
      const u = userInfo.user;
      data.username = u.uniqueId || data.username;
      data.displayName = u.nickname || data.displayName;
      data.bio = u.signature || data.bio;
      data.profilePic = u.avatarLarger || u.avatarMedium || null;
      data.profilePicThumb = u.avatarThumb || null;
      data.verified = u.verified || data.verified;
      if (userInfo.stats) {
        data.stats = {
          followers: userInfo.stats.followerCount || 0,
          following: userInfo.stats.followingCount || 0,
          likes: userInfo.stats.heartCount || userInfo.stats.heart || 0,
          videos: userInfo.stats.videoCount || 0,
        };
      }
      return data;
    }
  }

  // Fallback to SIGI_STATE
  if (!data.profilePic) {
    const sigi = parseSigiState();
    if (sigi?.UserModule && data.username) {
      const u = sigi.UserModule[data.username];
      if (u) {
        data.displayName = u.nickname || data.displayName;
        data.bio = u.signature || data.bio;
        data.profilePic = u.avatarLarger || u.avatarMedium || null;
        data.profilePicThumb = u.avatarThumb || null;
        data.verified = u.verified || data.verified;
      }
    }
  }

  // DOM fallback for profile pic
  if (!data.profilePic) {
    const avatar = document.querySelector(
      'img[class*="avatar" i][src*="tiktokcdn"], img[alt*="avatar" i]'
    );
    if (avatar) data.profilePic = avatar.src;
  }

  return data;
}

// ─── Video Item Extraction ───────────────────────────────────────────

/**
 * Normalize a TikTok item (video or photo carousel) into a consistent
 * descriptor. Works with both UNIVERSAL_DATA and SIGI_STATE schemas.
 */
function normalizeItem(item) {
  if (!item) return null;

  const video = item.video || {};
  const author = typeof item.author === "string"
    ? item.author
    : item.author?.uniqueId || null;

  const result = {
    id: item.id || video.id || null,
    desc: item.desc || "",
    author: author,
    createTime: item.createTime || 0,
    isAd: item.isAd || false,
  };

  // Video data
  if (video.playAddr || video.downloadAddr) {
    // playAddr/downloadAddr can be a string or an object with urlList
    const playUrl = typeof video.playAddr === "string"
      ? video.playAddr
      : video.playAddr?.urlList?.[0] || null;
    const downloadUrl = typeof video.downloadAddr === "string"
      ? video.downloadAddr
      : video.downloadAddr?.urlList?.[0] || null;

    result.video = {
      url: downloadUrl || playUrl || null,
      playUrl: playUrl || null,
      downloadUrl: downloadUrl || null,
      width: video.width || 0,
      height: video.height || 0,
      duration: video.duration || 0,
      cover: video.cover || null,
      originCover: video.originCover || null,
      dynamicCover: video.dynamicCover || null,
      format: video.format || "mp4",
      bitrate: video.bitrate || 0,
    };
  }

  // Photo carousel
  if (item.imagePost?.images) {
    result.images = item.imagePost.images.map((img) => ({
      url: img.imageURL?.urlList?.[0] || null,
      width: img.imageWidth || 0,
      height: img.imageHeight || 0,
    })).filter((img) => img.url);
  }

  // Stats
  if (item.stats) {
    result.stats = {
      plays: item.stats.playCount || 0,
      likes: item.stats.diggCount || 0,
      comments: item.stats.commentCount || 0,
      shares: item.stats.shareCount || 0,
      saves: item.stats.collectCount || 0,
    };
  }

  return result;
}

/**
 * Extract all video/photo items from SSR data.
 * Returns array of normalized item descriptors.
 */
function extractItems() {
  const items = [];
  const seenIds = new Set();

  // MAIN world intercept data (most reliable on current TikTok)
  const intercepted = readInterceptData();
  if (intercepted?.videos) {
    for (const [id, v] of Object.entries(intercepted.videos)) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      items.push({
        id,
        desc: v.desc || "",
        author: v.author || null,
        createTime: v.createTime || 0,
        isAd: false,
        video: {
          url: v.url,
          playUrl: v.playUrl,
          downloadUrl: v.downloadUrl,
          width: v.width || 0,
          height: v.height || 0,
          duration: v.duration || 0,
          cover: v.cover || null,
          originCover: v.cover || null,
          dynamicCover: v.dynamicCover || null,
          format: "mp4",
          bitrate: 0,
        },
      });
    }
  }

  // UNIVERSAL_DATA — single video page
  const universal = parseUniversalData();
  if (universal?.videoDetail?.itemInfo?.itemStruct) {
    const item = normalizeItem(universal.videoDetail.itemInfo.itemStruct);
    if (item && item.id && !seenIds.has(item.id)) {
      seenIds.add(item.id);
      items.push(item);
    }
  }

  // SIGI_STATE — ItemModule contains all loaded videos on profile pages
  const sigi = parseSigiState();
  if (sigi?.ItemModule) {
    for (const [id, raw] of Object.entries(sigi.ItemModule)) {
      if (seenIds.has(id)) continue;
      const item = normalizeItem(raw);
      if (item && item.id) {
        seenIds.add(item.id);
        items.push(item);
      }
    }
  }

  return items;
}

// ─── MAIN World Intercept Data ───────────────────────────────────────
// The MAIN world script (tiktok-video-intercept.js) captures video/user
// data from TikTok's API responses and stores it on window.__NAS_TIKTOK_DATA__.
// Since we're in ISOLATED world, we read it via a DOM bridge.

function readInterceptData() {
  try {
    // Create a bridge script to read MAIN world data
    const bridge = document.createElement("script");
    bridge.textContent = `
      try {
        const d = window.__NAS_TIKTOK_DATA__;
        if (d) {
          const payload = {
            videos: Object.fromEntries(d.videos || []),
            users: Object.fromEntries(d.users || []),
            ready: d.ready || false,
          };
          document.dispatchEvent(new CustomEvent("__NAS_TIKTOK_BRIDGE__", {
            detail: JSON.stringify(payload),
          }));
        }
      } catch {}
    `;
    let result = null;
    const handler = (e) => {
      try { result = JSON.parse(e.detail); } catch {}
    };
    document.addEventListener("__NAS_TIKTOK_BRIDGE__", handler);
    document.documentElement.appendChild(bridge);
    bridge.remove();
    document.removeEventListener("__NAS_TIKTOK_BRIDGE__", handler);
    return result;
  } catch {
    return null;
  }
}

// ─── Single Video Page Extraction ────────────────────────────────────

function extractSingleVideo() {
  // Try MAIN world intercept data first (most reliable on current TikTok)
  const intercepted = readInterceptData();
  if (intercepted?.videos) {
    const entries = Object.entries(intercepted.videos);
    if (entries.length > 0) {
      const [id, v] = entries[0];
      return {
        id,
        desc: v.desc || "",
        author: v.author || null,
        createTime: v.createTime || 0,
        isAd: false,
        video: {
          url: v.url,
          playUrl: v.playUrl,
          downloadUrl: v.downloadUrl,
          width: v.width || 0,
          height: v.height || 0,
          duration: v.duration || 0,
          cover: v.cover || null,
          originCover: v.cover || null,
          dynamicCover: v.dynamicCover || null,
          format: "mp4",
          bitrate: 0,
        },
      };
    }
  }

  // Try UNIVERSAL_DATA
  const universal = parseUniversalData();
  const itemStruct = universal?.videoDetail?.itemInfo?.itemStruct;
  if (itemStruct) return normalizeItem(itemStruct);

  // Fallback to SIGI_STATE — on video pages, ItemModule has a single entry
  const sigi = parseSigiState();
  if (sigi?.ItemModule) {
    const entries = Object.values(sigi.ItemModule);
    if (entries.length > 0) return normalizeItem(entries[0]);
  }

  return null;
}

// ─── DOM Video Scraping (Fallback) ───────────────────────────────────
// When SSR data is unavailable (SPA navigation, logged-out redirect),
// try to extract video URLs from the DOM.

function scrapeVideoFromDOM() {
  const videos = [];
  const seen = new Set();

  // og:video meta tags
  const metaTags = document.querySelectorAll(
    'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'
  );
  for (const tag of metaTags) {
    const url = tag.getAttribute("content");
    if (url && !seen.has(url) && TT_CDN_PATTERN.test(url)) {
      seen.add(url);
      videos.push({ url, source: "meta" });
    }
  }

  // og:image for cover/thumbnail
  const ogImage = document.querySelector('meta[property="og:image"]');
  const coverUrl = ogImage?.getAttribute("content") || null;

  // <video> elements with non-blob src
  const videoEls = document.querySelectorAll("video");
  for (const el of videoEls) {
    const src = el.src || el.querySelector("source")?.src;
    if (src && !src.startsWith("blob:") && !seen.has(src) && TT_CDN_PATTERN.test(src)) {
      seen.add(src);
      videos.push({
        url: src,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        source: "dom",
      });
    }
  }

  return { videos, coverUrl };
}

// ─── Main Analyzer ───────────────────────────────────────────────────

function analyzeTikTok() {
  const pageType = detectPageType();
  const result = {
    platform: "tiktok",
    pageType,
    assets: [],
    platformMeta: {},
  };

  // Profile data (available on profile and video pages)
  const profile = extractProfileData();
  result.platformMeta = {
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    verified: profile.verified,
    stats: profile.stats,
  };

  // Profile pic as asset
  if (profile.profilePic) {
    result.assets.push({
      url: profile.profilePic,
      type: "image",
      context: "profile-pic",
      isLogo: true,
      isUI: false,
      alt: `${profile.username || "tiktok"} profile picture`,
      width: 0,
      height: 0,
      platformTag: "tiktok-profile-pic",
      username: profile.username,
    });
  }

  if (pageType === "profile") {
    // Extract all videos from SSR data
    const items = extractItems();
    for (const item of items) {
      if (item.isAd) continue; // Skip ads

      // Video
      if (item.video?.url) {
        // Cover image as thumbnail
        const cover = item.video.originCover || item.video.cover || null;
        result.assets.push({
          url: item.video.url,
          type: "video",
          context: "profile-video",
          isLogo: false,
          isUI: false,
          alt: item.desc || "",
          width: item.video.width || 0,
          height: item.video.height || 0,
          platformTag: "tiktok-video",
          poster: cover,
          videoId: item.id,
          username: item.author || profile.username,
          shortcode: item.id,
          // TikTok serves H.264 MP4 — no transcode or mux needed
          needsMux: false,
          needsTranscode: false,
          codec: "h264",
        });

        // Add cover as a separate image asset
        if (cover && TT_CDN_PATTERN.test(cover)) {
          result.assets.push({
            url: cover,
            type: "image",
            context: "video-cover",
            isLogo: false,
            isUI: false,
            alt: item.desc || "",
            width: item.video.width || 0,
            height: item.video.height || 0,
            platformTag: "tiktok-video-cover",
            username: item.author || profile.username,
          });
        }
      }

      // Photo carousel images
      if (item.images) {
        for (const img of item.images) {
          if (!img.url) continue;
          result.assets.push({
            url: img.url,
            type: "image",
            context: "photo-carousel",
            isLogo: false,
            isUI: false,
            alt: item.desc || "",
            width: img.width || 0,
            height: img.height || 0,
            platformTag: "tiktok-photo",
            username: item.author || profile.username,
            shortcode: item.id,
          });
        }
      }
    }
  }

  if (pageType === "video") {
    const item = extractSingleVideo();
    if (item?.video?.url) {
      const cover = item.video.originCover || item.video.cover || null;
      result.assets.push({
        url: item.video.url,
        type: "video",
        context: "single-video",
        isLogo: false,
        isUI: false,
        alt: item.desc || "",
        width: item.video.width || 0,
        height: item.video.height || 0,
        platformTag: "tiktok-video",
        poster: cover,
        videoId: item.id,
        username: item.author || profile.username,
        shortcode: item.id,
        needsMux: false,
        needsTranscode: false,
        codec: "h264",
      });

      if (cover && TT_CDN_PATTERN.test(cover)) {
        result.assets.push({
          url: cover,
          type: "image",
          context: "video-cover",
          isLogo: false,
          isUI: false,
          alt: item.desc || "",
          width: item.video.width || 0,
          height: item.video.height || 0,
          platformTag: "tiktok-video-cover",
          username: item.author || profile.username,
        });
      }

      // Photo carousel on video page
      if (item.images) {
        for (const img of item.images) {
          if (!img.url) continue;
          result.assets.push({
            url: img.url,
            type: "image",
            context: "photo-carousel",
            isLogo: false,
            isUI: false,
            alt: item.desc || "",
            width: img.width || 0,
            height: img.height || 0,
            platformTag: "tiktok-photo",
            username: item.author || profile.username,
            shortcode: item.id,
          });
        }
      }
    }

    // DOM fallback if SSR data was empty
    if (result.assets.filter((a) => a.type === "video").length === 0) {
      const domResult = scrapeVideoFromDOM();
      for (const v of domResult.videos) {
        result.assets.push({
          url: v.url,
          type: "video",
          context: "dom-video",
          isLogo: false,
          isUI: false,
          alt: "",
          width: v.width || 0,
          height: v.height || 0,
          platformTag: "tiktok-video",
          poster: domResult.coverUrl,
          needsMux: false,
          needsTranscode: false,
          codec: "h264",
          username: profile.username,
        });
      }
    }
  }

  return result;
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzePlatform") {
    try {
      const result = analyzeTikTok();
      sendResponse(result);
    } catch (err) {
      console.error("NAS TikTok script error:", err);
      sendResponse({ platform: "tiktok", error: err.message });
    }
    return false; // Synchronous — SSR parsing is instant
  }

  if (message.action === "deepScanPlatform") {
    deepScanTikTok()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS TikTok deep scan error:", err);
        sendResponse({ platform: "tiktok", error: err.message });
      });
    return true; // Async
  }
});

// ─── Deep Scan ───────────────────────────────────────────────────────
// Scroll the page to trigger lazy-loaded content, then re-analyze.
// TikTok loads more videos via API as the user scrolls.

async function deepScanTikTok() {
  const pageType = detectPageType();

  if (pageType === "profile") {
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

    // Scroll back
    window.scrollTo({ top: originalScroll, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 300));
  }

  // Re-analyze after scrolling (TikTok may have updated SIGI_STATE
  // or loaded new items into the DOM)
  return analyzeTikTok();
}

} // end duplicate injection guard
