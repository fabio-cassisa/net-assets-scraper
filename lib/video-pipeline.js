// ─── Net Assets Scraper V2 — Video Pipeline ──────────────────────────
// Shared cross-platform video processing pipeline.
//
// Accepts normalized video descriptors:
//   { url, audioUrl, width, height, codec, needsTranscode, needsMux, platform, id }
//
// Phases:
//   1. Fetch — downloads video (+ audio if separate)
//   2. Mux   — combines video + audio into single .mp4 via mp4box.js
//   3. Transcode — VP9/AV1 → H.264 via WebCodecs (Phase 3, not yet)
//
// Usage from panel.js:
//   const blob = await VideoPipeline.process(descriptor, onProgress);
//   downloadBlob(blob, filename);

const VideoPipeline = (() => {
  "use strict";

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Full pipeline: fetch → mux → (future: transcode) → Blob
   * @param {Object} descriptor - normalized video descriptor
   * @param {Function} [onProgress] - callback({ phase, percent, detail })
   * @returns {Promise<Blob>} playable .mp4 blob
   */
  async function process(descriptor, onProgress = noop) {
    const { url, audioUrl, needsMux } = descriptor;

    // Phase 1: Fetch raw data
    onProgress({ phase: "fetch", percent: 0, detail: "Downloading video…" });
    const videoData = await fetchMedia(url, (p) =>
      onProgress({
        phase: "fetch",
        percent: Math.round(p * (audioUrl ? 50 : 100)),
        detail: "Downloading video…",
      })
    );

    let audioData = null;
    if (audioUrl && needsMux) {
      onProgress({ phase: "fetch", percent: 50, detail: "Downloading audio…" });
      audioData = await fetchMedia(audioUrl, (p) =>
        onProgress({
          phase: "fetch",
          percent: Math.round(50 + p * 50),
          detail: "Downloading audio…",
        })
      );
    }

    // Phase 2: Mux if we have separate audio
    if (audioData) {
      onProgress({ phase: "mux", percent: 0, detail: "Muxing video + audio…" });
      try {
        const muxed = await mux(videoData, audioData, onProgress);
        onProgress({ phase: "done", percent: 100, detail: "Ready" });
        return muxed;
      } catch (err) {
        console.warn("[VideoPipeline] Mux failed, falling back to video-only:", err);
        onProgress({ phase: "done", percent: 100, detail: "Ready (no audio — mux failed)" });
        return new Blob([videoData], { type: "video/mp4" });
      }
    }

    // No audio to mux — return video as-is
    onProgress({ phase: "done", percent: 100, detail: "Ready" });
    return new Blob([videoData], { type: "video/mp4" });
  }

  /**
   * Batch process multiple descriptors sequentially.
   * @param {Object[]} descriptors
   * @param {Function} [onProgress] - callback({ index, total, phase, percent, detail })
   * @returns {Promise<Array<{descriptor, blob, error}>>}
   */
  async function processBatch(descriptors, onProgress = noop) {
    const results = [];
    for (let i = 0; i < descriptors.length; i++) {
      const desc = descriptors[i];
      try {
        const blob = await process(desc, ({ phase, percent, detail }) =>
          onProgress({ index: i, total: descriptors.length, phase, percent, detail })
        );
        results.push({ descriptor: desc, blob, error: null });
      } catch (err) {
        console.error(`[VideoPipeline] Failed on video ${i}:`, err);
        results.push({ descriptor: desc, blob: null, error: err.message });
      }
    }
    return results;
  }

  // ─── Fetch with progress ──────────────────────────────────────────

  async function fetchMedia(url, onProgress = noop) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);

    // Streaming read with progress
    const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength > 0) onProgress(received / contentLength);
    }

    // Merge chunks into single ArrayBuffer
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    onProgress(1);
    return merged.buffer;
  }

  // ─── Mux video + audio with mp4box.js ─────────────────────────────

  /**
   * Muxes separate video and audio ArrayBuffers into a single .mp4 Blob.
   * Uses mp4box.js to parse both inputs, extract all samples, then build
   * a combined output file.
   */
  async function mux(videoBuffer, audioBuffer, onProgress = noop) {
    if (typeof MP4Box === "undefined") {
      throw new Error("MP4Box not loaded — add mp4box.all.min.js to panel.html");
    }

    // Step 1: Parse both inputs and extract samples
    onProgress({ phase: "mux", percent: 10, detail: "Parsing video…" });
    const videoSrc = await parseAndExtract(videoBuffer, "video");

    onProgress({ phase: "mux", percent: 25, detail: "Parsing audio…" });
    const audioSrc = await parseAndExtract(audioBuffer, "audio");

    if (videoSrc.samples.length === 0) {
      throw new Error("No video samples found in source");
    }

    // Step 2: Build output file
    onProgress({ phase: "mux", percent: 40, detail: "Building output…" });
    const output = MP4Box.createFile();

    // Add video track
    const vTrack = videoSrc.track;
    const vId = output.addTrack({
      timescale: vTrack.timescale,
      duration: vTrack.duration,
      width: vTrack.video ? vTrack.video.width : vTrack.track_width,
      height: vTrack.video ? vTrack.video.height : vTrack.track_height,
      nb_samples: videoSrc.samples.length,
      type: vTrack.codec,
      description: videoSrc.description,
    });

    // Add audio track (if samples exist)
    let aId = null;
    if (audioSrc.samples.length > 0) {
      const aTrack = audioSrc.track;
      aId = output.addTrack({
        timescale: aTrack.timescale,
        duration: aTrack.duration,
        channel_count: aTrack.audio ? aTrack.audio.channel_count : 2,
        samplerate: aTrack.audio ? aTrack.audio.sample_rate : 44100,
        nb_samples: audioSrc.samples.length,
        type: aTrack.codec,
        description: audioSrc.description,
        hdlr: "soun",
      });
    }

    // Step 3: Add all samples
    onProgress({ phase: "mux", percent: 55, detail: "Writing samples…" });

    for (const sample of videoSrc.samples) {
      output.addSample(vId, sample.data, {
        duration: sample.duration,
        dts: sample.dts,
        cts: sample.cts,
        is_sync: sample.is_sync,
      });
    }

    if (aId !== null) {
      for (const sample of audioSrc.samples) {
        output.addSample(aId, sample.data, {
          duration: sample.duration,
          dts: sample.dts,
          cts: sample.cts,
          is_sync: sample.is_sync,
        });
      }
    }

    // Step 4: Serialize to ArrayBuffer
    onProgress({ phase: "mux", percent: 85, detail: "Finalizing…" });
    const buffer = serializeOutput(output);

    if (!buffer || buffer.byteLength === 0) {
      throw new Error("Muxing produced empty output");
    }

    console.log(`[VideoPipeline] Muxed: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
    return new Blob([buffer], { type: "video/mp4" });
  }

  /**
   * Parse an MP4 buffer and extract track info + all samples synchronously.
   * Returns { track, samples[], description } for the first video or audio track.
   */
  function parseAndExtract(buffer, label) {
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      let trackInfo = null;
      let description = null;
      const samples = [];

      file.onReady = (info) => {
        // Find the right track (first video track for "video", first audio for "audio")
        const track = label === "audio"
          ? info.tracks.find((t) => t.type === "audio" || (t.audio && t.audio.sample_rate > 0))
          : info.tracks.find((t) => t.type === "video" || (t.video && t.video.width > 0));

        if (!track) {
          // Fallback: just take the first track
          trackInfo = info.tracks[0] || null;
        } else {
          trackInfo = track;
        }

        if (!trackInfo) {
          resolve({ track: null, samples: [], description: null });
          return;
        }

        // Extract codec description box
        description = extractDescription(file, trackInfo);

        // Set up sample extraction — this fires onSamples synchronously
        // when all data is already appended
        file.setExtractionOptions(trackInfo.id, null, {
          nbSamples: trackInfo.nb_samples,
        });

        file.onSamples = (_id, _user, extractedSamples) => {
          for (const s of extractedSamples) {
            samples.push({
              data: s.data,
              duration: s.duration,
              dts: s.dts,
              cts: s.cts,
              is_sync: s.is_sync,
            });
          }
        };

        file.start();

        resolve({ track: trackInfo, samples, description });
      };

      file.onError = (e) => reject(new Error(`MP4Box parse error (${label}): ${e}`));

      // mp4box.js requires fileStart on the buffer
      buffer.fileStart = 0;
      file.appendBuffer(buffer);
      file.flush();
    });
  }

  /**
   * Extract codec-specific description box (avcC, vpcC, esds, etc.)
   * as a Uint8Array. mp4box.js needs this to write the correct stsd entry.
   */
  function extractDescription(file, track) {
    try {
      const trak = file.getTrackById(track.id);
      if (!trak) return undefined;

      const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
      if (!entry) return undefined;

      // Known codec config box names
      const configBoxes = ["avcC", "hvcC", "vpcC", "av1C", "esds"];
      for (const boxName of configBoxes) {
        if (entry[boxName]) {
          const stream = new DataStream();
          stream.endianness = DataStream.BIG_ENDIAN;
          entry[boxName].write(stream);
          return new Uint8Array(stream.buffer, 0, stream.position);
        }
      }
    } catch (err) {
      console.warn("[VideoPipeline] Could not extract track description:", err);
    }
    return undefined;
  }

  /**
   * Serialize an mp4box output file to ArrayBuffer.
   * Tries multiple approaches for compatibility across mp4box.js builds.
   */
  function serializeOutput(file) {
    // Approach 1: getBuffer() — available in some builds
    if (typeof file.getBuffer === "function") {
      try {
        return file.getBuffer();
      } catch { /* fall through */ }
    }

    // Approach 2: DataStream write — works with mp4box.all.min.js
    if (typeof DataStream !== "undefined") {
      try {
        const stream = new DataStream();
        stream.endianness = DataStream.BIG_ENDIAN;
        file.write(stream);
        return stream.buffer.slice(0, stream.position);
      } catch { /* fall through */ }
    }

    // Approach 3: save() with in-memory capture (unlikely in browser)
    if (typeof file.save === "function") {
      try {
        return file.save();
      } catch { /* fall through */ }
    }

    return null;
  }

  // ─── Utilities ────────────────────────────────────────────────────

  function noop() {}

  /**
   * Generate a filename for a video descriptor.
   * @param {Object} desc - video descriptor
   * @param {number} [index] - optional index for batch naming
   * @returns {string}
   */
  function makeFilename(desc, index) {
    const parts = [desc.platform || "video"];
    if (desc.id) parts.push(desc.id.slice(-8));
    else if (typeof index === "number") parts.push(String(index + 1));
    if (desc.width && desc.height) parts.push(`${desc.width}x${desc.height}`);
    return parts.join("_") + ".mp4";
  }

  // ─── Exposed API ──────────────────────────────────────────────────

  return {
    process,
    processBatch,
    makeFilename,
  };
})();
