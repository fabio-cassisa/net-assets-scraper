# net assets scraper

browser extension that extracts brand assets from any website — logos, images, videos, fonts, and colors — into an organized brand kit.

## context

built for a creative development team that makes ad creatives all day. the workflow: visit a client's website, grab their brand assets (logos, product shots, brand colors, fonts), drop them into a template builder, ship a mockup. before this tool, that meant digging through devtools, right-clicking images one by one, eyedropping colors manually.

this extension sits in the background, passively captures every image/video/font the browser loads, analyzes the page for brand colors and font stacks, and lets you download everything as an organized zip with one click.

non-technical people use this — sales, account managers. it needs to be dead simple.

> v1 captured network requests and listed them. v2 is a complete rewrite — smart extraction, DOM analysis, brand color detection, organized output.

## what it does

- **passive capture** — `webRequest` API monitors every image, video, font, and audio file the browser loads. no button to press, it just watches.
- **smart brand colors** — extracts colors from CSS custom properties first (most reliable), then meta tags (`theme-color`), then weighted DOM frequency analysis with noise filtering. skips near-black/white/grey.
- **logo detection** — flags images as logos based on alt text, class names, IDs, file paths, and DOM position (header/nav zones).
- **UI element filtering** — identifies and hides nav icons, social icons, button arrows, favicons, and other UI chrome. uses size heuristics (≤48px), DOM context (inside `<button>`, `<nav>`), class/id pattern matching, and known icon CDN domains.
- **deep scan** — auto-scrolls the entire page to trigger lazy-loaded images (IntersectionObserver, `data-src`, `data-lazy-src`, etc.), then runs full DOM analysis.
- **font detection** — finds Google Fonts links, Adobe Fonts/TypeKit, `@font-face` declarations, and computed font families from key elements.
- **preview grid** — visual grid with real thumbnails, video frame grabs, and live font glyph rendering. type badges, logo badges, file sizes, dimensions.
- **organized download** — selected assets go into a zip: `logos/`, `images/`, `videos/`, `fonts/` + a `brand.json` with all extracted colors, fonts, and page metadata.

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
├── manifest.json        # manifest v3 — permissions, content scripts
├── background.js        # service worker — webRequest passive capture
├── content.js           # content script — DOM analysis, color/font/image extraction, deep scan
├── panel/
│   ├── panel.html       # popup UI
│   ├── panel.css        # cyberpunk dark theme
│   └── panel.js         # panel logic — grid, filters, zip generation, video download pipeline
├── platforms/
│   ├── instagram.js              # instagram content script — profile, post, reel, story extraction
│   └── instagram-video-intercept.js  # MAIN world — JSON.parse + fetch() interception for DASH video capture
├── lib/
│   ├── jszip.min.js     # zip library
│   ├── mp4box.all.min.js  # mp4 muxing library
│   └── video-pipeline.js # VP9→H.264 transcode (WebCodecs) + audio mux (MP4Box)
└── assets/
    └── icons/           # extension icons (16–128px)
```

## install

```
1. clone or download this repo
2. open chrome://extensions (or brave://extensions, edge://extensions)
3. enable "developer mode" (top right toggle)
4. click "load unpacked" → select this folder
5. browse to any site and click the extension icon
```

works on chrome, brave, edge, arc, and other chromium browsers.

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

output: universal H.264+AAC `.mp4` files that play everywhere. fallback chain handles failures gracefully — transcode fail → use VP9, mux fail → video-only.

## permissions

- `webRequest` — passively monitor network requests for assets
- `tabs` + `activeTab` — access current tab URL and state
- `scripting` — inject content script for DOM analysis
- `downloads` — save the zip file
- `storage` — persist settings
- `clipboardWrite` — copy color hex codes
- `host_permissions: <all_urls>` — capture from any site

## status

🟢 **v2.1 — drop 2 in progress**. social media mode — instagram video pipeline working.

- [x] passive network capture via `webRequest`
- [x] smart brand color extraction (CSS vars → meta → DOM frequency)
- [x] logo detection + UI element filtering
- [x] deep scan (auto-scroll for lazy-loaded content)
- [x] preview grid with video frame grabs + font glyph rendering
- [x] organized zip download with `brand.json`
- [x] dark cyberpunk theme
- [x] instagram platform detection + content extraction (profile, post, reel, story)
- [x] instagram video interception — JSON.parse nuclear patch + fetch() CDN capture
- [x] VP9 → H.264 transcode via WebCodecs (hardware-accelerated)
- [x] audio + video mux via MP4Box.js (universal .mp4 output)
- [x] human-readable asset naming (`nike_di3xk2_1080x1350.mp4`)

**drop 2 remaining:**

- [ ] selective brand download (make brand items opt-in)
- [ ] brand palette HTML (visual brand card in zip)
- [ ] font organization (`install/` vs `web/` folders)
- [ ] lazy rendering for 100+ video cards

**planned:**

🟡 drop 3 — element capture + advanced
- [ ] click-to-screenshot DOM elements as PNG
- [ ] font file downloads (Google Fonts → `.woff2`)
- [ ] batch mode (scan multiple pages)

## versioning

- `v2.1` — current. instagram video pipeline (VP9→H.264 transcode + mux).
- `v2.0` — core rebuild with smart extraction.
- `v1.0` — original network capture version. still available via `git checkout v1.0`.

## why open source

tools like this exist commercially. this one is lightweight, transparent, and offline — no tracking, no account, no cloud, no store listing. just a local tool that does one thing well.

---

<sub>built by [fabio cassisa](https://github.com/fabio-cassisa)</sub>
