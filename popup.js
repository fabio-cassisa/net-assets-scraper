// Function to check if URL is an image
function isImage(url) {
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.endsWith(".jpg") ||
    lowerUrl.endsWith(".jpeg") ||
    lowerUrl.endsWith(".png") ||
    lowerUrl.endsWith(".gif") ||
    lowerUrl.includes(".jpg?") ||
    lowerUrl.includes(".jpeg?") ||
    lowerUrl.includes(".png?") ||
    lowerUrl.includes(".gif?") ||
    lowerUrl.endsWith(".webp") ||
    lowerUrl.endsWith(".tif") ||
    lowerUrl.includes(".webp?") ||
    lowerUrl.includes(".tif?") ||
    lowerUrl.endsWith(".svg") ||
    lowerUrl.includes(".svg?") ||
    lowerUrl.endsWith(".avif") ||
    lowerUrl.includes(".avif?")
  );
}

// Function to check if URL is a video
function isVideo(url) {
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.endsWith(".mp4") ||
    lowerUrl.endsWith(".webm") ||
    lowerUrl.endsWith(".ogg") ||
    lowerUrl.endsWith(".avi") ||
    lowerUrl.includes(".mp4?") ||
    lowerUrl.includes(".webm?") ||
    lowerUrl.includes(".ogg?") ||
    lowerUrl.includes(".avi?") ||
    lowerUrl.endsWith(".mov") ||
    lowerUrl.endsWith(".wmv") ||
    lowerUrl.includes(".mov?") ||
    lowerUrl.includes(".wmv?")
  );
}

// Function to check if URL is a font
function isFont(url) {
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.endsWith(".woff") ||
    lowerUrl.endsWith(".woff2") ||
    lowerUrl.endsWith(".ttf") ||
    lowerUrl.endsWith(".otf") ||
    lowerUrl.includes(".woff?") ||
    lowerUrl.includes(".woff2?") ||
    lowerUrl.includes(".ttf?") ||
    lowerUrl.includes(".otf?") ||
    lowerUrl.endsWith(".eot") ||
    lowerUrl.includes(".eot?")
  );
}

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

  // Single tab query for both hostname display and color extraction
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length === 0) {
      console.error("No active tabs found.");
      return;
    }

    const activeTab = tabs[0];
    const activeTabUrl = new URL(activeTab.url);
    activeTabHostname = activeTabUrl.hostname;

    document.getElementById("currentWebsite").textContent = activeTabHostname;

    // Fetch colors from the content script
    chrome.tabs.sendMessage(activeTab.id, { action: "getColors" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Error in sendMessage:", chrome.runtime.lastError.message);
        return;
      }

      if (response && response.colors) {
        detectedColors = response.colors;
        response.colors.forEach((color) => {
          const square = document.createElement("div");
          square.classList.add("color-square");
          square.style.backgroundColor = color;
          square.title = color;

          square.addEventListener("click", () => {
            navigator.clipboard.writeText(color).then(() => {
              showCustomAlert(`Copied ${color} to clipboard!`);
            });
          });

          square.addEventListener("mouseenter", (event) => {
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
      } else {
        console.error("No colors found or invalid response.");
      }
    });
  });

  // Custom alert modal
  function showCustomAlert(message) {
    const modal = document.getElementById("custom-alert");
    const alertMessage = document.getElementById("alert-message");
    const closeAlertButton = document.getElementById("close-alert-button");

    alertMessage.textContent = message;
    modal.style.display = "block";

    const autoCloseTimeout = setTimeout(() => {
      modal.style.display = "none";
    }, 3000);

    closeAlertButton.onclick = function () {
      clearTimeout(autoCloseTimeout);
      modal.style.display = "none";
    };
  }

  // Download button handler
  downloadBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        console.error("No active tabs found.");
        statusElem.textContent = "Error: No active tab found.";
        return;
      }

      const tabId = tabs[0].id;

      chrome.tabs.sendMessage(tabId, { action: "getHarData" }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("Error in sendMessage:", chrome.runtime.lastError);
          statusElem.textContent = `Error: ${chrome.runtime.lastError.message}`;
          return;
        }

        if (!response || !response.harData) {
          console.error("No response or harData found.");
          statusElem.textContent = "Error: No data found.";
          return;
        }

        const allUrls = extractUrlsFromHar(response.harData);

        const imagesChecked = document.getElementById("imagesCheckbox").checked;
        const videosChecked = document.getElementById("videosCheckbox").checked;
        const fontsChecked = document.getElementById("fontsCheckbox").checked;

        // Filter first, then track progress only for matching URLs
        const filteredUrls = allUrls.filter((url) => {
          if (imagesChecked && isImage(url)) return true;
          if (videosChecked && isVideo(url)) return true;
          if (fontsChecked && isFont(url)) return true;
          return false;
        });

        if (filteredUrls.length === 0) {
          statusElem.textContent = "No matching files found on this page.";
          return;
        }

        const zip = new JSZip();

        // Only include colors.txt if colors were actually detected
        if (detectedColors.length > 0) {
          zip.file("colors.txt", detectedColors.join("\n"));
        }

        progressContainer.style.display = "block";
        summaryElem.style.display = "none";
        let completed = 0;
        let successful = 0;
        let failed = 0;
        const countByType = { images: 0, videos: 0, fonts: 0 };

        function updateProgress() {
          const progress = (completed / filteredUrls.length) * 100;
          progressBar.style.width = `${progress}%`;
          progressText.textContent = `${Math.round(progress)}%`;
        }

        const promises = filteredUrls.map((url) =>
          fetch(url)
            .then((response) => {
              const fileName = getFileName(url, response);
              return response.blob().then((blobData) => {
                zip.file(fileName, blobData, { binary: true });
                completed++;
                successful++;
                if (isImage(url)) countByType.images++;
                else if (isVideo(url)) countByType.videos++;
                else if (isFont(url)) countByType.fonts++;
                updateProgress();
              });
            })
            .catch((error) => {
              console.error(`Failed to fetch ${url}:`, error);
              completed++;
              failed++;
              updateProgress();
            })
        );

        // Generate zip when all downloads complete
        Promise.all(promises)
          .then(() => {
            const zipName = activeTabHostname
              ? `${activeTabHostname.replace(/[^a-z0-9.-]/gi, "_")}_assets.zip`
              : "downloaded_assets.zip";

            return zip.generateAsync({ type: "blob" }).then((content) => {
              const blobUrl = URL.createObjectURL(content);
              chrome.downloads.download(
                { url: blobUrl, filename: zipName },
                () => {
                  if (chrome.runtime.lastError) {
                    console.error("Failed to download zip file:", chrome.runtime.lastError);
                  }
                  URL.revokeObjectURL(blobUrl);
                }
              );
            });
          })
          .catch((error) => {
            console.error("Failed to process downloads:", error);
          })
          .finally(() => {
            progressContainer.style.display = "none";
            summaryElem.style.display = "block";
            summaryElem.innerHTML = `<p class="inter-regular">Images: ${countByType.images} - Videos: ${countByType.videos} - Fonts: ${countByType.fonts}</p>`;
            statusElem.textContent = `Download complete. ${successful} files downloaded, ${failed} failed.`;
          });

        statusElem.textContent = "Downloading files as a zip...";
      });
    });
  });
});

// Extract unique URLs from HAR data
function extractUrlsFromHar(harData) {
  const entries = harData.log.entries;
  const seen = new Set();
  const urls = [];
  for (const entry of entries) {
    const url = entry.request.url;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

// Strip query string to get clean filename
function cleanFileName(url) {
  try {
    const pathname = new URL(url).pathname;
    let fileName = pathname.substring(pathname.lastIndexOf("/") + 1);
    if (!fileName.trim()) {
      fileName = `file_${Date.now()}`;
    }
    return fileName.replace(/[<>:"/\\|?*]/g, "_");
  } catch {
    let fileName = url.substring(url.lastIndexOf("/") + 1);
    // Strip query string
    const qIdx = fileName.indexOf("?");
    if (qIdx !== -1) fileName = fileName.substring(0, qIdx);
    if (!fileName.trim()) fileName = `file_${Date.now()}`;
    return fileName.replace(/[<>:"/\\|?*]/g, "_");
  }
}

function getFileName(url, response) {
  let fileName = cleanFileName(url);

  // Attempt to get filename from Content-Disposition header
  const contentDisposition = response.headers.get("Content-Disposition");
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="(.+)"/);
    if (match) {
      fileName = match[1];
    }
  }

  // Fallback to content type if filename has no extension
  if (!fileName.includes(".")) {
    const contentType = response.headers.get("Content-Type");
    if (contentType) {
      const ext = mimeToExtension(contentType);
      if (ext) fileName += ext;
    }
  }

  // Ensure correct extension based on URL
  fileName = ensureCorrectExtension(url, fileName);

  return fileName.replace(/[<>:"/\\|?*]/g, "_");
}

function ensureCorrectExtension(url, fileName) {
  const validExtensions = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".tif", ".svg",
    ".mp4", ".webm", ".ogg", ".avi", ".mov", ".wmv",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ]);

  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (validExtensions.has(ext)) return fileName;

  // Default extensions by type
  if (isImage(url)) return fileName + ".png";
  if (isVideo(url)) return fileName + ".mp4";
  if (isFont(url)) return fileName + ".woff";
  return fileName;
}

function mimeToExtension(mimeType) {
  const mimeMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/tiff": ".tif",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogg",
    "video/avi": ".avi",
    "video/mov": ".mov",
    "video/wmv": ".wmv",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/vnd.ms-fontobject": ".eot",
  };
  return mimeMap[mimeType] || "";
}
