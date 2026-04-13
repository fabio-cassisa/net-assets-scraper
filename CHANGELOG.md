# changelog

all notable changes to net assets scraper.

---

## v2.9.1

bugfix release — CDN original resolution now works correctly with Hide UI filter, and several CDN normalization edge cases are fixed.

### fixed

- **Hide UI filter no longer kills CDN-verified originals** — assets with verified full-size originals now bypass all UI detection (isUI flag, URL pattern heuristics, small dimension checks). previously, content script UI classification could hide real product images even after their originals were confirmed.
- **card metadata shows original size/dimensions** — cards for CDN-verified assets now display the original's file size and dimensions (e.g. "1.2 MB · 1200×1200") instead of the thumbnail's metadata. the card info now reflects what actually gets downloaded.
- **Thumbor regex no longer matches every URL** — the regex had all-optional groups that degraded to matching any URL with a path. Cloudinary and other CDN URLs were misclassified as Thumbor, breaking their dedup. now requires at least one Thumbor-specific indicator (unsafe, fit-in, dimensions, smart, or filters) before matching.
- **Storyblok regex handles query parameters** — the `$` anchor blocked matches when URLs included cache-busters or auth tokens (`?token=abc`). now correctly matches transforms followed by query strings.
- **HEAD verification requests have 10s timeout** — a slow or hanging CDN can no longer block the entire verification pipeline. each request has an AbortController with a 10-second timeout.
- **download size estimate uses original sizes** — the "selected size" indicator in the download bar now uses `cdnOriginalSize` for verified assets instead of the thumbnail's `contentLength`.

---

## v2.9.0

CDN original resolution — when a page serves tiny CDN thumbnails, NAS now detects the full-size original on the CDN server and downloads that instead. no more downloading 120×168 compressed variants when the 1200×1200 original is available.

### added

- **CDN original resolution** — for recognized CDN patterns (Storyblok, Thumbor, Imgix, Cloudinary, Contentful, Shopify), NAS constructs the original image URL by stripping transform parameters and verifies it exists via HEAD request. if the original is available, the extension downloads the full-size version instead of the tiny thumbnail the page served. for Storyblok URLs, original dimensions are extracted from the URL path and shown on the card.
- **original resolution badge** — verified CDN originals show a green badge with the original dimensions (e.g. "1200×1200") or file size. hover for full details including CDN type and original file size.
- **smart filter bypass** — CDN assets with verified originals are no longer hidden by the "Hide tiny" filter. the page may serve 120×168 thumbnails, but if the 1200×1200 original is confirmed fetchable, the asset stays visible.

### changed

- CDN dedup now tags all CDN-matched assets with their original URL, not just multi-variant groups. single-variant CDN images also benefit from original resolution.

---

## v2.8.0

scanning intelligence release — the extension now understands CDN patterns, extracts assets the network layer misses, and deduplicates intelligently.

### added

- **CDN normalization + deduplication** — recognizes 6 major CDN transform patterns (Storyblok, Thumbor, Imgix, Cloudinary, Contentful, Shopify) and collapses duplicate variants of the same image. when a hero image appears at 6 different sizes/formats, NAS picks the highest-quality version and shows a "N sizes" badge. dramatically reduces noise on CDN-heavy websites.
- **CSS background-image extraction** — hero banners, card backgrounds, and section images set via CSS stylesheets (not just inline styles) are now discovered. walks prominent layout elements and extracts computed `background-image` URLs with proper zone/dimension context.
- **inline SVG extraction** — logos and significant SVG elements embedded directly in HTML (never hitting the network) are now serialized and included in scan results. detects logo-like context via parent classes, IDs, ARIA labels, and structural position.
- **expanded lazy-load coverage** — added `data-bg`, `data-full-src`, `data-image`, `data-bg-src` to the lazy-load attribute sweep.
- **asset pipeline debug logging** — console now shows `raw → enriched → filtered` count chain for transparency.

### fixed

- **404/error response filtering** — `webRequest.onCompleted` now skips responses with HTTP status codes outside the 2xx-3xx range. eliminates phantom assets from failed CDN format negotiations (e.g. avif 404s on Thumbor-style CDNs).
- **scan complete toast count** — the "Deep scan complete" notification now shows the actual visible asset count after filters, not the raw pre-filter total. includes a "(N filtered)" note when filters reduce the count.

### changed

- CDN badge UI — cards with deduplicated CDN variants show a sky-blue "N sizes" badge with tooltip showing CDN type.

---

## v2.7.0

brand intelligence release — the extension now understands brands, not just assets.

### added

- **brand guideline generator** — every zip includes a self-contained `brand-guideline.html`. dark/light theme toggle, click-to-copy values, color swatches with contrast ratios, typography samples, CTA button replicas, social links grid. opens in any browser, works offline.
- **open brand guideline** — preview the guideline page directly from the panel without downloading. data passes via `chrome.storage.session` to a real extension page (CSP-safe).
- **settings panel** — gear icon with persistent preferences: quick scan, min image size threshold, auto-select logos, image compression toggle.
- **quick scan mode** — skip auto-scrolling, analyze only what's visible. fast but less thorough.
- **min image size filter** — configurable threshold (48/100/200/400px) to cut noise from tiny icons.
- **auto-select logos** — logo-flagged images are pre-selected on scan results.
- **image compression** — optional downscale (max 2000px) + JPEG 80% quality. skips SVG, fonts, and videos.
- **enhanced brand extraction** — typography scale (h1-h3, body, button), social links, favicon variants, JSON-LD structured data, semantic color roles (primary/secondary/background/text), copy headlines + CTA recipes.
- **font file downloads** — proactive Google Fonts CSS → `.woff2` resolution, `@font-face` direct URL fetching. resolves fonts even if cached before extension loaded. deduplicates against webRequest-captured fonts.
- **export tokens** — on-demand from guideline page: CSS custom properties (`brand-tokens.css`), W3C Design Tokens JSON (`brand-tokens.json` — Figma Tokens Studio / Style Dictionary compatible), markdown brand brief (for AI agents).
- **quick summary** — plain-text brand summary banner in guideline page. one-click copy for sales/non-technical handoff.
- **print/PDF support** — guideline page has print-optimized layout.
- **Adobe Swatch Exchange** — `.ase` color palette export from guideline page. works in Photoshop, Illustrator, InDesign, Affinity Designer, Procreate.

### fixed

- **font dedup bug** — resolved fonts from Google Fonts CSS were not properly deduplicated against webRequest-captured fonts. could produce duplicate font files in the zip.
- **hexLuminance null guard** — theme auto-detection could crash if a color entry had a null/empty hex value. now falls back to `#000000`.
- **legacy download path brand.json parity** — the panel fallback download path (used for Instagram VP9 transcode) now produces the same full v2.7 brand.json structure as the background pipeline. previously missing: `brand`, `colors.primary/secondary/background/text`, `typography`, `copy`, `ctas`, `structuredData`.
- **legacy download path guideline HTML** — panel fallback downloads now include `brand-guideline.html` via message relay to background.js. both download paths produce identical zips.

### changed

- zero-assets kit message — changed from "0 assets in this kit" to "brand data only — no media assets" when kit has brand data but no downloadable media.
- guideline button disabled state — proper `opacity: 0.4` + `cursor: not-allowed` when no scan data available.

---

## v2.6.0

reliability release — scans and downloads survive panel close.

### added

- **background-survivable scanning** — deep scan routes through background service worker. panel can close mid-scan, results cached per tab with URL validation, restored on reopen.
- **background-survivable downloads** — zip generation in service worker with keepalive, progress reporting, try-catch-finally cleanup.
- **scan cache with URL validation** — prevents stale results on SPA navigation (Facebook, Instagram, Twitter `pushState`).

### fixed

- SPA cache staleness — single-page app navigation between profiles no longer returns cached results from the previous profile.

---

## v2.5.0

### added

- background download pipeline (service worker zip generation)
- feed page warning banners (home, explore, search = wrong page for brand assets)
- download + scan UI locks with safety timeouts
- grid batching for large asset lists

---

## v2.4.0

### added

- deep scan progress bar
- facebook `progressive_urls` API capture (HD/SD video)
- post-scroll collection window for facebook feed videos

---

## v2.3.0

### added

- smart asset naming (`@username-platform-context-WxH.ext`)
- platform metadata display (user, bio, followers, verified) for all 6 platforms
- download progress bar
- per-asset failure tracking with `download-report.txt` in zip
- chrome notification on download completion

---

## v2.2.0

social media mode — 6 platforms with MAIN world API interception.

### added

- instagram — full video pipeline (VP9→H.264 transcode + MP4Box mux)
- tiktok — H.264 direct download via MAIN world intercept + postMessage bridge
- twitter/x — GraphQL API intercept, MP4 variants sorted by bitrate
- facebook — GraphQL intercept, multi-line JSON parsing
- youtube — thumbnails, channel art, avatars (no video by design)
- vimeo — progressive H.264 MP4 via config API intercept

---

## v2.1.0

### added

- instagram video pipeline (VP9→H.264 WebCodecs transcode + MP4Box mux)
- MAIN world script injection for API interception

---

## v2.0.0

complete rewrite — smart extraction replaces raw network listing.

### added

- DOM analysis for colors, fonts, images
- brand color extraction (CSS vars → meta → DOM frequency)
- logo detection + UI element filtering
- deep scan (auto-scroll for lazy-loaded content)
- preview grid with thumbnails, video grabs, font glyphs
- organized zip output with `brand.json`
- dark cyberpunk theme

---

## v1.0.0

original release — network request capture with basic asset listing.
