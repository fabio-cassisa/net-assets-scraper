// Content script is injected via manifest.json content_scripts.
// Service worker only needed for install logging.
chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed.");
});
