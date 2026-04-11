// ─── Net Assets Scraper V2 — Instagram Video Interceptor ─────────────
// Runs in MAIN world (page JS context) to capture Instagram video URLs.
//
// Strategy (three layers, ordered by reliability):
//
//   1. FETCH INTERCEPTION (passive) — patches window.fetch to inspect
//      Instagram's GraphQL/API responses. As of April 2026, Instagram
//      returns video data in extensions.all_video_dash_prefetch_representations
//      (VP9 DASH + separate AAC audio). Legacy video_url / video_versions
//      fields are kept as fallback but no longer appear in current API.
//      Works in ALL Chromium browsers, survives SPA navigation.
//
//   2. EMBEDDED DATA SCAN (on-demand) — scans <script> tags already in
//      the page HTML for SSR-delivered video data. Instagram embeds the
//      initial page payload via inline scripts, which bypass fetch().
//      Triggered by content script on scan/deep-scan — no browsing needed.
//      [NOT YET IMPLEMENTED — Phase 4]
//
//   3. MSE INTERCEPTION (fallback) — patches SourceBuffer.appendBuffer
//      to capture DASH segments as they're fed to MediaSource. Requires
//      reassembly into a playable file. More fragile, browser-dependent.
//
// The content script (ISOLATED world) queries all via postMessage bridge.
//
// Captured videos include codec + audioUrl metadata so the download
// pipeline can mux (mp4box.js) or transcode (WebCodecs VP9→H.264)
// to produce universal playable files.

(function () {
  "use strict";

  // Guard against double injection
  if (window.__NAS_VIDEO_INTERCEPTED__) return;
  window.__NAS_VIDEO_INTERCEPTED__ = true;

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 1: Fetch Interception — capture video/audio CDN URLs
  //             directly from Instagram's player + API responses
  // ═══════════════════════════════════════════════════════════════════

  // Storage: url → { url, type, timestamp, ... }
  const videoUrls = new Map();   // video CDN URLs
  const audioUrls = new Map();   // audio CDN URLs (paired with videos for muxing)

  // DASH lookup index: base_url → rich metadata from API (P0).
  // When CDN captures arrive, we check this index to enrich them with
  // videoId, dimensions, bandwidth, codec, and paired audio URL.
  const dashIndex = new Map();   // base_url → { videoId, width, height, bandwidth, codec, audioUrl, audioCodec }

  // Instagram API endpoint patterns (for JSON response parsing — bonus strategy)
  const API_PATTERNS = [
    /instagram\.com\/graphql\/query/,
    /instagram\.com\/api\/graphql/,
    /instagram\.com\/api\/v1\//,
  ];

  // Instagram CDN pattern (video + audio segments)
  const CDN_PATTERN = /scontent[.-][\w-]+\.cdninstagram\.com|fbcdn\.net/;

  // ─── Patch window.fetch ────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const rawUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    const response = await origFetch.apply(this, args);

    try {
      // PRIMARY: Capture CDN video/audio URLs from the player's own fetches.
      // Instagram serves BOTH video and audio with Content-Type: video/mp4,
      // so we classify by URL path pattern instead:
      //   /m78/  = AAC audio (codec mp4a.40.5, 0×0 dimensions)
      //   /m367/ or /m366/ = VP9 video
      if (CDN_PATTERN.test(rawUrl) && response.ok) {
        const ct = response.headers?.get("content-type") || "";
        if (/\/m78\//.test(rawUrl)) {
          captureCdnUrl(rawUrl, "audio", ct);
        } else if (/\/m36[67]\//.test(rawUrl)) {
          captureCdnUrl(rawUrl, "video", ct);
        }
      }

      // BONUS: Also inspect API responses for metadata (if Instagram ever
      // routes GraphQL through fetch — currently they don't, but keeping
      // this for forward-compatibility and edge cases)
      if (API_PATTERNS.some((p) => p.test(rawUrl))) {
        const clone = response.clone();
        extractVideoUrlsFromResponse(clone).catch(() => {});
      }
    } catch {
      // Never break Instagram's normal operation
    }

    return response;
  };

  // ─── Patch XMLHttpRequest for older API calls ──────────────────────
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._nasUrl = url;
    return origXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._nasUrl && API_PATTERNS.some((p) => p.test(this._nasUrl))) {
      this.addEventListener("load", function () {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            const data = JSON.parse(this.responseText);
            extractVideoData(data);
          }
        } catch {
          // Silent — don't break XHR
        }
      });
    }
    return origXhrSend.apply(this, args);
  };

  // ─── Patch Response.prototype.json ─────────────────────────────────
  // Instagram captures the original window.fetch before our patch runs,
  // so our patched fetch never sees GraphQL API calls. But Instagram
  // still calls response.json() to parse them — and we CAN intercept that.
  const origJson = Response.prototype.json;
  Response.prototype.json = async function () {
    const data = await origJson.call(this);
    try {
      const url = this.url || "";
      if (API_PATTERNS.some((p) => p.test(url))) {
        extractVideoData(data);
      }
    } catch {
      // Never break Instagram's normal operation
    }
    return data;
  };

  // ─── Patch Response.prototype.text ─────────────────────────────────
  // Instagram may use .text() + JSON.parse() instead of .json().
  // We intercept .text() to check for DASH data in GraphQL responses.
  const origText = Response.prototype.text;
  Response.prototype.text = async function () {
    const text = await origText.call(this);
    try {
      const url = this.url || "";
      if (API_PATTERNS.some((p) => p.test(url)) && text.includes("dash_prefetch")) {
        const data = JSON.parse(text);
        extractVideoData(data);
      }
    } catch {
      // Never break Instagram's normal operation
    }
    return text;
  };

  // ─── Patch JSON.parse ──────────────────────────────────────────────
  // Nuclear option: intercept JSON.parse itself to catch DASH data
  // regardless of how Instagram reads the response. Only inspects objects
  // that contain the specific DASH key to avoid performance impact.
  const origJsonParse = JSON.parse;
  JSON.parse = function (text, ...rest) {
    const result = origJsonParse.call(this, text, ...rest);
    try {
      if (typeof text === "string" && text.length > 500 && text.includes("dash_prefetch_representations")) {
        extractVideoData(result);
      }
    } catch {
      // Never break anything
    }
    return result;
  };

  // ─── Extract video URLs from a fetch response ──────────────────────
  async function extractVideoUrlsFromResponse(response) {
    const contentType = response.headers?.get("content-type") || "";
    if (!contentType.includes("json") && !contentType.includes("text")) return;

    const text = await response.text();
    // Quick check before expensive parse
    if (!text.includes("video")) return;

    try {
      const data = JSON.parse(text);
      extractVideoData(data);
    } catch {
      // Not valid JSON — skip
    }
  }

  // ─── Strategy 2: Embedded Data Scan ────────────────────────────────
  // Instagram uses SSR — the initial page payload (including DASH
  // prefetch representations) is embedded in <script> tags in the HTML,
  // NOT fetched via a separate GraphQL call. This scanner extracts that
  // data from the DOM and populates dashIndex for CDN enrichment.

  function scanEmbeddedScripts() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script:not([src])'
    );
    let found = 0;

    for (const script of scripts) {
      const text = script.textContent;
      if (!text || text.length < 100) continue;
      // Quick check before expensive parse
      if (!text.includes("dash_prefetch_representations")) continue;

      try {
        const data = JSON.parse(text);
        extractVideoData(data);
        found++;
      } catch {
        // Not parseable JSON — might be regular JS. Try to extract
        // JSON objects from assignment patterns like: window.__data = {...}
        try {
          const jsonMatch = text.match(/=\s*(\{[\s\S]+\})\s*;?\s*$/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[1]);
            extractVideoData(data);
            found++;
          }
        } catch {
          // Give up on this script tag
        }
      }
    }

    if (found > 0) {
      console.log(`[NAS] Embedded scan: found DASH data in ${found} script tag(s), dashIndex size: ${dashIndex.size}`);
    }
  }

  // Run embedded scan when DOM is ready (SSR data is in the initial HTML)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanEmbeddedScripts);
  } else {
    // DOM already loaded — scan immediately
    scanEmbeddedScripts();
  }

  // ─── Extract video URLs from parsed API data ────────────────────────
  const MAX_DEPTH = 20;

  /**
   * Main extraction entry point. Inspects a parsed API response for video
   * data using three strategies in priority order:
   *
   *   P0  all_video_dash_prefetch_representations (current Instagram format,
   *       April 2026+). Lives in `response.extensions`. Contains per-video
   *       representation arrays with base_url, codec, dimensions, bandwidth.
   *
   *   P1  video_url (legacy) — progressive H.264 with audio. May return if
   *       Instagram A/B tests or reverts their API.
   *
   *   P2  video_versions (legacy) — array of quality variants. Filter
   *       audio-only DASH tracks (width=0).
   */
  function extractVideoData(data) {
    // P0: DASH prefetch representations (current format)
    const dashReps = findDashPrefetchReps(data);
    if (dashReps.length > 0) {
      for (const video of dashReps) {
        processDashVideo(video);
      }
      console.log(`[NAS] Captured ${dashReps.length} video(s) from DASH prefetch reps`);
    }

    // P1 + P2: Legacy fields — recurse through the full response
    // (kept as fallback in case Instagram serves these in some contexts)
    walkForLegacyVideoUrls(data, 0);
  }

  // ─── P0: DASH Prefetch Representations (current Instagram API) ─────

  /**
   * Finds all_video_dash_prefetch_representations anywhere in the object.
   * Instagram puts it in response.extensions but we search broadly for safety.
   */
  function findDashPrefetchReps(obj) {
    if (!obj || typeof obj !== "object") return [];

    // Direct hit
    if (Array.isArray(obj.all_video_dash_prefetch_representations)) {
      return obj.all_video_dash_prefetch_representations;
    }

    // Search one level deep (covers response.extensions, response.data, etc.)
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (Array.isArray(val.all_video_dash_prefetch_representations)) {
          return val.all_video_dash_prefetch_representations;
        }
      }
    }

    return [];
  }

  /**
   * Processes a single DASH video entry. Picks the best video representation
   * and captures the audio track URL separately.
   *
   * Structure per video:
   * {
   *   video_id: "386650297...",
   *   representations: [
   *     { base_url, width, height, bandwidth, codecs, mime_type, segments },
   *     ...
   *     { base_url, width: 0, height: 0, codecs: "mp4a.40.5", mime_type: "audio/mp4" }
   *   ]
   * }
   */
  function processDashVideo(video) {
    const reps = video.representations;
    if (!Array.isArray(reps) || reps.length === 0) return;

    // Separate video and audio representations
    const videoReps = [];
    let audioRep = null;

    for (const rep of reps) {
      if (!rep.base_url) continue;

      const isAudio = (
        (rep.mime_type && rep.mime_type.startsWith("audio/")) ||
        (rep.width === 0 && rep.height === 0) ||
        (rep.codecs && rep.codecs.startsWith("mp4a"))
      );

      if (isAudio) {
        // Keep highest bandwidth audio
        if (!audioRep || (rep.bandwidth || 0) > (audioRep.bandwidth || 0)) {
          audioRep = rep;
        }
      } else {
        videoReps.push(rep);
      }
    }

    if (videoReps.length === 0) return;

    // Pick best video: highest bandwidth (= highest quality)
    videoReps.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const best = videoReps[0];

    const audioUrl = audioRep ? audioRep.base_url : null;
    const audioCodec = audioRep ? (audioRep.codecs || "mp4a.40.5") : null;

    // Index ALL representations so CDN captures can be enriched
    for (const rep of videoReps) {
      dashIndex.set(rep.base_url, {
        videoId: video.video_id || null,
        width: rep.width || 0,
        height: rep.height || 0,
        bandwidth: rep.bandwidth || 0,
        codec: rep.codecs || "vp09",
        audioUrl,
        audioCodec,
        isBest: rep === best,
      });
    }
    // Also index the audio URL itself
    if (audioRep) {
      dashIndex.set(audioRep.base_url, {
        videoId: video.video_id || null,
        width: 0,
        height: 0,
        bandwidth: audioRep.bandwidth || 0,
        codec: audioCodec,
        audioUrl: null,
        audioCodec: null,
        isAudio: true,
      });
    }

    const entry = {
      url: best.base_url,
      width: best.width || 0,
      height: best.height || 0,
      bandwidth: best.bandwidth || 0,
      codec: best.codecs || "vp09",
      mime: best.mime_type || "video/mp4",
      videoId: video.video_id || null,
      audioUrl,
      audioCodec,
      timestamp: Date.now(),
      source: "dash-api",
    };

    if (!videoUrls.has(entry.url)) {
      videoUrls.set(entry.url, entry);
      console.log(
        `[NAS] DASH video: ${entry.width}×${entry.height}`,
        `codec=${entry.codec}`,
        `bw=${entry.bandwidth}`,
        `audio=${entry.audioUrl ? "yes" : "no"}`,
        entry.url.slice(0, 80) + "…"
      );
    }
  }

  // ─── P1+P2: Legacy video_url / video_versions (fallback) ──────────

  function walkForLegacyVideoUrls(obj, depth) {
    if (!obj || depth > MAX_DEPTH) return;
    if (typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walkForLegacyVideoUrls(item, depth + 1);
      }
      return;
    }

    // Skip the DASH reps — already handled by P0
    if (obj.all_video_dash_prefetch_representations) return;

    // Extract videoId from parent object (Instagram uses id, pk, or media_id)
    const vid = obj.id || obj.pk || obj.media_id || null;

    // P1: video_url (singular) — progressive H.264 with audio
    let hasDirectUrl = false;
    if (typeof obj.video_url === "string" && CDN_PATTERN.test(obj.video_url)) {
      const w = obj.video_width || obj.original_width || 0;
      const h = obj.video_height || obj.original_height || 0;
      addVideoEntry(obj.video_url, w, h, "h264", null, null, vid);
      hasDirectUrl = true;
      console.log("[NAS] Legacy video_url found:", obj.video_url.slice(0, 80) + "…", `${w}×${h}`, vid ? `vid=${vid}` : "(no id)");
    }

    // P2: video_versions array — filter audio-only tracks
    if (!hasDirectUrl && Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
      const withVideo = obj.video_versions.filter(
        (v) => v.url && (v.width > 0 || v.height > 0) && CDN_PATTERN.test(v.url)
      );
      if (withVideo.length > 0) {
        const sorted = [...withVideo].sort((a, b) => (b.width || 0) - (a.width || 0));
        const best = sorted[0];
        addVideoEntry(best.url, best.width || 0, best.height || 0, "unknown", null, null, vid);
        console.log("[NAS] Legacy video_versions: picked", `${best.width}×${best.height}`, best.url.slice(0, 80) + "…", vid ? `vid=${vid}` : "(no id)");
      }
    }

    // Recurse into all values
    for (const key of Object.keys(obj)) {
      if (key === "video_versions" || key === "video_url") continue;
      walkForLegacyVideoUrls(obj[key], depth + 1);
    }
  }

  // ─── Shared storage helpers ────────────────────────────────────────

  function addVideoEntry(url, width, height, codec, audioUrl, audioCodec, videoId) {
    if (videoUrls.has(url)) return;
    videoUrls.set(url, {
      url,
      width: width || 0,
      height: height || 0,
      codec: codec || "unknown",
      audioUrl: audioUrl || null,
      audioCodec: audioCodec || null,
      videoId: videoId || null,
      timestamp: Date.now(),
    });
  }

  /**
   * Store a CDN video or audio URL captured from the player's own fetches.
   * Called by the patched window.fetch when a CDN response has a video/ or
   * audio/ Content-Type header.
   */
  function captureCdnUrl(url, type, contentType) {
    const map = type === "audio" ? audioUrls : videoUrls;
    if (map.has(url)) return;

    // Check if DASH API already told us about this URL (enrichment)
    const dashMeta = dashIndex.get(url);

    const entry = {
      url,
      type,
      contentType: contentType || "",
      timestamp: Date.now(),
      source: dashMeta ? "cdn+dash" : "cdn-intercept",
    };

    // Merge DASH metadata if available
    if (dashMeta) {
      entry.videoId = dashMeta.videoId;
      entry.width = dashMeta.width;
      entry.height = dashMeta.height;
      entry.bandwidth = dashMeta.bandwidth;
      entry.codec = dashMeta.codec;
      entry.isBest = dashMeta.isBest || false;
      if (type === "video") {
        entry.audioUrl = dashMeta.audioUrl;
        entry.audioCodec = dashMeta.audioCodec;
      }
    }

    map.set(url, entry);

    const tag = dashMeta
      ? `${entry.width}×${entry.height} bw=${entry.bandwidth} id=${entry.videoId}`
      : contentType;
    console.log(`[NAS] CDN ${type}${dashMeta ? " (enriched)" : ""}: ${tag}`, url.slice(0, 80) + "…");
  }

  // ─── Pipeline helpers ───────────────────────────────────────────────

  /** Find best audio URL for a video that wasn't DASH-enriched */
  function findAudioForVideo(videoEntry) {
    if (audioUrls.size === 0) return null;
    let best = null;
    for (const a of audioUrls.values()) {
      if (!best || (a.bandwidth || 0) > (best.bandwidth || 0)) best = a;
    }
    return best ? best.url : null;
  }

  /** Check if codec needs WebCodecs transcoding for universal playback */
  function isTranscodeNeeded(codec) {
    if (!codec) return false;
    const c = codec.toLowerCase();
    return c.startsWith("vp09") || c.startsWith("vp9") || c.startsWith("av01");
  }

  // ═══════════════════════════════════════════════════════════════════
  // STRATEGY 2: MSE Interception — capture DASH segments (fallback)
  // ═══════════════════════════════════════════════════════════════════

  // Storage: videoId → { codec, buffers: [Uint8Array], totalBytes }
  const mseCaptures = new Map();
  const msToUrl = new WeakMap();
  let videoCounter = 0;

  // ─── Patch URL.createObjectURL ─────────────────────────────────────
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      msToUrl.set(obj, url);
    }
    return url;
  };

  // ─── Patch SourceBuffer.appendBuffer ───────────────────────────────
  const origAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const ms = this._mediaSource || null;
      const videoId = getVideoId(ms);

      if (videoId && data && data.byteLength > 0) {
        if (!mseCaptures.has(videoId)) {
          const codec = this.mimeType || this._mimeType || "video/mp4";
          mseCaptures.set(videoId, {
            codec,
            buffers: [],
            totalBytes: 0,
            timestamp: Date.now(),
          });
        }

        const capture = mseCaptures.get(videoId);
        // True copy — original buffer may be reused/detached
        const raw = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data.buffer
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const copy = new Uint8Array(raw);
        capture.buffers.push(copy);
        capture.totalBytes += copy.byteLength;
      }
    } catch {
      // Never break video playback
    }

    return origAppendBuffer.call(this, data);
  };

  // ─── Patch MediaSource.addSourceBuffer ─────────────────────────────
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    sb._mediaSource = this;
    sb._mimeType = mimeType;
    return sb;
  };

  function getVideoId(mediaSource) {
    if (!mediaSource) return `nas-video-${++videoCounter}`;
    const url = msToUrl.get(mediaSource);
    if (url) return url;
    if (!mediaSource.__nasId) {
      mediaSource.__nasId = `nas-video-${++videoCounter}`;
    }
    return mediaSource.__nasId;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API — exposed for content script via postMessage bridge
  // ═══════════════════════════════════════════════════════════════════

  window.__NAS_VIDEO_CAPTURES__ = {
    // MSE captures
    list() {
      const result = [];
      for (const [id, capture] of mseCaptures) {
        result.push({
          id,
          codec: capture.codec,
          totalBytes: capture.totalBytes,
          segmentCount: capture.buffers.length,
          timestamp: capture.timestamp,
        });
      }
      result.sort((a, b) => b.timestamp - a.timestamp);
      return result;
    },

    reassemble(id) {
      const capture = mseCaptures.get(id);
      if (!capture || capture.buffers.length === 0) return null;
      return new Blob(capture.buffers, { type: "video/mp4" });
    },

    async reassembleAsDataUrl(id) {
      const blob = this.reassemble(id);
      if (!blob) return null;
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    },

    get count() { return mseCaptures.size; },
    clear() { mseCaptures.clear(); },
    remove(id) { mseCaptures.delete(id); },
  };

  // Fetch-intercepted video + audio URLs (primary strategy)
  window.__NAS_VIDEO_URLS__ = {
    list() {
      return Array.from(videoUrls.values()).sort((a, b) => b.timestamp - a.timestamp);
    },
    audioList() {
      return Array.from(audioUrls.values()).sort((a, b) => b.timestamp - a.timestamp);
    },

    /**
     * Deduplicated best-quality videos. Groups by videoId (from DASH
     * enrichment), picks highest bandwidth per video, returns normalized
     * descriptors ready for the pipeline.
     *
     * Lazy re-enrichment: CDN captures that arrived before the embedded
     * script scan are retroactively enriched from dashIndex here.
     */
    bestVideos() {
      // Lazy re-enrichment: retroactively enrich unenriched CDN captures
      if (dashIndex.size > 0) {
        for (const [url, entry] of videoUrls) {
          if (entry.source === "cdn-intercept") {
            const meta = dashIndex.get(url);
            if (meta) {
              entry.videoId = meta.videoId;
              entry.width = meta.width;
              entry.height = meta.height;
              entry.bandwidth = meta.bandwidth;
              entry.codec = meta.codec;
              entry.isBest = meta.isBest || false;
              entry.audioUrl = meta.audioUrl;
              entry.audioCodec = meta.audioCodec;
              entry.source = "cdn+dash";
            }
          }
        }
      }

      const groups = new Map(); // videoId → best entry
      const hasDash = dashIndex.size > 0;

      for (const entry of videoUrls.values()) {
        if (entry.type === "audio") continue;
        // Drop unenriched CDN captures — no videoId means we can't dedup
        // or identify which video this segment belongs to
        if (!entry.videoId) continue;
        // When DASH data is available, skip legacy entries — they're lower
        // quality duplicates of the same videos already captured via DASH
        if (hasDash && !entry.source) continue;

        const key = entry.videoId;
        const existing = groups.get(key);

        if (!existing || (entry.bandwidth || 0) > (existing.bandwidth || 0)) {
          groups.set(key, entry);
        }
      }

      // Build normalized descriptors for the pipeline
      return Array.from(groups.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((v) => ({
          url: v.url,
          audioUrl: v.audioUrl || findAudioForVideo(v) || null,
          width: v.width || 0,
          height: v.height || 0,
          codec: v.codec || "unknown",
          audioCodec: v.audioCodec || null,
          needsTranscode: isTranscodeNeeded(v.codec),
          needsMux: !!(v.audioUrl || findAudioForVideo(v)),
          platform: "instagram",
          id: v.videoId || null,
          bandwidth: v.bandwidth || 0,
          source: v.source || "unknown",
        }));
    },

    get bestCount() {
      const seen = new Set();
      for (const entry of videoUrls.values()) {
        if (entry.type === "audio") continue;
        seen.add(entry.videoId || entry.url);
      }
      return seen.size;
    },

    get count() { return videoUrls.size; },
    get audioCount() { return audioUrls.size; },
    clear() { videoUrls.clear(); audioUrls.clear(); dashIndex.clear(); },
  };

  // ─── Cross-world message bridge ────────────────────────────────────
  window.addEventListener("message", async (event) => {
    if (event.data?.source !== "nas-content") return;

    // Fetch-intercepted URLs (primary)
    if (event.data.type === "get-video-urls") {
      const best = window.__NAS_VIDEO_URLS__.bestVideos();
      console.log(
        `[NAS] bestVideos() → ${best.length} deduped videos`,
        `(raw videoUrls: ${window.__NAS_VIDEO_URLS__.count},`,
        `dashIndex: ${dashIndex.size})`,
        best.map((v) => `${v.width}×${v.height} ${v.codec} ${v.source}`).join(", ")
      );
      window.postMessage({
        source: "nas-mse",
        type: "video-url-list",
        videos: window.__NAS_VIDEO_URLS__.list(),
        audio: window.__NAS_VIDEO_URLS__.audioList(),
        bestVideos: best,
      }, "*");
    }

    // MSE captures (fallback)
    if (event.data.type === "get-video-list") {
      window.postMessage({
        source: "nas-mse",
        type: "video-list",
        videos: window.__NAS_VIDEO_CAPTURES__.list(),
      }, "*");
    }

    if (event.data.type === "get-video-data") {
      const dataUrl = await window.__NAS_VIDEO_CAPTURES__.reassembleAsDataUrl(event.data.id);
      window.postMessage({
        source: "nas-mse",
        type: "video-data",
        id: event.data.id,
        dataUrl,
      }, "*");
    }
  });

  console.log("[NAS] Video interceptor active (fetch + MSE)");
})();
