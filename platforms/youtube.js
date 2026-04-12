// ─── Net Assets Scraper V2 — YouTube Platform Script ─────────────────
// Extracts BRAND ASSETS ONLY from YouTube pages:
//   - Channel avatars (high-res via URL param upgrade)
//   - Channel banners
//   - Video thumbnails (maxresdefault where available)
//   - Channel metadata (name, handle, subscriber count, description)
//
// ⚠️  NO VIDEO DOWNLOAD — YouTube's cipher/signature system changes
// constantly. Maintaining a working downloader is a full-time job.
// Thumbnails are static CDN files and always accessible.
//
// Data sources (priority order):
//   1. OG meta tags — fastest, reliable for basic info
//   2. ytInitialData — richest data, embedded in SSR script tags
//   3. DOM scraping — fallback for SPA navigation
//
// Page types:
//   - Channel: youtube.com/@handle, /c/NAME, /channel/ID
//   - Video:   youtube.com/watch?v=ID
//   - Shorts:  youtube.com/shorts/ID
//   - Playlist: youtube.com/playlist?list=ID

// Guard against duplicate injection
if (window.__NAS_YOUTUBE_LOADED__) {
  // Already loaded — skip
} else {
  window.__NAS_YOUTUBE_LOADED__ = true;

// ─── Constants ───────────────────────────────────────────────────────
const YT_IMG_CDN = /yt3\.ggpht\.com|yt3\.googleusercontent\.com|i\.ytimg\.com|lh3\.googleusercontent\.com/;

// ─── Page Type Detection ─────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname;
  const search = window.location.search;

  if (path === "/" || path === "")                     return "home";
  if (/^\/watch\b/.test(path))                        return "video";
  if (/^\/shorts\/[\w-]+/.test(path))                 return "shorts";
  if (/^\/playlist\b/.test(path))                     return "playlist";
  if (/^\/@[\w.-]+/.test(path))                       return "channel";
  if (/^\/c\/[\w.-]+/.test(path))                     return "channel";
  if (/^\/channel\/[\w-]+/.test(path))                return "channel";
  if (/^\/user\/[\w.-]+/.test(path))                  return "channel";
  if (/^\/results\b/.test(path))                      return "search";
  if (/^\/(feed|trending|gaming)\b/.test(path))       return "browse";

  return "other";
}

// ─── Image URL Manipulation ──────────────────────────────────────────
// YouTube CDN uses URL params/suffixes for image sizing.

function upgradeAvatarUrl(url) {
  if (!url) return null;
  // Replace size suffix: =s176-c-k-... → =s900-c-k-...
  return url.replace(/=s\d+/, "=s900");
}

function upgradeBannerUrl(url) {
  if (!url) return null;
  // Replace width: =w1060- or =w2120- → =w2560-
  return url.replace(/=w\d+-/, "=w2560-");
}

function getMaxThumbnail(videoId) {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

function getHqThumbnail(videoId) {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ─── OG Meta Tag Extraction ──────────────────────────────────────────

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
    siteName: getMeta("og:site_name"),
  };
}

// ─── ytInitialData Extraction ────────────────────────────────────────
// YouTube embeds page data as: var ytInitialData = { ... };
// in inline <script> tags. This is the richest source.

function parseYtInitialData() {
  const results = {
    channel: null,
    thumbnails: [],
    avatar: null,
    banner: null,
  };

  // Try to find ytInitialData in script tags
  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;

    // Pattern: var ytInitialData = {...};
    const match = text.match(/var\s+ytInitialData\s*=\s*(\{.+?\});/s);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        walkYtData(data, results, 0);
      } catch { /* skip */ }
      break; // Only one ytInitialData per page
    }

    // Alternative pattern: window["ytInitialData"] = {...};
    const altMatch = text.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\});/s);
    if (altMatch) {
      try {
        const data = JSON.parse(altMatch[1]);
        walkYtData(data, results, 0);
      } catch { /* skip */ }
      break;
    }
  }

  return results;
}

const MAX_DEPTH = 12;

function walkYtData(obj, results, depth) {
  if (!obj || typeof obj !== "object" || depth > MAX_DEPTH) return;

  if (Array.isArray(obj)) {
    for (const item of obj) walkYtData(item, results, depth + 1);
    return;
  }

  // Channel header — c4TabbedHeaderRenderer (classic) or pageHeaderRenderer (new)
  if (obj.c4TabbedHeaderRenderer) {
    const header = obj.c4TabbedHeaderRenderer;
    if (!results.channel) {
      results.channel = {
        name: header.title || null,
        channelId: header.channelId || null,
        handle: header.channelHandleText?.runs?.[0]?.text || null,
        subscribers: header.subscriberCountText?.simpleText
          || header.subscriberCountText?.runs?.[0]?.text || null,
      };
    }
    // Avatar from header
    const avatarThumbs = header.avatar?.thumbnails;
    if (avatarThumbs?.length && !results.avatar) {
      const best = avatarThumbs[avatarThumbs.length - 1];
      results.avatar = upgradeAvatarUrl(best.url);
    }
    // Banner from header
    const bannerThumbs = header.banner?.thumbnails;
    if (bannerThumbs?.length && !results.banner) {
      const best = bannerThumbs[bannerThumbs.length - 1];
      results.banner = upgradeBannerUrl(best.url);
    }
  }

  // New-style page header (pageHeaderViewModel)
  if (obj.pageHeaderViewModel) {
    const vm = obj.pageHeaderViewModel;
    if (!results.channel) {
      results.channel = {
        name: vm.title?.content || null,
        handle: vm.metadata?.contentMetadataViewModel?.metadataRows?.[0]
          ?.metadataParts?.[0]?.text?.content || null,
        subscribers: null,
        channelId: null,
      };
    }
    // Avatar from banner
    const img = vm.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel
      ?.image?.sources;
    if (img?.length && !results.avatar) {
      const best = img[img.length - 1];
      results.avatar = upgradeAvatarUrl(best.url);
    }
    // Banner
    const bannerImg = vm.banner?.imageBannerViewModel?.image?.sources;
    if (bannerImg?.length && !results.banner) {
      const best = bannerImg[bannerImg.length - 1];
      results.banner = upgradeBannerUrl(best.url);
    }
  }

  // Video renderer — extract thumbnails
  if (obj.videoId && obj.thumbnail?.thumbnails) {
    const thumbs = obj.thumbnail.thumbnails;
    const best = thumbs[thumbs.length - 1];
    if (best?.url && !results.thumbnails.some((t) => t.videoId === obj.videoId)) {
      results.thumbnails.push({
        videoId: obj.videoId,
        url: best.url,
        title: obj.title?.runs?.[0]?.text || obj.title?.simpleText || "",
        width: best.width || 0,
        height: best.height || 0,
      });
    }
  }

  // Recurse
  for (const key of Object.keys(obj)) {
    walkYtData(obj[key], results, depth + 1);
  }
}

// ─── DOM Scraping (Fallback) ─────────────────────────────────────────

function extractFromDOM() {
  const data = {
    name: null,
    handle: null,
    avatar: null,
    banner: null,
    thumbnails: [],
  };

  // Channel name
  const nameEl = document.querySelector(
    "#channel-name yt-formatted-string, ytd-channel-name yt-formatted-string"
  );
  if (nameEl) data.name = nameEl.textContent.trim();

  // Channel handle
  const handleEl = document.querySelector("#channel-handle, ytd-channel-name + yt-formatted-string");
  if (handleEl) data.handle = handleEl.textContent.trim();

  // Avatar
  const avatarSelectors = [
    "#avatar img",
    "ytd-channel-avatar img",
    "#channel-header-container img.yt-img-shadow",
  ];
  for (const sel of avatarSelectors) {
    const el = document.querySelector(sel);
    if (el?.src && YT_IMG_CDN.test(el.src)) {
      data.avatar = upgradeAvatarUrl(el.src);
      break;
    }
  }

  // Banner
  const bannerSelectors = [
    "#channel-banner img",
    "ytd-c4-tabbed-header-renderer .banner-visible-area img",
    ".page-header-banner img",
  ];
  for (const sel of bannerSelectors) {
    const el = document.querySelector(sel);
    if (el?.src && YT_IMG_CDN.test(el.src)) {
      data.banner = upgradeBannerUrl(el.src);
      break;
    }
  }

  // Video thumbnails from the grid
  const thumbEls = document.querySelectorAll("ytd-thumbnail img.yt-core-image, ytd-thumbnail img[src*='ytimg.com']");
  const seen = new Set();
  for (const el of thumbEls) {
    if (!el.src || seen.has(el.src) || !el.src.includes("ytimg.com")) continue;
    seen.add(el.src);

    // Extract video ID from the img URL: /vi/{ID}/
    const idMatch = el.src.match(/\/vi\/([\w-]+)\//);
    if (!idMatch) continue;

    data.thumbnails.push({
      videoId: idMatch[1],
      url: el.src,
      title: el.alt || "",
      width: el.naturalWidth || 0,
      height: el.naturalHeight || 0,
    });
  }

  return data;
}

// ─── Channel Handle Extraction ───────────────────────────────────────

function extractChannelHandle() {
  // From URL: /@handle
  const handleMatch = window.location.pathname.match(/^\/@([\w.-]+)/);
  if (handleMatch) return handleMatch[1];
  // From /c/name
  const cMatch = window.location.pathname.match(/^\/c\/([\w.-]+)/);
  if (cMatch) return cMatch[1];
  // From /user/name
  const userMatch = window.location.pathname.match(/^\/user\/([\w.-]+)/);
  if (userMatch) return userMatch[1];
  return null;
}

function extractVideoId() {
  // Watch page: ?v=ID
  const params = new URLSearchParams(window.location.search);
  const v = params.get("v");
  if (v) return v;
  // Shorts: /shorts/ID
  const shortsMatch = window.location.pathname.match(/^\/shorts\/([\w-]+)/);
  if (shortsMatch) return shortsMatch[1];
  return null;
}

// ─── Main Analyzer ───────────────────────────────────────────────────

function analyzeYouTube() {
  const pageType = detectPageType();
  const result = {
    platform: "youtube",
    pageType,
    assets: [],
    platformMeta: {},
  };

  const handle = extractChannelHandle();
  const videoId = extractVideoId();
  const meta = extractMetaData();
  const ytData = parseYtInitialData();
  const dom = extractFromDOM();

  // Build platform metadata
  result.platformMeta = {
    name: ytData.channel?.name || dom.name || meta.name || null,
    username: ytData.channel?.handle || dom.handle || handle || null,
    subscribers: ytData.channel?.subscribers || null,
    channelId: ytData.channel?.channelId || null,
    description: meta.description || null,
  };

  const resolvedHandle = result.platformMeta.username || handle;

  // ── Channel avatar ──
  const avatar = ytData.avatar || dom.avatar || null;
  if (avatar && YT_IMG_CDN.test(avatar)) {
    result.assets.push({
      url: avatar,
      type: "image",
      context: "profile-pic",
      isLogo: true,
      isUI: false,
      alt: `${result.platformMeta.name || resolvedHandle || "youtube"} channel avatar`,
      width: 0,
      height: 0,
      platformTag: "youtube-avatar",
      username: resolvedHandle,
    });
  }

  // ── Channel banner ──
  const banner = ytData.banner || dom.banner || null;
  if (banner && YT_IMG_CDN.test(banner)) {
    result.assets.push({
      url: banner,
      type: "image",
      context: "banner",
      isLogo: false,
      isUI: false,
      alt: `${result.platformMeta.name || resolvedHandle || "youtube"} channel banner`,
      width: 0,
      height: 0,
      platformTag: "youtube-banner",
      username: resolvedHandle,
    });
  }

  // ── OG image (video thumbnail on watch page, avatar on channel) ──
  const ogImage = meta.image;
  if (ogImage) {
    const existingUrls = new Set(result.assets.map((a) => a.url));
    if (!existingUrls.has(ogImage)) {
      const isAvatar = ogImage.includes("yt3.ggpht.com") || ogImage.includes("yt3.googleusercontent.com");
      result.assets.push({
        url: isAvatar ? upgradeAvatarUrl(ogImage) : ogImage,
        type: "image",
        context: isAvatar ? "profile-pic" : "video-thumbnail",
        isLogo: isAvatar,
        isUI: false,
        alt: meta.name || "",
        width: 0,
        height: 0,
        platformTag: isAvatar ? "youtube-avatar" : "youtube-thumbnail",
        username: resolvedHandle,
      });
    }
  }

  // ── Current video thumbnail (watch/shorts page) ──
  if (videoId && (pageType === "video" || pageType === "shorts")) {
    const maxThumb = getMaxThumbnail(videoId);
    const hqThumb = getHqThumbnail(videoId);
    const seenUrls = new Set(result.assets.map((a) => a.url));

    if (!seenUrls.has(maxThumb)) {
      result.assets.push({
        url: maxThumb,
        type: "image",
        context: "video-thumbnail",
        isLogo: false,
        isUI: false,
        alt: meta.name || "",
        width: 1280,
        height: 720,
        platformTag: "youtube-thumbnail-max",
        username: resolvedHandle,
        shortcode: videoId,
      });
    }
    // Also add HQ as fallback (maxres doesn't always exist)
    if (!seenUrls.has(hqThumb)) {
      result.assets.push({
        url: hqThumb,
        type: "image",
        context: "video-thumbnail",
        isLogo: false,
        isUI: false,
        alt: meta.name || "",
        width: 480,
        height: 360,
        platformTag: "youtube-thumbnail-hq",
        username: resolvedHandle,
        shortcode: videoId,
      });
    }
  }

  // ── Video thumbnails from channel/search ──
  const allThumbs = [...ytData.thumbnails, ...dom.thumbnails];
  const seenVideoIds = new Set();
  const seenUrls = new Set(result.assets.map((a) => a.url));

  for (const thumb of allThumbs) {
    if (!thumb.videoId || seenVideoIds.has(thumb.videoId)) continue;
    seenVideoIds.add(thumb.videoId);

    // Use maxresdefault for best quality
    const maxUrl = getMaxThumbnail(thumb.videoId);
    if (seenUrls.has(maxUrl)) continue;
    seenUrls.add(maxUrl);

    result.assets.push({
      url: maxUrl,
      type: "image",
      context: "video-thumbnail",
      isLogo: false,
      isUI: false,
      alt: thumb.title || "",
      width: 1280,
      height: 720,
      platformTag: "youtube-thumbnail-max",
      username: resolvedHandle,
      shortcode: thumb.videoId,
    });
  }

  return result;
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzePlatform") {
    try {
      const result = analyzeYouTube();
      sendResponse(result);
    } catch (err) {
      console.error("NAS YouTube script error:", err);
      sendResponse({ platform: "youtube", error: err.message });
    }
    return false; // Synchronous
  }

  if (message.action === "deepScanPlatform") {
    deepScanYouTube()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS YouTube deep scan error:", err);
        sendResponse({ platform: "youtube", error: err.message });
      });
    return true; // Async
  }
});

// ─── Deep Scan ───────────────────────────────────────────────────────
// Scroll channel pages to load more video thumbnails.

async function deepScanYouTube() {
  const pageType = detectPageType();

  if (pageType === "channel") {
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

  return analyzeYouTube();
}

} // end duplicate injection guard
