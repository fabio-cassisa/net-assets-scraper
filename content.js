// ─── Net Assets Scraper V2 — Content Script ─────────────────────────
// Runs on every page. Extracts:
//   - Brand colors (CSS vars, meta tags, weighted frequency)
//   - Image context (where images appear in DOM, alt text, dimensions)
//   - Font information (font-family declarations, Google Fonts links)
//   - Page metadata (OG tags, theme color, site name)

// Guard against duplicate injection (extension reload + programmatic inject)
if (window.__NAS_CONTENT_LOADED__) {
  // Already loaded — skip re-registration
} else {
  window.__NAS_CONTENT_LOADED__ = true;

// ─── Color Utilities ─────────────────────────────────────────────────

function rgbToHex(rgb) {
  const parts = rgb.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  // Skip fully transparent
  if (parts.length >= 4 && parseFloat(parts[3]) === 0) return null;
  let hex = "#";
  for (let i = 0; i < 3; i++) {
    hex += Math.round(parseFloat(parts[i])).toString(16).padStart(2, "0");
  }
  return hex.toLowerCase();
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function isNearBlackWhiteGrey(hex) {
  const { r, g, b } = hexToRgb(hex);
  const avg = (r + g + b) / 3;
  const isNeutral = Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && Math.abs(r - b) < 20;
  if (isNeutral && (avg < 50 || avg > 210)) return true; // near-black or near-white grey
  if (r < 40 && g < 40 && b < 40) return true; // very dark
  if (r > 230 && g > 230 && b > 230) return true; // very light
  return false;
}

// Simple color distance (Euclidean in RGB — not perceptually perfect but fast)
function colorDistance(hex1, hex2) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  return Math.sqrt((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2);
}

function deduplicateColors(colors, threshold = 30) {
  const unique = [];
  for (const [color, weight] of colors) {
    const isDuplicate = unique.some(([c]) => colorDistance(color, c) < threshold);
    if (!isDuplicate) {
      unique.push([color, weight]);
    }
  }
  return unique;
}

// ─── Brand Color Extraction ──────────────────────────────────────────

function extractCssVariableColors() {
  const colors = [];
  const root = document.documentElement;
  const computed = getComputedStyle(root);

  // Check all CSS custom properties on :root
  try {
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      try {
        const rules = Array.from(sheet.cssRules || []);
        for (const rule of rules) {
          if (rule.selectorText === ":root" || rule.selectorText === "html") {
            for (const prop of rule.style) {
              if (prop.startsWith("--")) {
                const value = rule.style.getPropertyValue(prop).trim();
                // Check if it looks like a color
                const hex = parseColorToHex(value);
                if (hex && !isNearBlackWhiteGrey(hex)) {
                  const name = prop.replace(/^--/, "");
                  colors.push({ hex, name, source: "css-variable" });
                }
              }
            }
          }
        }
      } catch {
        // CORS — can't read cross-origin stylesheets
      }
    }
  } catch {
    // Fallback: silent
  }
  return colors;
}

function parseColorToHex(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();

  // Already hex
  if (/^#[0-9a-f]{3,8}$/i.test(v)) {
    if (v.length === 4) {
      return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    if (v.length === 7 || v.length === 9) return v.slice(0, 7);
    return null;
  }

  // rgb/rgba
  if (v.startsWith("rgb")) {
    return rgbToHex(v);
  }

  // hsl — convert via temp element
  if (v.startsWith("hsl")) {
    try {
      const temp = document.createElement("div");
      temp.style.color = v;
      document.body.appendChild(temp);
      const computed = getComputedStyle(temp).color;
      document.body.removeChild(temp);
      return rgbToHex(computed);
    } catch {
      return null;
    }
  }

  return null;
}

function extractMetaColors() {
  const colors = [];
  const selectors = [
    { sel: 'meta[name="theme-color"]', attr: "content", name: "theme-color" },
    { sel: 'meta[name="msapplication-TileColor"]', attr: "content", name: "tile-color" },
    { sel: 'meta[name="apple-mobile-web-app-status-bar-style"]', attr: "content", name: "status-bar" },
  ];

  for (const { sel, attr, name } of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const hex = parseColorToHex(el.getAttribute(attr));
      if (hex && !isNearBlackWhiteGrey(hex)) {
        colors.push({ hex, name, source: "meta-tag" });
      }
    }
  }
  return colors;
}

function extractDomColors() {
  const colorsMap = {};

  // Weight by element position/role
  function getWeight(element) {
    let weight = 1;
    const tag = element.tagName.toLowerCase();
    const parent = element.closest("header, nav, [role='banner']");
    if (parent) weight = 3; // Brand-heavy zones

    // Large elements get more weight
    const rect = element.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 100) weight *= 2;

    // Buttons, links, CTAs
    if (tag === "button" || tag === "a" || element.closest("button, a, [role='button']")) {
      weight *= 2;
    }

    return weight;
  }

  // Sample strategically instead of ALL elements
  const selectors = [
    "header *", "nav *", "footer *",
    "main *", "article *", "section *",
    "h1, h2, h3, h4, h5, h6",
    "a, button, [role='button']",
    ".hero *, .banner *, .cta *, .brand *",
    "[class*='primary'], [class*='accent'], [class*='brand']",
  ];

  const seen = new Set();
  const elements = [];

  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          elements.push(el);
        }
      });
    } catch {
      // Invalid selector, skip
    }
  }

  // If we got fewer than 100 elements from targeted selectors, fall back to sampling body
  if (elements.length < 100) {
    document.querySelectorAll("body *").forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        elements.push(el);
      }
    });
  }

  // Cap at 2000 elements for performance
  const sample = elements.slice(0, 2000);

  for (const element of sample) {
    const computed = getComputedStyle(element);
    const weight = getWeight(element);

    for (const prop of ["color", "backgroundColor", "borderColor"]) {
      const hex = rgbToHex(computed[prop]);
      if (hex && !isNearBlackWhiteGrey(hex)) {
        colorsMap[hex] = (colorsMap[hex] || 0) + weight;
      }
    }
  }

  return Object.entries(colorsMap)
    .sort(([, a], [, b]) => b - a);
}

function extractAllColors() {
  // Priority 1: Explicit brand colors from CSS variables
  const cssVarColors = extractCssVariableColors();

  // Priority 2: Meta tag colors (theme-color etc.)
  const metaColors = extractMetaColors();

  // Priority 3: Weighted DOM color extraction
  const domColors = extractDomColors();

  // Merge: CSS vars and meta first (they're declared brand colors), then DOM
  const declared = [...cssVarColors, ...metaColors].map((c) => ({
    hex: c.hex,
    name: c.name,
    source: c.source,
  }));

  // Deduplicate DOM colors and take top candidates
  const dedupedDom = deduplicateColors(domColors, 35);
  const domResults = dedupedDom.slice(0, 10).map(([hex, weight]) => ({
    hex,
    name: null,
    source: "dom-frequency",
    weight,
  }));

  // Merge declared + dom, deduplicate across sources
  const allColors = [];
  const seenHexes = new Set();

  for (const color of [...declared, ...domResults]) {
    if (!seenHexes.has(color.hex)) {
      seenHexes.add(color.hex);
      allColors.push(color);
    }
  }

  return allColors.slice(0, 12); // Max 12 brand colors
}

// ─── Image Context Extraction ────────────────────────────────────────

function extractImageContext() {
  const images = [];
  const seen = new Set();

  document.querySelectorAll("img, picture source, [style*='background-image'], video, source[type^='video']").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    let urls = [];

    if (tag === "img") {
      if (el.src) urls.push(el.src);
      if (el.srcset) {
        el.srcset.split(",").forEach((s) => {
          const u = s.trim().split(/\s+/)[0];
          if (u) urls.push(u);
        });
      }
      // Lazy-load attributes (common patterns across libraries)
      for (const attr of ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-srcset", "data-hi-res-src"]) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        if (attr.includes("srcset")) {
          val.split(",").forEach((s) => {
            const u = s.trim().split(/\s+/)[0];
            if (u) urls.push(u);
          });
        } else {
          urls.push(val.startsWith("//") ? "https:" + val : val);
        }
      }
    } else if (tag === "source") {
      if (el.srcset) {
        el.srcset.split(",").forEach((s) => {
          const u = s.trim().split(/\s+/)[0];
          if (u) urls.push(u);
        });
      }
      if (el.src) urls.push(el.src);
    } else if (tag === "video") {
      // Skip blob: URLs — they're page-scoped MSE streams, unfetchable from extension
      if (el.src && !el.src.startsWith("blob:")) urls.push(el.src);
      if (el.poster) urls.push(el.poster);
    } else {
      // Background image
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none") {
        const match = bg.match(/url\(["']?(.+?)["']?\)/);
        if (match) urls.push(match[1]);
      }
    }

    for (const url of urls) {
      if (seen.has(url) || url.startsWith("data:")) continue;
      seen.add(url);

      const context = getElementContext(el);
      images.push({
        url,
        alt: el.alt || "",
        context: context.zone,
        isLogo: context.isLogo,
        isUI: context.isUI,
        width: el.naturalWidth || el.width || 0,
        height: el.naturalHeight || el.height || 0,
      });
    }
  });

  return images;
}

function getElementContext(el) {
  const zone = getZone(el);
  const isLogo = detectLogo(el);
  const isUI = detectUIElement(el);
  return { zone, isLogo, isUI };
}

function getZone(el) {
  if (el.closest("header, nav, [role='banner']")) return "header";
  if (el.closest("footer, [role='contentinfo']")) return "footer";
  if (el.closest("main, article, [role='main']")) return "main";
  if (el.closest("aside, [role='complementary']")) return "sidebar";
  if (el.closest(".hero, .banner, [class*='hero'], [class*='banner']")) return "hero";
  return "body";
}

function detectLogo(el) {
  const alt = (el.alt || "").toLowerCase();
  const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const src = (el.src || "").toLowerCase();

  const hints = [alt, cls, id, src].join(" ");
  return /logo|brand|site-icon|site_icon/.test(hints);
}

// Detect UI/chrome elements — nav icons, social icons, decorative SVGs, etc.
const UI_HINTS = /icon|arrow|chevron|caret|close|menu|hamburger|toggle|spinner|loader|breadcrumb|pagination|social|share|facebook|twitter|instagram|linkedin|youtube|tiktok|pinterest|whatsapp|telegram|discord|github|mailto|search-icon|nav-|ui-|btn-|button-|widget/;
const UI_ICON_DOMAINS = /fontawesome|cdnjs|googleapis.*icon|material.*icon|use\.typekit|icomoon/;

function detectUIElement(el) {
  // 1. Very small images are almost always UI (icons, bullets, decorations)
  const w = el.naturalWidth || el.width || el.offsetWidth || 0;
  const h = el.naturalHeight || el.height || el.offsetHeight || 0;
  if (w > 0 && h > 0 && w <= 48 && h <= 48) return true;

  // 2. Inside interactive/nav elements
  if (el.closest("button, [role='button'], nav a, .nav, .navbar, .breadcrumb, .pagination, .social, .share")) {
    return true;
  }

  // 3. Class/id/alt/src hint matching
  const alt = (el.alt || "").toLowerCase();
  const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const src = (el.src || el.getAttribute("data-src") || "").toLowerCase();
  const hints = [alt, cls, id, src].join(" ");

  if (UI_HINTS.test(hints)) return true;

  // 4. Icon CDN domains
  if (UI_ICON_DOMAINS.test(src)) return true;

  // 5. Inline SVGs used as icons (parent has icon-like class or small container)
  const parent = el.parentElement;
  if (parent) {
    const parentCls = (typeof parent.className === "string" ? parent.className : "").toLowerCase();
    const parentRole = (parent.getAttribute("role") || "").toLowerCase();
    if (UI_HINTS.test(parentCls) || parentRole === "button" || parentRole === "navigation") {
      return true;
    }
  }

  return false;
}

// ─── Font Extraction ─────────────────────────────────────────────────

function extractFontInfo() {
  const fonts = new Map();

  // 1. Google Fonts links
  document.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').forEach((link) => {
    try {
      const url = new URL(link.href);
      const family = url.searchParams.get("family");
      if (family) {
        family.split("|").forEach((f) => {
          const name = f.split(":")[0].replace(/\+/g, " ");
          fonts.set(name, { name, source: "google-fonts", url: link.href });
        });
      }
    } catch { /* skip */ }
  });

  // 2. Adobe Fonts / TypeKit
  document.querySelectorAll('link[href*="use.typekit.net"], link[href*="use.adobe.com"]').forEach((link) => {
    fonts.set("Adobe Fonts Kit", { name: "Adobe Fonts Kit", source: "adobe-fonts", url: link.href });
  });

  // 3. @font-face declarations from accessible stylesheets
  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule instanceof CSSFontFaceRule) {
            const family = rule.style.getPropertyValue("font-family").replace(/['"]/g, "").trim();
            const src = rule.style.getPropertyValue("src");
            if (family && !fonts.has(family)) {
              // Extract URL from src
              const urlMatch = src.match(/url\(["']?(.+?)["']?\)/);
              fonts.set(family, {
                name: family,
                source: "font-face",
                url: urlMatch ? urlMatch[1] : null,
              });
            }
          }
        }
      } catch { /* CORS */ }
    }
  } catch { /* silent */ }

  // 4. Computed font families from key elements
  const keyElements = document.querySelectorAll("h1, h2, h3, p, a, button, body");
  const usedFamilies = new Set();
  keyElements.forEach((el) => {
    const family = getComputedStyle(el).fontFamily;
    if (family) {
      family.split(",").forEach((f) => {
        const clean = f.trim().replace(/['"]/g, "");
        if (clean && !["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"].includes(clean.toLowerCase())) {
          usedFamilies.add(clean);
        }
      });
    }
  });

  return {
    declared: Array.from(fonts.values()),
    used: Array.from(usedFamilies),
  };
}

// ─── Page Metadata ───────────────────────────────────────────────────

function extractPageMeta() {
  const get = (sel, attr = "content") => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute(attr) : null;
  };

  return {
    title: document.title || "",
    siteName: get('meta[property="og:site_name"]') || get('meta[name="application-name"]') || "",
    description: get('meta[property="og:description"]') || get('meta[name="description"]') || "",
    ogImage: get('meta[property="og:image"]') || "",
    favicon: getFaviconUrl(),
    themeColor: get('meta[name="theme-color"]') || "",
    url: window.location.href,
    hostname: window.location.hostname,
  };
}

function getFaviconUrl() {
  const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  if (link) return link.href;
  return window.location.origin + "/favicon.ico";
}

// ─── Deep Scan — auto-scroll to trigger lazy loaders ─────────────────

async function deepScan() {
  const originalScroll = window.scrollY;
  const viewportH = window.innerHeight;
  const maxScroll = document.documentElement.scrollHeight;
  const stepPx = Math.floor(viewportH * 0.8); // overlap slightly
  const maxDuration = 12000; // cap at 12 seconds
  const stepDelay = 250;     // ms between scroll steps

  const startTime = Date.now();
  let position = 0;

  // Scroll down the page in steps
  while (position < maxScroll && (Date.now() - startTime) < maxDuration) {
    position += stepPx;
    window.scrollTo({ top: position, behavior: "instant" });
    await new Promise((r) => setTimeout(r, stepDelay));
  }

  // Brief pause at the bottom for final assets to trigger
  await new Promise((r) => setTimeout(r, 500));

  // Scroll back to original position
  window.scrollTo({ top: originalScroll, behavior: "instant" });

  // Small wait for any last paint/load events
  await new Promise((r) => setTimeout(r, 300));

  // Now run the full DOM analysis with everything loaded
  return {
    colors: extractAllColors(),
    imageContext: extractImageContext(),
    fontInfo: extractFontInfo(),
    pageMeta: extractPageMeta(),
  };
}

// ─── Message Handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "analyzeDOM") {
    try {
      const colors = extractAllColors();
      const imageContext = extractImageContext();
      const fontInfo = extractFontInfo();
      const pageMeta = extractPageMeta();

      sendResponse({
        colors,
        imageContext,
        fontInfo,
        pageMeta,
      });
    } catch (err) {
      console.error("NAS content script error:", err);
      sendResponse({ error: err.message });
    }
    return true; // async
  }

  // Deep scan — auto-scroll page to trigger lazy loaders, then analyze
  if (message.action === "deepScan") {
    deepScan()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("NAS deep scan error:", err);
        sendResponse({ error: err.message });
      });
    return true; // async
  }

  // Proxy fetch for blob: URLs and platform CDN URLs (only accessible from the page's origin)
  if (message.action === "fetchBlob") {
    // TikTok (and some other platforms) serve video from subdomains that require
    // cookies/credentials from the main domain. Content scripts (ISOLATED world)
    // can't always send these cross-subdomain cookies. Use the MAIN world via
    // an injected script + message bridge for reliable CDN fetches.
    fetchBlobViaMainWorld(message.url)
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true; // async
  }
});

/**
 * Fetch a blob URL from the MAIN world where the page's full cookie jar
 * and origin context are available. Only uses postMessage bridge on
 * TikTok (where tiktok-video-intercept.js provides the MAIN world handler).
 * All other platforms go straight to fetchBlobDirect().
 */
async function fetchBlobViaMainWorld(url) {
  // Only TikTok has a MAIN world fetch handler — skip the bridge elsewhere
  const isTikTok = window.location.hostname.includes("tiktok.com");
  if (!isTikTok) return fetchBlobDirect(url);

  const requestId = `nas_fetch_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        window.removeEventListener("message", handler);
        // Fallback: try ISOLATED world fetch directly
        fetchBlobDirect(url).then(resolve).catch(reject);
      }
    }, 15000);

    function handler(event) {
      if (event.source !== window) return;
      const msg = event.data;
      if (msg?.type !== "NAS_MAIN_FETCH_RESPONSE") return;
      if (msg.requestId !== requestId) return;

      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", handler);

      if (msg.error) {
        // Fallback to direct fetch on MAIN world failure
        fetchBlobDirect(url).then(resolve).catch(reject);
      } else {
        resolve({ dataUrl: msg.dataUrl, type: msg.contentType, size: msg.size });
      }
    }

    window.addEventListener("message", handler);
    window.postMessage({ type: "NAS_MAIN_FETCH", requestId, url }, "*");
  });
}

/**
 * Direct ISOLATED world fetch — works for most CDNs but fails on
 * platforms that require cross-subdomain cookies (e.g. TikTok).
 */
function fetchBlobDirect(url) {
  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("text/html") && !url.includes(".html")) {
        throw new Error(`Unexpected Content-Type: ${ct}`);
      }
      return r.blob();
    })
    .then((blob) => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve({ dataUrl: reader.result, type: blob.type, size: blob.size });
        };
        reader.readAsDataURL(blob);
      });
    });
}

} // end duplicate injection guard
