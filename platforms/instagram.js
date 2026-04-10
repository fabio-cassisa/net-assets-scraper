// ─── Net Assets Scraper V2 — Instagram Platform Script ───────────────
// Extracts brand assets from Instagram pages:
//   - Profile pictures (high-res)
//   - Post images and carousels
//   - Reels/video poster frames + video URLs
//   - Stories (when accessible)
//   - Bio text, username, follower counts
//
// Page types:
//   - Profile:  instagram.com/username/
//   - Post:     instagram.com/p/CODE/
//   - Reel:     instagram.com/reels/CODE/
//   - Stories:  instagram.com/stories/username/

// Guard against duplicate injection
if (window.__NAS_INSTAGRAM_LOADED__) {
  // Already loaded — skip
} else {
  window.__NAS_INSTAGRAM_LOADED__ = true;

// ─── Constants ───────────────────────────────────────────────────────
const IG_CDN_PATTERN = /scontent[.-]|cdninstagram\.com|fbcdn\.net/;

// ─── Page Type Detection ─────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname;

  if (/^\/p\/[\w-]+\/?/.test(path))      return "post";
  if (/^\/reels?\/[\w-]+\/?/.test(path))  return "reel";
  if (/^\/stories\/[\w.]+\/?/.test(path)) return "stories";
  if (/^\/explore\/?/.test(path))          return "explore";
  if (/^\/[\w.]+\/?$/.test(path) && path !== "/") return "profile";

  return "other";
}

// ─── Profile Page Extraction ─────────────────────────────────────────

function extractProfileData() {
  const data = {
    username: null,
    fullName: null,
    bio: null,
    profilePic: null,
    postImages: [],
    isVerified: false,
  };

  // Username from URL
  const pathMatch = window.location.pathname.match(/^\/([\w.]+)\/?$/);
  if (pathMatch) data.username = pathMatch[1];

  // Profile picture — Instagram renders the profile pic as an <img> inside
  // a header/section area. Look for the canonical profile pic patterns.
  const profilePicCandidates = document.querySelectorAll(
    'img[alt*="profile picture" i], img[alt*="foto de perfil" i], img[alt*="profilbild" i], img[data-testid="user-avatar"]'
  );

  // Also try: the first large circular image in the header area
  if (profilePicCandidates.length === 0) {
    const headerImgs = document.querySelectorAll("header img");
    for (const img of headerImgs) {
      const style = getComputedStyle(img);
      if (style.borderRadius === "50%" || parseInt(style.borderRadius) > 40) {
        data.profilePic = getBestImageUrl(img);
        break;
      }
    }
  } else {
    // Take the largest profile pic candidate
    let best = null;
    let bestSize = 0;
    for (const img of profilePicCandidates) {
      const size = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
      if (size > bestSize || !best) {
        best = img;
        bestSize = size;
      }
    }
    if (best) data.profilePic = getBestImageUrl(best);
  }

  // Try to get HD profile pic from meta og:image (sometimes it's the profile pic)
  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage && !data.profilePic) {
    data.profilePic = ogImage.content;
  }

  // Full name — typically in the header <span> or <h1>/<h2>
  const nameEl = document.querySelector("header h2, header h1, header section span[dir]");
  if (nameEl) {
    // Username is usually the first h2, full name might be elsewhere
    data.username = data.username || nameEl.textContent.trim();
  }

  // Bio text
  const bioSelectors = [
    "header section > div > span",
    'header [data-testid="user-bio"]',
    "header section h1 ~ div span",
  ];
  for (const sel of bioSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 5) {
      data.bio = el.textContent.trim();
      break;
    }
  }

  // Verified badge
  data.isVerified = !!document.querySelector(
    'header [aria-label*="Verified" i], header [title*="Verified" i], header svg[aria-label*="Verified" i]'
  );

  // Post grid images — the main feed grid
  data.postImages = extractPostGrid();

  return data;
}

// ─── Post Grid Extraction ────────────────────────────────────────────

function extractPostGrid() {
  const posts = [];
  const seen = new Set();

  // Instagram's post grid uses <article> or main content area with <img> tags
  // The images are usually inside <a> links pointing to /p/CODE/
  const postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');

  for (const link of postLinks) {
    const href = link.getAttribute("href");
    const imgs = link.querySelectorAll("img");

    for (const img of imgs) {
      const url = getBestImageUrl(img);
      if (!url || seen.has(url)) continue;
      if (!isInstagramCdnUrl(url)) continue;
      seen.add(url);

      posts.push({
        url,
        alt: img.alt || "",
        postUrl: href ? `https://www.instagram.com${href}` : null,
        type: href && href.includes("/reel/") ? "reel-thumb" : "post",
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
      });
    }

    // Check for video indicators (reels have a video icon overlay)
    const videoIndicator = link.querySelector('svg[aria-label*="Video" i], svg[aria-label*="Reel" i], span[aria-label*="Video" i]');
    if (videoIndicator) {
      // Mark the last image from this link as a reel thumbnail
      if (posts.length > 0) {
        const last = posts[posts.length - 1];
        if (last.postUrl === `https://www.instagram.com${href}`) {
          last.type = "reel-thumb";
        }
      }
    }
  }

  return posts;
}

// ─── Single Post Page Extraction ─────────────────────────────────────

function extractPostData() {
  const data = {
    images: [],
    videos: [],
    caption: null,
    author: null,
  };

  const seen = new Set();

  // Post images — main content area, not sidebar/nav
  // Instagram wraps post images in <article> elements
  const article = document.querySelector("article, [role='presentation'] div");
  const container = article || document.body;

  // Images in the post content
  const imgs = container.querySelectorAll("img");
  for (const img of imgs) {
    const url = getBestImageUrl(img);
    if (!url || seen.has(url)) continue;
    if (!isInstagramCdnUrl(url)) continue;

    // Skip tiny images (profile pics in comments, UI icons)
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && w <= 50 && h <= 50) continue;

    seen.add(url);
    data.images.push({
      url,
      alt: img.alt || "",
      width: w,
      height: h,
      type: "post-image",
    });
  }

  // Videos in the post
  // First: try to get complete video URLs from meta tags (not fragments)
  const metaVideoUrls = extractVideoUrlsFromMeta();
  for (const url of metaVideoUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      data.videos.push({
        url,
        poster: null,
        type: "post-video",
        width: 0,
        height: 0,
      });
    }
  }

  // Fallback: check <video> elements for direct CDN src (skip blob: URLs)
  const videos = container.querySelectorAll("video");
  for (const video of videos) {
    const src = video.src || video.querySelector("source")?.src;
    if (!src || seen.has(src)) continue;
    // Skip blob: URLs — they point to MSE assembled streams, not downloadable files
    if (src.startsWith("blob:")) continue;
    if (!IG_CDN_PATTERN.test(src)) continue;
    seen.add(src);

    data.videos.push({
      url: src,
      poster: video.poster || null,
      type: "post-video",
      width: video.videoWidth || video.width || 0,
      height: video.videoHeight || video.height || 0,
    });
  }

  // Grab poster frames from video elements as image assets
  for (const video of videos) {
    if (video.poster && !seen.has(video.poster) && isInstagramCdnUrl(video.poster)) {
      seen.add(video.poster);
      data.images.push({
        url: video.poster,
        alt: "",
        width: 0,
        height: 0,
        type: "video-poster",
      });
    }
  }

  // Carousel detection — look for next/prev buttons indicating multiple slides
  const carouselBtns = container.querySelectorAll(
    'button[aria-label*="Next" i], button[aria-label*="Go Forward" i], button[aria-label*="Neste" i], button[aria-label*="Nästa" i], button[aria-label*="Avanti" i]'
  );
  if (carouselBtns.length > 0) {
    // It's a carousel — the visible images are what we got, user needs to
    // manually swipe for more (we can't click carousel buttons from content script
    // without side effects). Flag it.
    data.isCarousel = true;
  }

  // Caption
  const captionSelectors = [
    'article span[dir="auto"]',
    'article div[role="button"] span',
    'article ul li span[dir="auto"]',
  ];
  for (const sel of captionSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 10) {
      data.caption = el.textContent.trim().slice(0, 500);
      break;
    }
  }

  // Author username
  const authorLink = document.querySelector('article header a[href^="/"]');
  if (authorLink) {
    data.author = authorLink.textContent.trim() || authorLink.getAttribute("href").replace(/\//g, "");
  }

  return data;
}

// ─── Reel Page Extraction ────────────────────────────────────────────

function extractReelData() {
  const data = {
    videos: [],
    poster: null,
    author: null,
  };

  const seen = new Set();

  // First: try to get complete video URLs from meta tags (not fragments)
  const metaVideoUrls = extractVideoUrlsFromMeta();
  for (const url of metaVideoUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      data.videos.push({
        url,
        poster: null,
        type: "reel",
        width: 0,
        height: 0,
      });
    }
  }

  // Fallback: check <video> elements for direct CDN src (skip blob: URLs)
  const videos = document.querySelectorAll("video");
  for (const video of videos) {
    const src = video.src || video.querySelector("source")?.src;
    if (!src || seen.has(src)) continue;
    // Skip blob: URLs — they point to MSE assembled streams, not downloadable files
    if (src.startsWith("blob:")) continue;
    if (!IG_CDN_PATTERN.test(src)) continue;
    seen.add(src);

    data.videos.push({
      url: src,
      poster: video.poster || null,
      type: "reel",
      width: video.videoWidth || video.width || 0,
      height: video.videoHeight || video.height || 0,
    });
  }

  // Grab poster frames from video elements
  for (const video of videos) {
    if (video.poster && !seen.has(video.poster)) {
      seen.add(video.poster);
      data.poster = video.poster;
    }
  }

  return data;
}

// ─── Stories Extraction ──────────────────────────────────────────────

function extractStoriesData() {
  const data = {
    images: [],
    videos: [],
  };

  const seen = new Set();

  // Stories use <img> and <video> elements in a fullscreen viewer
  const imgs = document.querySelectorAll("img");
  for (const img of imgs) {
    const url = getBestImageUrl(img);
    if (!url || seen.has(url)) continue;
    if (!isInstagramCdnUrl(url)) continue;

    // Skip small UI elements
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && w <= 100 && h <= 100) continue;

    seen.add(url);
    data.images.push({
      url,
      alt: img.alt || "",
      type: "story-image",
      width: w,
      height: h,
    });
  }

  const videos = document.querySelectorAll("video");

  // First: try meta tags for complete video URLs
  const metaVideoUrls = extractVideoUrlsFromMeta();
  for (const url of metaVideoUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      data.videos.push({
        url,
        poster: null,
        type: "story-video",
        isBlob: false,
        width: 0,
        height: 0,
      });
    }
  }

  // Fallback: <video> elements with direct CDN src (skip blob: URLs)
  for (const video of videos) {
    const src = video.src || video.querySelector("source")?.src;
    if (!src || seen.has(src)) continue;
    if (src.startsWith("blob:")) continue;
    if (!IG_CDN_PATTERN.test(src)) continue;
    seen.add(src);

    data.videos.push({
      url: src,
      poster: video.poster || null,
      type: "story-video",
      isBlob: false,
      width: video.videoWidth || video.width || 0,
      height: video.videoHeight || video.height || 0,
    });
  }

  return data;
}

// ─── Shared Utilities ────────────────────────────────────────────────

function getBestImageUrl(img) {
  // srcset often has higher-res versions
  if (img.srcset) {
    const candidates = img.srcset.split(",").map((s) => {
      const parts = s.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] || "1x";
      // Parse width descriptor (e.g., "640w") or pixel density (e.g., "2x")
      let weight = 1;
      if (descriptor.endsWith("w")) {
        weight = parseInt(descriptor) || 1;
      } else if (descriptor.endsWith("x")) {
        weight = parseFloat(descriptor) * 1000 || 1;
      }
      return { url, weight };
    });
    // Pick the highest resolution
    candidates.sort((a, b) => b.weight - a.weight);
    if (candidates.length > 0 && candidates[0].url) {
      return candidates[0].url;
    }
  }

  // Lazy-load attributes
  for (const attr of ["data-src", "data-lazy-src", "data-original"]) {
    const val = img.getAttribute(attr);
    if (val && val.startsWith("http")) return val;
  }

  return img.src || null;
}

function isInstagramCdnUrl(url) {
  if (!url) return false;
  // Accept Instagram CDN URLs and any https image URLs on the page
  return IG_CDN_PATTERN.test(url) && !url.includes("static.cdninstagram.com/rsrc");
}

// ─── Video URL Extraction from Meta / JSON-LD ────────────────────────
// Instagram serves video via MSE (blob: URLs + fragmented segments).
// Complete video files are only available from og:video meta tags and
// JSON-LD structured data embedded in the page HTML.

function extractVideoUrlsFromMeta() {
  const urls = [];
  const seen = new Set();

  // 1. og:video and og:video:url meta tags
  const metaTags = document.querySelectorAll(
    'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]'
  );
  for (const tag of metaTags) {
    const url = tag.getAttribute("content");
    if (url && !seen.has(url) && IG_CDN_PATTERN.test(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  // 2. JSON-LD structured data (VideoObject)
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const videoUrl = item.contentUrl || item.embedUrl || item.url;
        if (videoUrl && !seen.has(videoUrl) && IG_CDN_PATTERN.test(videoUrl)) {
          seen.add(videoUrl);
          urls.push(videoUrl);
        }
      }
    } catch { /* skip malformed JSON-LD */ }
  }

  return urls;
}

// ─── Main Analyzer ───────────────────────────────────────────────────

function analyzeInstagram() {
  const pageType = detectPageType();
  const result = {
    platform: "instagram",
    pageType,
    assets: [],      // Unified asset list for the panel
    platformMeta: {}, // Platform-specific metadata
  };

  if (pageType === "profile") {
    const profile = extractProfileData();
    result.platformMeta = {
      username: profile.username,
      fullName: profile.fullName,
      bio: profile.bio,
      isVerified: profile.isVerified,
    };

    // Profile pic as an asset
    if (profile.profilePic) {
      result.assets.push({
        url: profile.profilePic,
        type: "image",
        context: "profile-pic",
        isLogo: true, // Profile pics are brand logos in this context
        isUI: false,
        alt: `${profile.username || "profile"} profile picture`,
        width: 0,
        height: 0,
        platformTag: "instagram-profile-pic",
      });
    }

    // Post grid images
    for (const post of profile.postImages) {
      result.assets.push({
        url: post.url,
        type: "image",
        context: "post-grid",
        isLogo: false,
        isUI: false,
        alt: post.alt,
        width: post.width,
        height: post.height,
        platformTag: post.type === "reel-thumb" ? "instagram-reel-thumb" : "instagram-post",
        postUrl: post.postUrl,
      });
    }
  }

  if (pageType === "post") {
    const post = extractPostData();
    result.platformMeta = {
      author: post.author,
      caption: post.caption,
      isCarousel: post.isCarousel || false,
    };

    for (const img of post.images) {
      result.assets.push({
        url: img.url,
        type: "image",
        context: "post",
        isLogo: false,
        isUI: false,
        alt: img.alt,
        width: img.width,
        height: img.height,
        platformTag: "instagram-post-image",
      });
    }

    for (const video of post.videos) {
      result.assets.push({
        url: video.url,
        type: "video",
        context: "post",
        isLogo: false,
        isUI: false,
        alt: "",
        width: video.width,
        height: video.height,
        platformTag: "instagram-post-video",
        poster: video.poster,
      });
    }
  }

  if (pageType === "reel") {
    const reel = extractReelData();
    result.platformMeta = { author: reel.author };

    for (const video of reel.videos) {
      result.assets.push({
        url: video.url,
        type: "video",
        context: "reel",
        isLogo: false,
        isUI: false,
        alt: "",
        width: video.width,
        height: video.height,
        platformTag: "instagram-reel",
        poster: video.poster,
        isBlob: video.isBlob || false,
      });
    }

    if (reel.poster) {
      result.assets.push({
        url: reel.poster,
        type: "image",
        context: "reel-poster",
        isLogo: false,
        isUI: false,
        alt: "Reel poster",
        width: 0,
        height: 0,
        platformTag: "instagram-reel-poster",
      });
    }
  }

  if (pageType === "stories") {
    const stories = extractStoriesData();

    for (const img of stories.images) {
      result.assets.push({
        url: img.url,
        type: "image",
        context: "story",
        isLogo: false,
        isUI: false,
        alt: img.alt,
        width: img.width,
        height: img.height,
        platformTag: "instagram-story",
      });
    }

    for (const video of stories.videos) {
      result.assets.push({
        url: video.url,
        type: "video",
        context: "story",
        isLogo: false,
        isUI: false,
        alt: "",
        width: video.width,
        height: video.height,
        platformTag: "instagram-story-video",
        poster: video.poster,
        isBlob: video.isBlob || false,
      });
    }
  }

  return result;
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzePlatform") {
    try {
      const result = analyzeInstagram();
      sendResponse(result);
    } catch (err) {
      console.error("NAS Instagram script error:", err);
      sendResponse({ platform: "instagram", error: err.message });
    }
    return true;
  }

  // Deep scan variant — scroll the page to load more grid posts, then analyze
  if (message.action === "deepScanPlatform") {
    deepScanInstagram()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS Instagram deep scan error:", err);
        sendResponse({ platform: "instagram", error: err.message });
      });
    return true;
  }
});

// ─── Deep Scan for Instagram ─────────────────────────────────────────
// On profile pages: scroll down to load more grid posts
// On other pages: similar to base content.js deep scan

async function deepScanInstagram() {
  const pageType = detectPageType();

  if (pageType === "profile") {
    // Scroll the profile grid to load more posts
    const maxDuration = 15000; // 15s for Instagram (slower lazy loading)
    const stepDelay = 400;
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
  } else {
    // Generic scroll for other page types
    const originalScroll = window.scrollY;
    const viewportH = window.innerHeight;
    const maxScroll = document.documentElement.scrollHeight;
    const stepPx = Math.floor(viewportH * 0.8);
    const maxDuration = 10000;
    const stepDelay = 300;
    const startTime = Date.now();
    let position = 0;

    while (position < maxScroll && (Date.now() - startTime) < maxDuration) {
      position += stepPx;
      window.scrollTo({ top: position, behavior: "instant" });
      await new Promise((r) => setTimeout(r, stepDelay));
    }

    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo({ top: originalScroll, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 300));
  }

  // Now run the full analysis
  return analyzeInstagram();
}

} // end duplicate injection guard
