// ─── File type detection via extension Sets ─────────────────────────
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "tif", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "avi", "mov", "wmv"]);
const FONT_EXTS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);
const ALL_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...FONT_EXTS]);

const MIME_TO_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/webp": ".webp", "image/avif": ".avif", "image/tiff": ".tif",
  "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/webm": ".webm",
  "video/ogg": ".ogg", "font/woff": ".woff", "font/woff2": ".woff2",
  "font/ttf": ".ttf", "font/otf": ".otf",
  "application/vnd.ms-fontobject": ".eot",
};

/**
 * Extract file extension from a URL, ignoring query strings and fragments.
 * Returns lowercase extension without dot, or empty string.
 */
function getUrlExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return "";
    return pathname.substring(dot + 1).toLowerCase();
  } catch {
    // Fallback: strip query/hash manually
    const clean = url.split("?")[0].split("#")[0];
    const dot = clean.lastIndexOf(".");
    if (dot === -1) return "";
    return clean.substring(dot + 1).toLowerCase();
  }
}

function isImage(url) { return IMAGE_EXTS.has(getUrlExtension(url)); }
function isVideo(url) { return VIDEO_EXTS.has(getUrlExtension(url)); }
function isFont(url)  { return FONT_EXTS.has(getUrlExtension(url)); }

// ─── Main popup logic ────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {
  const downloadBtn = document.getElementById("downloadBtn");
  const statusElem = document.getElementById("status");
  const progressContainer = document.getElementById("progress-container");
  const progressBar = document.getElementById("progress-bar").firstElementChild;
  const progressText = document.getElementById("progress-text");
  const summaryElem = document.getElementById("summary");
  const colorSquaresContainer = document.getElementById("color-squares");
  const tooltip = document.getElementById("tooltip");

  let detectedColors = [];
  let activeTabHostname = "";

  // Single tab query for hostname + color extraction
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) {
      console.error("No active tabs found.");
      return;
    }

    const activeTab = tabs[0];
    activeTabHostname = new URL(activeTab.url).hostname;
    document.getElementById("currentWebsite").textContent = activeTabHostname;

    chrome.tabs.sendMessage(activeTab.id, { action: "getColors" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Error in sendMessage:", chrome.runtime.lastError.message);
        return;
      }
      if (!response || !response.colors) {
        console.error("No colors found or invalid response.");
        return;
      }

      detectedColors = response.colors;
      detectedColors.forEach((color) => {
        const square = document.createElement("div");
        square.classList.add("color-square");
        square.style.backgroundColor = color;
        square.title = color;

        square.addEventListener("click", () => {
          navigator.clipboard.writeText(color).then(() => {
            showCustomAlert(`Copied ${color} to clipboard!`);
          });
        });

        square.addEventListener("mouseenter", () => {
          const rect = square.getBoundingClientRect();
          tooltip.textContent = color;
          tooltip.style.left = `${rect.left + window.scrollX}px`;
          tooltip.style.top = `${rect.top - tooltip.offsetHeight + window.scrollY - 5}px`;
          tooltip.style.opacity = 1;
        });

        square.addEventListener("mouseleave", () => {
          tooltip.style.opacity = 0;
        });

        colorSquaresContainer.appendChild(square);
      });
    });
  });

  // ─── Custom alert modal ──────────────────────────────────────────
  function showCustomAlert(message) {
    const modal = document.getElementById("custom-alert");
    const alertMessage = document.getElementById("alert-message");
    const closeBtn = document.getElementById("close-alert-button");

    alertMessage.textContent = message;
    modal.style.display = "block";

    const autoClose = setTimeout(() => { modal.style.display = "none"; }, 3000);

    closeBtn.onclick = () => {
      clearTimeout(autoClose);
      modal.style.display = "none";
    };
  }

  // ─── Download handler ────────────────────────────────────────────
  downloadBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        statusElem.textContent = "Error: No active tab found.";
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, { action: "getHarData" }, (response) => {
        if (chrome.runtime.lastError) {
          statusElem.textContent = `Error: ${chrome.runtime.lastError.message}`;
          return;
        }
        if (!response || !response.harData) {
          statusElem.textContent = "Error: No data found.";
          return;
        }

        const allUrls = extractUniqueUrls(response.harData);
        const wantImages = document.getElementById("imagesCheckbox").checked;
        const wantVideos = document.getElementById("videosCheckbox").checked;
        const wantFonts = document.getElementById("fontsCheckbox").checked;

        const filteredUrls = allUrls.filter((url) =>
          (wantImages && isImage(url)) ||
          (wantVideos && isVideo(url)) ||
          (wantFonts && isFont(url))
        );

        if (filteredUrls.length === 0) {
          statusElem.textContent = "No matching files found on this page.";
          return;
        }

        const zip = new JSZip();
        if (detectedColors.length > 0) {
          zip.file("colors.txt", detectedColors.join("\n"));
        }

        progressContainer.style.display = "block";
        summaryElem.style.display = "none";
        let completed = 0;
        let successful = 0;
        let failed = 0;
        const countByType = { images: 0, videos: 0, fonts: 0 };

        const updateProgress = () => {
          const pct = (completed / filteredUrls.length) * 100;
          progressBar.style.width = `${pct}%`;
          progressText.textContent = `${Math.round(pct)}%`;
        };

        const promises = filteredUrls.map((url) =>
          fetch(url)
            .then((res) => res.blob().then((blob) => ({ blob, res })))
            .then(({ blob, res }) => {
              zip.file(buildFileName(url, res), blob, { binary: true });
              completed++;
              successful++;
              if (isImage(url)) countByType.images++;
              else if (isVideo(url)) countByType.videos++;
              else if (isFont(url)) countByType.fonts++;
              updateProgress();
            })
            .catch((err) => {
              console.error(`Failed to fetch ${url}:`, err);
              completed++;
              failed++;
              updateProgress();
            })
        );

        statusElem.textContent = "Downloading files as a zip...";

        Promise.all(promises)
          .then(() => {
            const safeName = activeTabHostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
            return zip.generateAsync({ type: "blob" }).then((content) => {
              const blobUrl = URL.createObjectURL(content);
              chrome.downloads.download(
                { url: blobUrl, filename: `${safeName}_assets.zip` },
                () => {
                  if (chrome.runtime.lastError) {
                    console.error("Failed to download zip:", chrome.runtime.lastError);
                  }
                  URL.revokeObjectURL(blobUrl);
                }
              );
            });
          })
          .catch((err) => console.error("Failed to process downloads:", err))
          .finally(() => {
            progressContainer.style.display = "none";
            summaryElem.style.display = "block";
            summaryElem.innerHTML = `<p class="inter-regular">Images: ${countByType.images} - Videos: ${countByType.videos} - Fonts: ${countByType.fonts}</p>`;
            statusElem.textContent = `Download complete. ${successful} files downloaded, ${failed} failed.`;
          });
      });
    });
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** Extract unique URLs from HAR-style performance data */
function extractUniqueUrls(harData) {
  const seen = new Set();
  const urls = [];
  for (const entry of harData.log.entries) {
    const url = entry.request.url;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** Build a clean filename from URL + response headers */
function buildFileName(url, response) {
  // 1. Try Content-Disposition header
  const cd = response.headers.get("Content-Disposition");
  if (cd) {
    const match = cd.match(/filename="(.+)"/);
    if (match) return sanitizeFileName(match[1]);
  }

  // 2. Extract from URL pathname (no query string)
  let name = "";
  try {
    const pathname = new URL(url).pathname;
    name = pathname.substring(pathname.lastIndexOf("/") + 1);
  } catch {
    name = url.substring(url.lastIndexOf("/") + 1).split("?")[0];
  }

  if (!name.trim()) name = `file_${Date.now()}`;

  // 3. Ensure valid extension
  const ext = getUrlExtension(url);
  const hasExt = ALL_EXTS.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());

  if (!hasExt) {
    // Try Content-Type header
    const ct = response.headers.get("Content-Type");
    const mimeExt = ct ? MIME_TO_EXT[ct.split(";")[0].trim()] : null;

    if (mimeExt) {
      name += mimeExt;
    } else if (ext && ALL_EXTS.has(ext)) {
      name += "." + ext;
    } else if (isImage(url)) {
      name += ".png";
    } else if (isVideo(url)) {
      name += ".mp4";
    } else if (isFont(url)) {
      name += ".woff";
    }
  }

  return sanitizeFileName(name);
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_");
}
