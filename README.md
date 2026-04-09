# chrome assets scraper

browser extension that captures and downloads assets from any website you're visiting.

## context

built this out of a real need at work — when building ad creatives, I constantly need to grab images, fonts, videos, and other assets from client websites for reference. instead of digging through devtools and network tabs manually, I wanted a one-click solution.

the extension monitors network requests, captures asset URLs, and lets you download them directly. it's a developer tool, built for creative developers who need assets fast.

> ⚠️ alpha version — built for personal/educational use, not commercial distribution.

## stack

`javascript` · `chrome extension (manifest v3)` · `html` · `css`

## how it works

1. install the extension locally (see below)
2. navigate to any website
3. click the extension icon — it captures network requests
4. browse captured assets and download what you need

## structure

```
├── background.js    # service worker — captures network requests
├── content.js       # content script — injected into pages
├── popup.html       # extension popup ui
├── popup.js         # popup logic and interaction
├── style.css        # popup styling
├── manifest.json    # chrome extension manifest v3
├── libs/            # third-party libraries
└── assets/          # extension icons
```

## install locally

```bash
1. clone this repo
2. open chrome://extensions
3. enable "developer mode"
4. click "load unpacked" → select this folder
5. navigate to any site and click the extension icon
```

## permissions

the extension requires:
- `tabs` — to access the current tab
- `downloads` — to save assets locally
- `activeTab` + `scripting` — to interact with page content
- `clipboardWrite` — to copy asset URLs
- `host_permissions: <all_urls>` — to capture network requests from any site

## status

🟡 alpha — functional but rough around the edges. planned improvements:
- [ ] better asset categorization (images, fonts, scripts, media)
- [ ] filtering and search within captured assets
- [ ] bulk download
- [ ] ui/ux overhaul
- [ ] potential migration to a more modern stack

## why open source

tools like this exist commercially, but I wanted something lightweight and transparent. no tracking, no account needed, no cloud — just a local tool that does one thing well.

---

<sub>built by [fabio cassisa](https://github.com/fabio-cassisa)</sub>
