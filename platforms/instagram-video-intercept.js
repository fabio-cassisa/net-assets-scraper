// ─── Net Assets Scraper V2 — Instagram MSE Video Interceptor ─────────
// Runs in MAIN world (page JS context) to intercept MediaSource API.
// Captures video data as Instagram feeds it to the browser via DASH/MSE,
// then exposes reassembled complete videos for the content script to read.
//
// How Instagram video works:
//   1. Creates MediaSource + SourceBuffer (with codec string)
//   2. Fetches DASH segments via fetch/XHR
//   3. Calls sourceBuffer.appendBuffer(data) for each segment
//   4. First append = init segment (ftyp+moov), rest = media segments (moof+mdat)
//
// We patch appendBuffer to intercept every chunk, then reassemble on demand.

(function () {
  "use strict";

  // Guard against double injection
  if (window.__NAS_MSE_INTERCEPTED__) return;
  window.__NAS_MSE_INTERCEPTED__ = true;

  // Storage: videoId → { codec, buffers: [ArrayBuffer], totalBytes }
  // videoId is derived from the SourceBuffer's parent MediaSource objectURL
  const captures = new Map();

  // Track MediaSource → objectURL mapping
  const msToUrl = new WeakMap();

  // Counter for unique video IDs when objectURL isn't available
  let videoCounter = 0;

  // ─── Patch URL.createObjectURL to track MediaSource URLs ───────────
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
      // Identify which video stream this buffer belongs to
      const ms = this._mediaSource || findMediaSource(this);
      const videoId = getVideoId(ms);

      if (videoId && data && data.byteLength > 0) {
        if (!captures.has(videoId)) {
          // Extract codec from the SourceBuffer's mime type
          const codec = this.mimeType || this._mimeType || "video/mp4";
          captures.set(videoId, {
            codec,
            buffers: [],
            totalBytes: 0,
            timestamp: Date.now(),
          });
        }

        const capture = captures.get(videoId);
        // Store a copy of the buffer (original may be detached)
        const copy = new Uint8Array(
          data instanceof ArrayBuffer ? data : data.buffer
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data
        );
        capture.buffers.push(copy);
        capture.totalBytes += copy.byteLength;
      }
    } catch (e) {
      // Never break video playback — silently ignore capture errors
    }

    // Always call the original
    return origAppendBuffer.call(this, data);
  };

  // ─── Patch MediaSource.addSourceBuffer to track parentage ──────────
  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sb = origAddSourceBuffer.call(this, mimeType);
    sb._mediaSource = this;
    sb._mimeType = mimeType;
    return sb;
  };

  // ─── Helpers ───────────────────────────────────────────────────────

  function findMediaSource(sourceBuffer) {
    // Fallback: try to find the MediaSource that owns this SourceBuffer
    // by checking active MediaSources (limited, but best we can do)
    return sourceBuffer._mediaSource || null;
  }

  function getVideoId(mediaSource) {
    if (!mediaSource) return `nas-video-${++videoCounter}`;
    const url = msToUrl.get(mediaSource);
    if (url) return url;
    // Assign a stable ID to this MediaSource
    if (!mediaSource.__nasId) {
      mediaSource.__nasId = `nas-video-${++videoCounter}`;
    }
    return mediaSource.__nasId;
  }

  // ─── Public API for content script ─────────────────────────────────
  // Content script reads this via window.postMessage or direct access
  // (MAIN world script shares the page's window object)

  window.__NAS_VIDEO_CAPTURES__ = {
    /**
     * Get list of captured video streams with metadata
     * @returns {Array<{id, codec, totalBytes, segmentCount, timestamp}>}
     */
    list() {
      const result = [];
      for (const [id, capture] of captures) {
        result.push({
          id,
          codec: capture.codec,
          totalBytes: capture.totalBytes,
          segmentCount: capture.buffers.length,
          timestamp: capture.timestamp,
        });
      }
      // Sort by timestamp (newest first)
      result.sort((a, b) => b.timestamp - a.timestamp);
      return result;
    },

    /**
     * Reassemble a captured video into a complete Blob
     * @param {string} id - Video ID from list()
     * @returns {Blob|null} Complete MP4 blob, or null if not found
     */
    reassemble(id) {
      const capture = captures.get(id);
      if (!capture || capture.buffers.length === 0) return null;

      // Concatenate all buffers: init segment + media segments
      // They're already in correct order (appendBuffer is called sequentially)
      const blob = new Blob(capture.buffers, { type: "video/mp4" });
      return blob;
    },

    /**
     * Reassemble and return as a data URL (for messaging to content script)
     * @param {string} id - Video ID
     * @returns {Promise<string|null>} Data URL or null
     */
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

    /**
     * Get the total number of captured streams
     */
    get count() {
      return captures.size;
    },

    /**
     * Clear all captures (free memory)
     */
    clear() {
      captures.clear();
    },

    /**
     * Clear a specific capture
     */
    remove(id) {
      captures.delete(id);
    },
  };

  // ─── Cross-world message bridge ────────────────────────────────────
  // Content script (ISOLATED world) talks to us via window.postMessage
  window.addEventListener("message", async (event) => {
    if (event.data?.source !== "nas-content") return;

    if (event.data.type === "get-video-list") {
      const videos = window.__NAS_VIDEO_CAPTURES__.list();
      window.postMessage({
        source: "nas-mse",
        type: "video-list",
        videos,
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

  console.log("[NAS] MSE video interceptor active");
})();
