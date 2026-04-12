# net assets scraper

browser extension that extracts brand assets from any website — logos, images, videos, fonts, and colors — into an organized brand kit.

## context

built for a creative development team that makes ad creatives all day. the workflow: visit a client's website or social media page, grab their brand assets (logos, product shots, brand colors, fonts, videos), drop them into a template builder, ship a mockup. before this tool, that meant digging through devtools, right-clicking images one by one, eyedropping colors manually.

this extension sits in the background, passively captures every image/video/font the browser loads, analyzes the page for brand colors and font stacks, and lets you download everything as an organized zip with one click.

non-technical people use this — sales, account managers. it needs to be dead simple.

> v1 captured network requests and listed them. v2 is a complete rewrite — smart extraction, DOM analysis, brand color detection, platform-aware social media scraping, organized output.

## what it does

- **passive capture** — `webRequest` API monitors every image, video, font, and audio file the browser loads. no button to press, it just watches.
- **social media mode** — dedicated scrapers for 6 platforms with API interception, video download, and profile metadata extraction (see platform support below).
- **smart brand colors** — extracts colors from CSS custom properties first (most reliable), then meta tags (`theme-color`), then weighted DOM frequency analysis with noise filtering. skips near-black/white/grey.
- **logo detection** — flags images as logos based on alt text, class names, IDs, file paths, and DOM position (header/nav zones).
- **UI element filtering** — identifies and hides nav icons, social icons, button arrows, favicons, and other UI chrome. uses size heuristics (≤48px), DOM context (inside `<button>`, `<nav>`), class/id pattern matching, and known icon CDN domains.
- **deep scan** — auto-scrolls the entire page to trigger lazy-loaded images (IntersectionObserver, `data-src`, `data-lazy-src`, etc.), then runs full DOM analysis.
- **font detection** — finds Google Fonts links, Adobe Fonts/TypeKit, `@font-face` declarations, and computed font families from key elements.
- **preview grid** — visual grid with real thumbnails, video frame grabs, and live font glyph rendering. type badges, logo badges, file sizes, dimensions.
- **organized download** — selected assets go into a zip: `logos/`, `images/`, `videos/`, `fonts/` + a `brand.json` with all extracted colors, fonts, and page metadata.

## platform support

each platform has a dedicated MAIN world intercept script that monkey-patches `fetch()` and `XMLHttpRequest` to capture API responses containing video URLs and media metadata. a postMessage bridge passes data to the ISOLATED world content script for extraction.

| platform | images | videos | method | notes |
|----------|--------|--------|--------|-------|
| **instagram** | ✅ profile, post, story, reel | ✅ VP9→H.264 transcode + mux | MAIN world MSE + DASH interception | full pipeline — JSON.parse patch, fetch CDN capture, WebCodecs transcode, MP4Box mux |
| **tiktok** | ✅ profile, covers, dynamic covers | ✅ H.264 direct download | MAIN world fetch/XHR intercept | CSP-safe postMessage bridge (inline script injection blocked by TikTok CSP) |
| **twitter/x** | ✅ profile pic, banner, tweet images | ✅ H.264 MP4 from GraphQL variants | MAIN world fetch/XHR intercept | handles `legacy` user format, MP4 variants sorted by bitrate |
| **facebook** | ✅ profile pic, cover photo, feed images | ✅ H.264 progressive MP4 (HD/SD) | MAIN world fetch/XHR intercept | `progressive_urls` API capture, post-scroll collection window, multi-line JSON parsing |
| **youtube** | ✅ thumbnails, channel art, avatars | ❌ by design | OG meta + DOM scraping | no video download — cipher/signature war = maintenance trap |
| **vimeo** | ✅ thumbnails, avatars | ✅ H.264 progressive MP4 | MAIN world fetch/XHR intercept | `progressive[]` config capture, direct CDN fetch (self-authenticated URLs) |

### architecture — MAIN world intercept pattern

all social platforms now load video/media data via API calls after page render (SSR hydration is dead). every platform follows the same proven pattern:

```
MAIN world (document_start)              ISOLATED world (document_idle)
 *-video-intercept.js                     *.js (platform script)
    │                                         │
    │ monkey-patches fetch() + XHR            │ readInterceptData()
    │ captures API responses by URL pattern   │   → postMessage(NAS_*_GET_DATA)
    │ walks JSON for videos/users/images      │   ← postMessage(NAS_*_DATA_RESPONSE)
    │ stores in window.__NAS_*_DATA__         │ merges into SSR/DOM results
    │                                         │
    │ NAS_MAIN_FETCH handler                  │ fetchBlobViaMainWorld()
    │   (fetch with page cookies)             │   → postMessage(NAS_MAIN_FETCH)
```

## how it works

1. install locally (see below)
2. browse to any website — assets are captured automatically
3. click the extension icon to open the panel
4. filter by type, toggle "hide tiny" / "hide UI" to cut noise
5. hit **scan** for a deep scan (auto-scrolls the page, finds lazy-loaded content)
6. select what you need, hit **download kit**
7. get a zip with organized folders + `brand.json`

## stack

`javascript` · `chrome extension (manifest v3)` · `html` · `css` · `jszip` · `mp4box.js` · `webcodecs`

no build step, no bundler, no framework. vanilla JS. coworkers install by dragging a folder into chrome.

## structure

```
├── manifest.json          # manifest v3 — permissions, content scripts, MAIN world entries
├── background.js          # service worker — webRequest passive capture
├── content.js             # content script — DOM analysis, color/font/image extraction, deep scan, fetchBlob proxy
├── panel/
│   ├── panel.html         # popup UI
│   ├── panel.css          # cyberpunk dark theme
│   └── panel.js           # panel logic — grid, filters, zip generation, video download pipeline
├── platforms/
│   ├── instagram.js                  # instagram — profile, post, reel, story extraction
│   ├── instagram-video-intercept.js  # MAIN world — JSON.parse + fetch() interception for DASH video
│   ├── tiktok.js                     # tiktok — profile, video, feed extraction
│   ├── tiktok-video-intercept.js     # MAIN world — fetch/XHR intercept + postMessage bridge
│   ├── twitter.js                    # twitter/x — profile, tweet, media extraction
│   ├── twitter-video-intercept.js    # MAIN world — GraphQL API intercept
│   ├── facebook.js                   # facebook — page, post, video extraction
│   ├── facebook-video-intercept.js   # MAIN world — GraphQL API intercept (multi-line JSON)
│   ├── youtube.js                    # youtube — thumbnails, channel art (no video by design)
│   ├── vimeo.js                      # vimeo — video, profile, showcase extraction
│   └── vimeo-video-intercept.js      # MAIN world — player config API intercept
├── lib/
│   ├── jszip.min.js       # zip library
│   ├── mp4box.all.min.js  # mp4 muxing library
│   └── video-pipeline.js  # VP9→H.264 transcode (WebCodecs) + audio mux (MP4Box)
└── assets/
    └── icons/             # extension icons (16–128px)
```

## video pipeline

instagram serves all video as VP9 DASH segments with separate audio tracks. most tools and apps (QuickTime, Premiere, PowerPoint, Keynote) can't play VP9. this extension solves that:

```
instagram page
     │
     ├── JSON.parse interception ──→ captures DASH representations from GraphQL
     │                                populates dashIndex (url → metadata)
     │
     ├── fetch() CDN interception ──→ enriches captures with DASH metadata
     │                                classifies by URL path (/m367/ = VP9, /m78/ = AAC)
     │
     └── panel download:
         1. fetch video (VP9) + audio (AAC) buffers via content script
         2. transcode VP9 → H.264 via WebCodecs (VideoToolbox HW accel)
         3. mux H.264 + AAC → universal .mp4 via MP4Box.js
         4. zip it with human-readable filename
```

other platforms (tiktok, twitter, vimeo) serve H.264 MP4 natively — no transcode needed, direct download.

## install

### quick install (recommended)

1. go to the [latest release](https://github.com/fabio-cassisa/ChromeAssetsScraper/releases/latest)
2. download `net-assets-scraper-v*.zip`
3. unzip it to a folder on your computer (anywhere is fine)
4. open your browser → go to `chrome://extensions`
   - arc: extensions → manage extensions
   - brave: `brave://extensions`
   - edge: `edge://extensions`
5. toggle **developer mode** ON (top-right corner)
6. click **load unpacked** → select the unzipped folder
7. pin the NAS icon in your toolbar — done!

### update to a new version

1. download the new zip from [releases](https://github.com/fabio-cassisa/ChromeAssetsScraper/releases)
2. unzip it to the **same folder** (overwrite)
3. go to `chrome://extensions` → click the ↻ reload button on the NAS card

### developer install

```
git clone https://github.com/fabio-cassisa/ChromeAssetsScraper.git
# open chrome://extensions → developer mode ON → load unpacked → select the cloned folder
```

works on chrome, arc, brave, edge, and other chromium browsers.

## permissions

- `webRequest` — passively monitor network requests for assets
- `tabs` + `activeTab` — access current tab URL and state
- `scripting` — inject content script for DOM analysis
- `downloads` — save the zip file
- `clipboardWrite` — copy color hex codes
- `host_permissions: <all_urls>` — capture from any site

## known behaviors

- **facebook videos** — deep scan auto-scrolls and waits for video API responses. video URLs are captured via `progressive_urls` in Facebook's GraphQL responses. for best results, let the scan complete fully before downloading.
- **facebook/twitter CDN expiry** — image URLs are time-signed and expire. download your kit promptly after scanning.
- **deep scan on long feeds** — scrolling through large feeds (twitter timelines, facebook pages) takes time. a quick scan grabs what's visible; deep scan scrolls for more.
- **youtube** — no video download by design. youtube's cipher/signature system changes frequently — supporting it would require constant maintenance. images and brand assets work fine.

## status

🟢 **v2.6 — stable release. background-survivable scanning + downloads.**

- [x] passive network capture via `webRequest`
- [x] smart brand color extraction (CSS vars → meta → DOM frequency)
- [x] logo detection + UI element filtering
- [x] deep scan (auto-scroll for lazy-loaded content)
- [x] preview grid with video frame grabs + font glyph rendering
- [x] organized zip download with `brand.json`
- [x] dark cyberpunk theme
- [x] instagram — full video pipeline (VP9→H.264 transcode + MP4Box mux)
- [x] tiktok — H.264 direct download via MAIN world intercept + postMessage bridge
- [x] twitter/x — GraphQL API intercept, MP4 variants sorted by bitrate
- [x] facebook — GraphQL intercept, multi-line JSON parsing, `progressive_urls` API capture (HD/SD)
- [x] youtube — thumbnails, channel art, avatars (no video by design)
- [x] vimeo — progressive H.264 MP4 via config API intercept
- [x] smart asset naming (`@username-platform-context-WxH.ext`)
- [x] platform metadata display (user, bio, followers, verified) for all 6 platforms
- [x] background-survivable downloads — close panel, zip still appears
- [x] background-survivable scanning — close panel mid-scan, reopen to get results
- [x] scan cache with URL validation (prevents stale results on SPA navigation)
- [x] per-asset failure tracking with `download-report.txt` in zip
- [x] chrome notification on download completion
- [x] feed page warning banners (home, explore, search = wrong page for brand assets)
- [x] download + scan UI locks with safety timeouts

**next — backlog:**

- [ ] quick presets (brand kit / media pack / everything)
- [ ] size awareness (zip estimate, adnami suite limits warning)
- [ ] font file downloads (Google Fonts → `.woff2`)
- [ ] image compression toggle (stay under 3.8MB for suite templates)
- [ ] base64 memory optimization (streaming fetch instead of data URLs)

**planned — drop 3:**

- [ ] click-to-screenshot DOM elements as PNG
- [ ] batch mode (scan multiple pages)

## versioning

all releases available at [github.com/fabio-cassisa/ChromeAssetsScraper/releases](https://github.com/fabio-cassisa/ChromeAssetsScraper/releases)

- `v2.6` — **current stable.** background-survivable scanning + downloads, scan cache with URL validation, SPA stale-data fix.
- `v2.5` — background download pipeline, feed warnings, UI locks, grid batching.
- `v2.4` — deep scan progress bar, facebook `progressive_urls` API capture, post-scroll collection window.
- `v2.3` — phase B polish — smart naming, platform metadata, progress bar, audit fixes.
- `v2.2` — social media mode complete — 6 platforms with MAIN world API interception.
- `v2.1` — instagram video pipeline (VP9→H.264 transcode + mux).
- `v2.0` — core rebuild with smart extraction.
- `v1.0` — original network capture version.

## why open source

tools like this exist commercially. this one is lightweight, transparent, and offline — no tracking, no account, no cloud, no store listing. just a local tool that does one thing well.

---

<sub>built by [fabio cassisa](https://github.com/fabio-cassisa)</sub>
