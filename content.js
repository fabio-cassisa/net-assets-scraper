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

  // If we got fewer than 100 elements from targeted selectors, sample from body
  // but cap the querySelectorAll walk to avoid freezing on DOM-heavy pages
  if (elements.length < 100) {
    const bodyEls = document.body.querySelectorAll("*");
    const limit = Math.min(bodyEls.length, 2000 - elements.length);
    for (let i = 0; i < limit; i++) {
      const el = bodyEls[i];
      if (!seen.has(el)) {
        seen.add(el);
        elements.push(el);
      }
    }
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
      for (const attr of ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-srcset", "data-hi-res-src", "data-bg", "data-full-src", "data-image", "data-bg-src"]) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        if (attr.includes("srcset")) {
          val.split(",").forEach((s) => {
            const u = s.trim().split(/\s+/)[0];
            if (u) urls.push(u);
          });
        } else {
          // Guard: many CMS platforms store non-URL values in data-* attributes
          // (e.g. WordPress uses data-image for attachment IDs like "1024").
          // Only accept values that look like actual URLs or paths.
          if (/^\d+$/.test(val) || (!val.includes("/") && !val.includes("."))) continue;
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

    for (let url of urls) {
      if (url.startsWith("data:")) continue;
      // Safety net: reject values that aren't real URLs (e.g. numeric IDs, CSS classes)
      if (/^\d+$/.test(url) || (!url.includes("/") && !url.includes(".") && !url.startsWith("http"))) continue;
      // Resolve relative URLs against the page origin (srcset and data-* attrs
      // can contain bare paths like "/sites/g/files/..." which otherwise resolve
      // against the extension origin during download → ERR_FILE_NOT_FOUND)
      try { url = new URL(url, document.baseURI).href; } catch { continue; }
      if (seen.has(url)) continue;
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

  // ── CSS background-image extraction (stylesheet-set, not just inline) ──
  // The selector above only catches elements with inline style="background-image:".
  // Many sites set hero/banner/card backgrounds via CSS classes in stylesheets.
  // Walk prominent layout elements and check computed backgroundImage.
  const bgCandidates = document.querySelectorAll(
    "section, [class*='hero'], [class*='banner'], [class*='cover'], [class*='background'], " +
    "[class*='bg-'], [class*='jumbotron'], [class*='parallax'], [class*='splash'], " +
    "header > div, main > div, .container > div, [role='banner'] > div, " +
    "[data-bg], [data-background], [data-bg-src]"
  );
  for (const el of bgCandidates) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;
    // Extract all url() values (some elements stack multiple backgrounds)
    const bgMatches = [...bg.matchAll(/url\(["']?(.+?)["']?\)/g)];
    for (const match of bgMatches) {
      let url = match[1];
      if (!url || url.startsWith("data:") || seen.has(url)) continue;
      // Resolve relative URLs
      try { url = new URL(url, document.baseURI).href; } catch { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      const zone = getZone(el);
      images.push({
        url,
        alt: el.getAttribute("aria-label") || "",
        context: zone,
        isLogo: false,
        isUI: false,
        width: el.offsetWidth || 0,
        height: el.offsetHeight || 0,
        sourceType: "css-bg",
      });
    }
  }

  // ── Inline SVG extraction (logos and significant SVGs) ──
  // Many modern sites embed logos as inline <svg> elements instead of <img src="logo.svg">.
  // These never hit webRequest. Serialize significant SVGs to blob URLs.
  const svgEls = document.querySelectorAll("svg");
  for (const svg of svgEls) {
    // Skip tiny decorative SVGs (icons, arrows, chevrons)
    const w = svg.width?.baseVal?.value || svg.getBoundingClientRect().width || 0;
    const h = svg.height?.baseVal?.value || svg.getBoundingClientRect().height || 0;
    if (w > 0 && h > 0 && w <= 32 && h <= 32) continue;

    // Skip SVGs inside buttons, nav links, and other UI chrome
    if (svg.closest("button, [role='button'], nav a, .pagination, .breadcrumb")) continue;

    // Check if this looks like a logo or meaningful brand element
    const parent = svg.closest("[class*='logo'], [id*='logo'], [class*='brand'], [aria-label*='logo'], header, [role='banner']");
    const svgClass = (typeof svg.className === "string" ? svg.className : svg.className?.baseVal || "").toLowerCase();
    const svgId = (svg.id || "").toLowerCase();
    const ariaLabel = (svg.getAttribute("aria-label") || svg.closest("[aria-label]")?.getAttribute("aria-label") || "").toLowerCase();
    const isLogo = !!(parent || /logo|brand/.test(svgClass) || /logo|brand/.test(svgId) || /logo|brand/.test(ariaLabel));

    // Only extract logos OR SVGs with enough visual substance (not tiny icons)
    if (!isLogo && (w < 60 || h < 30)) continue;

    // Serialize to data: URI (not blob: — blob URLs are page-scoped and
    // unfetchable from the extension panel or service worker context)
    try {
      const svgData = new XMLSerializer().serializeToString(svg);
      const dataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
      if (seen.has(dataUrl)) continue;
      seen.add(dataUrl);
      const zone = getZone(svg);
      images.push({
        url: dataUrl,
        alt: ariaLabel || (isLogo ? "logo" : ""),
        context: zone,
        isLogo,
        isUI: false,
        width: Math.round(w),
        height: Math.round(h),
        sourceType: "inline-svg",
      });
    } catch { /* serialization failed, skip */ }
  }

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
const UI_HINTS = /icon|arrow|chevron|caret|close|menu|hamburger|toggle|spinner|loader|breadcrumb|pagination|social|share|search-icon|nav-|ui-|btn-|button-|widget/;
// Social platform names — only match in class/id/alt, NOT in src URLs
// (an image at "cdn.example.com/blog/facebook-case-study.jpg" is content, not UI)
const UI_SOCIAL_HINTS = /facebook|twitter|instagram|linkedin|youtube|tiktok|pinterest|whatsapp|telegram|discord|github|mailto/;
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

  // Social platform names — only check class/id/alt (not src) to avoid
  // false-positiving on content images whose URL happens to contain "facebook" etc.
  const contextHints = [alt, cls, id].join(" ");
  if (UI_SOCIAL_HINTS.test(contextHints)) return true;

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

  // 1. Google Fonts links (CSS v1: family=Open+Sans|Roboto:400,700  CSS v2: family=Inter:wght@400;700)
  document.querySelectorAll('link[href*="fonts.googleapis.com"]').forEach((link) => {
    try {
      const url = new URL(link.href);
      const familyParam = url.searchParams.get("family");
      if (!familyParam) return;
      // CSS v1: "Open+Sans:400,700|Roboto" — pipe-separated, colon-separated weights
      // CSS v2: "Inter:wght@400;700&family=Roboto:wght@300" — multiple family params
      familyParam.split("|").forEach((f) => {
        const name = f.split(":")[0].replace(/\+/g, " ");
        if (name && !fonts.has(name)) {
          fonts.set(name, { name, source: "google-fonts", cssUrl: link.href, url: null });
        }
      });
    } catch { /* skip */ }
  });
  // Also handle multiple family= params in CSS v2 URLs
  document.querySelectorAll('link[href*="fonts.googleapis.com/css2"]').forEach((link) => {
    try {
      const allFamilies = new URL(link.href).searchParams.getAll("family");
      for (const fam of allFamilies) {
        const name = fam.split(":")[0].replace(/\+/g, " ");
        if (name && !fonts.has(name)) {
          fonts.set(name, { name, source: "google-fonts", cssUrl: link.href, url: null });
        }
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
            const weight = rule.style.getPropertyValue("font-weight") || "400";
            const style = rule.style.getPropertyValue("font-style") || "normal";
            if (!family) continue;

            // Extract ALL url() values from src (multiple format fallbacks)
            const urlMatches = [...src.matchAll(/url\(["']?(.+?)["']?\)/g)].map((m) => m[1]);
            // Prefer woff2 > woff > ttf > otf
            const ranked = urlMatches.sort((a, b) => {
              const rank = (u) => u.includes("woff2") ? 0 : u.includes("woff") ? 1 : u.includes("ttf") ? 2 : u.includes("otf") ? 3 : 4;
              return rank(a) - rank(b);
            });
            const bestUrl = ranked[0] || null;

            // Key by family+weight+style to capture all variants
            const key = `${family}::${weight}::${style}`;
            if (!fonts.has(key)) {
              fonts.set(key, {
                name: family,
                source: "font-face",
                url: bestUrl ? new URL(bestUrl, document.baseURI).href : null,
                weight,
                style,
                allUrls: ranked.map((u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } }),
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

// ─── Copy & CTA Extraction ───────────────────────────────────────────

const CTA_KEYWORDS = /^(shop|buy|order|get|start|sign|subscribe|try|book|contact|learn|discover|explore|download|join|register|apply|request|schedule|watch|view|see|read|find|check|claim|grab|unlock|access|create|build|upgrade|switch)\b/i;

function extractCopyAndCTAs() {
  const copy = { headlines: [], tagline: null, description: null };
  const ctas = [];
  const seen = new Set();

  // ── Headlines: h1, h2 (above the fold preferred) ──
  document.querySelectorAll("h1, h2").forEach((el) => {
    const text = el.textContent?.trim();
    if (!text || text.length < 4 || text.length > 200) return;
    if (seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    copy.headlines.push(text);
  });
  // Cap at 5 most prominent
  copy.headlines = copy.headlines.slice(0, 5);

  // ── Tagline: og:description or meta description ──
  const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim();
  const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim();
  copy.tagline = ogDesc || metaDesc || null;

  // ── Description: first substantial <p> in main content area ──
  const mainContent = document.querySelector("main, article, [role='main'], .content, #content") || document.body;
  const paragraphs = mainContent.querySelectorAll("p");
  for (const p of paragraphs) {
    const text = p.textContent?.trim();
    if (text && text.length >= 40 && text.length <= 500) {
      copy.description = text;
      break;
    }
  }

  // ── CTA buttons: <a> and <button> with short, action-oriented text ──
  const ctaSeen = new Set();
  const candidates = document.querySelectorAll('a, button, [role="button"], input[type="submit"]');

  for (const el of candidates) {
    const text = (el.textContent || el.value || "").trim().replace(/\s+/g, " ");
    if (!text || text.length < 2 || text.length > 40) continue;
    if (!CTA_KEYWORDS.test(text)) continue;

    const key = text.toLowerCase();
    if (ctaSeen.has(key)) continue;
    ctaSeen.add(key);

    const style = getComputedStyle(el);
    const bgColor = style.backgroundColor;
    const color = style.color;

    // Skip invisible or transparent buttons
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (bgColor === "rgba(0, 0, 0, 0)" && style.borderColor === "rgba(0, 0, 0, 0)") continue;

    ctas.push({
      text,
      backgroundColor: bgColor,
      color,
      fontFamily: style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "",
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      borderRadius: style.borderRadius,
      padding: style.padding,
    });

    if (ctas.length >= 6) break; // cap at 6 unique CTAs
  }

  return { copy, ctas };
}

// ─── Typography Scale Extraction ─────────────────────────────────────

function extractTypographyScale() {
  const scale = [];
  const elements = [
    { selector: "h1", label: "h1" },
    { selector: "h2", label: "h2" },
    { selector: "h3", label: "h3" },
    { selector: "body", label: "body" },
    { selector: "a", label: "a" },
    { selector: "button, [role='button']", label: "button" },
    { selector: "small, .caption, figcaption", label: "small" },
  ];

  for (const { selector, label } of elements) {
    const el = document.querySelector(selector);
    if (!el) continue;

    const s = getComputedStyle(el);
    const family = s.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "";

    // Skip if this is just inheriting body defaults for heading tags with no actual content
    if (label.startsWith("h") && !el.textContent?.trim()) continue;

    scale.push({
      element: label,
      fontFamily: family,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing === "normal" ? "0" : s.letterSpacing,
      color: rgbToHex(s.color) || s.color,
      textTransform: s.textTransform !== "none" ? s.textTransform : null,
    });
  }

  return scale;
}

// ─── Social Links Extraction ─────────────────────────────────────────

function extractSocialLinks() {
  const SOCIAL_PATTERNS = {
    twitter:   /(?:twitter\.com|(?:^|\/\/)(?:www\.)?x\.com)\/(?!share|intent|search|hashtag)([^\s/?#]+)/i,
    instagram: /instagram\.com\/(?!p\/|explore|accounts|reel)([^\s/?#]+)/i,
    linkedin:  /linkedin\.com\/(?:company|in)\/([^\s/?#]+)/i,
    facebook:  /facebook\.com\/(?!sharer|share|dialog)([^\s/?#]+)/i,
    youtube:   /youtube\.com\/(?:@|channel\/|c\/|user\/)([^\s/?#]+)/i,
    tiktok:    /tiktok\.com\/@?([^\s/?#]+)/i,
  };

  const links = {};

  // Prioritize footer and header links — they're the canonical social links
  const containers = document.querySelectorAll("footer, header, nav, [class*='social'], [class*='footer'], [id*='footer']");
  const anchors = new Set();

  containers.forEach((c) => c.querySelectorAll("a[href]").forEach((a) => anchors.add(a)));
  // Fallback: scan all links if we found very few
  if (anchors.size < 3) {
    document.querySelectorAll("a[href]").forEach((a) => anchors.add(a));
  }

  for (const a of anchors) {
    const href = a.href;
    if (!href) continue;
    for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
      if (links[platform]) continue; // already found
      if (regex.test(href)) {
        links[platform] = href;
      }
    }
  }

  return links;
}

// ─── JSON-LD / Schema.org Structured Data ────────────────────────────

function extractStructuredData() {
  const results = [];

  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      // Handle both single objects and arrays
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const type = item["@type"];
        if (!type) continue;

        // Extract Organization / Brand data
        if (/^(Organization|Corporation|LocalBusiness|Brand|WebSite)$/i.test(type)) {
          const entry = { type };
          if (item.name) entry.name = item.name;
          if (item.url) entry.url = item.url;
          if (item.logo) {
            entry.logo = typeof item.logo === "string" ? item.logo : item.logo?.url || null;
          }
          if (item.sameAs) entry.sameAs = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
          if (item.description) entry.description = item.description;
          if (item.contactPoint) entry.contactPoint = item.contactPoint;
          results.push(entry);
        }
      }
    } catch { /* malformed JSON-LD, skip */ }
  });

  return results.length > 0 ? results : null;
}

// ─── Favicon Variants ────────────────────────────────────────────────

function extractFaviconVariants() {
  const favicons = [];
  const seen = new Set();

  const selectors = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
    'link[rel="mask-icon"]',
  ];

  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((link) => {
      const url = link.href;
      if (!url || seen.has(url)) return;
      seen.add(url);
      favicons.push({
        url,
        sizes: link.getAttribute("sizes") || null,
        type: link.getAttribute("rel") || "icon",
      });
    });
  }

  // Always include /favicon.ico as fallback if nothing else
  if (favicons.length === 0) {
    favicons.push({
      url: window.location.origin + "/favicon.ico",
      sizes: null,
      type: "icon",
    });
  }

  return favicons;
}

// ─── Color Semantics ─────────────────────────────────────────────────
// Takes the existing flat color list and adds semantic roles

function categorizeColors(allColors) {
  const bodyStyle = getComputedStyle(document.body);
  const bgHex = rgbToHex(bodyStyle.backgroundColor) || "#ffffff";
  const textHex = rgbToHex(bodyStyle.color) || "#000000";

  // Primary = most prominent non-bg, non-text color (first in the weighted list)
  // Secondary = second most prominent
  let primary = null;
  let secondary = null;

  for (const c of allColors) {
    const hex = c.hex;
    // Skip if it's too close to bg or text
    if (colorDistance(hex, bgHex) < 40) continue;
    if (colorDistance(hex, textHex) < 40) continue;

    if (!primary) { primary = hex; continue; }
    if (!secondary) { secondary = hex; break; }
  }

  return {
    primary: primary || (allColors[0]?.hex ?? null),
    secondary: secondary || (allColors[1]?.hex ?? null),
    background: bgHex,
    text: textHex,
  };
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
  const colors = extractAllColors();
  return {
    colors,
    imageContext: extractImageContext(),
    fontInfo: extractFontInfo(),
    pageMeta: extractPageMeta(),
    ...extractCopyAndCTAs(),
    typographyScale: extractTypographyScale(),
    socialLinks: extractSocialLinks(),
    structuredData: extractStructuredData(),
    favicons: extractFaviconVariants(),
    colorSemantics: categorizeColors(colors),
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
      const { copy, ctas } = extractCopyAndCTAs();

      sendResponse({
        colors,
        imageContext,
        fontInfo,
        pageMeta,
        copy,
        ctas,
        typographyScale: extractTypographyScale(),
        socialLinks: extractSocialLinks(),
        structuredData: extractStructuredData(),
        favicons: extractFaviconVariants(),
        colorSemantics: categorizeColors(colors),
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
 * and origin context are available. Uses postMessage bridge on platforms
 * that have MAIN world intercept scripts AND require cookies for CDN fetches.
 * Vimeo progressive URLs are token-signed (no cookies needed) so they
 * go direct — avoids base64 memory bomb on large video files.
 * All other platforms go straight to fetchBlobDirect().
 */
async function fetchBlobViaMainWorld(url) {
  // Platforms that need MAIN world cookies for CDN video fetches
  const host = window.location.hostname;
  const hasMainWorldHandler = host.includes("tiktok.com")
    || host.includes("twitter.com")
    || (host === "x.com" || host.endsWith(".x.com"))
    || host.includes("facebook.com");
  // NOTE: Vimeo excluded — progressive CDN URLs are self-authenticated (token in URL)

  if (!hasMainWorldHandler) return fetchBlobDirect(url);

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
