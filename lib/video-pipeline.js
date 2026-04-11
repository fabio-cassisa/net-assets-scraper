// ─── Net Assets Scraper V2 — Video Pipeline ──────────────────────────
// Shared cross-platform video processing pipeline.
//
// Accepts normalized video descriptors:
//   { url, audioUrl, width, height, codec, needsTranscode, needsMux, platform, id }
//
// Phases:
//   1. Fetch     — downloads video (+ audio if separate)
//   2. Transcode — VP9/AV1 → H.264 via WebCodecs (hardware-accelerated)
//   3. Mux       — combines video + audio into single .mp4 via mp4box.js
//
// Usage from panel.js:
//   const blob = await VideoPipeline.process(descriptor, onProgress);
//   downloadBlob(blob, filename);

const VideoPipeline = (() => {
  "use strict";

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Full pipeline: fetch → transcode → mux → Blob
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

    const vDesc = videoSrc.description;
    const aDesc = audioSrc.description;
    console.log(
      `[VideoPipeline] Mux inputs — video: ${videoSrc.samples.length} samples ` +
      `(track: ${videoSrc.track?.codec || "?"}, desc: ${vDesc ? vDesc.name + " " + vDesc.bytes.byteLength + "B" : "none"}), ` +
      `audio: ${audioSrc.samples.length} samples ` +
      `(track: ${audioSrc.track?.codec || "?"}, desc: ${aDesc ? aDesc.name + " " + aDesc.bytes.byteLength + "B" : "none"})`
    );

    if (videoSrc.samples.length === 0) {
      throw new Error("No video samples found in source");
    }

    // Step 2: Build output file
    // ⚠ DO NOT pass `description` to addTrack — MP4Box calls addBox() on it,
    //   which expects a parsed Box object with .write(). Raw bytes crash with
    //   "this.boxes[e].write is not a function". Instead we:
    //   a) Create the track WITHOUT description
    //   b) Grab the stsd sample entry
    //   c) Inject the original Box object directly via addBox()
    onProgress({ phase: "mux", percent: 40, detail: "Building output…" });
    const output = MP4Box.createFile();

    // MP4Box addTrack needs the fourcc only (e.g. "avc1", "mp4a"),
    // NOT the full codec string with profile/level ("avc1.640028", "mp4a.40.5").
    function fourcc(codec) {
      return codec ? codec.split(".")[0] : codec;
    }

    // Add video track — use avcDecoderConfigRecord for H.264, box injection for others
    const vTrack = videoSrc.track;
    const vOpts = {
      timescale: vTrack.timescale,
      duration: vTrack.duration,
      width: vTrack.video ? vTrack.video.width : vTrack.track_width,
      height: vTrack.video ? vTrack.video.height : vTrack.track_height,
      nb_samples: videoSrc.samples.length,
      type: fourcc(vTrack.codec),
    };
    // For H.264, use the dedicated parameter (known working from buildH264Mp4)
    // ⚠ extractDescription serializes the FULL box (8-byte header + data), but
    //   avcDecoderConfigRecord expects RAW config bytes (no box header).
    //   WebCodecs gives raw bytes → works. extractDescription gives full box → must strip header.
    if (vDesc && vDesc.name === "avcC") {
      // Strip 8-byte box header (4B size + 4B "avcC" fourcc) → raw AVCDecoderConfigurationRecord
      const raw = vDesc.bytes.byteLength > 8
        ? vDesc.bytes.slice(8)
        : vDesc.bytes;
      const buf = raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      vOpts.avcDecoderConfigRecord = buf;
    }
    const vId = output.addTrack(vOpts);
    // For non-avc codecs, inject via serialize→re-parse clone
    if (vDesc && vDesc.name !== "avcC" && vDesc.bytes) {
      _injectDescriptionBox(output, vId, vDesc.bytes);
    }

    // Add audio track (if samples exist)
    let aId = null;
    if (audioSrc.samples.length > 0) {
      const aTrack = audioSrc.track;
      const aOpts = {
        timescale: aTrack.timescale,
        duration: aTrack.duration,
        channel_count: aTrack.audio ? aTrack.audio.channel_count : 2,
        samplerate: aTrack.audio ? aTrack.audio.sample_rate : 44100,
        nb_samples: audioSrc.samples.length,
        type: fourcc(aTrack.codec),
        hdlr: "soun",
      };
      aId = output.addTrack(aOpts);
      // Inject audio codec config box (esds for AAC) via fresh clone
      if (aDesc && aDesc.bytes) {
        _injectDescriptionBox(output, aId, aDesc.bytes);
      }
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

    if (!buffer || buffer.byteLength < 1024) {
      throw new Error(`Muxing produced insufficient output (${buffer?.byteLength || 0} bytes)`);
    }

    console.log(`[VideoPipeline] Muxed: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
    return new Blob([buffer], { type: "video/mp4" });
  }

  // ─── Mux helpers ──────────────────────────────────────────────────

  /**
   * Inject a codec config Box (avcC, esds, etc.) into a track's stsd entry.
   * We CLONE the box via serialize→re-parse so it has no dangling references
   * to the source file's object graph. This avoids write() failures when
   * serializing the output file.
   *
   * @param {Object} outputFile - MP4Box output file
   * @param {number} trackId - track ID from addTrack
   * @param {Uint8Array} descBytes - serialized box bytes (from extractDescription)
   */
  function _injectDescriptionBox(outputFile, trackId, descBytes) {
    try {
      const trak = outputFile.getTrackById(trackId);
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      if (!entry || !descBytes || descBytes.byteLength === 0) return;

      // Convert Uint8Array → ArrayBuffer for MP4BoxStream
      const ab = descBytes instanceof ArrayBuffer
        ? descBytes
        : descBytes.buffer.slice(descBytes.byteOffset, descBytes.byteOffset + descBytes.byteLength);

      // Parse the raw bytes into a FRESH Box object (no source-file baggage)
      const stream = new MP4BoxStream(ab);
      const parsed = BoxParser.parseOneBox(stream, false);
      if (parsed.box) {
        entry.addBox(parsed.box);
      } else {
        console.warn(`[mux] Failed to parse description box for track ${trackId}`);
      }
    } catch (err) {
      console.warn(`[mux] Failed to inject description box for track ${trackId}:`, err);
    }
  }

  // ─── Transcode VP9/AV1 → H.264 via WebCodecs ─────────────────────

  /**
   * Transcode a VP9 (or AV1) video-only .mp4 buffer into an H.264 .mp4 buffer.
   * Uses WebCodecs VideoDecoder + VideoEncoder with hardware acceleration.
   *
   * @param {ArrayBuffer} sourceBuffer - VP9/AV1 .mp4 (video track only)
   * @param {Function} [onProgress] - callback({ phase, percent, detail })
   * @returns {Promise<ArrayBuffer>} H.264 video-only .mp4 buffer
   */
  async function transcode(sourceBuffer, onProgress = noop) {
    // ── Guard: WebCodecs available? ──
    if (typeof VideoDecoder === "undefined" || typeof VideoEncoder === "undefined") {
      throw new Error("WebCodecs not available in this environment");
    }
    if (typeof MP4Box === "undefined") {
      throw new Error("MP4Box not loaded");
    }

    onProgress({ phase: "transcode", percent: 0, detail: "Parsing source…" });

    // 1. Parse source to get track info + samples
    const source = await parseAndExtract(sourceBuffer, "video");
    if (!source.track || source.samples.length === 0) {
      throw new Error("No video samples found in source buffer");
    }

    const { track, samples, description: srcDescription } = source;
    const width = track.video?.width || track.track_width;
    const height = track.video?.height || track.track_height;
    const sourceCodec = track.codec; // e.g. 'vp09.00.41.08'
    const totalSamples = samples.length;

    // Compute source framerate for encoder config
    // track.duration can be 0 for DASH segments → guard against Infinity/NaN
    let framerate = 30; // safe default
    if (track.duration > 0 && track.timescale > 0 && totalSamples > 0) {
      const avgDurationSec = track.duration / track.timescale / totalSamples;
      const computed = Math.round(1 / avgDurationSec);
      if (Number.isFinite(computed) && computed > 0 && computed <= 120) {
        framerate = computed;
      }
    }

    console.log(
      `[Transcode] Source: ${sourceCodec} ${width}x${height} @ ${framerate}fps, ` +
      `${totalSamples} samples, timescale=${track.timescale}`
    );

    // 2. Check H.264 encoder support
    const encoderConfig = {
      codec: "avc1.640028", // H.264 High Profile Level 4.0 (good for 1080p)
      width,
      height,
      bitrate: estimateBitrate(width, height),
      framerate,
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "avc" }, // length-prefixed NALUs (what MP4 expects)
    };

    let support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      // Try software fallback
      encoderConfig.hardwareAcceleration = "prefer-software";
      support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support.supported) {
        throw new Error(`H.264 encoding not supported for ${width}x${height}`);
      }
      console.log("[Transcode] Using software H.264 encoder (no hardware support)");
    }

    // 3. Configure decoder — needs raw bytes, not the Box object
    const descBytes = srcDescription?.bytes;
    const decoderConfig = {
      codec: sourceCodec,
      codedWidth: width,
      codedHeight: height,
    };
    if (descBytes && descBytes.byteLength > 0) {
      decoderConfig.description = descBytes;
    }

    const decoderSupport = await VideoDecoder.isConfigSupported(decoderConfig);
    if (!decoderSupport.supported) {
      throw new Error(`Decoder not supported for codec: ${sourceCodec}`);
    }

    // 4. Set up the decode → encode pipeline
    const h264Chunks = [];
    let avcDescription = null; // avcC box from first keyframe
    let encodedCount = 0;
    let decodedCount = 0;

    return new Promise((resolve, reject) => {
      let encodeError = null;
      let decodeError = null;

      const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          // Capture the avcC description from the first keyframe
          if (!avcDescription && metadata?.decoderConfig?.description) {
            avcDescription = metadata.decoderConfig.description;
          }

          // Copy chunk data to a persistent buffer
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);

          h264Chunks.push({
            data: buf,
            timestamp: chunk.timestamp,
            duration: chunk.duration || 0,
            isKey: chunk.type === "key",
          });

          encodedCount++;
          if (encodedCount % 30 === 0 || encodedCount === totalSamples) {
            onProgress({
              phase: "transcode",
              percent: Math.round((encodedCount / totalSamples) * 80) + 15,
              detail: `Encoding ${encodedCount}/${totalSamples}`,
            });
          }
        },
        error: (e) => {
          encodeError = e;
          console.error("[Transcode] Encoder error:", e);
        },
      });
      encoder.configure(encoderConfig);

      const decoder = new VideoDecoder({
        output: (frame) => {
          try {
            // Keyframe every 2 seconds (or first frame)
            const keyFrame = decodedCount === 0 || decodedCount % (framerate * 2) === 0;
            encoder.encode(frame, { keyFrame });
          } finally {
            frame.close(); // CRITICAL: free GPU memory
          }
          decodedCount++;
        },
        error: (e) => {
          decodeError = e;
          console.error("[Transcode] Decoder error:", e);
        },
      });
      decoder.configure(decoderConfig);

      // 5. Feed all samples through the pipeline with backpressure
      (async () => {
        try {
          const srcTimescale = track.timescale;

          for (let i = 0; i < totalSamples; i++) {
            if (decodeError || encodeError) break;

            const sample = samples[i];
            const chunk = new EncodedVideoChunk({
              type: sample.is_sync ? "key" : "delta",
              timestamp: Math.round((sample.cts / srcTimescale) * 1_000_000), // → microseconds
              duration: Math.round((sample.duration / srcTimescale) * 1_000_000),
              data: sample.data,
            });
            decoder.decode(chunk);

            // Backpressure: pause if encoder is falling behind
            while (encoder.encodeQueueSize > 10) {
              await sleep(1);
            }

            if (i % 30 === 0) {
              onProgress({
                phase: "transcode",
                percent: Math.round((i / totalSamples) * 15) + 5,
                detail: `Decoding ${i}/${totalSamples}`,
              });
            }
          }

          // Flush both pipelines
          onProgress({ phase: "transcode", percent: 90, detail: "Flushing…" });
          await decoder.flush();
          await encoder.flush();
          decoder.close();
          encoder.close();

          if (decodeError) throw decodeError;
          if (encodeError) throw encodeError;

          if (h264Chunks.length === 0) {
            throw new Error("Transcoding produced zero output frames");
          }

          // 6. Build output .mp4 from H.264 chunks
          onProgress({ phase: "transcode", percent: 95, detail: "Building H.264 container…" });
          const outBuffer = buildH264Mp4(h264Chunks, avcDescription, width, height);

          if (!outBuffer || outBuffer.byteLength === 0) {
            throw new Error("H.264 container serialization failed");
          }

          console.log(
            `[Transcode] Done: ${totalSamples} frames → ${h264Chunks.length} H.264 chunks, ` +
            `${(outBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`
          );

          onProgress({ phase: "transcode", percent: 100, detail: "Transcode complete" });
          resolve(outBuffer);
        } catch (err) {
          // Clean up on error
          try { decoder.close(); } catch { /* ignore */ }
          try { encoder.close(); } catch { /* ignore */ }
          reject(err);
        }
      })();
    });
  }

  /**
   * Build a video-only .mp4 from H.264 EncodedVideoChunk data.
   * @param {Array} chunks - { data, timestamp, duration, isKey }
   * @param {BufferSource|null} avcDescription - avcC box data from encoder
   * @param {number} width
   * @param {number} height
   * @returns {ArrayBuffer}
   */
  function buildH264Mp4(chunks, avcDescription, width, height) {
    const output = MP4Box.createFile();

    // WebCodecs metadata.decoderConfig.description gives us the raw
    // AVCDecoderConfigurationRecord bytes. MP4Box.addTrack has a dedicated
    // `avcDecoderConfigRecord` parameter that creates a proper BoxParser.avcCBox
    // object internally (with .write() method). Do NOT use the generic
    // `description` parameter — that expects a pre-parsed Box object.
    let avcRecord = undefined;
    if (avcDescription) {
      // Must be an ArrayBuffer for MP4BoxStream constructor
      avcRecord = avcDescription instanceof ArrayBuffer
        ? avcDescription
        : avcDescription.buffer
          ? avcDescription.buffer.slice(
              avcDescription.byteOffset,
              avcDescription.byteOffset + avcDescription.byteLength
            )
          : avcDescription;
    }

    console.log(
      `[buildH264Mp4] ${chunks.length} chunks, ${width}x${height}, ` +
      `avcRecord: ${avcRecord ? avcRecord.byteLength + "B" : "none"}`
    );

    const trackOpts = {
      timescale: 1_000_000, // microseconds (matching WebCodecs timestamps)
      width,
      height,
      nb_samples: chunks.length,
      type: "avc1",
    };
    if (avcRecord) {
      trackOpts.avcDecoderConfigRecord = avcRecord;
    }

    const trackId = output.addTrack(trackOpts);
    if (!trackId) {
      console.error("[buildH264Mp4] addTrack returned falsy:", trackId);
      return null;
    }

    for (const chunk of chunks) {
      // mp4box.js addSample expects an ArrayBuffer
      const sampleData = chunk.data instanceof ArrayBuffer
        ? chunk.data
        : chunk.data.buffer
          ? chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength)
          : chunk.data;

      output.addSample(trackId, sampleData, {
        duration: chunk.duration,
        dts: chunk.timestamp,
        cts: chunk.timestamp,
        is_sync: chunk.isKey,
      });
    }

    const buffer = serializeOutput(output);
    console.log(`[buildH264Mp4] Serialized: ${buffer ? buffer.byteLength + " bytes" : "null"}`);
    return buffer;
  }

  /**
   * Estimate a reasonable bitrate for H.264 encoding based on resolution.
   * Targets visually transparent quality for already-compressed social media video.
   */
  function estimateBitrate(width, height) {
    const pixels = width * height;
    if (pixels >= 1920 * 1080) return 8_000_000;  // 8 Mbps for 1080p+
    if (pixels >= 1280 * 720)  return 5_000_000;  // 5 Mbps for 720p
    if (pixels >= 854 * 480)   return 3_000_000;  // 3 Mbps for 480p
    return 2_000_000;                               // 2 Mbps fallback
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
   * Returns { bytes: Uint8Array, name: string } so that:
   *  - bytes  → raw serialized box (with header) for box injection or avcDecoderConfigRecord
   *  - name   → box type name for codec-specific branching in mux()
   * Returns undefined if no config box found.
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
          return {
            bytes: new Uint8Array(stream.buffer, 0, stream.position),
            name: boxName,
          };
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
        const buf = file.getBuffer();
        if (buf && buf.byteLength > 0) return buf;
      } catch (e) { console.warn("[serializeOutput] getBuffer failed:", e); }
    }

    // Approach 2: DataStream write — works with mp4box.all.min.js
    if (typeof DataStream !== "undefined") {
      try {
        const stream = new DataStream();
        stream.endianness = DataStream.BIG_ENDIAN;
        file.write(stream);
        const buf = stream.buffer.slice(0, stream.position);
        if (buf && buf.byteLength > 0) return buf;
        console.warn("[serializeOutput] DataStream write produced 0 bytes");
      } catch (e) { console.warn("[serializeOutput] DataStream write failed:", e); }
    }

    // Approach 3: save() with in-memory capture (unlikely in browser)
    if (typeof file.save === "function") {
      try {
        const buf = file.save();
        if (buf && buf.byteLength > 0) return buf;
      } catch (e) { console.warn("[serializeOutput] save failed:", e); }
    }

    console.error("[serializeOutput] All approaches failed");
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
    mux,
    transcode,
    makeFilename,
  };
})();
