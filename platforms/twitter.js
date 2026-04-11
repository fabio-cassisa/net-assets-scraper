// ─── Net Assets Scraper V2 — Twitter/X Platform Script ───────────────
// Extracts brand assets from Twitter/X pages:
//   - Profile pictures (original resolution via URL manipulation)
//   - Banner/header images
//   - Tweet images (upgraded to original via name=orig)
//   - Video download URLs (H.264 MP4 from variant arrays — no transcode)
//   - Profile metadata (name, handle, bio, follower counts)
//
// Data sources (priority order):
//   1. MAIN world API intercept (twitter-video-intercept.js) — richest, captures GraphQL
//   2. OG / Twitter Card meta tags — fastest, always on SSR
//   3. __NEXT_DATA__ hydration JSON — when available (increasingly rare)
//   4. DOM scraping with data-testid — fallback for SPA navigation
//
// Page types:
//   - Profile:  x.com/username or twitter.com/username
//   - Tweet:    x.com/username/status/ID
//   - List:     x.com/i/lists/ID
//   - Search:   x.com/search?q=...

// Guard against duplicate injection
if (window.__NAS_TWITTER_LOADED__) {
  // Already loaded — skip
} else {
  window.__NAS_TWITTER_LOADED__ = true;

// ─── Constants ───────────────────────────────────────────────────────
const TW_IMG_CDN = /pbs\.twimg\.com/;
const TW_VID_CDN = /video\.twimg\.com/;
const TW_CDN_PATTERN = /twimg\.com/;

// ─── Page Type Detection ─────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname;

  if (/^\/\w+\/status\/\d+/.test(path))        return "tweet";
  if (/^\/i\/lists\/\d+/.test(path))            return "list";
  if (/^\/search\b/.test(path))                 return "search";
  if (/^\/explore\/?$/.test(path))              return "explore";
  if (/^\/home\/?$/.test(path))                 return "home";
  if (/^\/\w+\/followers\/?$/.test(path))       return "followers";
  if (/^\/\w+\/following\/?$/.test(path))       return "following";
  if (/^\/\w+\/media\/?$/.test(path))           return "media";
  if (/^\/\w+\/likes\/?$/.test(path))           return "likes";
  // Profile — single path segment (username)
  if (/^\/\w+\/?$/.test(path) && path !== "/")  return "profile";

  return "other";
}

// ─── Image URL Manipulation ──────────────────────────────────────────
// Twitter image CDN uses query params to control size:
//   ?format=jpg&name=small|medium|large|orig|4096x4096
// Profile pics use _normal, _bigger, _200x200, _400x400 suffixes.

function upgradeImageUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);

    // Profile pic suffix replacement — get original
    // e.g. /profile_images/123/photo_normal.jpg → /profile_images/123/photo.jpg
    if (u.pathname.includes("/profile_images/")) {
      u.pathname = u.pathname.replace(/_(normal|bigger|mini|200x200|400x400)(?=\.\w+$)/, "");
      return u.toString();
    }

    // Tweet media — force original resolution
    if (u.hostname === "pbs.twimg.com" && u.pathname.startsWith("/media/")) {
      u.searchParams.set("name", "orig");
      if (!u.searchParams.has("format")) {
        u.searchParams.set("format", "jpg");
      }
      return u.toString();
    }

    return url;
  } catch {
    // Regex fallback for profile pics
    return url.replace(/_(normal|bigger|mini|200x200|400x400)(?=\.\w+)/, "");
  }
}

// ─── OG / Twitter Card Meta Extraction ───────────────────────────────

function getMeta(property) {
  const el = document.querySelector(`meta[property="${property}"]`)
    || document.querySelector(`meta[name="${property}"]`);
  return el?.getAttribute("content") || null;
}

function extractMetaData() {
  return {
    name: getMeta("og:title"),
    description: getMeta("og:description") || getMeta("description"),
    image: getMeta("og:image") || getMeta("twitter:image"),
    url: getMeta("og:url"),
    type: getMeta("og:type"),
    twitterCard: getMeta("twitter:card"),
    twitterSite: getMeta("twitter:site"),
    twitterCreator: getMeta("twitter:creator"),
  };
}

// ─── Hydration Data Extraction ───────────────────────────────────────
// Twitter/X sometimes embeds __NEXT_DATA__ or window.__INITIAL_STATE__
// in script tags. Format varies — we try known patterns.

function parseHydrationData() {
  const results = {
    user: null,
    tweets: [],
    videos: [],
    images: [],
  };

  // Try __NEXT_DATA__ (Next.js hydration)
  const nextData = document.getElementById("__NEXT_DATA__");
  if (nextData) {
    try {
      const json = JSON.parse(nextData.textContent);
      walkHydrationData(json, results, 0);
    } catch { /* skip */ }
  }

  // Try embedded script tags with JSON
  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const script of scripts) {
    try {
      const json = JSON.parse(script.textContent);
      walkHydrationData(json, results, 0);
    } catch { /* skip */ }
  }

  return results;
}

const MAX_DEPTH = 15;

function walkHydrationData(obj, results, depth) {
  if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) return;

  if (Array.isArray(obj)) {
    for (const item of obj) walkHydrationData(item, results, depth + 1);
    return;
  }

  // User/profile object — has screen_name + profile_image_url_https
  if (obj.screen_name && obj.profile_image_url_https && !results.user) {
    results.user = {
      name: obj.name || null,
      screenName: obj.screen_name,
      profilePic: upgradeImageUrl(obj.profile_image_url_https),
      banner: obj.profile_banner_url || null,
      bio: obj.description || null,
      followers: obj.followers_count || 0,
      following: obj.friends_count || 0,
      verified: obj.verified || obj.is_blue_verified || false,
      id: obj.id_str || obj.id || null,
    };
  }

  // Media entity — has media_url_https + type
  if (obj.media_url_https && obj.type) {
    if (obj.type === "video" || obj.type === "animated_gif") {
      // Extract MP4 variants
      const variants = obj.video_info?.variants || [];
      const mp4s = variants
        .filter((v) => v.content_type === "video/mp4" && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (mp4s.length > 0) {
        const best = mp4s[0];
        // Parse dimensions from URL or aspect_ratio
        const aspect = obj.video_info?.aspect_ratio || [16, 9];
        const w = obj.original_info?.width || obj.sizes?.large?.w || 0;
        const h = obj.original_info?.height || obj.sizes?.large?.h || 0;

        if (!results.videos.some((v) => v.url === best.url)) {
          results.videos.push({
            url: best.url,
            thumbnail: upgradeImageUrl(obj.media_url_https),
            width: w,
            height: h,
            bitrate: best.bitrate || 0,
            id: obj.id_str || obj.media_key || null,
            type: obj.type,
          });
        }
      }
    } else if (obj.type === "photo") {
      const url = upgradeImageUrl(obj.media_url_https);
      if (url && !results.images.some((i) => i.url === url)) {
        results.images.push({
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
    walkHydrationData(obj[key], results, depth + 1);
  }
}

// ─── DOM Scraping (Fallback) ─────────────────────────────────────────
// Twitter/X uses data-testid extensively — much more stable than classes.

function extractFromDOM() {
  const data = {
    name: null,
    handle: null,
    bio: null,
    profilePic: null,
    banner: null,
    verified: false,
    tweetImages: [],
    tweetVideos: [],
  };

  // Display name
  const nameEl = document.querySelector('[data-testid="UserName"]');
  if (nameEl) {
    // First child span is display name, second is @handle
    const spans = nameEl.querySelectorAll("span");
    for (const span of spans) {
      const text = span.textContent.trim();
      if (text.startsWith("@")) {
        data.handle = text.slice(1);
      } else if (text && !data.name && text.length > 0 && !text.match(/^[\s·]+$/)) {
        data.name = text;
      }
    }
  }

  // Bio
  const bioEl = document.querySelector('[data-testid="UserDescription"]');
  if (bioEl) data.bio = bioEl.textContent.trim();

  // Profile picture — look for img within avatar container
  const avatarSelectors = [
    '[data-testid^="UserAvatar-Container"] img[src*="twimg.com"]',
    'a[href$="/photo"] img[src*="profile_images"]',
    '[aria-label*="Opens profile photo"] img',
  ];
  for (const sel of avatarSelectors) {
    const el = document.querySelector(sel);
    if (el?.src && TW_IMG_CDN.test(el.src)) {
      data.profilePic = upgradeImageUrl(el.src);
      break;
    }
  }

  // Banner — header photo
  const bannerSelectors = [
    'a[href$="/header_photo"] img[src*="twimg.com"]',
    '[data-testid="UserProfileHeader_Items"] ~ div img[src*="profile_banners"]',
  ];
  for (const sel of bannerSelectors) {
    const el = document.querySelector(sel);
    if (el?.src && TW_IMG_CDN.test(el.src)) {
      data.banner = el.src;
      break;
    }
  }

  // Verified badge
  data.verified = !!document.querySelector(
    '[data-testid="icon-verified"]'
  );

  // Tweet images
  const seen = new Set();
  const tweetPhotos = document.querySelectorAll('[data-testid="tweetPhoto"] img');
  for (const img of tweetPhotos) {
    const src = img.src;
    if (!src || seen.has(src) || !TW_IMG_CDN.test(src)) continue;
    seen.add(src);
    data.tweetImages.push({
      url: upgradeImageUrl(src),
      alt: img.alt || "",
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
    });
  }

  // Tweet videos — look for video elements with twimg.com sources
  const videoEls = document.querySelectorAll('[data-testid="videoComponent"] video, video[poster*="twimg.com"]');
  for (const el of videoEls) {
    const src = el.src || el.querySelector("source")?.src;
    if (src && !src.startsWith("blob:") && TW_CDN_PATTERN.test(src) && !seen.has(src)) {
      seen.add(src);
      data.tweetVideos.push({
        url: src,
        poster: el.poster || null,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
      });
    }
  }

  return data;
}

// ─── Username Extraction ─────────────────────────────────────────────

function extractUsername() {
  // From URL path — /username or /username/status/ID
  const pathMatch = window.location.pathname.match(/^\/(\w+)/);
  if (pathMatch) {
    const name = pathMatch[1];
    // Exclude known non-user paths
    const reserved = ["home", "explore", "search", "notifications", "messages", "i", "settings", "compose"];
    if (!reserved.includes(name)) return name;
  }
  // From twitter:creator meta
  const creator = getMeta("twitter:creator");
  if (creator) return creator.replace(/^@/, "");
  // From twitter:site meta
  const site = getMeta("twitter:site");
  if (site) return site.replace(/^@/, "");
  return null;
}

// ─── Post ID Extraction ─────────────────────────────────────────────

function extractPostId() {
  const m = window.location.pathname.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

// ─── MAIN World Intercept Data (via postMessage bridge) ──────────────
// Reads data captured by twitter-video-intercept.js (MAIN world).
// Uses postMessage because MAIN and ISOLATED worlds can't share globals.

async function readInterceptData() {
  const requestId = `nas_tw_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(null); // No data — intercept may not be active yet
    }, 2000);

    function handler(event) {
      if (event.source !== window) return;
      const msg = event.data;
      if (msg?.type !== "NAS_TWITTER_DATA_RESPONSE") return;
      if (msg.requestId !== requestId) return;

      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      resolve(msg.data || null);
    }

    window.addEventListener("message", handler);
    window.postMessage({ type: "NAS_TWITTER_GET_DATA", requestId }, "*");
  });
}

// ─── Main Analyzer ───────────────────────────────────────────────────

async function analyzeTwitter() {
  const pageType = detectPageType();
  const result = {
    platform: "twitter",
    pageType,
    assets: [],
    platformMeta: {},
  };

  const username = extractUsername();
  const postId = extractPostId();
  const meta = extractMetaData();
  const hydration = parseHydrationData();
  const dom = extractFromDOM();

  // ── Read intercepted API data (from MAIN world) ──
  const intercepted = await readInterceptData();

  // Merge intercepted user data into hydration results
  // Prefer the user matching the current URL to avoid SPA navigation stale data
  if (intercepted?.users) {
    const urlUser = username?.toLowerCase();
    // First pass: look for the user matching the current page URL
    for (const [screenName, user] of Object.entries(intercepted.users)) {
      if (!hydration.user && user.screenName && urlUser && user.screenName.toLowerCase() === urlUser) {
        hydration.user = {
          name: user.name,
          screenName: user.screenName,
          profilePic: upgradeImageUrl(user.profilePic),
          banner: user.banner,
          bio: user.bio,
          followers: user.followers || 0,
          following: user.following || 0,
          verified: user.verified || false,
          id: user.id,
        };
      }
    }
    // Fallback: if no URL match, take the first available user
    if (!hydration.user) {
      for (const [screenName, user] of Object.entries(intercepted.users)) {
        if (user.screenName) {
          hydration.user = {
            name: user.name,
            screenName: user.screenName,
            profilePic: upgradeImageUrl(user.profilePic),
            banner: user.banner,
            bio: user.bio,
            followers: user.followers || 0,
            following: user.following || 0,
            verified: user.verified || false,
            id: user.id,
          };
          break;
        }
      }
    }
  }

  // Merge intercepted video data
  if (intercepted?.videos) {
    for (const [key, video] of Object.entries(intercepted.videos)) {
      if (!video.url) continue;
      if (!hydration.videos.some((v) => v.url === video.url)) {
        hydration.videos.push({
          url: video.url,
          thumbnail: video.thumbnail ? upgradeImageUrl(video.thumbnail) : null,
          width: video.width || 0,
          height: video.height || 0,
          bitrate: video.bitrate || 0,
          id: video.id || key,
          type: video.type || "video",
        });
      }
    }
  }

  // Merge intercepted image data
  if (intercepted?.images) {
    for (const [key, img] of Object.entries(intercepted.images)) {
      if (!img.url) continue;
      if (!hydration.images.some((i) => i.url === img.url)) {
        hydration.images.push({
          url: img.url,
          width: img.width || 0,
          height: img.height || 0,
          alt: img.alt || "",
          id: img.id || key,
        });
      }
    }
  }

  // Validate hydration user matches current page — clear stale data
  // The intercept accumulates users across SPA navigations; hydration JSON
  // can also contain unrelated user objects (logged-in user, suggested users).
  // URL-extracted username is ground truth — if it doesn't match, discard.
  if (hydration.user && username) {
    const hydrationHandle = hydration.user.screenName?.toLowerCase();
    if (hydrationHandle && hydrationHandle !== username.toLowerCase()) {
      hydration.user = null;
    }
  }

  // Build platform metadata (merge all sources)
  // URL-extracted username is the most reliable source on SPA navigations —
  // hydration and intercept data can be stale from a previously visited profile
  result.platformMeta = {
    name: hydration.user?.name || dom.name || meta.name || null,
    username: username || hydration.user?.screenName || dom.handle || null,
    bio: hydration.user?.bio || dom.bio || meta.description || null,
    followers: hydration.user?.followers || 0,
    following: hydration.user?.following || 0,
    verified: hydration.user?.verified || dom.verified || false,
    userId: hydration.user?.id || null,
  };

  const resolvedUsername = result.platformMeta.username || username;

  // ── Profile picture ──
  const profilePic = hydration.user?.profilePic || dom.profilePic || null;
  if (profilePic && TW_CDN_PATTERN.test(profilePic)) {
    result.assets.push({
      url: upgradeImageUrl(profilePic),
      type: "image",
      context: "profile-pic",
      isLogo: true,
      isUI: false,
      alt: `${result.platformMeta.name || resolvedUsername || "twitter"} profile picture`,
      width: 0,
      height: 0,
      platformTag: "twitter-profile-pic",
      username: resolvedUsername,
    });
  }

  // ── Banner / header image ──
  const banner = hydration.user?.banner || dom.banner || null;
  if (banner && TW_CDN_PATTERN.test(banner)) {
    result.assets.push({
      url: banner,
      type: "image",
      context: "banner",
      isLogo: false,
      isUI: false,
      alt: `${result.platformMeta.name || resolvedUsername || "twitter"} banner`,
      width: 0,
      height: 0,
      platformTag: "twitter-banner",
      username: resolvedUsername,
    });
  }

  // ── OG image (profile or tweet card) ──
  // Only add if we didn't already get a profile pic or banner
  const ogImage = meta.image;
  if (ogImage && TW_CDN_PATTERN.test(ogImage)) {
    const upgraded = upgradeImageUrl(ogImage);
    const existingUrls = new Set(result.assets.map((a) => a.url));
    if (!existingUrls.has(upgraded)) {
      const isProfilePic = ogImage.includes("/profile_images/");
      result.assets.push({
        url: upgraded,
        type: "image",
        context: isProfilePic ? "profile-pic" : "og-image",
        isLogo: isProfilePic,
        isUI: false,
        alt: meta.name || "",
        width: 0,
        height: 0,
        platformTag: isProfilePic ? "twitter-profile-pic" : "twitter-og-image",
        username: resolvedUsername,
      });
    }
  }

  // ── Videos from hydration data ──
  // Twitter video variants are H.264 MP4 with muxed audio — no pipeline needed
  for (const video of hydration.videos) {
    if (!video.url) continue;
    result.assets.push({
      url: video.url,
      type: "video",
      context: pageType === "tweet" ? "tweet-video" : "feed-video",
      isLogo: false,
      isUI: false,
      alt: "",
      width: video.width || 0,
      height: video.height || 0,
      platformTag: video.type === "animated_gif" ? "twitter-gif" : "twitter-video",
      poster: video.thumbnail || null,
      videoId: video.id,
      username: resolvedUsername,
      shortcode: postId || video.id,
      needsMux: false,
      needsTranscode: false,
      codec: "h264",
    });

    // Video thumbnail as image asset
    if (video.thumbnail && TW_CDN_PATTERN.test(video.thumbnail)) {
      result.assets.push({
        url: video.thumbnail,
        type: "image",
        context: "video-thumbnail",
        isLogo: false,
        isUI: false,
        alt: "",
        width: video.width || 0,
        height: video.height || 0,
        platformTag: "twitter-video-thumbnail",
        username: resolvedUsername,
      });
    }
  }

  // ── Images from hydration data ──
  const seenUrls = new Set(result.assets.map((a) => a.url));
  for (const img of hydration.images) {
    if (seenUrls.has(img.url)) continue;
    seenUrls.add(img.url);
    result.assets.push({
      url: img.url,
      type: "image",
      context: "tweet-image",
      isLogo: false,
      isUI: false,
      alt: img.alt || "",
      width: img.width || 0,
      height: img.height || 0,
      platformTag: "twitter-tweet-image",
      username: resolvedUsername,
      shortcode: postId,
    });
  }

  // ── DOM fallback: tweet images ──
  for (const img of dom.tweetImages) {
    if (seenUrls.has(img.url)) continue;
    seenUrls.add(img.url);
    result.assets.push({
      url: img.url,
      type: "image",
      context: "tweet-image",
      isLogo: false,
      isUI: false,
      alt: img.alt || "",
      width: img.width || 0,
      height: img.height || 0,
      platformTag: "twitter-tweet-image",
      username: resolvedUsername,
    });
  }

  // ── DOM fallback: videos ──
  for (const video of dom.tweetVideos) {
    if (seenUrls.has(video.url)) continue;
    seenUrls.add(video.url);
    result.assets.push({
      url: video.url,
      type: "video",
      context: "dom-video",
      isLogo: false,
      isUI: false,
      alt: "",
      width: video.width || 0,
      height: video.height || 0,
      platformTag: "twitter-video",
      poster: video.poster || null,
      username: resolvedUsername,
      shortcode: postId,
      needsMux: false,
      needsTranscode: false,
      codec: "h264",
    });
  }

  return result;
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzePlatform") {
    analyzeTwitter()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Twitter script error:", err);
        sendResponse({ platform: "twitter", error: err.message });
      });
    return true; // Async — waiting for intercept data
  }

  if (message.action === "deepScanPlatform") {
    deepScanTwitter()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Twitter deep scan error:", err);
        sendResponse({ platform: "twitter", error: err.message });
      });
    return true; // Async
  }
});

// ─── Deep Scan ───────────────────────────────────────────────────────
// Scroll the page to trigger lazy-loaded tweet content.

async function deepScanTwitter() {
  const pageType = detectPageType();

  if (["profile", "media", "likes"].includes(pageType)) {
    const maxDuration = 15000;
    const stepDelay = 600; // Twitter rate-limits DOM updates
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

  return await analyzeTwitter();
}

} // end duplicate injection guard
