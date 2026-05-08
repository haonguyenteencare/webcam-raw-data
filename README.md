# Meet getUserMedia Raw Data PoC

Chrome MV3 extension demo for hooking `navigator.mediaDevices.getUserMedia()` on Google Meet and sampling local camera/audio data.

## Purpose (Teencare)

- Goal: capture student-side raw camera/mic samples before Google Meet encoding for learning and engagement analysis.
- Why: mentor-side capture only sees remote decoded/composited media, not the student's original local camera/mic stream.
- Approach: student Chrome extension hooks `getUserMedia`, samples video/audio, uploads batch data to backend for local/S3 storage and dashboard/replay usage.

## What This Proves

- The extension can inject at `document_start` on `https://meet.google.com/*`.
- The page-level hook wraps `getUserMedia()` before Google Meet asks for camera/mic.
- Local `MediaStreamTrack` objects can be observed.
- Video tracks can be sampled with `MediaStreamTrackProcessor` and `VideoFrame.copyTo()`.
- Audio tracks can be sampled as PCM-like `Float32` chunks through Web Audio API.

This PoC stores popup previews in `chrome.storage.local`, can export a local JSON session, and uploads capture batches to a local API when it is running.
The popup also shows a live baseline for stored payload size vs estimated raw size, plus a lightweight student label for session mapping.

## How To Load The Extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this folder:

```text
/Users/macbook/Documents/teen-care/extension-webcam
```

## How To Test On Google Meet

1. Load the extension before opening Meet.
2. Open `https://meet.google.com/`.
3. Join or create a meeting.
4. Allow camera/mic permissions.
5. Click the extension icon.
6. Confirm events appear:
   - `hook-installed`
   - `get-user-media-called`
   - `stream-captured`
   - `video-frame`
   - `audio-samples`

## What To Look For

- `video-frame.displayWidth` / `displayHeight`: sampled camera resolution.
- `video-frame.format`: raw frame pixel format exposed by `VideoFrame`.
- `video-frame.allocationSize`: full raw frame byte size.
- `video-frame.firstBytes`: small byte preview from copied raw frame data.
- `video-frame.checksum`: proof that frame bytes are changing over time.
- `video-frame.thumbnailDataUrl`: compressed preview used for popup and export.
- `audio-samples.firstSamples`: small preview of PCM-like audio samples.
- `audio-samples.rms` / `peak`: basic audio level signal.

## Export And Replay

The popup has:

- `Export`: downloads the current tab session as a JSON file.
- `Viewer`: opens a local viewer where you can load the exported JSON.

The exported file contains sampled video thumbnails, frame metadata, checksums, sampled audio chunks, short playable WAV previews generated from captured PCM-like samples, and WebM chunks from `MediaRecorder` for easier playback review. It is meant for PoC review, not full continuous raw recording.

## Local API Upload

Run the separate local API first:

```bash
cd /Users/macbook/Documents/teen-care/meet-capture-api
npm install
npm start
```

The extension uploads batches to:

```text
http://localhost:8787/api/capture/batch
```

Captured local files are written by the API under:

```text
/Users/macbook/Documents/teen-care/meet-capture-api/captures
```

The upload uses:

- `meetingId`: parsed from the Google Meet URL.
- `studentId`: anonymous id generated once and stored in extension local storage.
- `studentLabel`: lightweight mapping you can enter from the popup.
- `sessionId`: generated per Meet tab/session.

## Important Limitations

- This only captures local camera/mic streams requested via `getUserMedia()` in the page.
- It does not capture remote students from a teacher machine.
- If Google Meet calls `getUserMedia()` before the hook is installed, that stream will be missed.
- `MediaStreamTrackProcessor` support depends on the browser version.
- `ScriptProcessorNode` is deprecated, but useful for a small PoC. A production version should use `AudioWorklet`.
- Export is compact by default: thumbnails, metadata, and compressed recordings are kept; full raw frame/audio payloads are intentionally omitted unless research mode is added later.

## Next Research Steps

- Add explicit UI/consent before sampling.
- Handle camera toggle, mic toggle, camera switch, reload, and rejoin.
- Replace `ScriptProcessorNode` with `AudioWorklet`.
- Add optional upload to a local test backend.
- Measure CPU, memory, frame latency, and bandwidth.
