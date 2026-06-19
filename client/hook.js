(() => {
  const marker = "__meetRawDataPocHooked";

  if (window[marker]) {
    return;
  }

  window[marker] = true;

  const state = {
    streamCount: 0,
    tracks: new Map(),
    remoteTrackCount: 0,
    activeStreams: new Set(), // Track streams that are currently live
    inspectedStreams: new Set(), // Track streams we have already started inspecting
    activeFlushers: new Set(),
    activeRecorders: new Set(),
  };

  window.addEventListener("beforeunload", () => {
    console.log("[HOOK] Page unloading... Flushing all active readers and recorders.");
    for (const flush of state.activeFlushers) {
      try { flush(); } catch (e) {}
    }
    for (const recorder of state.activeRecorders) {
      try {
        if (recorder.state === "recording") {
          recorder.requestData();
        }
      } catch (e) {}
    }
  });

  const captureFlags = {
    consentGranted: false,
    researchRawMode: false,
    studentLabel: "",
  };

  let firstSettingsResolved = false;
  const firstSettingsWaiters = [];

  const resolveFirstSettings = () => {
    if (firstSettingsResolved) {
      return;
    }

    firstSettingsResolved = true;

    for (const waiter of firstSettingsWaiters) {
      waiter();
    }

    firstSettingsWaiters.length = 0;
  };

  let initialIndices = {};

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    if (!event.data) {
      return;
    }

    if (event.data.source === "meet-raw-data-poc-settings") {
      captureFlags.consentGranted = Boolean(event.data.consentGranted);
      captureFlags.researchRawMode = Boolean(event.data.researchRawMode);
      captureFlags.studentLabel = String(event.data.studentLabel || "").trim();
      initialIndices = event.data.lastIndices || {};
      
      // Re-check all active streams whenever settings change
      for (const { stream, constraints, isRemote } of state.activeStreams) {
        inspectStream(stream, constraints, isRemote);
      }

      resolveFirstSettings();
    } else if (event.data.source === "meet-raw-data-poc-stop") {
      console.log("[HOOK] Stop signal received. Revoking consent and cleaning up...");
      captureFlags.consentGranted = false;
      // Trình xử lý trong các hàm read sẽ tự động nhận biết và dọn dẹp
    }
  });

  window.setTimeout(() => {
    if (!firstSettingsResolved) {
      captureFlags.consentGranted = false;
      captureFlags.researchRawMode = false;
      resolveFirstSettings();
    }
  }, 2000);

  const post = (type, payload = {}) => {
    window.postMessage(
      {
        source: "meet-raw-data-poc",
        type,
        payload,
        at: Date.now(),
      },
      "*",
    );
  };

  const summarizeTrack = (track) => ({
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings: typeof track.getSettings === "function" ? track.getSettings() : {},
  });

  const makeChecksum = (bytes) => {
    let checksum = 2166136261;
    const limit = Math.min(bytes.length, 8192);

    for (let index = 0; index < limit; index += 1) {
      checksum ^= bytes[index];
      checksum = Math.imul(checksum, 16777619);
    }

    return (checksum >>> 0).toString(16).padStart(8, "0");
  };

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.addEventListener("load", () => resolve(reader.result));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsDataURL(blob);
    });

  const makeThumbnailDataUrl = async (rgbaBytes, width, height) => {
    if (!("OffscreenCanvas" in window) || !("ImageData" in window)) {
      return null;
    }

    const sourceCanvas = new OffscreenCanvas(width, height);
    const sourceContext = sourceCanvas.getContext("2d");
    const thumbnailWidth = 240;
    const thumbnailHeight = Math.max(1, Math.round((height / width) * thumbnailWidth));
    const thumbnailCanvas = new OffscreenCanvas(thumbnailWidth, thumbnailHeight);
    const thumbnailContext = thumbnailCanvas.getContext("2d");

    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgbaBytes), width, height), 0, 0);
    thumbnailContext.drawImage(sourceCanvas, 0, 0, thumbnailWidth, thumbnailHeight);

    const blob = await thumbnailCanvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });

    return blobToDataUrl(blob);
  };

  const rgbaBytesToDataUrl = async (bytes) => {
    const blob = new Blob([bytes]);

    return blobToDataUrl(blob);
  };

  const startMediaRecorder = (stream, streamId) => {
    if (!("MediaRecorder" in window)) {
      post("media-recorder-unsupported", {
        streamId,
        reason: "MediaRecorder is not available",
      });
      return;
    }

    const clonedTracks = stream.getTracks().map((track) => track.clone());
    const recordingStream = new MediaStream(clonedTracks);
    const supportedTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "audio/webm;codecs=opus",
      "audio/webm",
    ];
    const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported(type));

    try {
      const options = {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 2500000,
        audioBitsPerSecond: 128000,
      };
      const recorder = new MediaRecorder(recordingStream, options);
      state.activeRecorders.add(recorder);

      let chunkIndex = (initialIndices[streamId] || -1) + 1;

      recorder.addEventListener("dataavailable", async (event) => {
        if (!event.data || event.data.size === 0) {
          return;
        }

        try {
          post("media-recording", {
            streamId,
            chunkIndex: chunkIndex++,
            mimeType: recorder.mimeType,
            size: event.data.size,
            hasAudio: recordingStream.getAudioTracks().length > 0,
            hasVideo: recordingStream.getVideoTracks().length > 0,
            dataUrl: await blobToDataUrl(event.data),
          });
        } catch (error) {
          post("media-recording-error", {
            streamId,
            message: error.message,
          });
        }
      });

      recorder.start(5000);

      const checkConsentInterval = window.setInterval(() => {
        if (!captureFlags.consentGranted && recorder.state !== "inactive") {
            console.log("[HOOK] Stopping MediaRecorder due to consent revocation");
            recorder.stop();
            window.clearInterval(checkConsentInterval);
        }
      }, 2000);

      for (const track of stream.getTracks()) {
        track.addEventListener(
          "ended",
          () => {
            if (recorder.state !== "inactive") {
              recorder.stop();
            }

            for (const clonedTrack of clonedTracks) {
              clonedTrack.stop();
            }
            state.activeRecorders.delete(recorder);
            window.clearInterval(checkConsentInterval);
          },
          { once: true },
        );
      }

      post("media-recorder-started", {
        streamId,
        mimeType: recorder.mimeType,
        hasAudio: recordingStream.getAudioTracks().length > 0,
        hasVideo: recordingStream.getVideoTracks().length > 0,
      });
    } catch (error) {
      post("media-recorder-error", {
        streamId,
        message: error.message,
      });
    }
  };

  const readVideoFrames = async (track, streamId, parentStream) => {
    if (!("MediaStreamTrackProcessor" in window) || !("VideoFrame" in window)) {
      post("video-unsupported", {
        track: summarizeTrack(track),
        reason: "MediaStreamTrackProcessor or VideoFrame is not available",
      });
      return;
    }

    const sampleTrack = track.clone();
    const processor = new MediaStreamTrackProcessor({ track: sampleTrack });
    const reader = processor.readable.getReader();
    let lastSentAt = 0;
    let lastRawSentAt = 0;
    let frameCount = 0;
    let frameBatch = [];

    state.tracks.set(sampleTrack.id, sampleTrack);

    const flushBatch = () => {
      if (frameBatch.length > 0) {
        console.log(`[HOOK] Flushing video batch with ${frameBatch.length} frames for stream ${streamId}`);
        post("video-batch", {
          streamId,
          track: summarizeTrack(track),
          frames: frameBatch,
        });
        frameBatch = [];
      }
    };

    state.activeFlushers.add(flushBatch);

    track.addEventListener("ended", () => {
      sampleTrack.stop();
      reader.cancel().catch(() => {});
      flushBatch();
    }, { once: true });

    try {
      while (sampleTrack.readyState === "live") {
        if (!captureFlags.consentGranted) {
          console.log("[HOOK] Video capture stopped: Consent revoked");
          break;
        }

        const { done, value: frame } = await reader.read();

        if (done || !frame) {
          break;
        }

        frameCount += 1;
        const now = performance.now();

        // Quay lại tần suất 1 giây mỗi hình, nhưng gộp lại gửi sau mỗi 10 hình
        if (now - lastSentAt >= 1000) {
          lastSentAt = now;

          try {
            const copyOptions = { format: "RGBA" };
            const allocationSize = frame.allocationSize(copyOptions);
            const buffer = new Uint8Array(allocationSize);
            const layout = await frame.copyTo(buffer, copyOptions);
            const thumbnailDataUrl = await makeThumbnailDataUrl(
              buffer,
              frame.displayWidth,
              frame.displayHeight,
            );
            const includeRawFrame = now - lastRawSentAt >= 10000; // Raw frame mỗi 10 giây

            if (includeRawFrame) {
              lastRawSentAt = now;
            }

            const rawIncluded = includeRawFrame && captureFlags.researchRawMode;
            let rgbaDataUrl;

            if (rawIncluded) {
              rgbaDataUrl = await rgbaBytesToDataUrl(buffer);
            }

            frameBatch.push({
              at: Date.now(),
              frameCount,
              rawSource: "VideoFrame.copyTo(RGBA)",
              sourceFormat: frame.format,
              copiedFormat: "RGBA",
              codedWidth: frame.codedWidth,
              codedHeight: frame.codedHeight,
              displayWidth: frame.displayWidth,
              displayHeight: frame.displayHeight,
              duration: frame.duration,
              format: frame.format,
              timestamp: frame.timestamp,
              allocationSize,
              copiedBytes: buffer.byteLength,
              checksum: makeChecksum(buffer),
              firstBytes: Array.from(buffer.slice(0, 24)),
              thumbnailDataUrl,
              rawIncluded,
              ...(rgbaDataUrl ? { rgbaDataUrl } : {}),
              layout,
            });

            if (frameBatch.length >= 10) {
              flushBatch();
            }
          } catch (error) {
            // Fallback sang Canvas nếu copyTo lỗi
            try {
              const bitmap = await createImageBitmap(frame);
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const context = canvas.getContext("2d", { willReadFrequently: true });

              context.drawImage(bitmap, 0, 0);

              const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
              const buffer = imageData.data;
              const allocationSize = buffer.byteLength;
              const thumbnailDataUrl = await makeThumbnailDataUrl(
                buffer,
                bitmap.width,
                bitmap.height,
              );
              const includeRawFrame = now - lastRawSentAt >= 10000;

              if (includeRawFrame) {
                lastRawSentAt = now;
              }

              const rawIncluded = includeRawFrame && captureFlags.researchRawMode;
              let rgbaDataUrl;

              if (rawIncluded) {
                rgbaDataUrl = await rgbaBytesToDataUrl(buffer);
              }

              frameBatch.push({
                at: Date.now(),
                frameCount,
                rawSource: "canvas.getImageData(RGBA)",
                sourceFormat: frame.format,
                copiedFormat: "RGBA",
                copyToError: error.message,
                codedWidth: frame.codedWidth,
                codedHeight: frame.codedHeight,
                displayWidth: frame.displayWidth,
                displayHeight: frame.displayHeight,
                duration: frame.duration,
                format: "RGBA",
                timestamp: frame.timestamp,
                allocationSize,
                copiedBytes: allocationSize,
                checksum: makeChecksum(buffer),
                firstBytes: Array.from(buffer.slice(0, 24)),
                thumbnailDataUrl,
                rawIncluded,
                ...(rgbaDataUrl ? { rgbaDataUrl } : {}),
              });

              if (frameBatch.length >= 10) {
                flushBatch();
              }

              bitmap.close();
            } catch (fallbackError) {
              post("video-frame-error", {
                streamId,
                track: summarizeTrack(track),
                message: error.message,
                fallbackMessage: fallbackError.message,
              });
            }
          }
        }

        frame.close();
      }
    } catch (error) {
      post("video-reader-error", {
        streamId,
        track: summarizeTrack(track),
        message: error.message,
      });
    } finally {
      sampleTrack.stop();
      reader.cancel().catch(() => {});
      flushBatch();
      state.activeFlushers.delete(flushBatch);
      state.inspectedStreams.delete(parentStream);
    }
  };

  const audioProcessorCode = `
    class AudioSampleProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this._bufferSize = 4096;
        this._buffer = new Float32Array(this._bufferSize);
        this._offset = 0;
      }

      process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input.length > 0) {
          const samples = input[0];
          for (let i = 0; i < samples.length; i++) {
            this._buffer[this._offset++] = samples[i];
            if (this._offset >= this._bufferSize) {
              // Gửi bản sao của buffer để tránh vấn đề về luồng
              this.port.postMessage(new Float32Array(this._buffer));
              this._offset = 0;
            }
          }
        }
        return true;
      }
    }
    registerProcessor('audio-sample-processor', AudioSampleProcessor);
  `;

  const readAudioSamples = async (track, streamId, parentStream) => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextCtor) {
      post("audio-unsupported", {
        track: summarizeTrack(track),
        reason: "AudioContext is not available",
      });
      return;
    }

    const sampleTrack = track.clone();
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(new MediaStream([sampleTrack]));
    
    let chunkCount = 0;
    let audioChunkIndex = (initialIndices[streamId] || -1) + 1;
    let lastSentAt = 0;
    let recordingSamples = [];
    let recordingSampleRate = audioContext.sampleRate;
    const maxRecordingSeconds = 20;

    try {
      const blob = new Blob([audioProcessorCode], { type: "application/javascript" });
      const moduleUrl = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);

      const processor = new AudioWorkletNode(audioContext, "audio-sample-processor");

      source.connect(processor);
      processor.connect(audioContext.destination);

      const cleanup = () => {
        processor.disconnect();
        source.disconnect();
        sampleTrack.stop();
        audioContext.close().catch(() => {});
        state.inspectedStreams.delete(parentStream);
      };

      track.addEventListener("ended", cleanup, { once: true });

      processor.port.onmessage = (event) => {
        if (!captureFlags.consentGranted) {
          console.log("[HOOK] Audio capture stopped: Consent revoked");
          cleanup();
          return;
        }

        const samples = event.data; // Float32Array từ processor
        chunkCount += 1;
        const now = performance.now();

        // Thu thập mẫu cho bản ghi dài
        if (recordingSamples.length < recordingSampleRate * maxRecordingSeconds) {
          const remaining = recordingSampleRate * maxRecordingSeconds - recordingSamples.length;
          recordingSamples.push(...Array.from(samples.slice(0, remaining)));
        }

        // Chỉ gửi metadata/preview mỗi 1 giây (hoặc lâu hơn để giảm tải theo yêu cầu của user)
        if (now - lastSentAt < 2000) { // Tăng lên 2 giây để giảm số lượng bản ghi
          return;
        }

        lastSentAt = now;

        let peak = 0;
        let sumSquares = 0;
        const preview = [];

        for (let index = 0; index < samples.length; index += 1) {
          const sample = samples[index];
          const absolute = Math.abs(sample);

          if (absolute > peak) {
            peak = absolute;
          }

          sumSquares += sample * sample;

          if (index < 128) {
            preview.push(Number(sample.toFixed(6)));
          }
        }

        post("audio-samples", {
          streamId,
          chunkCount,
          track: summarizeTrack(track),
          sampleRate: audioContext.sampleRate,
          channels: 1, // Mono từ processor
          sampleCount: samples.length,
          rms: Number(Math.sqrt(sumSquares / samples.length).toFixed(6)),
          peak: Number(peak.toFixed(6)),
          firstSamples: preview,
          rawIncluded: false,
        });
      };

      const recordingInterval = window.setInterval(() => {
        if (!captureFlags.consentGranted) {
           window.clearInterval(recordingInterval);
           return;
        }

        if (recordingSamples.length === 0) {
          return;
        }

        const rawIncluded = captureFlags.researchRawMode;
        const payload = {
          streamId,
          chunkIndex: audioChunkIndex++,
          track: summarizeTrack(track),
          sampleRate: recordingSampleRate,
          channels: 1,
          sampleCount: recordingSamples.length,
          firstSamples: recordingSamples.slice(0, 128).map((sample) => Number(sample.toFixed(6))),
          rawIncluded,
        };

        if (rawIncluded) {
          payload.samples = Array.from(recordingSamples);
        }

        post("audio-recording", payload);

        recordingSamples = [];
      }, 10000); // Tăng lên 10 giây để giảm tần suất gửi bản ghi thô
    } catch (error) {
      console.error("[HOOK] AudioWorklet failed:", error);
      post("audio-error", {
        streamId,
        message: "Failed to initialize AudioWorklet: " + error.message,
      });
      sampleTrack.stop();
    }
  };

  const inspectStream = (stream, constraints, isRemote = false) => {
    if (state.inspectedStreams.has(stream)) {
        return;
    }

    // Always track active streams
    let alreadyTracked = false;
    for (const item of state.activeStreams) {
      if (item.stream.id === stream.id) {
        alreadyTracked = true;
        break;
      }
    }
    if (!alreadyTracked) {
      state.activeStreams.add({ stream, constraints, isRemote });
    }

    // Only proceed if conditions are met
    if (!captureFlags.consentGranted || !captureFlags.studentLabel) {
        console.log(`[HOOK] Capture deferred: consent=${captureFlags.consentGranted}, label="${captureFlags.studentLabel}"`);
        return;
    }

    console.log(`[HOOK] Starting inspection for stream: ${stream.id} (Label: ${captureFlags.studentLabel})`);

    state.inspectedStreams.add(stream);
    const streamId = isRemote ? `remote-${++state.remoteTrackCount}` : `local-${++state.streamCount}`;

    post("stream-captured", {
      streamId,
      constraints,
      isRemote,
      label: isRemote ? "Remote Media (Mentor/Others)" : "Local Media (Student)",
      tracks: stream.getTracks().map(summarizeTrack),
    });

    if (!isRemote) {
        startMediaRecorder(stream, streamId);
    }

    for (const track of stream.getVideoTracks()) {
      readVideoFrames(track, streamId, stream);
    }

    for (const track of stream.getAudioTracks()) {
      readAudioSamples(track, streamId, stream);
    }
  };

  // Hook RTCPeerConnection to capture remote tracks (Mentor's audio/video)
  const originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = function(...args) {
    const pc = new originalRTCPeerConnection(...args);
    
    pc.addEventListener("track", (event) => {
      if (captureFlags.consentGranted && captureFlags.studentLabel) {
        const stream = event.streams[0] || new MediaStream([event.track]);
        inspectStream(stream, { remote: true }, true);
      }
    });

    return pc;
  };
  window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;

  const mediaDevices = navigator.mediaDevices;

  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    post("hook-error", { message: "navigator.mediaDevices.getUserMedia is not available" });
    return;
  }

  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

  mediaDevices.getUserMedia = async (...args) => {
    if (!firstSettingsResolved) {
      await new Promise((resolve) => {
        firstSettingsWaiters.push(resolve);
      });
    }

    post("get-user-media-called", { constraints: args[0] });
    const stream = await originalGetUserMedia(...args);

    inspectStream(stream, args[0]);

    return stream;
  };

  post("hook-installed", {
    userAgent: navigator.userAgent,
    hasMediaStreamTrackProcessor: "MediaStreamTrackProcessor" in window,
    hasVideoFrame: "VideoFrame" in window,
    hasAudioContext: Boolean(window.AudioContext || window.webkitAudioContext),
  });
})();
