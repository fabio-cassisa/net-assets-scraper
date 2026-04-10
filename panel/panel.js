// ─── Net Assets Scraper V2 — Side Panel Logic ────────────────────────
// Manages: tab communication, asset preview grid, filtering,
// selection, zip generation with organized folders + brand.json

// ─── State ───────────────────────────────────────────────────────────
let allAssets = [];       // All captured resources (from background + DOM)
let domData = null;       // DOM analysis data (colors, fonts, meta)
let selectedUrls = new Set();
let currentTab = "all";   // Active filter tab
let hideSmall = true;     // Filter toggle state

// ─── File type constants ─────────────────────────────────────────────
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "svg", "avif", "ico", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "avi", "mov", "wmv", "m4v", "mkv"]);
const FONT_EXTS  = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

const MIME_TO_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif", "image/tiff": "tif",
  "image/svg+xml": "svg", "image/x-icon": "ico", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogg",
  "font/woff": "woff", "font/woff2": "woff2", "font/ttf": "ttf",
  "font/otf": "otf", "application/vnd.ms-fontobject": "eot",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
};

const SIZE_THRESHOLD = 5 * 1024; // 5KB — below this is likely UI junk

// ─── Init ────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initTabNav();
  initControls();
  initDownload();
  scanCurrentTab();
});

// ─── Scan current tab ────────────────────────────────────────────────
async function scanCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Update site name
  try {
    const url = new URL(tab.url);
    document.getElementById("siteName").textContent = url.hostname;
  } catch {
    document.getElementById("siteName").textContent = "—";
  }

  // Bail on restricted pages (chrome://, arc://, etc.)
  if (isRestrictedTab(tab)) {
    allAssets = [];
    domData = null;
    renderGrid();
    renderBadges();
    return;
  }

  // 1. Get network resources from background service worker
  const bgResponse = await chrome.runtime.sendMessage({
    action: "getResources",
    tabId: tab.id,
  });
  const networkResources = bgResponse?.resources || [];

  // 2. Get DOM analysis from content script
  //    If the content script isn't responding (extension reload, first open),
  //    inject it programmatically and retry.
  domData = await queryContentScript(tab.id);

  // 3. Merge network resources with DOM context
  allAssets = enrichAssets(networkResources, domData?.imageContext || []);

  // 4. Render
  renderGrid();
  renderBadges();

  if (domData) {
    renderColors(domData.colors);
    renderFonts(domData.fontInfo);
    renderMeta(domData.pageMeta);
  }
}

// ─── Content script communication (with auto-inject fallback) ────────
const RESTRICTED_PROTOCOLS = ["chrome:", "chrome-extension:", "arc:", "about:", "devtools:", "edge:", "brave:"];

function isRestrictedTab(tab) {
  if (!tab?.url) return true;
  return RESTRICTED_PROTOCOLS.some((p) => tab.url.startsWith(p));
}

async function queryContentScript(tabId) {
  // Try messaging the existing content script first
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "analyzeDOM" });
    if (response) return response;
  } catch { /* content script not available */ }

  // Content script not injected — inject it and retry
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Brief delay for script to initialize and set up listeners
    await new Promise((r) => setTimeout(r, 300));
    const response = await chrome.tabs.sendMessage(tabId, { action: "analyzeDOM" });
    return response || null;
  } catch (err) {
    console.warn("Content script injection failed:", err);
    return null;
  }
}

// ─── Enrich network assets with DOM context ──────────────────────────
function enrichAssets(networkResources, imageContext) {
  // Build a lookup from DOM image context
  const contextMap = new Map();
  for (const img of imageContext) {
    contextMap.set(img.url, img);
  }

  const enriched = networkResources.map((res) => {
    const ctx = contextMap.get(res.url);
    return {
      ...res,
      alt: ctx?.alt || "",
      context: ctx?.context || "unknown",
      isLogo: ctx?.isLogo || false,
      domWidth: ctx?.width || 0,
      domHeight: ctx?.height || 0,
      displayName: buildDisplayName(res, ctx),
      selected: false,
    };
  });

  // Also add DOM-discovered images not in network resources
  // (e.g., background images that may have loaded before monitoring started)
  const networkUrls = new Set(networkResources.map((r) => r.url));
  for (const img of imageContext) {
    if (!networkUrls.has(img.url)) {
      const ext = getExtFromUrl(img.url);
      enriched.push({
        url: img.url,
        type: "image",
        contentType: "",
        contentLength: -1,
        ext,
        timestamp: Date.now(),
        alt: img.alt || "",
        context: img.context || "unknown",
        isLogo: img.isLogo || false,
        domWidth: img.width || 0,
        domHeight: img.height || 0,
        displayName: buildDisplayName({ url: img.url, ext }, img),
        selected: false,
      });
    }
  }

  // Sort: logos first, then by size descending, then by type
  enriched.sort((a, b) => {
    if (a.isLogo && !b.isLogo) return -1;
    if (!a.isLogo && b.isLogo) return 1;
    const sizeA = a.contentLength > 0 ? a.contentLength : 0;
    const sizeB = b.contentLength > 0 ? b.contentLength : 0;
    return sizeB - sizeA;
  });

  return enriched;
}

// ─── Display name builder ────────────────────────────────────────────
function buildDisplayName(resource, ctx) {
  // Priority 1: alt text
  if (ctx?.alt && ctx.alt.length > 2 && ctx.alt.length < 60) {
    return sanitizeFilename(ctx.alt) + "." + (resource.ext || guessExt(resource));
  }

  // Priority 2: Clean URL filename
  try {
    const pathname = new URL(resource.url).pathname;
    const segment = pathname.substring(pathname.lastIndexOf("/") + 1);
    if (segment && segment.length > 1 && segment.length < 80 && segment.includes(".")) {
      return decodeURIComponent(segment);
    }
    if (segment && segment.length > 1 && segment.length < 40) {
      return segment + "." + (resource.ext || guessExt(resource));
    }
  } catch { /* skip */ }

  // Priority 3: Context-based name
  const prefix = ctx?.isLogo ? "logo" : (ctx?.context || "asset");
  const ext = resource.ext || guessExt(resource);
  return `${prefix}-${Date.now().toString(36)}.${ext}`;
}

function guessExt(resource) {
  if (resource.contentType && MIME_TO_EXT[resource.contentType]) {
    return MIME_TO_EXT[resource.contentType];
  }
  if (resource.type === "image") return "png";
  if (resource.type === "video") return "mp4";
  if (resource.type === "font") return "woff2";
  return "bin";
}

function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return "";
    const ext = pathname.substring(dot + 1).toLowerCase();
    return ext.length <= 6 ? ext : "";
  } catch {
    return "";
  }
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 50);
}

// ─── Render Grid ─────────────────────────────────────────────────────
// Cached reference — survives grid.innerHTML = "" clears
let emptyStateEl = null;

function renderGrid() {
  const grid = document.getElementById("assetGrid");
  if (!emptyStateEl) emptyStateEl = document.getElementById("emptyState");
  const filtered = getFilteredAssets();

  if (filtered.length === 0) {
    grid.innerHTML = "";
    grid.appendChild(emptyStateEl);
    emptyStateEl.style.display = "flex";
    return;
  }

  emptyStateEl.style.display = "none";
  // Detach empty state before clearing so it survives
  if (emptyStateEl.parentNode === grid) grid.removeChild(emptyStateEl);
  grid.innerHTML = "";

  for (const asset of filtered) {
    const card = createAssetCard(asset);
    grid.appendChild(card);
  }
}

function getFilteredAssets() {
  let filtered = allAssets;

  // Tab filter
  if (currentTab !== "all" && currentTab !== "colors") {
    filtered = filtered.filter((a) => a.type === currentTab);
  }

  // Hide small toggle
  if (hideSmall) {
    filtered = filtered.filter((a) => {
      if (a.contentLength > 0 && a.contentLength < SIZE_THRESHOLD) return false;
      return true;
    });
  }

  return filtered;
}

function createAssetCard(asset) {
  const card = document.createElement("div");
  card.className = `asset-card${selectedUrls.has(asset.url) ? " selected" : ""}`;
  card.dataset.url = asset.url;

  // Checkbox indicator
  const checkbox = document.createElement("div");
  checkbox.className = "card-checkbox";
  card.appendChild(checkbox);

  // Type badge
  const typeBadge = document.createElement("span");
  typeBadge.className = `card-type-badge type-${asset.type}`;
  typeBadge.textContent = asset.type;
  card.appendChild(typeBadge);

  // Logo badge
  if (asset.isLogo) {
    const logoBadge = document.createElement("span");
    logoBadge.className = "card-logo-badge";
    logoBadge.textContent = "logo";
    card.appendChild(logoBadge);
  }

  // Thumbnail
  if (asset.type === "image") {
    const img = document.createElement("img");
    img.className = "card-thumb";
    img.src = asset.url;
    img.alt = asset.alt || asset.displayName;
    img.loading = "lazy";
    img.onerror = () => {
      img.replaceWith(createPlaceholder("🖼"));
    };
    // Detect images that load but are essentially empty (1×1 pixels, etc.)
    img.onload = () => {
      if (img.naturalWidth <= 2 && img.naturalHeight <= 2) {
        img.replaceWith(createPlaceholder("·"));
      }
    };
    card.appendChild(img);
  } else if (asset.type === "video") {
    const video = document.createElement("video");
    video.className = "card-thumb";
    video.src = asset.url;
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    // Seek slightly in to grab a real frame (some videos have blank first frames)
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(1, video.duration * 0.1);
    });
    video.onerror = () => {
      video.replaceWith(createPlaceholder("🎬"));
    };
    card.appendChild(video);
  } else if (asset.type === "font") {
    card.appendChild(createFontPreview(asset));
  } else if (asset.type === "audio") {
    card.appendChild(createPlaceholder("♪"));
  } else {
    card.appendChild(createPlaceholder("📄"));
  }

  // Info
  const info = document.createElement("div");
  info.className = "card-info";

  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = asset.displayName;
  name.title = asset.displayName;
  info.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (asset.contentLength > 0) {
    meta.textContent = formatBytes(asset.contentLength);
  }
  if (asset.domWidth && asset.domHeight) {
    meta.textContent += (meta.textContent ? " · " : "") + `${asset.domWidth}×${asset.domHeight}`;
  }
  info.appendChild(meta);

  card.appendChild(info);

  // Click to toggle selection
  card.addEventListener("click", () => {
    toggleSelection(asset.url);
    card.classList.toggle("selected");
    updateDownloadBar();
  });

  return card;
}

function createPlaceholder(icon) {
  const div = document.createElement("div");
  div.className = "card-thumb-placeholder";
  div.textContent = icon;
  return div;
}

// Counter for unique @font-face family names
let fontPreviewCounter = 0;

function createFontPreview(asset) {
  const div = document.createElement("div");
  div.className = "card-thumb-placeholder font-preview";

  const familyName = `nas-preview-${fontPreviewCounter++}`;
  const sampleText = "Ag";

  // Inject @font-face rule to load the actual font
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: '${familyName}'; src: url('${asset.url}'); }`;
  div.appendChild(style);

  const glyph = document.createElement("span");
  glyph.className = "font-glyph";
  glyph.textContent = sampleText;
  glyph.style.fontFamily = `'${familyName}', serif`;
  div.appendChild(glyph);

  // Show font name below glyph
  const label = document.createElement("span");
  label.className = "font-label";
  label.textContent = asset.displayName.replace(/\.[^.]+$/, "");
  div.appendChild(label);

  return div;
}

// ─── Tab Navigation ──────────────────────────────────────────────────
function initTabNav() {
  const tabNav = document.getElementById("tabNav");
  tabNav.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;

    tabNav.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    currentTab = btn.dataset.tab;

    const grid = document.getElementById("assetGrid");
    const colorsPanel = document.getElementById("colorsPanel");

    if (currentTab === "colors") {
      grid.style.display = "none";
      colorsPanel.style.display = "block";
      document.getElementById("controlsBar").style.display = "none";
    } else {
      grid.style.display = "grid";
      colorsPanel.style.display = "none";
      document.getElementById("controlsBar").style.display = "flex";
      renderGrid();
    }
  });
}

// ─── Controls ────────────────────────────────────────────────────────
function initControls() {
  document.getElementById("hideSmall").addEventListener("change", (e) => {
    hideSmall = e.target.checked;
    renderGrid();
  });

  document.getElementById("selectAll").addEventListener("click", () => {
    const filtered = getFilteredAssets();
    filtered.forEach((a) => selectedUrls.add(a.url));
    renderGrid();
    updateDownloadBar();
  });

  document.getElementById("selectNone").addEventListener("click", () => {
    selectedUrls.clear();
    renderGrid();
    updateDownloadBar();
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    const btnText = btn.querySelector("span");
    const originalText = btnText.textContent;

    // Show scanning state
    btn.disabled = true;
    btnText.textContent = "Scanning…";
    allAssets = [];
    domData = null;
    selectedUrls.clear();
    renderGrid();
    updateDownloadBar();

    // Deep scan: auto-scrolls the page to trigger lazy loaders
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !isRestrictedTab(tab)) {
      try {
        // Try deep scan first (auto-scroll + analyze)
        domData = await chrome.tabs.sendMessage(tab.id, { action: "deepScan" });
      } catch {
        // Fallback: inject + deep scan
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          });
          await new Promise((r) => setTimeout(r, 300));
          domData = await chrome.tabs.sendMessage(tab.id, { action: "deepScan" });
        } catch {
          domData = null;
        }
      }

      // Also grab network resources
      const bgResponse = await chrome.runtime.sendMessage({
        action: "getResources",
        tabId: tab.id,
      });
      const networkResources = bgResponse?.resources || [];

      allAssets = enrichAssets(networkResources, domData?.imageContext || []);
    }

    renderGrid();
    renderBadges();
    if (domData) {
      renderColors(domData.colors);
      renderFonts(domData.fontInfo);
      renderMeta(domData.pageMeta);
    }

    btn.disabled = false;
    btnText.textContent = originalText;
    showToast(`Deep scan complete — ${allAssets.length} assets found`);
  });
}

// ─── Selection ───────────────────────────────────────────────────────
function toggleSelection(url) {
  if (selectedUrls.has(url)) {
    selectedUrls.delete(url);
  } else {
    selectedUrls.add(url);
  }
}

function updateDownloadBar() {
  const count = selectedUrls.size;
  document.getElementById("selectedCount").textContent = `${count} selected`;
  document.getElementById("downloadBtn").disabled = count === 0;

  // Estimate size
  let totalSize = 0;
  for (const asset of allAssets) {
    if (selectedUrls.has(asset.url) && asset.contentLength > 0) {
      totalSize += asset.contentLength;
    }
  }
  document.getElementById("selectedSize").textContent = totalSize > 0 ? `~${formatBytes(totalSize)}` : "";
}

// ─── Render Badges ───────────────────────────────────────────────────
function renderBadges() {
  const counts = { image: 0, video: 0, font: 0 };
  const visible = hideSmall
    ? allAssets.filter((a) => !(a.contentLength > 0 && a.contentLength < SIZE_THRESHOLD))
    : allAssets;

  for (const asset of visible) {
    if (counts[asset.type] !== undefined) counts[asset.type]++;
  }

  document.getElementById("badgeImage").textContent = counts.image;
  document.getElementById("badgeVideo").textContent = counts.video;
  document.getElementById("badgeFont").textContent = counts.font;
}

// ─── Render Colors ───────────────────────────────────────────────────
function renderColors(colors) {
  const grid = document.getElementById("colorGrid");
  grid.innerHTML = "";

  if (!colors || colors.length === 0) {
    document.getElementById("colorsHint").textContent = "No brand colors detected on this page.";
    return;
  }

  for (const color of colors) {
    const swatch = document.createElement("div");
    swatch.className = "color-swatch";

    const circle = document.createElement("div");
    circle.className = "swatch-circle";
    circle.style.backgroundColor = color.hex;
    swatch.appendChild(circle);

    const hex = document.createElement("span");
    hex.className = "swatch-hex";
    hex.textContent = color.hex;
    swatch.appendChild(hex);

    if (color.name) {
      const name = document.createElement("span");
      name.className = "swatch-name";
      name.textContent = color.name;
      swatch.appendChild(name);
    }

    swatch.addEventListener("click", () => {
      navigator.clipboard.writeText(color.hex).then(() => {
        showToast(`Copied ${color.hex}`);
      });
    });

    grid.appendChild(swatch);
  }
}

// ─── Render Fonts ────────────────────────────────────────────────────
function renderFonts(fontInfo) {
  const list = document.getElementById("fontList");
  list.innerHTML = "";

  if (!fontInfo) return;

  const allFonts = [
    ...fontInfo.declared.map((f) => ({ name: f.name, source: f.source })),
    ...fontInfo.used.filter((name) => !fontInfo.declared.some((d) => d.name === name))
      .map((name) => ({ name, source: "computed" })),
  ];

  if (allFonts.length === 0) {
    list.innerHTML = '<p class="hint">No custom fonts detected.</p>';
    return;
  }

  for (const font of allFonts) {
    const item = document.createElement("div");
    item.className = "font-item";

    const name = document.createElement("span");
    name.className = "font-name";
    name.textContent = font.name;
    item.appendChild(name);

    const source = document.createElement("span");
    source.className = "font-source";
    source.textContent = font.source;
    item.appendChild(source);

    list.appendChild(item);
  }
}

// ─── Render Meta ─────────────────────────────────────────────────────
function renderMeta(meta) {
  const container = document.getElementById("metaInfo");
  container.innerHTML = "";

  if (!meta) return;

  const rows = [
    { label: "title", value: meta.title },
    { label: "site", value: meta.siteName },
    { label: "url", value: meta.hostname },
    { label: "og:image", value: meta.ogImage ? "✓ found" : "—" },
    { label: "theme", value: meta.themeColor || "—" },
  ];

  for (const row of rows) {
    if (!row.value) continue;
    const div = document.createElement("div");
    div.className = "meta-row";
    div.innerHTML = `<span class="meta-label">${row.label}</span><span class="meta-value">${row.value}</span>`;
    container.appendChild(div);
  }
}

// ─── Download / Zip Generation ───────────────────────────────────────
function initDownload() {
  document.getElementById("downloadBtn").addEventListener("click", downloadKit);
}

async function downloadKit() {
  const btn = document.getElementById("downloadBtn");
  const progressEl = document.getElementById("downloadProgress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");

  btn.style.display = "none";
  progressEl.style.display = "flex";
  progressFill.style.width = "0%";

  try {
    const zip = new JSZip();
    const selected = allAssets.filter((a) => selectedUrls.has(a.url));
    const total = selected.length;

    // Create folder structure
    const folders = {
      image: zip.folder("images"),
      video: zip.folder("videos"),
      font: zip.folder("fonts"),
      audio: zip.folder("audio"),
    };

    // Create logos subfolder
    const logosFolder = zip.folder("logos");

    // Track used filenames to avoid duplicates
    const usedNames = new Map(); // folder → Set<name>

    let completed = 0;
    let totalBytes = 0;

    // Update progress UI
    function updateProgress() {
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      progressFill.style.width = `${pct}%`;
      const sizeStr = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : "";
      progressText.textContent = `${completed} / ${total}${sizeStr}`;
    }

    updateProgress();

    // Download each selected asset
    const promises = selected.map(async (asset) => {
      try {
        let blob;

        if (asset.url.startsWith("blob:")) {
          // Blob URLs are page-scoped — proxy through content script
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const result = await chrome.tabs.sendMessage(tab.id, {
            action: "fetchBlob",
            url: asset.url,
          });
          if (result?.error) throw new Error(result.error);
          // Convert data URL back to blob
          const res = await fetch(result.dataUrl);
          blob = await res.blob();
        } else {
          const response = await fetch(asset.url);
          blob = await response.blob();
        }

        // Sniff actual content type from blob if available
        const actualType = blob.type || asset.contentType;
        const ext = getActualExtension(asset, actualType);
        let fileName = buildFinalFilename(asset, ext);

        // Pick the right folder
        const targetFolder = asset.isLogo ? logosFolder : (folders[asset.type] || folders.image);
        const folderKey = asset.isLogo ? "logos" : asset.type;

        // Deduplicate filename within folder
        if (!usedNames.has(folderKey)) usedNames.set(folderKey, new Set());
        const nameSet = usedNames.get(folderKey);
        fileName = deduplicateFilename(fileName, nameSet);
        nameSet.add(fileName);

        targetFolder.file(fileName, blob, { binary: true });
        totalBytes += blob.size;
        completed++;
        updateProgress();
      } catch (err) {
        console.error(`Failed to fetch ${asset.url}:`, err);
        completed++;
        updateProgress();
      }
    });

    await Promise.all(promises);

    // Zipping phase
    progressText.textContent = `Zipping ${completed} files…`;
    progressFill.style.width = "100%";

    // Add brand.json with colors, fonts, and meta
    if (domData) {
      const brandKit = {
        colors: (domData.colors || []).map((c) => ({
          hex: c.hex,
          name: c.name || null,
          source: c.source,
        })),
        fonts: domData.fontInfo || { declared: [], used: [] },
        meta: domData.pageMeta || {},
        exportedAt: new Date().toISOString(),
        assetCount: completed,
      };
      zip.file("brand.json", JSON.stringify(brandKit, null, 2));
    }

    // Remove empty folders
    for (const [type, folder] of Object.entries(folders)) {
      if (Object.keys(folder.files).length === 0) {
        zip.remove(type === "image" ? "images" : type === "video" ? "videos" : type === "font" ? "fonts" : "audio");
      }
    }
    // Check logos folder
    if (Object.keys(logosFolder.files).length === 0) {
      zip.remove("logos");
    }

    // Generate zip
    const content = await zip.generateAsync({ type: "blob" });
    const hostname = document.getElementById("siteName").textContent.replace(/[^a-z0-9.-]/gi, "_");
    const zipName = `${hostname || "assets"}_brand_kit.zip`;

    // Download
    const blobUrl = URL.createObjectURL(content);
    chrome.downloads.download({ url: blobUrl, filename: zipName }, () => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError);
      }
      URL.revokeObjectURL(blobUrl);
    });

    showToast(`Kit downloaded — ${completed} files · ${formatBytes(totalBytes)}`);
  } catch (err) {
    console.error("Kit generation failed:", err);
    showToast("Download failed. Check console.");
  } finally {
    progressEl.style.display = "none";
    btn.style.display = "";
    btn.disabled = false;
    btn.textContent = "Download Kit ↓";
    updateDownloadBar();
  }
}

function getActualExtension(asset, blobType) {
  // Trust blob type over URL extension
  if (blobType && MIME_TO_EXT[blobType]) return MIME_TO_EXT[blobType];
  if (asset.ext && asset.ext.length > 0 && asset.ext.length <= 5) return asset.ext;
  return guessExt(asset);
}

function buildFinalFilename(asset, ext) {
  let name = asset.displayName;

  // Make sure extension matches actual detected type
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    const currentExt = name.substring(dotIdx + 1).toLowerCase();
    // If current extension doesn't match, replace it
    if (currentExt !== ext && ext) {
      name = name.substring(0, dotIdx) + "." + ext;
    }
  } else if (ext) {
    name = name + "." + ext;
  }

  return sanitizeFilename(name);
}

function deduplicateFilename(name, usedSet) {
  if (!usedSet.has(name)) return name;
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.substring(dotIdx) : "";
  let counter = 2;
  while (usedSet.has(`${base}-${counter}${ext}`)) counter++;
  return `${base}-${counter}${ext}`;
}

// ─── Utilities ───────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2500);
}
