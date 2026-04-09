console.log("Content script loaded on this page.");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getHarData") {
    const harData = collectHarData();
    setTimeout(() => {
      sendResponse({ harData: harData });
    }, 0);
    return true;
  }

  if (request.action === "getColors") {
    const topColors = extractColors();
    sendResponse({ colors: topColors });
  }
});

function collectHarData() {
  const performanceEntries = performance.getEntriesByType("resource");
  const harEntries = performanceEntries.map((entry) => ({
    request: { url: entry.name },
  }));
  return { log: { entries: harEntries } };
}

function rgbToHex(rgb) {
  const parts = rgb.match(/\d+/g);
  if (!parts || parts.length < 3) return null;

  // Skip fully transparent colors
  if (parts.length >= 4 && parseInt(parts[3], 10) === 0) return null;

  let hex = "#";
  for (let i = 0; i < 3; i++) {
    hex += parseInt(parts[i], 10).toString(16).padStart(2, "0");
  }
  return hex;
}

function extractColors() {
  const colorsMap = {};

  document.querySelectorAll("*").forEach((element) => {
    const computedStyles = window.getComputedStyle(element);
    const hexColor = rgbToHex(computedStyles.color);
    const hexBg = rgbToHex(computedStyles.backgroundColor);

    if (hexColor) {
      colorsMap[hexColor] = (colorsMap[hexColor] || 0) + 1;
    }
    if (hexBg) {
      colorsMap[hexBg] = (colorsMap[hexBg] || 0) + 1;
    }
  });

  return Object.entries(colorsMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([color]) => color);
}
