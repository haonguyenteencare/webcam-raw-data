import cors from "cors";
import express from "express";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = __dirname;
const capturesRoot = path.join(projectRoot, "captures");
const port = Number(process.env.PORT || 8787);

const app = express();

app.use((req, res, next) => {
  console.log(`[NET] Incoming: ${req.method} ${req.url} (from: ${req.headers.origin || "unknown"})`);
  next();
});

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "250mb" }));
app.use("/captures", express.static(capturesRoot));

const sanitizeSegment = (value, fallback) => {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  const result = sanitized || fallback;
  console.log(`[UTILS] sanitizeSegment: "${value}" -> "${result}"`);
  return result;
};

const parseDataUrl = (dataUrl) => {
  console.log(`[UTILS] parseDataUrl: dataUrl length=${dataUrl?.length || 0}`);
  // Support complex MIME types like data:video/webm;codecs=opus;base64,...
  const match = /^data:(.*?)(;base64)?,(.*)$/s.exec(dataUrl || "");

  if (!match) {
    const preview = String(dataUrl || "").slice(0, 100);
    console.error(`[UTILS] parseDataUrl: Invalid data URL format. Preview: "${preview}..."`);
    throw new Error("Invalid data URL");
  }

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] || "";
  
  console.log(`[UTILS] parseDataUrl: mimeType=${mimeType}, isBase64=${isBase64}`);
  
  const buffer = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");

  return { buffer, mimeType };
};

const decodeNumberArray = (values, bytesPerValue) => {
  console.log(`[UTILS] decodeNumberArray: values.length=${values?.length || 0}, bytesPerValue=${bytesPerValue}`);
  if (!Array.isArray(values)) {
    return Buffer.alloc(0);
  }

  if (bytesPerValue === 4) {
    const buffer = Buffer.alloc(values.length * 4);

    values.forEach((value, index) => {
      buffer.writeFloatLE(Number(value) || 0, index * 4);
    });

    return buffer;
  }

  return Buffer.from(values.map((value) => Number(value) || 0));
};

const readManifest = async (manifestPath) => {
  console.log(`[FS] readManifest: ${manifestPath}`);
  try {
    const content = await readFile(manifestPath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[FS] readManifest: Could not read or parse manifest at ${manifestPath}: ${error.message}`);
    return null;
  }
};

const writeJson = async (filePath, value) => {
  console.log(`[FS] writeJson: ${filePath}`);
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    console.error(`[FS] writeJson error: ${filePath}`, error);
    throw error;
  }
};

const appendManifestEvents = async (sessionDir, sessionInfo, savedEvents) => {
  const manifestPath = path.join(sessionDir, "manifest.json");
  console.log(`[MANIFEST] appendManifestEvents: sessionDir=${sessionDir}, adding ${savedEvents.length} events`);
  
  const existing = await readManifest(manifestPath);
  const manifest =
    existing ||
    {
      formatVersion: 1,
      ...sessionInfo,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      eventCount: 0,
      events: [],
    };

  manifest.updatedAt = new Date().toISOString();
  manifest.eventCount += savedEvents.length;
  manifest.events.push(...savedEvents);

  await writeJson(manifestPath, manifest);
  console.log(`[MANIFEST] Updated manifest at ${manifestPath}. Total events: ${manifest.eventCount}`);

  return manifest;
};

const saveEvent = async (sessionDir, event, index) => {
  console.log(`[SAVE] saveEvent: type=${event.type}, sessionDir=${sessionDir}`);
  const payload = event.payload || {};
  const timestamp = Number(event.at || Date.now());
  const streamId = sanitizeSegment(payload.streamId, "stream");
  const baseName = `${timestamp}-${streamId}-${String(index).padStart(4, "0")}`;
  const saved = {
    type: event.type,
    at: timestamp,
    pageUrl: event.pageUrl,
    streamId: payload.streamId,
    files: {},
    metadata: {},
  };

  try {
    if (event.type === "video-frame") {
      const frameDir = path.join(sessionDir, "frames");

      await mkdir(frameDir, { recursive: true });

      if (payload.thumbnailDataUrl) {
        const { buffer } = parseDataUrl(payload.thumbnailDataUrl);
        const thumbnailPath = path.join(frameDir, `${baseName}.jpg`);

        await writeFile(thumbnailPath, buffer);
        saved.files.thumbnail = path.relative(sessionDir, thumbnailPath);
        console.log(`[SAVE] Saved thumbnail: ${thumbnailPath}`);
      }

      if (payload.rgbaDataUrl) {
        const { buffer } = parseDataUrl(payload.rgbaDataUrl);
        const rawPath = path.join(frameDir, `${baseName}.rgba`);

        await writeFile(rawPath, buffer);
        saved.files.rgba = path.relative(sessionDir, rawPath);
        saved.metadata.rawByteSize = buffer.byteLength;
        console.log(`[SAVE] Saved RGBA frame: ${rawPath} (${buffer.byteLength} bytes)`);
      }

      saved.metadata = {
        ...saved.metadata,
        width: payload.displayWidth,
        height: payload.displayHeight,
        allocationSize: payload.allocationSize,
        checksum: payload.checksum,
        sourceFormat: payload.sourceFormat,
        copiedFormat: payload.copiedFormat,
        rawSource: payload.rawSource,
        track: payload.track,
      };
      return saved;
    }

    if (event.type === "audio-recording") {
      const audioDir = path.join(sessionDir, "audio");

      await mkdir(audioDir, { recursive: true });

      const samplesPath = path.join(audioDir, `${baseName}.json`);
      const float32Path = path.join(audioDir, `${baseName}.f32`);

      await writeJson(samplesPath, {
        sampleRate: payload.sampleRate,
        channels: payload.channels,
        sampleCount: payload.sampleCount,
        samples: payload.samples || [],
      });
      await writeFile(float32Path, decodeNumberArray(payload.samples, 4));

      saved.files.samples = path.relative(sessionDir, samplesPath);
      saved.files.float32 = path.relative(sessionDir, float32Path);
      saved.metadata = {
        sampleRate: payload.sampleRate,
        channels: payload.channels,
        sampleCount: payload.sampleCount,
        track: payload.track,
      };
      console.log(`[SAVE] Saved audio recording: ${float32Path}`);
      return saved;
    }

    if (event.type === "media-recording") {
      const recordingDir = path.join(sessionDir, "recordings");

      await mkdir(recordingDir, { recursive: true });

      if (payload.dataUrl) {
        const { buffer, mimeType } = parseDataUrl(payload.dataUrl);
        const extension = mimeType.includes("webm") ? "webm" : "bin";
        const recordingPath = path.join(recordingDir, `${baseName}.${extension}`);

        await writeFile(recordingPath, buffer);
        saved.files.recording = path.relative(sessionDir, recordingPath);
        saved.metadata.byteSize = buffer.byteLength;
        console.log(`[SAVE] Saved media recording: ${recordingPath} (${buffer.byteLength} bytes)`);
      }

      saved.metadata = {
        ...saved.metadata,
        mimeType: payload.mimeType,
        size: payload.size,
        hasAudio: payload.hasAudio,
        hasVideo: payload.hasVideo,
      };
      return saved;
    }

    const eventDir = path.join(sessionDir, "events");

    await mkdir(eventDir, { recursive: true });

    const eventPath = path.join(eventDir, `${baseName}-${sanitizeSegment(event.type, "event")}.json`);

    await writeJson(eventPath, event);
    saved.files.event = path.relative(sessionDir, eventPath);
    saved.metadata = payload;
    console.log(`[SAVE] Saved generic event: ${eventPath}`);

    return saved;
  } catch (error) {
    console.error(`[SAVE] Error saving event type=${event.type} in ${sessionDir}:`, error);
    throw error;
  }
};

const findManifests = async (directory) => {
  console.log(`[FS] findManifests: Searching in ${directory}`);
  const manifests = [];

  try {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        manifests.push(...(await findManifests(entryPath)));
      } else if (entry.name === "manifest.json") {
        console.log(`[FS] findManifests: Found manifest at ${entryPath}`);
        manifests.push(entryPath);
      }
    }
  } catch (error) {
    console.error(`[FS] findManifests error in ${directory}:`, error);
    return manifests;
  }

  return manifests;
};

app.get("/health", (_request, response) => {
  console.log(`[HTTP] GET /health`);
  response.json({ ok: true, capturesRoot });
});

app.post("/api/capture/batch", async (request, response, next) => {
  try {
    const body = request.body || {};
    const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
    const studentId = sanitizeSegment(body.studentId, "unknown-student");
    const studentLabel = sanitizeSegment(body.studentLabel, "no-label");
    const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
    const events = Array.isArray(body.events) ? body.events : [];
    
    console.log(`[BATCH] Receiving ${events.length} events for session: ${sessionId} (Student: ${studentLabel})`);

    // New structure: captures/[meetingId]_[studentId]_[studentLabel]/[sessionId]
    const studentFolderName = `${meetingId}_${studentId}_${studentLabel}`;
    const sessionDir = path.resolve(capturesRoot, studentFolderName, sessionId);
    console.log(`[FS] Absolute session path: ${sessionDir}`);

    console.log(`[FS] Ensuring directory exists...`);
    try {
      await mkdir(sessionDir, { recursive: true });
      console.log(`[FS] Directory ready.`);
    } catch (fsError) {
      console.error(`[FS] Failed to create directory: ${fsError.message}`);
      throw fsError;
    }

    const savedEvents = [];

    for (let index = 0; index < events.length; index += 1) {
      const saved = await saveEvent(sessionDir, events[index], index);
      savedEvents.push(saved);
    }

    const manifest = await appendManifestEvents(
      sessionDir,
      {
        meetingId,
        studentId,
        sessionId,
        pageUrl: body.pageUrl,
        userAgent: body.userAgent,
      },
      savedEvents,
    );

    console.log(`[SUCCESS] Saved batch. Total events in manifest: ${manifest.eventCount}`);

    response.json({
      ok: true,
      meetingId,
      studentId,
      sessionId,
      savedEventCount: savedEvents.length,
      totalEventCount: manifest.eventCount,
      sessionPath: path.relative(projectRoot, sessionDir),
    });
  } catch (error) {
    console.error(`[ERROR] Batch processing failed: ${error.message}`);
    next(error);
  }
});

app.get("/api/sessions", async (_request, response, next) => {
  console.log(`[HTTP] GET /api/sessions`);
  try {
    const manifestPaths = await findManifests(capturesRoot);
    const sessions = [];

    for (const manifestPath of manifestPaths) {
      const manifest = await readManifest(manifestPath);
      const stats = await stat(manifestPath);

      if (manifest) {
        sessions.push({
          meetingId: manifest.meetingId,
          studentId: manifest.studentId,
          sessionId: manifest.sessionId,
          startedAt: manifest.startedAt,
          updatedAt: manifest.updatedAt,
          eventCount: manifest.eventCount,
          manifestPath: path.relative(capturesRoot, manifestPath),
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    }

    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    console.log(`[HTTP] GET /api/sessions: Returning ${sessions.length} sessions`);
    response.json({ ok: true, sessions });
  } catch (error) {
    console.error(`[HTTP] GET /api/sessions: Error:`, error);
    next(error);
  }
});

app.get("/api/sessions/:sessionId", async (request, response, next) => {
  const { sessionId } = request.params;
  console.log(`[HTTP] GET /api/sessions/${sessionId}`);
  try {
    const manifestPaths = await findManifests(capturesRoot);
    const target = sanitizeSegment(sessionId, "");

    for (const manifestPath of manifestPaths) {
      const manifest = await readManifest(manifestPath);

      if (manifest?.sessionId === target) {
        console.log(`[HTTP] GET /api/sessions/${sessionId}: Found session`);
        response.json({ ok: true, session: manifest });
        return;
      }
    }

    console.warn(`[HTTP] GET /api/sessions/${sessionId}: Session not found`);
    response.status(404).json({ ok: false, reason: "Session not found" });
  } catch (error) {
    console.error(`[HTTP] GET /api/sessions/${sessionId}: Error:`, error);
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ ok: false, reason: error.message });
});

await mkdir(capturesRoot, { recursive: true });

app.listen(port, () => {
  console.log(`Meet capture API listening on http://localhost:${port}`);
  console.log(`Captures root: ${capturesRoot}`);
});
