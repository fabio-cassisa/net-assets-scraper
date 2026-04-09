# chrome assets scraper

browser extension that captures and downloads assets from any website you visit.

## context

born from a real need — when building ad creatives, you constantly grab images, fonts, videos, and other assets from client websites for reference. instead of digging through devtools and network tabs manually, this extension captures network requests and lets you download assets directly.

a developer tool for creative developers who need assets fast.

> ⚠️ alpha version — personal/educational use, not commercial distribution.

## stack

`javascript` · `chrome extension (manifest v3)` · `html` · `css`

## how it works

1. install the extension locally (see below)
2. navigate to any website
3. click the extension icon — network requests get captured
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

```
1. clone this repo
2. open chrome://extensions
3. enable "developer mode"
4. click "load unpacked" → select this folder
5. navigate to any site and click the extension icon
```

## permissions

- `tabs` — access the current tab
- `downloads` — save assets locally
- `activeTab` + `scripting` — interact with page content
- `clipboardWrite` — copy asset URLs
- `host_permissions: <all_urls>` — capture requests from any site

## status

🟡 alpha — functional but rough. planned:
- [ ] better asset categorization (images, fonts, scripts, media)
- [ ] filtering and search
- [ ] bulk download
- [ ] ui/ux overhaul

## why open source

tools like this exist commercially. this one is lightweight and transparent — no tracking, no account, no cloud. just a local tool that does one thing.

---

<sub>built by [fabio cassisa](https://github.com/fabio-cassisa)</sub>
